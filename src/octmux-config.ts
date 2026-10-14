// Reader and validator for the optional octmux config file
// (default location: ~/.config/octmux/octmux.json, JSONC syntax).
//
// Error convention (applies to every function in this module):
//   Thrown Error messages do NOT start with "octmux: ". The caller
//   (src/index.tsx) adds that prefix when it prints the message, so the
//   prefix is applied in exactly one place.

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface OctmuxConfig {
  $schema?: string;
  server?: {
    url?: string;
    password?: string;
    // Directory path AS SEEN BY THE SERVER. Used as the session location instead of
    // octmux's local working directory. Must be absolute (checked after substitution).
    directory?: string;
    // Local path prefix -> server path prefix, e.g. { "/mnt/nfs": "/Volumes/Disks" } when the
    // server mounts the same storage at another place. octmux's local working directory is
    // rewritten with the longest matching prefix (see mapServerDirectory). Keys and values must
    // be absolute. Cannot be combined with server.directory.
    directoryMap?: Record<string, string>;
  };
}

// Keys the config file may contain. Anything else is a hard error, so a typo
// such as "passwrod" fails loudly instead of being silently ignored.
const ALLOWED_TOP_LEVEL_KEYS: readonly string[] = ["$schema", "server"];
const ALLOWED_SERVER_KEYS: readonly string[] = ["url", "password", "directory", "directoryMap"];
const ALLOWED_KEYS_TEXT = "$schema, server.url, server.password, server.directory, server.directoryMap";

// Matches a single OpenCode-style token: {env:NAME} or {file:PATH}.
// Group 1 is the token kind, group 2 is its argument.
const TOKEN_PATTERN = /\{(env|file):([^}]*)\}/g;

// Matches only {file:PATH} tokens. Group 1 is the path argument.
const FILE_TOKEN_PATTERN = /\{file:([^}]*)\}/g;

// Narrow type guard: true for a non-null, non-array object.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Turns any thrown value into a plain message string.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Returns only the errno code (for example "ENOENT") from a thrown Node fs error.
// err.message is never used for user-facing text: it carries raw errno wording
// such as "statx '/some/path'", which is noise next to the config path and key.
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

// Describes a {file:PATH} secret that could not be stat-ed or read, without raw errno text.
// Returns "{file:PATH} but RESOLVED does not exist" for a missing file, and
// "{file:PATH} but RESOLVED cannot be read (CODE)" for any other failure.
// Callers add their own prefix (the config path, and the key name where known).
function fileSecretProblem(filePath: string, resolved: string, err: unknown): string {
  if (errorCode(err) === "ENOENT") {
    return `{file:${filePath}} but ${resolved} does not exist`;
  }
  return `{file:${filePath}} but ${resolved} cannot be read (${errorCode(err)})`;
}

// Throws unless `value` is a string. `keyName` is the dotted key used in the message.
function requireString(value: unknown, keyName: string): string {
  if (typeof value !== "string") {
    throw new Error(`config key "${keyName}" must be a string`);
  }
  return value;
}

/**
 * Parses JSONC text and validates its shape. No token substitution happens here.
 * Throws on malformed JSON, a non-object root, unknown keys, or non-string values.
 */
export function parseAndValidate(raw: string): OctmuxConfig {
  // jsonc-parser collects syntax errors into `errors` instead of throwing.
  // allowTrailingComma lets users write JSONC-style trailing commas.
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    // Report the first syntax error only; later errors are usually follow-ons.
    const first = errors[0];
    throw new Error(
      `invalid JSON in config: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error("config root must be a JSON object");
  }

  // Reject unknown top-level keys before looking at their values.
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(`unknown config key "${key}" — allowed keys are ${ALLOWED_KEYS_TEXT}`);
    }
  }

  if (parsed.$schema !== undefined) {
    requireString(parsed.$schema, "$schema");
  }

  if (parsed.server !== undefined) {
    if (!isPlainObject(parsed.server)) {
      throw new Error(`config key "server" must be an object`);
    }
    // Reject unknown keys inside "server" with the dotted name, e.g. "server.passwrod".
    for (const key of Object.keys(parsed.server)) {
      if (!ALLOWED_SERVER_KEYS.includes(key)) {
        throw new Error(
          `unknown config key "server.${key}" — allowed keys are ${ALLOWED_KEYS_TEXT}`,
        );
      }
    }
    if (parsed.server.url !== undefined) {
      requireString(parsed.server.url, "server.url");
    }
    if (parsed.server.password !== undefined) {
      requireString(parsed.server.password, "server.password");
    }
    if (parsed.server.directory !== undefined) {
      requireString(parsed.server.directory, "server.directory");
    }
    if (parsed.server.directoryMap !== undefined) {
      if (!isPlainObject(parsed.server.directoryMap)) {
        throw new Error(`config key "server.directoryMap" must be an object of local path -> server path`);
      }
      for (const [local, remote] of Object.entries(parsed.server.directoryMap)) {
        requireString(remote, `server.directoryMap["${local}"]`);
      }
    }
  }

  // Shape is now verified, so the cast is safe.
  return parsed as OctmuxConfig;
}

/**
 * Maps the path argument of a {file:PATH} token to an absolute filesystem path.
 *   - "~/..." expands to the user's home directory.
 *   - Relative paths resolve against `configDir` (the directory holding octmux.json),
 *     NOT against process.cwd(), so the config behaves the same wherever octmux starts.
 *   - Absolute paths are returned as-is (resolve() handles them).
 */
export function resolveFileTokenPath(filePath: string, configDir: string): string {
  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }
  return resolve(configDir, filePath);
}

// Expands one {env:NAME} token. Unset or empty is an error by design.
// OpenCode substitutes "" in that case; octmux refuses, so a missing secret
// cannot silently turn into an unauthenticated request.
function substituteEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`environment variable ${name} referenced by {env:${name}} is unset or empty`);
  }
  return value;
}

// Expands one {file:PATH} token by reading the file and trimming surrounding whitespace.
// A read failure is rethrown in the same wording as the permission-check failures
// (see fileSecretProblem), so the user sees one consistent message for a bad secret file.
function substituteFile(filePath: string, configDir: string, readFile: (p: string) => string): string {
  const resolved = resolveFileTokenPath(filePath, configDir);
  let contents: string;
  try {
    contents = readFile(resolved);
  } catch (err) {
    throw new Error(fileSecretProblem(filePath, resolved, err));
  }
  return contents.trim();
}

/**
 * Expands every {env:NAME} and {file:PATH} token that appears anywhere in `value`.
 * Strings without tokens are returned unchanged.
 *
 * `readFile` is injected so tests can run without touching the disk. The default
 * reads the file as UTF-8.
 */
export function substituteTokens(
  value: string,
  configDir: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  return value.replace(TOKEN_PATTERN, (_match, kind: string, arg: string) => {
    if (kind === "env") {
      return substituteEnv(arg);
    }
    return substituteFile(arg, configDir, readFile);
  });
}

// True when a file mode has any group or other permission bit set.
// 0o077 covers exactly those bits.
function hasGroupOrOtherBits(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

// The message for a file that is readable by group or other users.
// It names the file and gives the exact chmod fix.
function loosePermissionMessage(path: string): string {
  return `${path} is readable by group or other users (refusing to use it for secrets). Fix with: chmod 600 ${path}`;
}

/**
 * Throws unless the file at `path` is accessible only by its owner
 * (no group or other permission bits set). Use before reading any file that
 * holds a secret. The message names the file itself, so callers that need a
 * configPath prefix must add it themselves.
 */
export function checkFilePermissions(path: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    throw new Error(`cannot stat ${path} (${errorCode(err)})`);
  }
  if (hasGroupOrOtherBits(mode)) {
    throw new Error(loosePermissionMessage(path));
  }
}

// Applies the password permission rules before any secret is read.
//   Rule 1: text outside a token is a literal secret stored in the config file,
//           so the config file itself must be 0600.
//   Rule 2: each {file:PATH} token names a secret file, which must be 0600.
//           This check runs before the file is read.
//   A password built only from {env:...} tokens stores nothing on disk, so no file check applies.
//
// Every message is prefixed with configPath, except the Rule 1 permission message:
// it already begins with configPath, so prefixing it again would print the path twice.
function checkPasswordPermissions(password: string, configPath: string, configDir: string): void {
  const literalText = password.replace(TOKEN_PATTERN, "");
  if (literalText.length > 0) {
    checkFilePermissions(configPath);
  }
  for (const match of password.matchAll(FILE_TOKEN_PATTERN)) {
    const filePath = match[1];
    const resolved = resolveFileTokenPath(filePath, configDir);

    // stat runs here, not inside checkFilePermissions, so a missing secret gets the
    // specific "does not exist" wording with the key name instead of a generic stat error.
    let mode: number;
    try {
      mode = statSync(resolved).mode;
    } catch (err) {
      throw new Error(`${configPath}: server.password references ${fileSecretProblem(filePath, resolved, err)}`);
    }
    if (hasGroupOrOtherBits(mode)) {
      throw new Error(`${configPath}: ${loosePermissionMessage(resolved)}`);
    }
  }
}

// Returns a copy of `config` with tokens expanded in server.url, server.password,
// and server.directory. server.directoryMap is copied unchanged.
function substituteConfig(config: OctmuxConfig, configDir: string): OctmuxConfig {
  const substituted: OctmuxConfig = { ...config };
  if (config.server !== undefined) {
    substituted.server = {};
    if (config.server.url !== undefined) {
      substituted.server.url = substituteTokens(config.server.url, configDir);
    }
    if (config.server.password !== undefined) {
      substituted.server.password = substituteTokens(config.server.password, configDir);
    }
    if (config.server.directory !== undefined) {
      substituted.server.directory = substituteTokens(config.server.directory, configDir);
    }
    // directoryMap is copied as written: its paths are plain config, not secrets, so no tokens are expanded.
    if (config.server.directoryMap !== undefined) {
      substituted.server.directoryMap = { ...config.server.directoryMap };
    }
  }
  return substituted;
}

// True when `path` is absolute on POSIX ("/...") or on Windows ("C:\..." or "C:/...").
// The server may run on another host, so the check is by spelling, not by stat-ing the path.
function isAbsoluteServerPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Loads and fully resolves the octmux config.
 *
 * - With no `explicitPath`, reads ~/.config/octmux/octmux.json. A missing file
 *   returns null, because the config is optional.
 * - With an `explicitPath` (for example from a --config flag), a missing file
 *   throws, because an explicit request that cannot be honoured must fail loudly.
 * - Any parse, validation, or substitution error is rethrown prefixed with the
 *   config file path.
 * - Permission checks run before any secret file is read.
 *
 * `defaultPath` is the location used when `explicitPath` is undefined. It defaults
 * to ~/.config/octmux/octmux.json. It is a parameter, not a hard-coded constant,
 * so tests can point it at a temp directory. Tests cannot redirect the home directory
 * by setting process.env.HOME at runtime: Bun reads HOME once at process start, so
 * os.homedir() ignores later changes.
 */
export function loadOctmuxConfig(
  explicitPath?: string,
  defaultPath: string = join(homedir(), ".config", "octmux", "octmux.json"),
): { config: OctmuxConfig; path: string } | null {
  // The default argument is evaluated at call time, so homedir() is read per call.
  const configPath = resolve(explicitPath ?? defaultPath);
  const configDir = dirname(configPath);

  if (!existsSync(configPath)) {
    if (explicitPath !== undefined) {
      throw new Error(`config file not found: ${configPath} (given explicitly)`);
    }
    // No config file at the default location is normal, not an error.
    return null;
  }

  const raw = readFileSync(configPath, "utf8");

  let config: OctmuxConfig;
  try {
    config = parseAndValidate(raw);
  } catch (err) {
    throw new Error(`${configPath}: ${errorMessage(err)}`);
  }

  // checkPasswordPermissions adds the configPath prefix itself (see its comment),
  // so it sits outside the try block below.
  const password = config.server?.password;
  if (password !== undefined) {
    checkPasswordPermissions(password, configPath, configDir);
  }

  try {
    config = substituteConfig(config, configDir);
  } catch (err) {
    throw new Error(`${configPath}: ${errorMessage(err)}`);
  }

  // An empty resolved password (a literal "", or an empty {file:} secret) would be
  // sent as Basic auth with an empty secret, which the server rejects with a
  // confusing 401. Fail here instead. The message names the config path only and
  // never echoes the value.
  if (config.server?.password === "") {
    throw new Error(`${configPath}: server.password resolved to an empty string`);
  }

  // server.directory is checked after substitution, so an {env:} or {file:} value is judged
  // by what octmux actually sends. The value is not a secret, so it is named in the message.
  const directory = config.server?.directory;
  if (directory !== undefined && !isAbsoluteServerPath(directory)) {
    throw new Error(
      `${configPath}: server.directory must be an absolute path (starting with "/" or a drive letter), got "${directory}"`,
    );
  }

  // server.directoryMap: every key (local prefix) and value (server prefix) must be absolute.
  // The values are server paths, so they are judged by spelling, like server.directory.
  const directoryMap = config.server?.directoryMap;
  if (directoryMap !== undefined) {
    if (directory !== undefined) {
      throw new Error(
        `${configPath}: server.directory and server.directoryMap cannot both be set — ` +
        "server.directory pins one server path, server.directoryMap translates the local directory. Keep one.",
      );
    }
    for (const [local, remote] of Object.entries(directoryMap)) {
      if (!local.startsWith("/")) {
        throw new Error(`${configPath}: server.directoryMap key must be an absolute local path, got "${local}"`);
      }
      if (!isAbsoluteServerPath(remote)) {
        throw new Error(
          `${configPath}: server.directoryMap["${local}"] must be an absolute server path ` +
          `(starting with "/" or a drive letter), got "${remote}"`,
        );
      }
    }
  }

  return { config, path: configPath };
}

// Removes trailing "/" characters, except from the root path "/" itself.
function trimTrailingSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Translates a local directory into the server's path for it, using server.directoryMap.
 *
 * The longest local prefix that matches on a whole path segment wins, so "/mnt/nfs" matches
 * "/mnt/nfs/Florian" but not "/mnt/nfs2". The rest of the path is appended to the server prefix
 * unchanged. Returns undefined when no prefix matches, so the caller decides the fallback.
 *
 * Example: mapServerDirectory("/mnt/nfs/Florian/x", { "/mnt/nfs": "/Volumes/Disks" })
 *          → "/Volumes/Disks/Florian/x"
 */
export function mapServerDirectory(localDirectory: string, directoryMap: Record<string, string>): string | undefined {
  let bestLocal: string | undefined;
  for (const key of Object.keys(directoryMap)) {
    const local = trimTrailingSlashes(key);
    const matches =
      localDirectory === local ||
      local === "/" ||
      localDirectory.startsWith(`${local}/`);
    if (matches && (bestLocal === undefined || local.length > bestLocal.length)) {
      bestLocal = key;
    }
  }
  if (bestLocal === undefined) return undefined;

  const local = trimTrailingSlashes(bestLocal);
  const remote = trimTrailingSlashes(directoryMap[bestLocal]);
  // The part of the local path below the matched prefix, starting with "/" (or empty for an exact match).
  const rest = local === "/" ? localDirectory : localDirectory.slice(local.length);
  if (rest === "" || rest === "/") return remote;
  return remote === "/" ? rest : `${remote}${rest}`;
}
