---
title: "OpenCode v1/v2 adaptation layer"
created_at: 2026-10-13--23-24
created_by: Claude Code (Claude Opus 5.5)
context: >
  The operator asked for an extensive, authoritative description of the redesign that lets one
  octmux binary serve both the OpenCode v1 API (@opencode-ai/sdk, the local systemd server) and the
  OpenCode v2 API (@opencode/client ^2.0.28, for example the macOS desktop app 2.0.28). Written after
  Stage 15.3 (HEAD 56ddacf). The redesign was built in Stages 14, 15.1, 15.2a, 15.2 and 15.3.
  The code is the source of truth. This document was verified against src/backend/types.ts,
  src/backend/v1.ts, src/backend/v1-queries.ts, src/backend/v2.ts, src/backend/v2-events.ts,
  src/backend/v2-queries.ts, src/backend/v2-ancestry.ts, src/events.ts, src/replay.ts,
  src/resync-gate.ts, src/index.tsx, src/app.tsx, src/protocol-detect.ts, src/octmux-config.ts,
  src/auth-headers.ts, src/orchestra-watch.ts and src/command-registry.ts, and cross-read with
  docs/Stage14.md, docs/Stage15.md, docs/OpenCode-v2-protocol-capture.md and README.md
  "Configuration". The companion document docs/OpenCode-v2-decision-record.md records why the
  design decisions were taken; this document describes how the layer works.
---

# OpenCode v1/v2 adaptation layer

This document describes how octmux supports two incompatible OpenCode wire protocols with one
UI. It is written for an engineer who must understand, debug or extend the layer. The rationale
behind the decisions is in `docs/OpenCode-v2-decision-record.md`. The v2 wire shapes are in
`docs/OpenCode-v2-protocol-capture.md` (cited below as "capture doc §N"). The stage logs are in
`docs/Stage14.md` and `docs/Stage15.md`.

---

## 1. Overview and goals

### 1.1 One app, two protocols

| | OpenCode v1 | OpenCode v2 |
|---|---|---|
| Client library | `@opencode-ai/sdk` (`createOpencodeClient`) plus raw `fetch()` | `@opencode/client` (`OpenCode.make`), version pinned by `BUNDLED_OC_CLIENT_VERSION = "2.0.28"` in `src/protocol-detect.ts` |
| Typical server | local systemd user service at `http://127.0.0.1:4096` | the OpenCode 2.0.28 desktop app (MBP), possibly on another host |
| Routes | unprefixed (`/session`, `/permission`, `/question`, `/global/health`, `/global/event`) | `/api/...` (`/api/session`, `/api/event`, `/api/info`, ...) |
| Directory scoping | `x-opencode-directory` header, SDK `directory` option | `location` (`{ directory }`) or `directory` parameters on each route |
| Event stream | `{ type, properties }` events, no sequence numbers | `{ type, data, durable? }` frames, per-session durable `seq` |
| Backend class | `V1Backend` (`src/backend/v1.ts`) | `V2Backend` (`src/backend/v2.ts`) |

Both protocols are served by the same `App` component (`src/app.tsx`) through one interface,
`Backend` (`src/backend/types.ts`). That interface is "the seam".

### 1.2 Goals the layer meets

1. **One consumer, no protocol branches.** `src/app.tsx` holds no `if (v2)` test. It calls
   `props.backend.*` and reacts to `ReplEvent`s and `HistoryOp`s. `src/orchestra-watch.ts` and
   `src/utils/formatters.ts` also take a `Backend` and nothing protocol-specific.
2. **One place that picks the protocol.** `src/index.tsx` runs detection, sets
   `backendProtocol` to `"v1"` or `"v2"`, and constructs `V1Backend` or `V2Backend`. No other file
   imports a concrete backend for production use.
3. **v1 behaviour kept.** `V1Backend` is a thin forwarder that repeats the calls the REPL made
   before the seam existed (`src/backend/v1.ts` header comment). Stage 15.1 was verified as a pure
   move (A/B against the pre-refactor build, `docs/Stage15.md` Stage 15.1 log). Deliberate v1 output
   changes are listed in the `docs/Stage15.md` Stage 15.3 log ("Interrupted" on replay, gated abandon
   hint).
4. **v2 served natively.** No proxy and no compatibility server: `V2Backend` speaks the v2 wire
   protocol directly through `@opencode/client`, and `V2EventTranslator` reads v2 frames directly.

### 1.3 What "native" means here, precisely

Two statements are true at the same time, and an engineer must keep both in mind:

- **The wire is native v2.** Every v2 REST call goes through the `@opencode/client` SDK
  (`V2Backend`, no raw `fetch()`). Frames from `GET /api/event` are translated by a dedicated
  translator (`src/backend/v2-events.ts`). History is read from the v2 message list with v2 item
  types (`src/backend/v2-queries.ts`). Concepts that exist only in v2 — forms, durable `seq` with
  incremental resync, the compaction lifecycle, `session.model.selected`, retries, shell exit codes,
  session-level model binding — are first-class members of the contract.
- **The neutral vocabulary is v1-derived.** The seam was cut around the v1 call shapes first
  (Stage 15.1: "this interface is v1-derived", `src/backend/types.ts` header). Several outputs
  therefore keep v1 shapes, and `V2Backend` adapts to them:
  - `ReplEvent` (`src/events.ts`) is the v1 event vocabulary, extended with v2-only kinds.
  - `ProviderCatalog` is the v1 `provider.list()` shape; `toProviderCatalog` builds it from v2
    `model.list()`.
  - `listPermissions()` returns a `Response` whose JSON is the v1 `GET /permission` item shape;
    `toV1PermissionShape` builds it.
  - `listQuestions` / `replyQuestion` / `rejectQuestion` return `Response`s (v1 raw-fetch shape);
    on v2 they are inert stubs, because v2 questions are forms.
  - `subscribeEvents()` yields `{ payload }` items (the v1 `global.event` wrapper); `wrapFrames`
    wraps each v2 frame that way.
  - `listCommands()` returns v1 `Command` objects; v2 entries get `template: ""`.

  In the other direction, v1 is "the adapted side" for every member that v2 introduced:
  `V1Backend` implements `setModel`, `listForms`, `replyForm`, `cancelForm`, `isSessionActive` and
  `getMissedHistory` as no-ops, and `filterEvent` never emits the v2-only `ReplEvent` kinds.

So: v2 is native on the wire and in the feature set; the neutral data shapes are v1-shaped; and
each backend fills the members the other protocol introduced with a documented no-op or stub.

---

## 2. Layer diagram

```
 ~/.config/octmux/octmux.json  (or --config <path>)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ CONFIG + AUTH   src/octmux-config.ts  loadOctmuxConfig                     │
 │   keys: server.url, server.password, server.directory ($schema ignored)    │
 │   {env:NAME} / {file:PATH} substitution, 0600 checks, absolute directory   │
 │ src/auth-headers.ts  setAuthPassword → getAuthHeaders                      │
 │   Authorization: Basic base64("opencode:" + password), process-wide        │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ DETECTION   src/protocol-detect.ts  detectProtocol (skipped by --auto-spawn)│
 │   1. GET /api/info      JSON 200 + version → v2-authorized                 │
 │                         JSON 401 UnauthorizedError → v2-unauthorized       │
 │   2. GET /global/health JSON 200 → v1;  any 401 → v1-unauthorized           │
 │   3. otherwise unreachable                                                 │
 │   v2: compareVersions(server, "2.0.28") → refuse on MAJOR mismatch          │
 │   v1: loud "⚠ … falling back to the v1 API" warning                         │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 ▼  backendProtocol = "v1" | "v2"
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ CONSTRUCTION   src/index.tsx                                               │
 │   serverDirectory = config server.directory ?? process.cwd()               │
 │   bootstrapBackend(serverDirectory) → --resume / --resume-last / --fork /  │
 │                                       default create                        │
 │   effectiveServerDirectory = resolved session's directory, if different    │
 │   backend(effectiveServerDirectory) → backend.subscribeEvents() → <App>    │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ BACKEND INTERFACE   src/backend/types.ts                                   │
 │   session.*  get list create fork update abort compact sendPrompt          │
 │              sendCommand setModel                                          │
 │   flat ops   listCommands getDefaultModelConfig listProviders              │
 │              listQuestions replyQuestion rejectQuestion listPermissions    │
 │              replyPermission listForms replyForm cancelForm                │
 │              isSessionDescendant isSessionActive subscribeEvents           │
 │   events.*   translateEvent getHistory getMissedHistory getTokenUsage      │
 │              hasPendingToolCalls getLatestAssistantActivity resetEventState│
 │              synthesizeSessionIdleEvents hasOpenStreamingPart              │
 │              recordOwnMessageID recordOwnCommandPrefix classifyUserTurn    │
 └──────────────┬────────────────────────────────────────┬──────────────────┘
                ▼                                        ▼
 ┌─────────────────────────────────┐   ┌─────────────────────────────────────┐
 │ V1Backend  src/backend/v1.ts    │   │ V2Backend  src/backend/v2.ts        │
 │  v1 SDK client + raw fetch      │   │  @opencode/client, attempt()/write()│
 │  filterEvent  src/events.ts     │   │  V2EventTranslator v2-events.ts     │
 │   (module-level state)          │   │   (one instance per backend)        │
 │  fetchHistory/translateHistory  │   │  translateHistoryV2 / Missed        │
 │   src/replay.ts                 │   │   v2-queries.ts                     │
 │  v1-queries.ts scans            │   │  v2-queries.ts scans                │
 │  utils/session-ancestry.ts      │   │  v2-ancestry.ts                     │
 └──────────────┬──────────────────┘   └──────────────┬──────────────────────┘
                └───────────────┬─────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ PROTOCOL-NEUTRAL OUTPUTS                                                   │
 │   ReplEvent stream (src/events.ts)   HistoryOp[] (src/replay.ts)           │
 │   SessionRecord   TokenUsageSummary   LatestAssistantActivity              │
 │   ProviderCatalog   BackendForm   v1-shaped permission/question JSON       │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ APP STATE MACHINE   src/app.tsx                                            │
 │   SSE loop + reconnect, applyReplEvents, runReplay/applyHistory,           │
 │   reconciler (3 s), discovery pass (5 s), resync runner (ResyncGate),      │
 │   handleSubmit (prompts, commands, local slash commands), modals           │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ RENDERERS   src/renderer/                                                  │
 │   block-buffer.ts (BlockBufferRenderer)  tmux-window.ts (TmuxWindowRenderer)│
 │   stdout.ts                                                                │
 └──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Config and auth

- `loadOctmuxConfig(explicitPath?)` (`src/octmux-config.ts`) reads `~/.config/octmux/octmux.json`,
  or the file named by `--config`. A missing default file returns `null`; a missing explicit file
  throws. Unknown keys fail (`parseAndValidate`, `ALLOWED_SERVER_KEYS = ["url", "password", "directory"]`).
- `substituteTokens` expands `{env:NAME}` (unset or empty is an error) and `{file:PATH}` (trimmed
  file contents; `~/` expands; relative paths resolve against the config file's directory).
- `checkPasswordPermissions` runs before any secret is read. Literal password text requires the
  config file to have no group/other bits; each `{file:}` secret must have none either. An empty
  resolved password is an error.
- `server.directory` must be absolute after substitution (`isAbsoluteServerPath`: `/…` or a drive
  letter). It is not stat-ed, because it names a path on the server's host.
- `setAuthPassword(password)` (`src/auth-headers.ts`) runs once in `src/index.tsx`, before any client
  is built. `getAuthHeaders()` returns `{ Authorization: "Basic …" }` or `{}`. Every request uses it:
  both SDK clients, the probes, `V1Backend`'s raw `fetch()` calls, `utils/session-ancestry.ts`, and
  `OpenCode.make({ baseUrl, headers: getAuthHeaders() })` in `V2Backend`'s constructor default. The
  password is never printed; URLs in messages go through `redactUrl`.

### 2.2 Detection, version gate, loud fallback

`detectProtocol(baseUrl)` (`src/protocol-detect.ts`) runs unless `--auto-spawn` is given. Each
probe has a 3000 ms timeout. Classification is JSON-strict (`classifyInfoResponse`,
`classifyHealthResponse`) because both server generations answer unknown paths with
`200 text/html`. On `v2-authorized` the version is read through the SDK (`server.info()`), not from
the probe body. A network error on the first probe ends detection immediately.

`src/index.tsx` then acts on the result:

| Result | Behaviour |
|---|---|
| `v1` | `console.warn("⚠ octmux: OpenCode v1 server detected at … — falling back to the v1 API …")`, continue on v1 |
| `v1-unauthorized` / `v2-unauthorized` | exit 1, naming `server.password` and the config path (never the value) |
| `v2-authorized` | `compareVersions(version, BUNDLED_OC_CLIENT_VERSION)`: `major-mismatch` exits 1; `server-newer-minor` prints a line on stderr and continues; `server-older-minor` and `unparseable` warn and continue; `exact` prints nothing. Then `backendProtocol = "v2"` |
| `unreachable` | exit 1 with the "no opencode server" hint, or the short `health: failed` form for `--endpoint` |

`compareVersions` compares MAJOR and MINOR only; PATCH is ignored.

### 2.3 Backend construction: bootstrap and effective backends

```
serverDirectory           = config.server.directory ?? process.cwd()
bootstrapClient (v1 only) = createOpencodeClient({ baseUrl, directory: serverDirectory, headers })
bootstrapBackend          = V1Backend(bootstrapClient, baseUrl, serverDirectory)
                          | V2Backend(baseUrl, serverDirectory, undefined, configHint)

session = --resume <id>   → bootstrapBackend.session.get(id)
        | --resume-last   → bootstrapBackend.session.list(), newest time.updated
        | --fork <id>     → bootstrapBackend.session.get(id), then .fork(id, { directory })
        | default         → bootstrapBackend.session.create({ directory: serverDirectory })

effectiveServerDirectory  = session.directory if it differs from serverDirectory, else serverDirectory
backend                   = V1Backend(client rebound to effectiveServerDirectory, …)
                          | V2Backend(baseUrl, effectiveServerDirectory, undefined, configHint)
eventStream               = await backend.subscribeEvents()
<App backend={backend} serverDirectory={serverDirectory} eventStream={eventStream.stream} …/>
```

- Two instances exist because the session's own directory is only known after the startup lookup.
  The comparison is with `serverDirectory`, a server-side path, never with the local cwd.
- `configHint` is the loaded config path (or `DEFAULT_CONFIG_HINT`, `~/.config/octmux/octmux.json`).
  `V2Backend` puts it into the `LocationNotFoundError` message.
- `App` receives `serverDirectory` (not the effective one). `/new` creates sessions there, and the
  status line project label is `deriveProjectName(props.serverDirectory)`.
- `--auto-spawn` spawns a local server (`spawnOpencodeServer`) and keeps `backendProtocol = "v1"`
  without detection.
- `server.directory` is refused together with `--worktree` or `--auto-spawn` (exit 2).
- A failed default `create` prints `octmux: could not create a session: <message>` and exits 1.

---

## 3. The Backend contract in detail

All members are declared in `src/backend/types.ts`. The doc comments there are normative; this
section summarises them and states what each implementation does.

### 3.1 Resolution and error conventions

| Kind of member | Success | Server error status | Transport failure |
|---|---|---|---|
| Read (`get`, `list`, `listForms`, `isSessionActive`, `fetchMessages`, `fetchChildren`) | the value | resolves `undefined` | rejects |
| Write (`create`, `fork`, `update`, `compact`, `sendPrompt`, `sendCommand`, `setModel`, `replyPermission`, `replyForm`, `cancelForm`) | `void` or the new `SessionRecord` | **v1** swallows (resolves the SDK's `data`, often `undefined`); **v2** rejects with a readable `Error` | rejects |
| `abort` | `{ interrupted }` | `{ interrupted: false }` in both | rejects |
| Data-only flat reads (`listCommands`, `getDefaultModelConfig`, `listProviders`) | `{ data }` | `{}` on v2; the SDK result on v1 | rejects |
| Raw-response flat ops (`listQuestions`, `listPermissions`, `rejectQuestion`, `replyQuestion`) | a `Response` | caller checks `r.ok` | rejects |

v2 error formatting (`formatWriteError` in `src/backend/v2.ts`):

- A declared typed error (an `Error` with `_tag`) → `"<_tag>: <message>"`.
- `LocationNotFoundError` → `"LocationNotFoundError: the OpenCode server has no directory <dir> — set server.directory in <configHint> to the server-side path"`.
- `ClientError` with reason `UnexpectedStatus` → `"OpenCode server returned HTTP <status>"`.
- Other SDK failures → `"OpenCode request failed (<reason>)"` or `"OpenCode request failed: <message>"`.
- Only `_tag`, `message` and status reach the text. Headers and bodies never do.

`attempt()` turns every non-transport SDK error into `{ ok: false }` for reads; `write()` rethrows
transport errors unchanged and formats the rest. Both wrap only the SDK call, never the mapping
after it, so a mapping bug is not disguised as an error status.

Consequence for callers: every write call site in `src/app.tsx` handles a rejection, either by
showing the message (`/new failed: …`, `/compact failed: …`, `[send error] …`, `[command error] …`)
or with an explicit `.catch(() => {})` (permission auto-replies, `abort`, `cancelForm`).

### 3.2 Flat arguments

Since Stage 15.2a the interface takes flat named arguments: `get(sessionID)`,
`compact(sessionID, model)`, `fork(sessionID, { directory? })`, `update(sessionID, { title })`,
`sendPrompt({ sessionID, text, promptID?, model? })`,
`sendCommand({ sessionID, name, args, promptID?, model? })`,
`replyPermission({ sessionID, permissionID, decision, message? })`. No SDK `{ path, query, body }`
object crosses the seam. `V1Backend` rebuilds the v1 SDK request internally; `V2Backend` builds the
v2 SDK input.

### 3.3 `SessionRecord`

```ts
type SessionRecord = {
  id: string;
  parentID?: string;          // absent for top-level sessions
  directory: string;          // server-side path
  title: string;
  time: { updated: number };
  model?: { providerID: string; id: string };
};
```

It lists only fields octmux reads. The v1 SDK `Session` satisfies it structurally (`model` is
present at runtime but missing from the SDK type, which is why it is declared here).
`toSessionRecord` (`src/backend/v2.ts`) maps a v2 `SessionInfo`: `location.directory` →
`directory`; `title ?? ""`; `model` reduced to `{ providerID, id }` (the v2 `variant` is dropped).

### 3.4 `session.*` members

| Member | v1 (`V1Backend`) | v2 (`V2Backend`) |
|---|---|---|
| `get` | `client.session.get` | `session.get({ sessionID })` → `toSessionRecord` |
| `list` | `client.session.list()` | `session.list({ directory: cwd, cursor? })`, all pages via `collectPages` |
| `create` | `client.session.create({ query: { directory } })` | `session.create({ location: { directory } })` |
| `fork` | `client.session.fork`, `query.directory` only when given | `session.fork({ sessionID })`; `directory` cannot be honoured, the fork keeps the parent's location |
| `update` | `client.session.update({ body: { title } })` | `session.update({ sessionID, title })` (no capture row; unverified against capture) |
| `abort` | `client.session.abort` → `{ interrupted: data === true }` | `session.interrupt` → `{ interrupted }`, `false` on error |
| `compact` | `client.session.summarize({ body: { providerID, modelID } })` | `session.compact({ sessionID })`; v2 takes no model |
| `sendPrompt` | `client.session.promptAsync` with `parts: [{ type: "text", text }]`, `messageID: promptID`, `model` when given | `ensureModel` when `model` is given, then `session.prompt({ sessionID, text, id: promptID })` |
| `sendCommand` | `client.session.command` with `command`, `arguments`, `messageID: promptID`, `model: "provider/model"` | `ensureModel` when `model` is given, then `session.command({ sessionID, name, text: args })`; `promptID` is dropped (no field); on any failure `translator.releaseCommandEcho()` then rethrow |
| `setModel` | no-op (v1 has no session-level model) | `ensureModel` → `session.switchModel` when the model differs from the cache |

`V1Backend.session` is typed `V1BackendSession`, which adds `getMessages` and `getChildren`. Those
two are deliberately **not** on the shared `BackendSession`: their only consumer is
`src/backend/v1-queries.ts`, which needs the v1 element types. `V2Backend` keeps the equivalents
(`fetchMessages`, `fetchChildren`) as public methods outside the seam.

`setModel` is part of the contract, but `src/app.tsx` does not call it. The model reaches v2 through
the `model` argument of `sendPrompt` and `sendCommand` (section 4.5).

### 3.5 Flat operations

| Member | v1 | v2 |
|---|---|---|
| `listCommands` | `client.command.list()` | `command.list({ location })`, mapped to `{ name, description?, template: "" }` |
| `getDefaultModelConfig` | `client.config.get()` (`data.model` = `"provider/model"`) | `model.default({ location })` reduced to `{ model: "providerID/id" }`; the rest of the payload (including `settings.apiKey`) is dropped |
| `listProviders` | `client.provider.list()` | `model.list({ location })` → `toProviderCatalog`; every returned provider is listed as connected |
| `listQuestions` | raw `GET /question` with `x-opencode-directory` | `200 []` (v2 has no question route) |
| `rejectQuestion` / `replyQuestion` | raw `POST /question/{id}/reject` / `/reply` | `204` no-op `Response` |
| `listPermissions` | raw `GET /permission` with `x-opencode-directory` | `permission.request.list({ location })` → `toV1PermissionShape`; error → `Response(status 500)` |
| `replyPermission` | `postSessionIdPermissionsPermissionId` with `body.response = decision`; `message` ignored | `permission.reply({ sessionID, requestID, decision, message? })` |
| `listForms` | `[]` | `session.form.list({ sessionID })` → `toBackendForm` |
| `replyForm` | no-op | `session.form.reply({ sessionID, formID, answer })` |
| `cancelForm` | no-op | `session.form.cancel({ sessionID, formID })` (no observed `form.cancelled` frame; capture doc §4.6) |
| `isSessionActive` | `undefined`, no request | `session.active()`; `true` when the map has the session, `false` when not, `undefined` on error |
| `isSessionDescendant` | `utils/session-ancestry.ts` (cached `GET /session` list, 5 s TTL, one-shot revalidation, depth 5) | `isSessionDescendantV2` (`src/backend/v2-ancestry.ts`): per-session `session.get` parent lookups, 5 s TTL cache per backend, depth 5, failures not cached |
| `subscribeEvents` | `client.global.event({})` | `{ stream: wrapFrames(client.event.subscribe()) }` |

`listProviders` carries a warning in `src/backend/types.ts`: it must never target the v2
`/api/provider` route, which returns plaintext API keys.

### 3.6 `events.*` members

| Member | Guarantee | v1 | v2 |
|---|---|---|---|
| `translateEvent(event, sessionID)` | one raw event → `null`, one `ReplEvent`, or an ordered list | `filterEvent` (`src/events.ts`) | `translateAndTrackModel` → `V2EventTranslator.translate`, plus model-cache tracking |
| `resetEventState()` | after it, no earlier state affects translation | clears the module-level sets/maps in `src/events.ts` | clears the translator instance |
| `synthesizeSessionIdleEvents()` | `session-idle` then one `block-end` per open block; clears the open set | module-level | instance |
| `hasOpenStreamingPart()` | a text or thinking block is open (tool blocks do not count) | yes | yes |
| `recordOwnMessageID(id)` | the user turn with this id is not re-rendered | `ownMessageIDs` | `ownPromptIDs` |
| `recordOwnCommandPrefix(prefix)` | the command's expanded echo is suppressed | prefix backstop only | prefix + one pending echo slot |
| `classifyUserTurn(messageID)` | debounced foreign-turn classification, idempotent | `classifyOneUserTurn` | always `[]` (v2 classifies inline) |
| `hasPendingToolCalls(sid)` | reconciler Layer 4 guard | any `pending`/`running` tool part in any message | a non-final tool item in the **latest** assistant message only |
| `getLatestAssistantActivity(sid)` | stall watchdog input (`LatestAssistantActivity`) | `queryLatestAssistantActivity` | `queryLatestAssistantActivityV2` |
| `getTokenUsage(sid)` | `TokenUsageSummary` or `null` | `queryTokenUsage` | `queryTokenUsageV2` |
| `getHistory(sid)` | `HistoryOp[]`, `[]` on error | `fetchHistory` → `translateHistory` | `fetchHistoryV2` → `translateHistoryV2`, and marks every returned id rendered |
| `getMissedHistory(sid)` | ops for complete, not-yet-rendered messages | `[]` | `fetchMissedHistoryV2` → `translateMissedHistoryV2` |

State scope differs: v1 translator state is module-level in `src/events.ts` (one per process);
v2 translator state lives on the `V2EventTranslator` instance held by each `V2Backend`, so the
bootstrap and effective backends share nothing.

### 3.7 `ReplEvent` kinds and which side emits them

`ReplEvent` is defined in `src/events.ts` and re-exported from `src/backend/types.ts`.

| Kind | v1 `filterEvent` | v2 translator |
|---|---|---|
| `block-start`, `block-delta`, `block-end` | yes | yes (`block-end.exitCode` is v2-only) |
| `session-idle`, `generating`, `error`, `parent-turn-end`, `message-completed` | yes | yes |
| `permission-asked` (`resources`) | yes, `resources = [title]` | yes, `resources` from `data.resources` |
| `subagent-detected`, `subagent-ended`, `subagent-activity` | yes | yes |
| `foreign-user-turn` | yes (via classification) | yes (inline) |
| `foreign-user-part` | yes (debounce arm) | never |
| `session-status`, `part-removed`, `block-retag`, `compaction-divider`, `session-compacted` | yes | never |
| `question-asked`, `question-replied`, `question-rejected`, `question-tool-detected` | yes | never |
| `model-switched` (v1 `session.next.model.switched`) | yes | never |
| `form-asked`, `form-replied` | never | yes |
| `turn-retry` | never | yes |
| `compaction-started`, `compaction-progress`, `compaction-ended`, `compaction-failed` | never | yes |
| `model-selected` | never | yes |
| `resync-needed` | never | yes |

`app.tsx` handles every kind in `applyReplEvents`. Kinds a backend never emits are inert on that
protocol; no protocol check is needed. `app.tsx` also builds `form-asked` itself in the discovery
pass (section 4.6).

---

## 4. Data flows, side by side

### 4.1 Startup and session create / resume / fork

| Step | v1 | v2 |
|---|---|---|
| Probe | `/api/info` inconclusive (HTML), `/global/health` JSON 200 | `/api/info` JSON 200, then `server.info()` for the version |
| Bootstrap | `createOpencodeClient({ baseUrl, directory: serverDirectory })` | `new V2Backend(baseUrl, serverDirectory)` (client built inside) |
| `--resume` | `GET /session/{id}` | `GET /api/session/{id}` |
| `--resume-last` | `GET /session` (directory-scoped by the client), sorted by `time.updated` | `GET /api/session?directory=…`, cursor-paged, sorted by `time.updated` |
| `--fork` | `POST /session/{id}/fork` with `query.directory` | `session.fork({ sessionID })`; the child keeps the parent's location |
| default | `POST /session?directory=…` | `POST /api/session` `{ location: { directory } }`; a `LocationNotFoundError` becomes a readable exit-1 message |
| Mount (`app.tsx` one-shot effect) | `session.get` → `activeModel` from `model`, else `getDefaultModel`; `refreshTokenUsage`; `runReplay` | same calls, v2 implementations |

`/new` (`parseNewCommand` branch) calls `backend.session.create({ directory: props.serverDirectory })`
then `switchSession`. `/fork` calls `backend.session.fork(sessionID)` with no directory.
`/sessions` lists with `backend.session.list()`. `/rename` calls `backend.session.update`.

`switchSession` (`src/app.tsx`) aborts a running turn, calls `backend.events.resetEventState()`,
resets the retry counter and the user-turn debouncer, calls `renderer.clearAll()`, then sets the new
session id. The mount effect re-runs for the new id and replays its history.

### 4.2 Live event stream

```
backend.subscribeEvents() ──► for await (item of stream)
      │                          lastSseEventTime = now; sseHealth = "ok"
      │                          evRaw = backend.events.translateEvent(item.payload, sessionIDRef)
      │                          ├─ evRaw   → applyReplEvents(list)
      │                          └─ null and payload is a v1-shaped permission.asked /
      │                             permission.updated / question.asked for another session
      │                             → isSessionDescendant → re-translate with that session id
      └─ stream throws/ends ──► sseHealth = "reconnecting", backoff 1 s … 30 s,
                               backend.subscribeEvents() again, reconciler pass, onRedraw()
```

The descendant re-translation reads `payload.properties.sessionID`. v2 frames carry `data`, not
`properties`, so this path never runs on v2; v2 handles child asks inside the translator (4.6).

#### Subscription

- v1: `GET /global/event`. Items are `{ directory?, payload: Event }`.
- v2: `GET /api/event`, a global, unfiltered stream (capture doc §2c, §4.10). `wrapFrames` yields
  `{ payload: frame }`. Frames for other sessions and directories arrive and are discarded by
  attribution.

#### Translation

v1 `filterEvent` (`src/events.ts`), main branches:

| v1 event | ReplEvents |
|---|---|
| `message.updated` (user) | records the id in `userMessageIDs` |
| `message.updated` (assistant) | classified foreign turns first; `block-retag` for a `summary === true` message; `parent-turn-end` (`aborted` for `MessageAbortedError`, else `error`) when `info.error`; `message-completed` once per message on `time.completed`; `generating` once per message otherwise |
| `message.part.delta` | `block-delta` for an open part; `subagent-activity` for a tracked child |
| `message.part.updated` text/reasoning/tool | `block-start` (+`generating` for text); text start closes open thinking blocks; tool lifecycle → `block-end ok/error` and a `-result` block; `task` tool pairing → `subagent-ended`; `question` tool → `question-tool-detected`; user text parts → `foreign-user-part` |
| `message.part.updated` compaction | `compaction-divider`, once per part |
| `session.created` (parentID = ours) | `subagent-detected` |
| `session.deleted` / `session.updated` | `subagent-ended` / `subagent-activity` for children |
| `session.compacted` | `session-compacted` |
| `session.next.model.switched` | `model-switched` |
| `session.idle` | classified foreign turns, `parent-turn-end idle`, `session-idle`, `block-end` per open part |
| `session.error` | `parent-turn-end error`, `error` |
| `session.status` | `session-status` |
| `message.part.removed` | `part-removed`, `block-end` |
| `permission.updated` / `permission.asked` | `permission-asked` with `resources = [title]` |
| `question.asked` / `.replied` / `.rejected` | `question-*` |

v2 `V2EventTranslator.translate` routing (`src/backend/v2-events.ts`):

1. A v1-shaped discovery input `{ type: "permission.asked", properties }` → `permissionAsked`, only
   for the passed session id.
2. `parseFrame` reads `{ type, data, durable.seq }`; a non-envelope returns `null`.
3. `session.created` → `childCreated` (its `data.sessionID` is the child).
4. `shell.exited` / `shell.deleted` → bookkeeping only.
5. `attributedSessionID` (capture doc §2c): `shell.created` → `data.info.metadata.sessionID`;
   `form.created` → `data.form.sessionID`; others → `data.sessionID`.
6. Another session → `childFrame` (tracked children only; otherwise `null`).
7. The REPL's session → `checkSeq` (duplicate dropped; gap → close open blocks + `resync-needed`),
   then `dispatch`.

`dispatch` mapping:

| v2 frame | ReplEvents |
|---|---|
| `session.execution.started` | `generating` |
| `session.execution.succeeded` | `parent-turn-end idle`, `session-idle`, `block-end` per open block of the session |
| `session.execution.interrupted` | `parent-turn-end aborted`, `session-idle`, block ends |
| `session.execution.failed` | `parent-turn-end error`, `error`, `session-idle`, block ends |
| `session.retry.scheduled` | `turn-retry` |
| `session.step.ended` | `message-completed` once per assistant message |
| `session.text.started` / `.delta` / `.ended` | `block-start` text (+`generating`) / `block-delta` / `block-end` |
| `session.reasoning.*` | same with role `thinking`; text start does **not** close reasoning |
| `session.tool.input.started` | `block-start` tool-call (`toolName` from this frame) |
| `session.tool.success` | `block-end ok` (+`exitCode` for non-zero `metadata.exit`), `-result` block when output text is non-empty; ends a `subagent` child |
| `session.tool.failed` | `block-end error`; ends a `subagent` child |
| `session.tool.progress` | links shell and subagent child; nothing shown |
| `session.inbox.enqueued` / `.delivered` | `userInboxItem` → `foreign-user-turn` or suppressed |
| `permission.asked` | `permission-asked` (`title = "action: res1, res2"`) |
| `form.created` / `form.replied` / `form.cancelled` | `form-asked` / `form-replied` / `form-replied` with `{}` |
| `session.compaction.started` / `.delta` / `.ended` / `.failed` | `compaction-started` / `compaction-progress` / `compaction-ended` / `compaction-failed` |
| `session.model.selected` | `model-selected` |
| `session.step.started`, `.streamed`, `.failed`, `session.usage.updated`, `session.tool.input.ended`, `session.tool.called`, `session.instructions.updated`, `session.shell.*`, `permission.replied`, `shell.created` | `null` (some update bookkeeping) |
| anything else | `null`; type name logged under `OCTMUX_DEBUG_SSE=1` |

`session.step.failed` is deliberately silent: the following terminal frame carries the same error,
and an interrupt's aborted step is not an error.

#### Block keys

- v1 uses the server part id as `partID`.
- v2 stream ordinals are per kind, so text and reasoning of one message can share ordinal 0 and
  overlap (capture doc §4.1, §4.2). The translator allocates a content index per assistant message
  in start order (`allocateContentPartID`) and keys text/reasoning blocks
  `${assistantMessageID}:${index}`. Tool blocks use the call `id`; results use `${callID}-result`.
  `translateHistoryV2` gives a stored content item at index *i* the same key, so live and replayed
  blocks share ids as long as stored order equals start order.

#### Own-echo suppression

Every prompt is minted a client id by `mintUserMessageID()` (`src/message-id.ts`) and recorded with
`recordOwnMessageID` before the send. The text is rendered locally with `renderer.commitUserInput`.

| | v1 | v2 |
|---|---|---|
| Prompt | `messageID: ownID` in the body; user `message.updated` id matches `ownMessageIDs`; `classifyOneUserTurn` suppresses | `id: ownID` in the body; the server echoes it as `inboxID` (capture doc §5, client-supplied id); `claimUserItem` step 1 suppresses |
| Command | `messageID: ownID` is sent too, so the id match suppresses; the `"# /" + name` prefix is a backstop | the POST takes no id and returns none. `recordOwnCommandPrefix` arms one **echo slot**. The next user item that is neither an own prompt nor already rendered takes the slot, whatever its text (a template need not start with `# /name`). The prefix is a backstop when no slot is pending |
| Failed command | nothing to release | `V2Backend.sendCommand` calls `releaseCommandEcho()` and rethrows |
| Foreign turn | user text parts accumulate → `foreign-user-part` arms `UserTurnDebouncer` → `classifyUserTurn` or the turn boundary emits `foreign-user-turn` | the whole text arrives in one inbox frame; an unclaimed item emits `foreign-user-turn` at its first arrival (`enqueued`) and is recorded so `delivered` is suppressed |

`claimUserItem(messageID, text)` order: own prompt → already rendered → pending slot (consume,
record) → prefix match (record) → not claimed. The live inbox path and the resync path both use it.

#### Turn end

- v1: `session.idle` for the REPL's session ends the turn; a `session.idle` from a tracked child is
  ignored (children idle repeatedly inside one task).
- v2: there is no `session.idle`. `session.execution.succeeded`, `.interrupted` and `.failed` each
  produce `session-idle` through `turnEnd`, in the v1 order (head events, `session-idle`, block
  ends).

In `app.tsx`, `session-idle` and `parent-turn-end` reset the generating state, `message-completed`
refreshes the usage figures, and the reconciler (every 3 s while `sseHealth !== "ok"`, guarded by
recency, `hasOpenStreamingPart` and `hasPendingToolCalls`) can synthesise `session-idle` when the
real terminal event was missed.

### 4.3 History replay

```
backend.events.getHistory(sid) ──► HistoryOp[] ──► applyHistory(renderer, editor, ops)
   v1: fetchHistory(client, sid) → translateHistory(messages)          (src/replay.ts)
   v2: fetchHistoryV2(fetchMessages, sid, markRendered) → translateHistoryV2 (v2-queries.ts)
```

`HistoryOp` (`src/replay.ts`): `user-input`, `system-message`, `block` (with `meta.toolName`,
`status`, optional `exitCode`), `compaction-divider`, `turn-end`, `seed-history`. `applyHistory`
is the only code that drives the renderer and editor for history; it calls `beginBlock` /
`endBlock` with two arguments unless `meta` / `exitCode` is present, preserving the v1 call shapes.

| Rule | v1 `translateHistory` | v2 `translateHistoryV2` |
|---|---|---|
| User text | text parts, excluding `synthetic` / `ignored`, joined with `\n` | the item's `text` field |
| Assistant content | text → `text`; reasoning → `thinking`; tool completed → call + result; tool error → call `error`; others skipped | same per `content` item, keyed `${id}:${index}`; completed shell tool with non-zero `metadata.exit` sets `exitCode` |
| Turn end | one `turn-end` per rendered assistant message | same |
| Summary boundary | first assistant message with `summary === true` | first `compaction` item with `status: "completed"` |
| Collapse | pre-boundary assistant messages hidden; `"[N earlier message(s) summarized — see compacted summary below]"` | same wording; pre-boundary idle items hidden too |
| Boundary render | summary text parts as role `summary`, compaction parts as dividers, `turn-end` | `${id}:summary` block role `summary`, `compaction-divider` (`auto` when `reason === "auto"`), `turn-end`; later completed compactions render as role `text` |
| "Interrupted" marker | `system-message "Interrupted"` after the `turn-end` of a message whose error is `MessageAbortedError` | after an `idle` item whose `outcome` is `interrupted` |
| Editor seed | `seed-history` last, only when translation completed | same |
| Errors | ops so far, no seed | same |

v2 additionally records every fetched message id as rendered (`markRendered`), so a later
`getMissedHistory` does not render it again (the D-A fix, `docs/Stage15.md` Stage 15.2 log).

### 4.4 Reconnect and resync

There are two distinct recovery mechanisms.

**Transport reconnect (both protocols).** When the stream ends or throws, the SSE loop in
`src/app.tsx` waits (1 s doubling to 30 s), calls `backend.subscribeEvents()` again, runs one
reconciler pass and calls `onRedraw`. v2 sends no SSE `id:` and replays nothing after a reconnect
(capture doc §4.11), so missed frames show up later as a durable `seq` gap.

**Durable-seq resync (v2 only).**

```
V2EventTranslator.checkSeq(sid, seq)
  first seq            → accept as start
  seq <= last          → "duplicate" → frame dropped
  seq == last + 1      → ok
  seq >  last + 1      → "gap": closeOpenParts(sid) block-ends + { kind: "resync-needed" }
                         (the gapped frame itself is dropped)
          │
          ▼
app.tsx applyReplEvents → runResyncRef → ResyncGate.request()
          │      (one run in flight; a request during a run queues exactly one re-run)
          ▼
resyncOnce():
  1. ops = backend.events.getMissedHistory(sid)          (dropped if the session changed)
     applyHistory(renderer, editor, ops)                  — nothing is cleared
  2. active = backend.isSessionActive(sid)                (undefined on failure)
  3. if shouldEndCompacting(ops, active) → setIsCompacting(false)
     decideResync(isGenerating, active):
       "end-turn"   → applyReplEvents([parent-turn-end idle, ...synthesizeSessionIdleEvents()])
       "start-turn" → setIsGenerating(true)
       "none"       → nothing
  4. refreshTokenUsage(sid); runDiscoveryPass()
```

- `getMissedHistory` (`V2Backend.events`) calls `fetchMissedHistoryV2` with a predicate: user items
  go through `translator.claimUserItem` (so a command echo seen only via resync consumes its slot);
  other items use the side-effect-free `isRendered`. The selected ids are then `markRendered`.
- `translateMissedHistoryV2` selects items that are complete (`isCompleteRenderable`: any user item;
  an assistant message with `time.completed`, a `finish`, an `error`, or a later `idle` item; a
  `completed` compaction) and not yet rendered. It renders them through `translateHistoryV2` with an
  `include` filter, so the summary boundary and collapse count are computed from the whole list.
- The live translator marks an assistant message rendered as soon as a block of it opens
  (`startStreamPart`, `startTool`), and foreign inbox ids when emitted.
- **Why incremental, never clear-and-replay.** In `--single` mode lines already printed to the
  terminal cannot be erased. A clear plus full replay prints earlier turns a second time (defect D-A,
  `docs/Stage15.md` Stage 15.2 log).
- **The compaction seq hole.** The server skips one durable `seq` between
  `session.compaction.started` (N) and `session.compaction.ended` (N+2) (capture 3b 83 → 85; seen
  live 46 → 48). The `ended` frame therefore arrives as a gap and is dropped. The resync renders the
  completed compaction item from REST (summarized line, summary block, divider), and
  `shouldEndCompacting` clears the compacting flag when the missed ops contain a
  `compaction-divider` or REST reports the session inactive.
- **The auto-title gap.** A benign gap (for example an auto-title rename after a skipped seq) finds
  nothing missing and renders nothing.
- Child frames never go through `checkSeq`: their seq belongs to the child aggregate, and nothing of
  the child is rendered in the parent.
- v1 has no durable seq, never emits `resync-needed`, and `V1Backend.getMissedHistory` /
  `isSessionActive` are inert. `/resync` and Ctrl-R (`handleResync`) run the reconciler pass and a
  usage refresh on both protocols; they do not invoke the v2 resync runner.

### 4.5 Prompts, commands and models

`handleSubmit` (`src/app.tsx`) order: local slash commands (`/exit`, `/new`, `/compact`,
`/sessions`, `/fork`, `/resync`, `/rename`, `/model`, `/help`, `/show`, `/<key>-output`), then a
`/name` that is in `opencodeCommands` (filled from `backend.listCommands()`), then a plain prompt.

**Prompt.** Queue if generating; else mint and record the own id, render the text, set generating,
validate `activeModel` with `validateModel` (falls back to `getDefaultModel` with a system line),
then `backend.session.sendPrompt({ sessionID, text, promptID, model: activeModel })`. A rejection
prints `[send error] <message>` and clears generating.

**Command.** Render the line, mint and record an own id, warn when the model has `tool_call === false`
(`getToolCallSupport`), validate the model, `recordOwnCommandPrefix("# /" + name)`, set
generating, then `backend.session.sendCommand({ sessionID, name, args, promptID, model })`.

**Model.**

| | v1 | v2 |
|---|---|---|
| Catalog | `provider.list()` | `model.list()` keyed by `ModelInfo.id` (never `ModelInfo.modelID`, the upstream API name, which two models can share) |
| Default | `config.get().data.model` | `model.default()` → `"providerID/id"` |
| `/model` picker or `/model p/m` | sets `activeModel` (local state) only | same |
| Next prompt / command | the model travels in the request body (per-prompt override) | `ensureModel` sends `switchModel({ model: { id, providerID } })` only when it differs from `lastModelBySession`; the server binds it to the session |
| Change made elsewhere | `session.next.model.switched` → `model-switched` | `session.model.selected` → `model-selected`; `translateAndTrackModel` writes it into `lastModelBySession`, so a later own reselect of the old model does send `switchModel` |
| App reaction | `adoptSessionModel` when the session matches | compare with `activeModelRef.current`; equal → nothing (covers octmux's own switch); different → `adoptSessionModel` |

`adoptSessionModel` validates the model with `validateModel` and either sets `activeModel` or prints
`session model switched to … (not available here — keeping …)`.

**The `activeModelRef` rule.** `applyReplEvents` is a `useCallback` whose dependency list does not
include `activeModel`. Any comparison against the current model inside it must read
`activeModelRef.current` (mirrored from state in an effect), never the `activeModel` closure value,
which would be stale.

### 4.6 Permissions, questions and forms

**Live path.**

| | v1 | v2 |
|---|---|---|
| Permission ask | `permission.updated` / `permission.asked` (`properties.permission`, `patterns`) → `permission-asked` with `resources = [title]` | `permission.asked` (`data.action`, `data.resources[]`) → `permission-asked`, title `"action: r1, r2"` |
| Child's ask | `null` from `filterEvent`, then the app's descendant walk re-translates with the child id | `childFrame` → `childPrompt` returns `subagent-activity` plus `permission-asked` carrying the child id (direct children only) |
| Reply | `postSessionIdPermissionsPermissionId` `{ response }` | `permission.reply` `{ decision, message? }` |
| Questions | `question.asked` → `question-asked` modal; `replyQuestion` / `rejectQuestion` raw routes | none; questions are forms |
| Forms | none | `form.created` → `form-asked`; `form.replied` / `form.cancelled` → `form-replied` |

In `app.tsx`, `permission-asked` opens the modal in `ask` mode, or auto-replies `always` / `reject`
in the `allow` / `deny` modes. `form-asked` opens `FormModal` (one field at a time) unless a form is
already open or the id is in `formDoneIDsRef`. Submit calls `replyForm`; Esc and Ctrl-C call
`cancelForm`. `form-replied` marks the form done and closes it if it is on screen, printing
`▶ Form answered elsewhere: <title>`.

**Discovery pass** (`runDiscoveryPassRef`, on mount and every 5 s, and at the end of each resync):

1. Questions: `listQuestions()` → filter to the current session or its descendants
   (`isSessionDescendant`) → oldest by id → re-translated as a v1-shaped `question.asked`. On v2 the
   list is always empty.
2. Permissions: `listPermissions()` → same filter → oldest → `translateEvent({ type:
   "permission.asked", properties: { id, sessionID, permission, patterns } }, oldest.sessionID)`.
   v1 `filterEvent` and the v2 `discoveredPermission` reader both accept that shape. On v2 the list
   is the location-scoped `GET /api/permission/request?location[directory]=…` reshaped by
   `toV1PermissionShape`, so asks of children and grandchildren in the same directory are found.
3. Forms: `listForms(currentSession)` → oldest not-done → `form-asked` built directly in `app.tsx`.
   On v1 the list is empty.

The descendant walk is what lets a grandchild's permission reach the parent modal on v2, since the
live translator tracks direct children only.

### 4.7 Subagents and orchestra events

| | v1 | v2 |
|---|---|---|
| Child detected | `session.created` with `parentID` = ours | same frame; `data.sessionID` is the child, `data.parentID` the parent |
| Parent call | `task` tool part | `subagent` tool call (`session.tool.input.started` with `name: "subagent"`) |
| Pairing | `state.metadata.sessionId` first, FIFO `tryPair` fallback (`openTaskPartIDs` × `unpairedChildren`) | `session.tool.progress` `metadata.sessionID` first; else the first unpaired call whose description (from `session.tool.called` `input.description`) equals the child's `title` |
| `subagent-detected` payload | `agent`, `model` (`provider/id`), `description` | same; `model` is `""` when the frame omits it |
| Activity | child deltas, `session.updated` | any other frame of a tracked child |
| End | parent `task` part completes or errors; `session.deleted` | the child's own terminal `session.execution.*`, or the parent `subagent` call's success/failure (also reads `metadata.sessionID` from the result) |
| Child text | never rendered in the parent | never rendered in the parent |

`applyReplEvents` forwards these to `OrchestraWatcher` (`notifySubagentStarted`,
`notifySubagentEnded`, `notifySubagentActivity`), which draws the subagent rows below the status
line. `parent-turn-end` sweeps orphaned rows. The orchestra badge itself is host-local (section 7).

The stall watchdog reads `getLatestAssistantActivity`. v2 searches the newest assistant message for
a running `subagent` call with `metadata.sessionID` from the end of the content list (v1 checks only
the last part) and judges the child stale after `CHILD_STALL_THRESHOLD_MS` (180 s), using message
and item timestamps because v2 text items carry no time.

### 4.8 Cost and token usage

`refreshTokenUsage(sid)` (`src/app.tsx`) calls `backend.events.getTokenUsage(sid)` on mount, on
session switch, on `message-completed` and `session-idle`, after compaction, after resync and on `/resync`. A `null`
result keeps the known context window and shows `0` used. Otherwise the context window comes from
`getContextWindow(backend, providerID, modelID)` and the running cost from `usage.runningCost`.

| | v1 `queryTokenUsage` | v2 `queryTokenUsageV2` |
|---|---|---|
| Boundary | last assistant message with `summary === true` | last `completed` compaction item |
| `used` | newest post-boundary non-summary assistant's tokens; zero falls back to the most recent non-zero one | newest post-boundary assistant: `input + cache.read + cache.write`; zero falls back likewise; `tokens: null` (failed step) → `null` |
| Model | from that newest assistant | `latest.model.providerID`, `latest.model.id` |
| Cost | `addAssistantCost` over the session's assistant messages | `addAssistantCostV2`; compaction items are not counted (v1 counts its summary assistant) |
| Child roll-up | `getChildren(sid)` then each child's messages, one level deep, failures skipped | `fetchChildren(sid)` (`session.list({ parentID })`), same rules |

### 4.9 Compaction

| | v1 | v2 |
|---|---|---|
| Trigger | `/compact` → `setIsCompacting(true)` → `session.summarize({ providerID, modelID })` | same app path → `session.compact({ sessionID })` (no model; `/compact` still requires an `activeModel` on both) |
| Live start | — | `compaction-started` → `isCompacting = true`, remembers `reason === "auto"` |
| Live progress | summary text streams as a normal assistant message; `block-retag` → `summary` | `compaction-progress` deliberately not rendered |
| Live end | compaction part → `compaction-divider`; `session.compacted` → `session-compacted` clears compacting and generating | `compaction-ended` → divider, then a `compaction-summary-<n>` summary block, refresh usage; does not end the turn (the turn ends with `execution.succeeded`) |
| Failure | — | `compaction-failed` → clears compacting, prints an error line |
| Seq hole | — | `ended` is dropped as a gap; resync renders the stored compaction and `shouldEndCompacting` clears the flag |
| Replay | section 4.3 | section 4.3 |

---

## 5. Protocol mapping table (v1 ↔ v2 → neutral concept)

| Neutral concept (seam member / output) | v1 wire | v2 wire |
|---|---|---|
| Health / info (detection) | `GET /global/health` → JSON `{healthy, version}` | `GET /api/info` → JSON `{version}`; `server.info()` |
| Event stream (`subscribeEvents`) | `GET /global/event`, items `{ directory, payload: { type, properties } }` | `GET /api/event`, frames `{ id, created, type, location?, data, durable? }`, wrapped as `{ payload }` |
| Session list (`session.list`) | `GET /session` (directory from client) | `GET /api/session?directory=…`, cursor-paged |
| Session children (v1 `getChildren` / v2 `fetchChildren`) | `GET /session/{id}/children` | `GET /api/session?parentID=…`, cursor-paged |
| Session get (`session.get`) | `GET /session/{id}` | `GET /api/session/{id}` |
| Session create (`session.create`) | `POST /session?directory=…` | `POST /api/session` `{ location: { directory } }` |
| Session fork (`session.fork`) | `POST /session/{id}/fork` (`query.directory` optional) | SDK `session.fork({ sessionID })`, no directory |
| Session rename (`session.update`) | `PATCH /session/{id}` `{ title }` (SDK `session.update`) | SDK `session.update({ sessionID, title })` |
| Session delete | not used by octmux | not used by octmux (`DELETE /api/session/{id}` exists, capture doc §5) |
| Prompt (`sendPrompt`) | `POST /session/{id}/prompt_async` (SDK `promptAsync`) `{ parts, messageID, model? }` | `POST /api/session/{id}/prompt` `{ text, id? }` |
| Command (`sendCommand`) | `POST /session/{id}/command` `{ command, arguments, messageID, model: "p/m" }` | `POST /api/session/{id}/command` `{ name, text }` |
| Command list (`listCommands`) | `client.command.list()` | `GET /api/command?location…` (`name`, `description`) |
| Abort (`session.abort`) | `POST /session/{id}/abort` → boolean | `POST /api/session/{id}/interrupt` → `{ interrupted }` |
| Running state (`isSessionActive`) | — | `GET /api/session/active` (map keyed by session id) |
| Messages (history, queries) | `GET /session/{id}/message` → `{ info, parts }[]` (one response, no paging) | `GET /api/session/{id}/message`, first page `order=asc`, then `cursor` alone; items `user` / `assistant` / `compaction` / `idle` / … |
| Turn start | assistant `message.updated` (not completed) | `session.execution.started` |
| Turn end | `session.idle`, `session.error`, `MessageAbortedError` on the message | `session.execution.succeeded` / `.failed` / `.interrupted` |
| Text / reasoning stream | `message.part.updated` (creation) + `message.part.delta` | `session.text.*`, `session.reasoning.*` (`assistantMessageID`, `ordinal`, `delta`) |
| Tool lifecycle | `message.part.updated` tool `state.status` | `session.tool.input.started`, `.success`, `.failed` (+ `progress`, `called`) |
| User turn echo | user `message.updated` + text parts | `session.inbox.enqueued` / `.delivered` (`inboxID`, `item.payload.text`) |
| Permissions list (`listPermissions`) | `GET /permission` (header-scoped) | `GET /api/permission/request?location[directory]=…` |
| Permission ask (live) | `permission.updated` / `permission.asked` (`permission`, `patterns`) | `permission.asked` (`action`, `resources`) |
| Permission reply (`replyPermission`) | `POST /session/{id}/permissions/{permissionID}` `{ response }` | `POST /api/session/{id}/permission/{requestID}/reply` `{ decision, message? }` |
| Questions (`listQuestions`, replies) | `GET /question`, `POST /question/{id}/reply|reject`; events `question.*` | — (forms) |
| Forms (`listForms`, `replyForm`, `cancelForm`) | — | `GET /api/session/{id}/form`, `POST …/form/{formID}/reply` `{ answer }`, SDK `session.form.cancel`; events `form.*` |
| Model catalog (`listProviders`) | `client.provider.list()` | `model.list({ location })` (never `/api/provider`) |
| Default model (`getDefaultModelConfig`) | `client.config.get()` `data.model` | `GET /api/model/default` → `providerID/id` |
| Model select | per-prompt `model` in the body; foreign `session.next.model.switched` | `POST /api/session/{id}/model` `{ model: { id, providerID } }` (SDK `switchModel`); event `session.model.selected` |
| Compaction | `POST /session/{id}/summarize` `{ providerID, modelID }`; compaction part; `session.compacted`; summary message | `POST /api/session/{id}/compact` `{}`; `session.compaction.*`; stored `compaction` item |
| Cost / tokens | assistant `info.cost`, `info.tokens`, `info.summary` | assistant `cost`, `tokens { input, output, reasoning, cache }`, `model`; compaction items |
| Subagent | `session.created` + `task` tool part `metadata.sessionId` | `session.created` + `subagent` tool, `session.tool.progress` `metadata.sessionID` |
| Durable ordering | none | `durable.seq` per session aggregate → `resync-needed` |
| Directory scoping | `x-opencode-directory` header on raw fetches; SDK `directory` option | `location[directory]` / `location: { directory }` / `directory` query, added by the SDK per route |

---

## 6. Invariants and rules

1. **No protocol conditionals in `src/app.tsx`.** It reacts to `ReplEvent` kinds and `HistoryOp`s.
   A kind that one protocol never emits needs no guard. New protocol differences go behind the seam.
2. **`src/index.tsx` alone picks the protocol** and constructs the backends.
3. **Models are identified by `ModelInfo.id`, never `ModelInfo.modelID`** on v2: catalog key, entry
   `id`, default model, `switchModel` body, `ModelRef.modelID`.
4. **Never call `/api/provider`.** It returns plaintext API keys. `listProviders` uses `model.list()`.
5. **Never log or keep the `model.default` payload.** It carries `settings.apiKey`;
   `getDefaultModelConfig` keeps only `providerID` and `id`. The v2 debug log prints frame type names
   only, never payload values.
6. **Cursor-only paging.** The first message page sends `order: "asc"`; later pages send `cursor`
   alone (`order` plus `cursor` is `InvalidCursorError`, capture doc §4.11). Session-list filters
   (`directory`, `parentID`) are repeated on every page. `collectPages` stops on a repeated cursor.
7. **Tolerant reader.** The v2 translator reads frames as untyped JSON (`isRecord`, `asString`,
   `asNumber`), drops what it cannot use, and returns `null` for unknown types.
8. **Request bodies send only used fields.** Optional fields are spread in only when present
   (`promptID` → `id`, `message` on permission reply, `query.directory` on v1 fork, `cursor` on
   pages).
9. **Translator state resets on session switch.** `switchSession` calls
   `backend.events.resetEventState()` before anything else of the new session is shown. Echo slots,
   rendered ids, seq counters, children and open blocks are cleared.
10. **Incremental resync, never clear and replay.** `--single` cannot erase printed lines. The
    only `renderer.clearAll()` in the session flow is in `switchSession`, where the whole view changes.
11. **Writes report errors; reads tolerate them.** v2 writes reject with a readable message; every
    write call site catches. Reads resolve `undefined` and call sites keep their `?? []` handling.
12. **Secrets never reach messages.** Passwords, auth headers and response bodies are kept out of
    errors; URLs are redacted.
13. **One translator per backend.** v2 state is instance-owned (no leak between the bootstrap and
    effective backends); v1 state is module-level by design.
14. **`activeModelRef` inside `applyReplEvents`** (section 4.5).

---

## 7. Host-local assumptions

The following are not served over the OpenCode API. They read or act on octmux's own host. With a
remote server (v2 desktop app on the MBP, or a v1 server reached through `--endpoint`) each
behaves as stated.

| Assumption | Code | With a remote server |
|---|---|---|
| Orchestra badge reads `~/.config/opencode/orchestra/sessions/*/`: `.oc-session-id` must match the harness session; `.brain-inflight` / `.duo-inflight` content gives the badge; `telemetry.json` `parser_warnings` are shown; directories with mtime older than 24 h are skipped | `OrchestraWatcher` (`src/orchestra-watch.ts`) | The sidecars are written on the server's host, so octmux finds none and shows no badge. The harness session is matched by `realpath(process.cwd())` against `SessionRecord.directory`; with `server.directory` set to a different path no session matches. Fenced off for oconona (`docs/Stage15.md` Known limits, C3.1) |
| Friendly model names from `~/.config/opencode/opencode.json` | `OrchestraWatcher.loadModelFriendlyNames` (parent row label only) | Falls back to the raw model id in the label |
| Slash-completion and highlighting names from `~/.config/opencode/commands/*.md` (names only) | `loadExternalCommands` (`src/command-registry.ts`), called in `src/index.tsx` | Completion may miss or show extra names. Forwarding uses the server's list (`backend.listCommands()` → `opencodeCommands`), so only server-known commands are sent |
| `--auto-spawn` locates the `opencode` binary (`which`, then fallbacks) and starts a local server | `spawnOpencodeServer` (`src/server-lifecycle.ts`) | Always local and always v1 (no detection). Refused with `server.directory` (exit 2) |
| `--worktree` creates a git worktree locally and chdirs into it | `src/utils/worktree.ts`, `src/index.tsx` | The server cannot see the path. Refused with `server.directory` (exit 2) |
| Git branch in the status line | `fetchGitBranch` (`src/utils/formatters.ts`) | Shows the local checkout's branch |

The project label in the status line is `deriveProjectName(serverDirectory)`, the basename of the
server-side directory, so it does follow `server.directory`.

octmux never writes under `~/.config/opencode`. The only file writes in `src/` are the tmux FIFO in
`src/renderer/fifo.ts`; the `--worktree` flow runs `git worktree` in the local repository.

---

## 8. How to extend: a feature that must work on both protocols

1. **Read the wire shapes.** Find the v1 events/routes in `src/events.ts` and the v1 SDK. Find the
   v2 frames and routes in `docs/OpenCode-v2-protocol-capture.md` (§2c attribution, §4 concept
   mapping, §5 REST rows) and in the `@opencode/client` types. If the capture doc has no row, mark
   the code "unverified" and plan a live check.
2. **Choose the seam surface.**
   - A request → a `BackendSession` member (session-scoped) or a flat `Backend` member. Use flat
     named arguments, return `SessionRecord` / neutral data, and follow the resolution convention
     (section 3.1). Document it in `src/backend/types.ts`.
   - A server-pushed signal → a `ReplEvent` kind in `src/events.ts`. Reuse an existing kind when
     the meaning is the same; add a new kind when it is not (the `model-selected` vs `model-switched`
     split is the precedent). Mark v2-only kinds in the union comment.
   - A history element → a `HistoryOp` variant only if no existing op can express it.
3. **Implement on v1** in `src/backend/v1.ts` (forwarder; raw `fetch()` needs
   `x-opencode-directory` and `getAuthHeaders()`), and in `filterEvent` if v1 pushes the signal. If
   v1 has no such concept, implement a documented no-op or empty result.
4. **Implement on v2** in `src/backend/v2.ts` through the SDK only: `attempt()` for reads, `write()`
   for writes, `location: { directory: this.cwd }` where the route takes one, only used fields in the
   body.
5. **Translate.** Add a `dispatch` case in `V2EventTranslator` (and `childPrompt` if children can
   raise it). Read tolerantly. Decide whether the frame is durable and whether it affects
   `renderedMessageIDs`. Update `translateHistoryV2` / `translateMissedHistoryV2` if the concept is
   stored in the message list, and keep the block-key scheme identical between live and history.
6. **Consume** in `src/app.tsx` `applyReplEvents` (no protocol test). Use refs, not closure state,
   for values that change between renders.
7. **Test** (section 9) with synthesised fixtures that follow the capture doc shapes, one case per
   branch, plus v1 regression tests pinned to the previous behaviour.
8. **Verify live** on both servers: the local v1 server and the v2 MBP server. Use an A/B build to
   classify anything odd as new or pre-existing.
9. **Document** in the relevant `docs/StageN.md` and in this document.

---

## 9. Testing strategy

Run with `/home/florian/.bun/bin/bun test src/` (743 pass at Stage 15.3, `docs/Stage15.md`).

| Layer | Test files |
|---|---|
| Config and detection | `src/octmux-config.test.ts`, `src/protocol-detect.test.ts` (classifiers, `compareVersions`, the `BUNDLED_OC_CLIENT_VERSION` / `package.json` agreement), `src/utils/redact-url.test.ts` |
| v1 translator | `src/events.test.ts`, `src/user-turn-debouncer.test.ts` |
| v1 queries | `src/backend/v1-queries.test.ts`, `src/refresh-token-usage.test.ts`, `src/stall-watchdog.test.ts` |
| Replay | `src/replay.test.ts` (including equivalence with the pre-split replay and the "Interrupted" marker) |
| v2 backend REST | `src/backend/v2.test.ts` (fake client injected through the constructor's third argument) |
| v2 translator | `src/backend/v2-events.test.ts` |
| v2 queries and history | `src/backend/v2-queries.test.ts` |
| Resync decisions | `src/resync-gate.test.ts` (`ResyncGate`, `decideResync`, `shouldEndCompacting`) |
| App helpers | `src/turn-status.test.ts`, `src/utils/formatters.test.ts`, `src/orchestra-watch.test.ts` |
| Renderer | `src/renderer/block-buffer.test.ts`, `src/renderer/table-layout.test.ts` |

- **Synthesised fixtures.** Every v2 frame and message in the tests is built by hand to the shapes
  quoted in the capture doc, with comments naming the section. No capture artefact is committed
  (they stay in the orchestra session directories named in the capture doc frontmatter).
- **Live gates.** v1: a smoke run against `127.0.0.1:4096` (startup warning, prompt, tool call,
  Ctrl-C, `/sessions`, `--resume`). v2: the live checklist on OpenCode 2.0.28 on the MBP (subagent
  with child permission, `/review` and `/rag` rendering once, `/fork`, `/rename`, `/sessions`,
  `/new`, `/model` own and foreign, foreign prompt, `--multi-window`, `/compact`, `--resume`
  "Interrupted", status-line label). Live tests touch only sessions they created.
- **A/B builds.** Each stage compares against the previous build (for example `b1e205d` for 15.3) to
  classify a defect as introduced or pre-existing.
- **Type check.** `tsgo` error multiset must equal the baseline.

---

## 10. Known limits

The full list is in `docs/Stage15.md` "Known limits". The key ones:

- A message partly received at a gap is not repaired; `getMissedHistory` renders only complete
  messages. A message whose opening frame was lost renders only after it completes and a later resync
  or session switch happens.
- The live compaction summary has no message id, so a later gap may render it again. A compaction
  rendered through resync appears in replay form, unlike the live form.
- A real dropped frame has not been observed live; resync was seen on the auto-title gap and the
  compaction seq hole.
- Grandchild subagents are not tracked live (their permissions arrive through discovery). The child
  model is `""` when `session.created` omits it.
- `permission.replied` does not close a modal answered elsewhere (same as v1).
- A foreign turn that arrives before a command's echo takes the echo slot; the echo then renders
  unless it starts with the recorded prefix.
- The "Interrupted" marker appears on full replay only, not after an incremental resync.
- Two `/model` switches in quick succession can briefly show the stale model.
- The orchestra badge and subagent rows need the server on the same host (section 7).
- `--auto-spawn` is v1-only; `--worktree` suits a same-host server.
- `GET /api/session` ignores the location filter on the server side (`docs/Stage15.md` Stage 15.3
  follow-ups).
