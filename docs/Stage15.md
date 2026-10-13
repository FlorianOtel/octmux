---
title: "Stage 15 — OpenCode v2 native session support, Backend seam"
created_at: 2026-10-13--16-41
created_by: Claude Code (Claude Haiku 5.5)
updated_by: Claude Code (Claude Haiku 5.5)
updated_at: 2026-10-13--17-51
context: >
  Operator request: octmux must support the OpenCode v2 API natively, not only
  detect it. Stage 15 is the session-level stage that Stage 14 anticipated. Stage 14
  added config, Basic auth and protocol detection, and ends with a v2 server
  printing "native v2 session support is not yet implemented". Stage 15 has three
  sub-stages. 15.1 introduces a protocol-neutral `Backend` interface with the
  existing v1 wire code behind a `V1Backend` adapter, and zero behaviour change.
  15.2 adds `V2Backend` and the v2 core (sessions, prompts, events). 15.3 brings
  v2 to feature parity with v1. The design decisions and the sub-stage plan are in
  the /brain session directory
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/20261013T123149Z-1871118
  (PLAN.md, review-comments.md). The v2 wire shapes are in
  `docs/OpenCode-v2-protocol-capture.md`.
---

# Stage 15 — OpenCode v2 native session support, Backend seam

## Scope

Stage 15 gives octmux a protocol-neutral seam between its UI and whichever
OpenCode wire protocol is in use. The seam is the `Backend` interface in
`src/backend/types.ts`. Sub-stages:

| Sub-stage | Content | Status |
|---|---|---|
| 15.1 | `Backend` interface; `V1Backend` adapter; all call sites use `Backend` | shipped |
| 15.2a | Backend contract reshape on the v1 side: flat session arguments, `SessionRecord`, v2-only `ReplEvent` kinds, history split, `v1-queries` | shipped |
| 15.2 | `V2Backend` and the v2 core (sessions, prompts, events) | next |
| 15.3 | v2 parity with v1 features | planned |

Stage 15.1 does not make v2 usable. A v2 server still exits with the Stage 14
message "native v2 session support is not yet implemented".

## Backend seam design

### Interface layout

`Backend` (`src/backend/types.ts`) has three kinds of member:

- `session: BackendSession` — session-scoped operations with flat named arguments:
  `getMessages`, `getChildren`, `get`, `abort`, `create`, `compact`, `list`, `fork`,
  `update`, `sendCommand`, `sendPrompt`, `setModel`. The interface doc-comment
  states the resolution convention: a method whose call sites read the response
  resolves with the SDK response's `data`; a method whose call sites do not read it
  resolves `void`, or `{ interrupted }` for `abort`.
- `events: BackendEvents` — the event pipeline and the session-read queries:
  `translateEvent`, `hasPendingToolCalls`, `getLatestAssistantActivity`,
  `getTokenUsage`, `getHistory`, `resetEventState`, `synthesizeSessionIdleEvents`,
  `hasOpenStreamingPart`, `recordOwnMessageID`, `recordOwnCommandPrefix`,
  `classifyUserTurn`.
- Flat operations: `listCommands`, `getDefaultModelConfig`, `listProviders`,
  `listQuestions`, `listPermissions`, `rejectQuestion`, `replyQuestion`,
  `replyPermission`, `isSessionDescendant`, `subscribeEvents`.

`ReplEvent` is re-exported from `src/events.ts`. It carries the v2-only kinds
described in "`ReplEvent` v2-only kinds" below.

### Flat session arguments and `SessionRecord`

Session methods take named arguments, for example `getMessages(sessionID)`,
`compact(sessionID, model)`, `sendPrompt({ sessionID, text, promptID?, model? })`,
and `replyPermission({ sessionID, permissionID, decision, message? })`. The SDK
option-object wrapper (`{ path, query, body }`) does not appear in the interface.
`V1Backend` builds the matching SDK request internally.

Session reads return `SessionRecord` (`src/backend/types.ts`): `id`, `parentID?`,
`directory`, `title`, `time.updated`, and the bound `model?`. It lists only the
fields octmux reads. The v1 SDK `Session` type satisfies it. `model` is declared
here because the SDK `Session` type omits it, although the runtime value is present.

`replyPermission` takes a protocol-neutral `decision` (`"once" | "always" | "reject"`).
v1 sends it as `body.response`. `message` is accepted and ignored by v1, which has
no such field.

### Session-read queries behind `BackendEvents`

`src/backend/v1-queries.ts` holds the v1 scans for the reconciler's pending-tool
check, the stall watchdog and the status-line token usage. Each scan is pure
over a message list. Each exported async wrapper fetches the messages first.
`V1Backend.events` calls the wrappers.

- `hasPendingToolCalls`: true when any tool part is `pending` or `running`.
- `getLatestAssistantActivity`: describes the newest assistant message for the
  watchdog. It reports whether the message has content, whether it is completed, and
  whether it is blocked on a paired child session (`openChild`, with a staleness flag).
- `getTokenUsage`: the context size of the newest post-summary assistant message, and
  the running cost summed over the session and its direct children. It returns `null`
  when there is no post-summary usage. In that case the cost roll-up is skipped.

Child lookups are best-effort. A failed child listing or child fetch is skipped, and
the parent's cost still counts.

### Replay: translate, then apply

`src/replay.ts` is split into three steps:

- `translateHistory(messages)` is pure. It returns `HistoryOp[]`, which is an ordered
  list of renderer and editor operations. It applies the compaction rules and the
  filters for synthetic and ignored user parts.
- `fetchHistory(client, sessionID)` fetches the messages and translates them. Errors
  yield `[]`.
- `applyHistory(renderer, editor, ops)` is the only code that calls the renderer or the
  editor for history replay.

`events.getHistory(sessionID)` on the Backend returns the operations. The caller passes
them to `applyHistory`. A translation error keeps the operations produced so far and
omits the final editor seed.

### `ReplEvent` v2-only kinds

Stage 15.2a adds these kinds to `ReplEvent` (`src/events.ts`). v1 never emits them, so
they are inert on the v1 path:

- `form-asked`, `form-replied`: v2 forms.
- `turn-retry`: a non-terminal retry. It does not flip the generating state.
- `compaction-started`, `compaction-progress`, `compaction-ended`, `compaction-failed`.
- `model-selected`: the model bound to the session. Kept distinct from the v1
  `model-switched` kind.
- `resync-needed`: internal. Set when a durable `seq` gap is detected, so the caller
  clears and replays.

Two existing kinds gained a field:

- `block-end.exitCode` (v2 only): the exit code of a completed shell tool.
- `permission-asked.resources`: the resources a permission request covers. v1 sets
  it to `[title]`.

### `listProviders` and the v2 `/api/provider` route

`listProviders()` wraps the v1 `client.provider.list()`. It is not the v2 route
`/api/provider`, which returns plaintext API keys and must never be called from
octmux. The interface doc-comment carries this warning. A future v2 implementation
must back `listProviders` with a provider-metadata route that does not expose
credentials.

### Module placement

`src/backend/v1.ts` is the only file that wires the v1 event, replay, query and
ancestry code into the seam. The following modules are referenced by `V1Backend`,
not moved:

- `src/events.ts` — event translation and the module-level pipeline state.
- `src/replay.ts` — `translateHistory`, `fetchHistory` and `applyHistory` (see
  "Replay: translate, then apply").
- `src/backend/v1-queries.ts` — the session-read scans (see "Session-read queries
  behind `BackendEvents`").
- `src/utils/session-ancestry.ts` — `isSessionDescendant`, with its cached session list.

`app.tsx`, `index.tsx`, `orchestra-watch.ts` and `utils/formatters.ts` import
`Backend` and nothing v1-specific from the seam.

### Who constructs backends

`src/index.tsx` constructs two `V1Backend` instances:

- `bootstrapBackend` wraps `bootstrapClient`, which is built with the launch
  working directory. It serves the startup session operations: resume, resume-last,
  fork and create.
- `backend` wraps the real `client`, which is built with the effective working
  directory. That is the launch directory (or the `--worktree` directory once
  octmux has chdir'd into it), unless `--resume` / `--resume-last` / `--fork`
  resolves a session whose own `directory` differs from the launch directory,
  in which case that session directory is used. It is passed to `<App backend={…}>`. `App` builds the
  `OrchestraWatcher` from it, and uses it for the initial SSE subscription and
  for every reconnect.

## Current state

- A v2 server is detected by the Stage 14 probes, and the `--config` / Basic-auth
  path works against it.
- A v2 server is not used for sessions, prompts or events. octmux prints the
  Stage 14 message and exits 1.
- The Backend session API uses flat named arguments and `SessionRecord`. The v1
  path is the only implementation.
- `ReplEvent` carries the v2-only kinds. v1 never emits them.
- `V2Backend` is Stage 15.2.

---

### 2026-10-13--17-51 — Stage 15.2a — Backend contract reshape on the v1 side

**Implemented by:** Claude Code (Claude Haiku 5.5) — 2026-10-13--17-51
**Commit(s):** `47bd8a6`

- Flat session API: `BackendSession` takes named arguments, and the SDK option
  objects are gone from the interface. `SessionRecord` replaces the SDK `Session`
  type at call sites. `setModel` is added (v1 no-op). `replyPermission` takes flat
  arguments.
- `ReplEvent`: additive v2-only kinds (`form-*`, `turn-retry`, `compaction-*`,
  `model-selected`, `resync-needed`). `permission-asked.resources` (v1 sets
  `[title]`). `block-end.exitCode` (v2 only). v1 does not emit the new kinds.
- History split: `src/replay.ts` gains a pure `translateHistory` returning
  `HistoryOp[]`, `fetchHistory`, and a shared `applyHistory`. `events.getHistory`
  exposes the operations. `replaySession` is removed.
- `src/backend/v1-queries.ts` (new): the reconciler Layer 4, stall-watchdog and
  token-usage scans moved out of `app.tsx` behind `BackendEvents`
  (`hasPendingToolCalls`, `getLatestAssistantActivity`, `getTokenUsage`). The
  running cost includes the direct-children roll-up.
- Verification:
  - `bun test src/`: 383 pass. This includes a replay equivalence test against the
    previous `replaySession` body, and 37 `v1-queries` tests pinned to the original
    inline behaviour.
  - tsgo errors 75 → 67. The 8 removed are `Property 'model' does not exist on type
    'Session'`, resolved by `SessionRecord`.
  - Fresh Reviewer checkpoint.
  - Live v1 smoke test: startup, prompt, tool call, Ctrl-C, `/sessions`, and
    `--resume` replay.
- Observations from the smoke test. All are pre-existing and tracked separately:
  - Replay hides tool output when tools-output is off.
  - Replay shows no "Interrupted" marker for an aborted turn.
  - The "/brain-abandon" hint after Ctrl-C appears even without an active `/brain` run.
  - One 3 s health-probe timeout right after a previous octmux exit. The retry succeeded.

### 2026-10-13--16-41 — Stage 15.1 — protocol-neutral Backend interface, v1 adapter

**Implemented by:** Claude Code (Claude Haiku 5.5) — 2026-10-13--16-41
**Commit(s):** `4bcc2b3`

- `src/backend/types.ts` (new): the `Backend`, `BackendSession` and `BackendEvents` interfaces, `V1Client` and `V1Request` helper types, and the `ReplEvent` re-export. Type-only; no logic.
- `src/backend/v1.ts` (new): `V1Backend`. Every method is a forwarder. Raw `fetch()` URLs and headers are copied verbatim, including `x-opencode-directory` and `getAuthHeaders()`.
- `src/app.tsx`: `AppProps` gains `backend: Backend`; `client`, `baseUrl` and `cwd` are removed from `AppProps`. Session, command, provider, question, permission, replay and ancestry call sites use `props.backend`. The SSE effect depends on `props.backend`. The reconnect path calls `props.backend.subscribeEvents()`. `OrchestraWatcher` is constructed from `props.backend`.
- `src/index.tsx`: constructs `bootstrapBackend` (launch cwd) and `backend` (effective cwd). The startup session operations use `bootstrapBackend`. The initial subscription uses `backend.subscribeEvents()`. `<App>` receives `backend={backend}` and no longer receives `client`, `baseUrl` or `cwd`.
- `src/orchestra-watch.ts`: constructor takes `Backend`; session lookup uses `backend.session.list()`.
- `src/orchestra-watch.test.ts`: the test stub is renamed to `stubBackend`; its behaviour is unchanged.
- `src/utils/formatters.ts`: `getContextWindow`, `getToolCallSupport`, `getDefaultModel` and `validateModel` take `Backend`.
- Unchanged: `src/events.ts`, `src/replay.ts`, `src/utils/session-ancestry.ts`.
- Verification: `bun test src/` passes 336 tests, 0 fail. The `tsgo` error set is identical to the pre-refactor build (none in `src/backend/`). `events.ts`, `replay.ts` and `session-ancestry.ts` are byte-identical to the pre-refactor version.
- Live v1 smoke test against the local v1 server: startup with the fallback warning, a prompt round trip, Ctrl-C interrupt during generation, and clean `/exit`.
- A/B run against the pre-refactor build (`fd8dee5`): the same smoke steps produce identical behaviour.
- Known pre-existing issue, found during the smoke test and present before Stage 15.1: Escape does not dismiss the `/sessions` picker. Tracked separately.
