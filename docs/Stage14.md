---
title: "Stage 14 — OpenCode v2 detection, Basic auth, octmux.json config"
created_at: 2026-10-13--13-25
created_by: Claude Code (Claude Haiku 5.5)
updated_by: Claude Code (Claude Opus 5.5)
updated_at: 2026-10-13--14-09
context: >
  Operator request: octmux must support the OpenCode v2 API, which the MBP desktop
  app serves (OpenCode server 2.0.28, reached over an SSH tunnel). Stage 14 is
  Stage A of a three-stage plan. Stage A adds a config file (octmux.json), Basic
  auth for every request, protocol detection that identifies v2 or v1 servers,
  and a loud v1 fallback. Native v2 session support is later work. The /brain
  session directory for this run is
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/20261013T104013Z-1717914.
  The design decisions are in that session's DECISIONS-draft.md (D1–D14, F1–F5).
---

# Stage 14 — OpenCode v2 detection, Basic auth, octmux.json config

## Scope

Stage 14 makes octmux start-up aware of two server protocols and of
authenticated servers. It reads its settings from an optional config file.
It does not yet use the v2 API for sessions, prompts, or events.

## Config file

- Location: `~/.config/octmux/octmux.json`, or the path given by `--config <path>`.
- Format: JSONC. Comments and trailing commas are accepted.
- Keys: `$schema` (accepted, not used), `server.url`, `server.password`.
  Any other key, including inside `server`, is an error.
- Load order: the config is loaded before endpoint resolution and before any
  SDK client is built.
- A missing default file is not an error. A missing file named by `--config`
  is an error (exit 1). `--config` with no path exits 2.
- Implemented in `src/octmux-config.ts`, which exports `parseAndValidate`,
  `substituteTokens`, `resolveFileTokenPath`, `checkFilePermissions`, and
  `loadOctmuxConfig`.

Error messages from this module do not start with `octmux: `. The caller in
`src/index.tsx` adds that prefix in one place.

## Token substitution

Applies to `server.url` and `server.password`. Tokens are expanded only in
parsed string values, so text inside JSONC comments is never substituted.

| Token | Resolution | Failure |
|---|---|---|
| `{env:NAME}` | value of the environment variable | unset or empty: exit 1 |
| `{file:PATH}` | contents, trimmed of surrounding whitespace | missing or unreadable: exit 1, message names the resolved path |

`{file:PATH}` path resolution:
- A leading `~/` expands to the home directory.
- Other relative paths resolve against the directory that holds the config file.
- Absolute paths are used as given.

## Permission checks

Checks run before any secret is read. A file passes only if it has no group
or other permission bits (mode `& 0o077 == 0`).

| Password form | Required mode |
|---|---|
| Literal text outside any token | the config file is `0600` |
| Each `{file:PATH}` token | that file is `0600` |
| Only `{env:NAME}` tokens | no file check |

A failing check exits 1 with the file path and the fix:
`chmod 600 <path>`.

A password that resolves to an empty string is an error, so a missing secret
cannot become an unauthenticated request.

## Authentication funnel

- `src/auth-headers.ts` is the single source of the auth header. It exposes
  `setAuthPassword(password)` and `getAuthHeaders()`.
- The header is `Authorization: Basic base64("opencode:" + password)`.
  When no password is set, the header is an empty object.
- `setAuthPassword` runs once at start-up, before any client is created.
  The v1 SDK copies headers when a client is constructed, so a later
  `setAuthPassword` call would not reach that client.
- Every request uses the helper:
  - both SDK clients created in `src/index.tsx`
  - the two protocol probes in `src/protocol-detect.ts`
  - the raw `fetch` calls in `src/server-lifecycle.ts` (`/health` for a
    spawned server), `src/app.tsx`, and `src/utils/session-ancestry.ts`
- The password is never printed. Endpoint URLs in messages go through
  `redactUrl` (`src/utils/redact-url.ts`), which removes any username and
  password from the URL.

## Protocol detection

Implemented in `src/protocol-detect.ts`. Runs at start-up unless `--auto-spawn`
is given. Each probe times out after 3000 ms.

Both server versions answer `200 text/html` for unknown paths, so only a
response with a JSON content type and the expected body counts as
identification.

| Step | Request | Positive identification | Otherwise |
|---|---|---|---|
| 1 (v2) | `GET /api/info` | JSON 200 with string `version` → `v2-authorized`; JSON 401 with `_tag: "UnauthorizedError"` → `v2-unauthorized` | inconclusive → step 2 |
| 2 (v1) | `GET /global/health` | JSON 200 → `v1`; any 401 → `v1-unauthorized` | inconclusive → unreachable |
| — | network error (refused, timeout) | none | `unreachable` immediately |

The v2 version is read through `@opencode/client` (`server.info()`), not from
the raw probe body. If that call fails, the result is `unreachable` with the
error name in the detail.

The v1 probe uses `/global/health`, not `/health`. On a v1 server `/health`
returns the web app's HTML.

## Version gate

Implemented by `compareVersions` in `src/protocol-detect.ts`. It compares MAJOR
and MINOR, and ignores PATCH, against `BUNDLED_OC_CLIENT_VERSION` (`2.0.28`).
That constant must match the `@opencode/client` entry in `package.json`. A
test asserts this.

| Result | Output | Exit |
|---|---|---|
| `major-mismatch` | `octmux: OpenCode server <v> major version differs from bundled client <c> — refusing` | 1 |
| `server-newer-minor` | `octmux: OpenCode server <v> is newer than the bundled client <c> (same major version)` | — |
| `server-older-minor` | `⚠ octmux: OpenCode server <v> is OLDER than the bundled client <c> — some requests may be rejected` | — |
| `unparseable` | `⚠ octmux: could not compare OpenCode server version <v> with bundled client <c>` | — |
| `exact` | nothing | — |

## Start-up messages

| Detected | Output | Exit |
|---|---|---|
| `v1` | `⚠ octmux: OpenCode v1 server detected at <url> — falling back to the v1 API (v2 not available on this server).` | continues |
| `v1-unauthorized` or `v2-unauthorized`, no password configured | `octmux: <OpenCode v1 \| v2> server at <url> requires authentication — set server.password in <config path>` | 1 |
| same, password configured and rejected | `octmux: credentials from <config path> (server.password) were rejected by <url>` | 1 |
| `v2-authorized` | version-gate line if one applies, then `octmux: OpenCode v2 server <v> detected at <url>; auth OK. Native v2 session support is not yet implemented in this octmux build.` | 1 |
| `unreachable`, endpoint from config or default | `✗  no opencode server at <url> (<origin>)` with start-up hints and `probe detail` | 1 |
| `unreachable`, endpoint from `--endpoint` | `health: failed — no opencode server at <url> (<probe detail>)` | 1 |

`<url>` is always the credential-free form. `<config path>` is the path that
was loaded, or the default path when no file exists. Passwords never appear.

## Endpoint precedence

`--endpoint <url>` beats `server.url`, which beats `http://127.0.0.1:4096`.
Both explicit values go through `new URL()` and have a trailing slash removed.
An unparseable `--endpoint` exits 2 without echoing the value. An unparseable
`server.url` exits 1, and the message names the config file, not the value.

`--auto-spawn` ignores `server.url` and skips detection.

## Dependencies

- `@opencode/client` `^2.0.28` (lock pinned in `bun.lock`). This is the
  official client for the v2 API. Its releases are in lockstep with the server
  releases, and it provides typed events. It is used for `server.info()` in
  the probe, and it is compiled into the binary (the compile is the gate that
  verified it).
- `jsonc-parser` `^3.3.1`. It parses JSONC (comments and trailing commas) and
  reports syntax errors without throwing.

## Tests

| File | Tests |
|---|---|
| `src/octmux-config.test.ts` | 25 |
| `src/protocol-detect.test.ts` | 29 |
| `src/utils/redact-url.test.ts` | 3 |

Full suite: `bun test src/`, 333 pass, 0 fail.

Live verification against the MBP server is a separate phase and is not part of this entry.

## Forward pointer

Native v2 session support (sessions, prompts, events) is planned as a later stage.

---

### 2026-10-13--13-25 — Stage 14 — OpenCode v2 detection, Basic auth, octmux.json config
**Implemented by:** Claude Code (Claude Haiku 5.5) — 2026-10-13--13-25
**Commit(s):** `93e6c8d`

- `src/octmux-config.ts` (new): JSONC parse, key validation, `{env:}`/`{file:}` substitution, permission checks, `loadOctmuxConfig`. Every config error is prefixed once with the config path and names the key; file errors report only the errno code. `loadOctmuxConfig(explicitPath?, defaultPath?)` takes the default path as a parameter because Bun reads `HOME` once at process start, so tests cannot redirect it.
- `src/auth-headers.ts` (new): one place that builds the Basic auth header.
- `src/protocol-detect.ts` (new): JSON-strict v2 and v1 probes, version gate, `detectProtocol`.
- `src/utils/redact-url.ts` (new): `redactUrl` strips credentials from any URL shown in a message.
- `src/index.tsx`: `--config` flag and help line; config loaded before endpoint resolution and clients; `setAuthPassword` before client creation; endpoint precedence; detection branches replace the old single health check; `redactUrl` at every endpoint print site; an unparseable `--endpoint` is no longer echoed.
- `src/server-lifecycle.ts`, `src/app.tsx`, `src/utils/session-ancestry.ts`: every raw `fetch` sends the auth header (`src/protocol-detect.ts` probes send it too).
- `package.json`, `bun.lock`: adds `@opencode/client` `^2.0.28` and `jsonc-parser` `^3.3.1`.
- `config/octmux.example.json` (new): commented example config, no secret.
- `README.md`: `--config` flag line and a Configuration section.
- Tests: 60 new (28 config, 29 protocol detection, 3 URL redaction). Full suite 336 pass, 0 fail.
- Live verification against an OpenCode 2.0.28 desktop server (MBP, via a dev ssh tunnel) and the local v1 server: no password, wrong password, correct password, v1 fallback, unreachable endpoint, four bad-config variants and URL-credential redaction all behave as specified.
- Observed v2 protocol shapes: `docs/OpenCode-v2-protocol-capture.md`.
- Forward pointer: native v2 session support is a later stage.
