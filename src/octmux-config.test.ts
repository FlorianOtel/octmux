import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  parseAndValidate,
  substituteTokens,
  checkFilePermissions,
  loadOctmuxConfig,
  mapServerDirectory,
} from "./octmux-config.ts";

// Every test works inside one fresh temp directory, removed in afterAll.
// The real ~/.config/octmux is never touched.
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "octmux-cfg-test-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Writes `content` to root/name and forces the exact permission `mode`.
// chmodSync is used because writeFileSync's mode is masked by the umask.
function writeFixture(name: string, content: string, mode = 0o600): string {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe("parseAndValidate (A3)", () => {
  test("accepts a valid minimal config", () => {
    const cfg = parseAndValidate(`{"server": {"url": "http://127.0.0.1:4096"}}`);
    expect(cfg).toEqual({ server: { url: "http://127.0.0.1:4096" } });
  });

  test("accepts JSONC comments and trailing commas", () => {
    const raw = `{
      // line comment
      "$schema": "https://example.invalid/schema.json",
      /* block comment */
      "server": { "password": "pw", },
    }`;
    expect(parseAndValidate(raw)).toEqual({
      $schema: "https://example.invalid/schema.json",
      server: { password: "pw" },
    });
  });

  test("throws on an unknown top-level key, naming it", () => {
    expect(() => parseAndValidate(`{"servr": {}}`)).toThrow('unknown config key "servr"');
  });

  test("throws on an unknown nested server key, naming it as server.<key>", () => {
    expect(() => parseAndValidate(`{"server": {"passwrod": "x"}}`)).toThrow(
      'unknown config key "server.passwrod" — allowed keys are $schema, server.url, server.password, server.directory, server.directoryMap',
    );
  });

  test("accepts server.directory as an allowed key (unknown-key list includes it)", () => {
    expect(parseAndValidate(`{"server": {"directory": "/srv/project"}}`)).toEqual({
      server: { directory: "/srv/project" },
    });
  });

  test("throws when server.directory is not a string", () => {
    expect(() => parseAndValidate(`{"server": {"directory": 42}}`)).toThrow(
      'config key "server.directory" must be a string',
    );
  });

  test("throws when server.password is not a string", () => {
    expect(() => parseAndValidate(`{"server": {"password": 1234}}`)).toThrow(
      'config key "server.password" must be a string',
    );
  });

  test("throws on malformed JSON, reporting the error code and offset", () => {
    expect(() => parseAndValidate(`{"server": `)).toThrow(/invalid JSON in config: .* at offset \d+/);
  });
});

describe("substituteTokens (A3)", () => {
  test("{env:VAR} substitutes when the variable is set", () => {
    process.env.OCTMUX_TEST_TOKEN_SET = "from-env";
    try {
      expect(substituteTokens("{env:OCTMUX_TEST_TOKEN_SET}", root)).toBe("from-env");
    } finally {
      delete process.env.OCTMUX_TEST_TOKEN_SET;
    }
  });

  test("{env:VAR} throws, naming the variable, when it is unset", () => {
    delete process.env.OCTMUX_TEST_TOKEN_UNSET;
    expect(() => substituteTokens("{env:OCTMUX_TEST_TOKEN_UNSET}", root)).toThrow(
      "environment variable OCTMUX_TEST_TOKEN_UNSET",
    );
  });

  test("{env:VAR} throws when the variable is set but empty", () => {
    process.env.OCTMUX_TEST_TOKEN_EMPTY = "";
    try {
      expect(() => substituteTokens("{env:OCTMUX_TEST_TOKEN_EMPTY}", root)).toThrow(
        "environment variable OCTMUX_TEST_TOKEN_EMPTY",
      );
    } finally {
      delete process.env.OCTMUX_TEST_TOKEN_EMPTY;
    }
  });

  test("{file:} missing throws, naming the resolved path", () => {
    const missing = join(root, "no-such-secret.txt");
    expect(() => substituteTokens("{file:no-such-secret.txt}", root)).toThrow(missing);
  });

  test("{file:} present substitutes and trims surrounding whitespace", () => {
    writeFixture("secret-trim.txt", "  hunter2\n\n");
    expect(substituteTokens("{file:secret-trim.txt}", root)).toBe("hunter2");
  });

  test("a string without tokens is returned unchanged", () => {
    expect(substituteTokens("plain-password-$1{x}", root)).toBe("plain-password-$1{x}");
  });

  test("tokens may appear anywhere inside a string", () => {
    process.env.OCTMUX_TEST_TOKEN_MID = "MID";
    try {
      writeFixture("secret-mid.txt", "FILE");
      expect(substituteTokens("pre-{env:OCTMUX_TEST_TOKEN_MID}-{file:secret-mid.txt}-post", root)).toBe(
        "pre-MID-FILE-post",
      );
    } finally {
      delete process.env.OCTMUX_TEST_TOKEN_MID;
    }
  });

  test("a leading ~/ in {file:} expands to the home directory", () => {
    const seen: string[] = [];
    // Injected reader records the path it was asked for; nothing is read from disk.
    substituteTokens("{file:~/octmux-secret.txt}", root, (p) => {
      seen.push(p);
      return "x";
    });
    expect(seen).toEqual([join(homedir(), "octmux-secret.txt")]);
  });

  test("a relative {file:} path resolves against configDir, not the cwd", () => {
    const seen: string[] = [];
    substituteTokens("{file:sub/secret.txt}", root, (p) => {
      seen.push(p);
      return "x";
    });
    expect(seen).toEqual([join(root, "sub", "secret.txt")]);
    expect(seen[0].startsWith(process.cwd())).toBe(false);
  });
});

describe("checkFilePermissions (A4)", () => {
  test("a 0600 file passes", () => {
    const path = writeFixture("perm-600.txt", "x", 0o600);
    expect(() => checkFilePermissions(path)).not.toThrow();
  });

  test("a 0644 file throws, naming the file and the chmod 600 fix", () => {
    const path = writeFixture("perm-644.txt", "x", 0o644);
    expect(() => checkFilePermissions(path)).toThrow(`chmod 600 ${path}`);
    expect(() => checkFilePermissions(path)).toThrow(path);
  });
});

describe("loadOctmuxConfig (A4)", () => {
  test("a 0600 secrets file referenced by {file:} loads and substitutes", () => {
    writeFixture("secret-ok.txt", "file-password\n", 0o600);
    const configPath = writeFixture(
      "cfg-file-ok.json",
      `{"server": {"password": "{file:secret-ok.txt}"}}`,
      0o644, // The config itself holds no literal secret, so its mode is not checked.
    );
    const loaded = loadOctmuxConfig(configPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.path).toBe(configPath);
    expect(loaded!.config.server?.password).toBe("file-password");
  });

  test("a 0644 secrets file throws, prefixed with the config path, naming the file and the chmod 600 fix", () => {
    const secretPath = writeFixture("secret-loose.txt", "leaky", 0o644);
    const configPath = writeFixture(
      "cfg-file-loose.json",
      `{"server": {"password": "{file:secret-loose.txt}"}}`,
      0o600,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: ${secretPath} is readable by group or other users`,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(`chmod 600 ${secretPath}`);
  });

  test("the 0644 secrets message is not double-prefixed with the config path", () => {
    writeFixture("secret-loose-2.txt", "leaky", 0o644);
    const configPath = writeFixture(
      "cfg-file-loose-2.json",
      `{"server": {"password": "{file:secret-loose-2.txt}"}}`,
      0o600,
    );
    let message = "";
    try {
      loadOctmuxConfig(configPath);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(`${configPath}: ${configPath}`);
  });

  test("a missing {file:} secret throws the 'does not exist' message with configPath and key, and no raw errno text", () => {
    const configPath = writeFixture(
      "cfg-file-missing.json",
      `{"server": {"password": "{file:/nonexistent/x}"}}`,
      0o600,
    );
    let message = "";
    try {
      loadOctmuxConfig(configPath);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      `${configPath}: server.password references {file:/nonexistent/x} but /nonexistent/x does not exist`,
    );
    expect(message).not.toContain("ENOENT");
    expect(message).not.toContain("statx");
  });

  test("an unreadable {file:} secret throws the 'cannot be read (CODE)' message, using the code and not the raw message", () => {
    // A directory passes the stat and the permission check (0700), but readFileSync
    // on it fails with EISDIR, which exercises the non-ENOENT wording.
    const dirPath = join(root, "secret-dir");
    mkdirSync(dirPath);
    chmodSync(dirPath, 0o700);
    const configPath = writeFixture(
      "cfg-file-unreadable.json",
      `{"server": {"password": "{file:secret-dir}"}}`,
      0o600,
    );
    let message = "";
    try {
      loadOctmuxConfig(configPath);
    } catch (err) {
      message = (err as Error).message;
    }
    // substituteFile has no key name in scope, so this path names configPath and the token only.
    expect(message).toBe(
      `${configPath}: {file:secret-dir} but ${dirPath} cannot be read (EISDIR)`,
    );
    expect(message).not.toContain("ENOENT");
    expect(message).not.toContain("statx");
  });

  test("a 0644 config with a literal password throws, naming the config file", () => {
    const configPath = writeFixture(
      "cfg-literal-loose.json",
      `{"server": {"password": "literal-secret"}}`,
      0o644,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(`chmod 600 ${configPath}`);
  });

  test("a 0600 config with a literal password loads", () => {
    const configPath = writeFixture(
      "cfg-literal-ok.json",
      `{"server": {"password": "literal-secret"}}`,
      0o600,
    );
    const loaded = loadOctmuxConfig(configPath);
    expect(loaded!.config.server?.password).toBe("literal-secret");
  });

  test("an explicit config path that does not exist throws", () => {
    const missing = join(root, "explicit-missing.json");
    expect(() => loadOctmuxConfig(missing)).toThrow(`config file not found: ${missing}`);
  });

  test("a missing default config returns null without throwing", () => {
    // Inject a default path inside the temp root that does not exist.
    // Passing it as the second argument keeps the real ~/.config/octmux untouched.
    // (process.env.HOME cannot be used: Bun caches the home directory at startup.)
    const missingDefault = join(root, "nope", "octmux.json");
    expect(loadOctmuxConfig(undefined, missingDefault)).toBeNull();
  });

  test("a parse error is prefixed with the config file path", () => {
    const configPath = writeFixture("cfg-bad-key.json", `{"server": {"passwrod": "x"}}`, 0o600);
    expect(() => loadOctmuxConfig(configPath)).toThrow(`${configPath}: unknown config key "server.passwrod"`);
  });

  test("an empty {file:} secret throws, naming the config path and not the value", () => {
    // A whitespace-only secrets file trims to "", which must not reach the auth header.
    writeFixture("secret-empty.txt", "  \n", 0o600);
    const configPath = writeFixture(
      "cfg-empty-secret.json",
      `{"server": {"password": "{file:secret-empty.txt}"}}`,
      0o600,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: server.password resolved to an empty string`,
    );
  });
});

describe("loadOctmuxConfig server.directory (C8)", () => {
  test("a valid absolute POSIX path loads unchanged", () => {
    const configPath = writeFixture(
      "cfg-dir-abs.json",
      `{"server": {"directory": "/srv/octmux-project"}}`,
      0o600,
    );
    const loaded = loadOctmuxConfig(configPath);
    expect(loaded!.config.server?.directory).toBe("/srv/octmux-project");
  });

  test("Windows drive-letter paths with a backslash or a slash are accepted", () => {
    const backslash = writeFixture(
      "cfg-dir-win-bs.json",
      `{"server": {"directory": "C:\\\\work\\\\repo"}}`,
      0o600,
    );
    const slash = writeFixture(
      "cfg-dir-win-fs.json",
      `{"server": {"directory": "D:/work/repo"}}`,
      0o600,
    );
    expect(loadOctmuxConfig(backslash)!.config.server?.directory).toBe("C:\\work\\repo");
    expect(loadOctmuxConfig(slash)!.config.server?.directory).toBe("D:/work/repo");
  });

  test("a relative path throws, naming the config file, the key, and the offending value", () => {
    const configPath = writeFixture(
      "cfg-dir-relative.json",
      `{"server": {"directory": "relative/dir"}}`,
      0o600,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: server.directory must be an absolute path (starting with "/" or a drive letter), got "relative/dir"`,
    );
  });

  test("an empty string throws the absolute-path error", () => {
    const configPath = writeFixture(
      "cfg-dir-empty.json",
      `{"server": {"directory": ""}}`,
      0o600,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: server.directory must be an absolute path`,
    );
  });

  test("{env:NAME} substitutes into server.directory", () => {
    process.env.OCTMUX_TEST_DIR_ENV = "/remote/from-env";
    try {
      const configPath = writeFixture(
        "cfg-dir-env.json",
        `{"server": {"directory": "{env:OCTMUX_TEST_DIR_ENV}"}}`,
        0o600,
      );
      expect(loadOctmuxConfig(configPath)!.config.server?.directory).toBe("/remote/from-env");
    } finally {
      delete process.env.OCTMUX_TEST_DIR_ENV;
    }
  });

  test("an {env:NAME} that resolves to a relative path throws, because the check runs after substitution", () => {
    process.env.OCTMUX_TEST_DIR_REL = "not/absolute";
    try {
      const configPath = writeFixture(
        "cfg-dir-env-rel.json",
        `{"server": {"directory": "{env:OCTMUX_TEST_DIR_REL}"}}`,
        0o600,
      );
      expect(() => loadOctmuxConfig(configPath)).toThrow(
        `${configPath}: server.directory must be an absolute path`,
      );
    } finally {
      delete process.env.OCTMUX_TEST_DIR_REL;
    }
  });

  test("{file:PATH} substitutes and is trimmed, with no permission check on the file", () => {
    // The file is 0644 on purpose: a directory is not a secret, so group/other bits are allowed.
    writeFixture("dir-file.txt", "/remote/from-file\n", 0o644);
    const configPath = writeFixture(
      "cfg-dir-file.json",
      `{"server": {"directory": "{file:dir-file.txt}"}}`,
      0o600,
    );
    expect(loadOctmuxConfig(configPath)!.config.server?.directory).toBe("/remote/from-file");
  });

  test("a 0644 config holding only server.directory loads (no literal secret, so no mode check)", () => {
    const configPath = writeFixture(
      "cfg-dir-644.json",
      `{"server": {"directory": "/srv/shared"}}`,
      0o644,
    );
    expect(loadOctmuxConfig(configPath)!.config.server?.directory).toBe("/srv/shared");
  });
});

describe("loadOctmuxConfig server.directoryMap", () => {
  test("a map of absolute local and server prefixes loads unchanged", () => {
    const configPath = writeFixture(
      "cfg-map-ok.json",
      `{"server": {"directoryMap": {"/mnt/nfs": "/Volumes/Disks", "/home/me": "C:\\\\Users\\\\me"}}}`,
    );
    expect(loadOctmuxConfig(configPath)!.config.server?.directoryMap).toEqual({
      "/mnt/nfs": "/Volumes/Disks",
      "/home/me": "C:\\Users\\me",
    });
  });

  test("throws when directoryMap is not an object", () => {
    expect(() => parseAndValidate(`{"server": {"directoryMap": ["/mnt/nfs"]}}`)).toThrow(
      'config key "server.directoryMap" must be an object',
    );
  });

  test("throws when a directoryMap value is not a string", () => {
    expect(() => parseAndValidate(`{"server": {"directoryMap": {"/mnt/nfs": 1}}}`)).toThrow(
      'config key "server.directoryMap["/mnt/nfs"]" must be a string',
    );
  });

  test("throws when a key is not an absolute local path", () => {
    const configPath = writeFixture("cfg-map-relkey.json", `{"server": {"directoryMap": {"mnt/nfs": "/Volumes/Disks"}}}`);
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: server.directoryMap key must be an absolute local path, got "mnt/nfs"`,
    );
  });

  test("throws when a value is not an absolute server path", () => {
    const configPath = writeFixture("cfg-map-relval.json", `{"server": {"directoryMap": {"/mnt/nfs": "Volumes"}}}`);
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: server.directoryMap["/mnt/nfs"] must be an absolute server path`,
    );
  });

  test("throws when server.directory is also set", () => {
    const configPath = writeFixture(
      "cfg-map-both.json",
      `{"server": {"directory": "/srv/x", "directoryMap": {"/mnt/nfs": "/Volumes/Disks"}}}`,
    );
    expect(() => loadOctmuxConfig(configPath)).toThrow(
      `${configPath}: server.directory and server.directoryMap cannot both be set`,
    );
  });
});

describe("mapServerDirectory", () => {
  const map = { "/mnt/nfs": "/Volumes/Disks" };

  test("rewrites the matching prefix and keeps the rest of the path", () => {
    expect(mapServerDirectory("/mnt/nfs/Florian/Gin-AI/projects/octmux", map)).toBe(
      "/Volumes/Disks/Florian/Gin-AI/projects/octmux",
    );
  });

  test("an exact match maps to the server prefix itself", () => {
    expect(mapServerDirectory("/mnt/nfs", map)).toBe("/Volumes/Disks");
  });

  test("matches whole path segments only", () => {
    expect(mapServerDirectory("/mnt/nfs2/x", map)).toBeUndefined();
  });

  test("returns undefined when no prefix matches", () => {
    expect(mapServerDirectory("/home/florian/x", map)).toBeUndefined();
  });

  test("the longest matching prefix wins", () => {
    const nested = { "/mnt/nfs": "/Volumes/Disks", "/mnt/nfs/Florian/Gin-AI": "/Users/fotel/Gin-AI" };
    expect(mapServerDirectory("/mnt/nfs/Florian/Gin-AI/projects/a", nested)).toBe("/Users/fotel/Gin-AI/projects/a");
    expect(mapServerDirectory("/mnt/nfs/Eva", nested)).toBe("/Volumes/Disks/Eva");
  });

  test("trailing slashes on keys and values are ignored", () => {
    expect(mapServerDirectory("/mnt/nfs/a", { "/mnt/nfs/": "/Volumes/Disks/" })).toBe("/Volumes/Disks/a");
  });

  test("a root key or value maps every path", () => {
    expect(mapServerDirectory("/a/b", { "/": "/srv" })).toBe("/srv/a/b");
    expect(mapServerDirectory("/srv/a", { "/srv": "/" })).toBe("/a");
  });
});
