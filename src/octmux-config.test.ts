import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  parseAndValidate,
  substituteTokens,
  checkFilePermissions,
  loadOctmuxConfig,
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
      'unknown config key "server.passwrod" — allowed keys are $schema, server.url, server.password',
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
