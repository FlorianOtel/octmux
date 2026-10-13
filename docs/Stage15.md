---
title: "Stage 15 — OpenCode v2 native session support, Backend seam"
created_at: 2026-10-13--16-41
created_by: Claude Code (Claude Haiku 5.5)
updated_by: Claude Code (Claude Opus 5.5)
updated_at: 2026-10-13--23-59
context: >
  Operator request: octmux must support the OpenCode v2 API natively, not only
  detect it. Stage 15 is the session-level stage that Stage 14 anticipated. Stage 14
  added config, Basic auth and protocol detection, and ends with a v2 server
  printing "native v2 session support is not yet implemented". Stage 15 has three
  sub-stages. 15.1 introduces a protocol-neutral `Backend` interface with the
  existing v1 wire code behind a `V1Backend` adapter, and zero behaviour change.
  15.2 adds `V2Backend` and the v2 core (sessions, prompts, events). 15.3 brings
  v2 to feature parity with v1 and is shipped. The architecture of the v1/v2 adaptation layer is
  described end to end in `docs/OpenCode-v1-v2-adaptation-layer.md`. Every design
  decision of Stages 14 and 15 is in `docs/OpenCode-v2-decision-record.md`. The v2 wire
  shapes are in `docs/OpenCode-v2-protocol-capture.md`.
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
| 15.2 | `V2Backend` and the v2 core: sessions, prompts, commands, compaction, model select, permissions, forms, streaming events, replay, resync, startup | shipped |
| 15.3 | v2 parity with v1 features | shipped |
| 15.4 | Client-only boundary: orchestra state, model names and command names over the API | shipped |

A v2 server is served natively by `V2Backend` (see "Native v2 backend" below).
v2 is at feature parity with v1, apart from the limits listed under "Known limits" below.

## Backend seam design

### Interface layout

`Backend` (`src/backend/types.ts`) has three kinds of member:

- `session: BackendSession` — session-scoped operations with flat named arguments:
  `get`, `abort`, `create`, `compact`, `list`, `fork`, `update`, `sendCommand`,
  `sendPrompt`, `setModel`. `getMessages` and `getChildren` are on `V1BackendSession`
  only; `V2Backend` reads messages and children through its internal `fetchMessages`
  and `fetchChildren`. The interface doc-comment
  states the resolution convention: a method whose call sites read the response
  resolves with the SDK response's `data`; a method whose call sites do not read it
  resolves `void`, or `{ interrupted }` for `abort`.
- `events: BackendEvents` — the event pipeline and the session-read queries:
  `translateEvent`, `hasPendingToolCalls`, `getLatestAssistantActivity`,
  `getTokenUsage`, `getHistory`, `resetEventState`, `synthesizeSessionIdleEvents`,
  `hasOpenStreamingPart`, `recordOwnMessageID`, `recordOwnCommandPrefix`,
  `classifyUserTurn`, `getMissedHistory`. `getMissedHistory` is the incremental
  resync read (see "Native v2 backend").
- Flat operations: `listCommands`, `getDefaultModelConfig`, `listProviders`,
  `listQuestions`, `listPermissions`, `rejectQuestion`, `replyQuestion`,
  `replyPermission`, `isSessionDescendant`, `subscribeEvents`, `listForms`,
  `replyForm`, `cancelForm`, `isSessionActive`, `getOrchestraState`.

`ReplEvent` is re-exported from `src/events.ts`. It carries the v2-only kinds
described in "`ReplEvent` v2-only kinds" below.

### Flat session arguments and `SessionRecord`

Session methods take named arguments, for example `get(sessionID)`,
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

`translateHistory` adds an "Interrupted" system message immediately after the `turn-end` of an
assistant message whose error is `MessageAbortedError`. This is the same check as the live path
(`src/events.ts`). `translateHistoryV2` adds the same marker for an idle item whose outcome is
`interrupted` (see "Queries and history").

### `ReplEvent` v2-only kinds

Stage 15.2a adds these kinds to `ReplEvent` (`src/events.ts`). v1 never emits them, so
they are inert on the v1 path:

- `form-asked`, `form-replied`: v2 forms.
- `turn-retry`: a non-terminal retry. It does not flip the generating state.
- `compaction-started`, `compaction-progress`, `compaction-ended`, `compaction-failed`.
- `model-selected`: the model bound to the session. Kept distinct from the v1
  `model-switched` kind.
- `resync-needed`: internal. Set when a durable `seq` gap is detected. The caller runs an
  incremental resync (`getMissedHistory`); nothing on screen is cleared.

Two existing kinds gained a field:

- `block-end.exitCode` (v2 only): the exit code of a completed shell tool.
- `permission-asked.resources`: the resources a permission request covers. v1 sets
  it to `[title]`.

### `listProviders` and the v2 `/api/provider` route

`listProviders()` wraps the v1 `client.provider.list()`. It is not the v2 route
`/api/provider`, which returns plaintext API keys and must never be called from
octmux. The interface doc-comment carries this warning. `V2Backend` backs `listProviders` with the v2 model catalog (`model.list()`), which
carries no credentials. The v2 route `/api/provider` is never called.

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

`app.tsx`, `orchestra-watch.ts` and `utils/formatters.ts` import `Backend` and
nothing protocol-specific from the seam. `app.tsx` has no protocol branch.
`index.tsx` is the only file that picks a protocol (see "Who constructs backends").

### Who constructs backends

`src/index.tsx` constructs two backend instances of the protocol it detected at
startup, `V1Backend` or `V2Backend`. The startup flow is shared by both protocols.

- `bootstrapBackend` wraps `bootstrapClient`, which is built with the server
  directory (`server.directory` when set, otherwise the launch working directory).
  It serves the startup session operations: resume, resume-last, fork and create.
- `backend` wraps the real client, which is built with the effective server
  directory. That is the server directory, unless `--resume` / `--resume-last` /
  `--fork` resolves a session whose own `directory` differs from it, in which case
  that session directory is used. The comparison is with the server directory, not
  the local working directory. It is passed to `<App backend={…}>`. `App` builds the
  `OrchestraWatcher` from it, and uses it for the initial SSE subscription and
  for every reconnect.

## Native v2 backend

### `V2Backend` (`src/backend/v2.ts`)

- Built on the `@opencode/client` SDK. Every call goes through the SDK, not raw
  `fetch()`. The SDK sends the directory as `location` (`{ directory }`) on v2
  routes, so v2 has no `x-opencode-directory` header.
- Session records: `location.directory` becomes `SessionRecord.directory`. The bound
  model becomes `{ providerID, id }`.
- Session lists are filtered by directory (`session.list`), or by `parentID` for
  children. Messages are cursor-paged. `collectPages` follows `cursor.next` and stops
  when the cursor is absent or repeats. The filter is sent on every page. The first
  message page sets `order: "asc"`. Later pages send `cursor` alone, because the
  cursor already encodes order and direction.
- Models are keyed by `ModelInfo.id` (the short name, for example `glm-5.3-flash`)
  everywhere: the catalog key, the entry `id`, the default model and the
  `switchModel` body (`model.id`). `ModelInfo.modelID` is the upstream API name, and
  octmux does not use it. `model.default` is reduced to `providerID` and `id`.
  `setModel` sends nothing when the model equals the one last recorded for that session. The
  record is set by each `setModel` that octmux sends, and by each `session.model.selected`
  event for the REPL's session. `translateAndTrackModel` (`src/backend/v2.ts`) wraps
  `translateEvent` to record the events, so the cache follows a switch made elsewhere.
- `listProviders` is built from `model.list()`. It never calls `/api/provider`.
- `listPermissions` uses the location-scoped request route, reshaped to the v1
  `GET /permission` shape. Child sessions share the directory, so the list is expected
  to include their asks.
- Forms: `listForms`, `replyForm`, and `cancelForm` (`session.form.cancel`).
- Writes (`sendPrompt`, `sendCommand`, `compact`, `setModel`, `create`, `fork`,
  `update`, `replyPermission`, `replyForm`, `cancelForm`) go through one `write()`
  helper. An error status throws a readable `Error`. A `LocationNotFoundError` names
  the missing directory and the config key `server.directory`, and the config file
  path when one is loaded. Other tagged errors read `<_tag>: <message>`. A transport
  failure is rethrown. `abort` is the one exception: it swallows the error status and
  returns `{ interrupted }`.
- Reads resolve `undefined` or `void` on an error status. A transport failure is
  rethrown.
- `fork` ignores `directory` on v2. The fork keeps the parent's location.

### `V2EventTranslator` (`src/backend/v2-events.ts`)

One translator instance per backend. `translate(frame, currentSessionID)` maps one
frame to one or more `ReplEvent`s, and returns `null` for frames octmux does not render.

- Envelope: `{ type, data, durable? }`. The session is read from the frame. Durable
  frames carry a per-session `seq`.
- Attribution: frames of the REPL's session are handled directly. Frames of a tracked
  child session go to the child path. Every other session is ignored.
- Blocks: each block is keyed `${messageID}:${index}`. The index is the content
  position of the part in its message, allocated in start order. Tool blocks use the
  call `id` as the part id, and their result uses `${callID}-result`. The same keys
  are used by `translateHistoryV2`, so a live block and a replayed one share a part id.
  Stream ordinals are per kind, so they cannot serve as keys.
- Text start does not close an open reasoning block. In v2 the two can overlap.
- Tools: the tool lifecycle maps to the v1 block events. Input is not rendered, as in
  v1. A completed shell tool carries `block-end.exitCode`, and a non-zero exit shows
  a marker line.
- Turn end: `parent-turn-end`, then `session-idle`, then the block ends, in the v1
  order. v2 has no `session.idle`, so `execution.failed` and `execution.interrupted`
  also produce `session-idle`. A failed step (`session.step.failed`) produces no
  error line. `execution.failed` carries the same error, and an aborted step on
  Ctrl-C must not show one.
- Retries: `turn-retry` produces one line per attempt. It does not change the
  generating state.
- Own echo: octmux mints a prompt id for each prompt (`recordOwnMessageID`). The
  inbox echo that carries it is suppressed as an own turn. Own commands are matched
  by the echo slot and, as a backstop, the prefix of their expanded text
  (`recordOwnCommandPrefix`). A foreign user turn is emitted as `foreign-user-turn`
  directly from `userInboxItem`; v2 `classifyUserTurn` returns `[]`.
- Command echo slot: a command's POST returns no id, and one `user` item comes back per
  command. `recordOwnCommandPrefix` also arms one pending echo slot. The next user item that is
  not an own prompt and not already shown takes the slot and is suppressed, whatever its text.
  The live inbox path and the resync path both claim user items through `claimUserItem`, so an
  echo seen only through resync also takes its slot. The prefix match runs only when no slot is
  pending, as a backstop for an echo that arrives with no slot armed. `V2Backend.sendCommand`
  releases one slot (`releaseCommandEcho`) when `ensureModel` or the POST throws. `resetEventState`
  clears all slots on a session switch.
- Subagents: a `session.created` whose `parentID` is the REPL's session registers a
  child. The child is linked to the parent `subagent` tool call primarily by the call's
  `session.tool.progress` `metadata.sessionID`. Title pairing (the child's `title` equals
  the call's description) is the fallback, used only while the progress frame has not
  yet linked the child. The call's input supplies the description. Child frames never reach the parent's blocks. A
  child is removed on its terminal frame, or when the parent `subagent` call ends
  first.
- Permissions: `permission.asked` produces `permission-asked` with `resources`. The
  app's discovery pass also feeds in v1-shaped `permission.asked` inputs. Those are
  accepted only for the REPL's session or its descendants.
- Forms: `form.created` produces `form-asked`. `form.replied` and `form.cancelled`
  produce `form-replied`.
- Compaction: `compaction-started`, `compaction-progress` (not rendered),
  `compaction-ended` (a divider, then the summary block), and `compaction-failed`.
  The `compaction-ended` token total is the sum of the reported token parts. The server skips one
  durable `seq` between `compaction.started` and `compaction.ended`. The `ended` frame therefore
  arrives as a gap, is dropped, and a resync follows (see "App integration").
- `model.selected` produces `model-selected`.
- Durable `seq`: a duplicate is ignored. A gap closes the open blocks with
  `block-end`, then emits `resync-needed`. The gapped frame itself is dropped.

### Queries and history (`src/backend/v2-queries.ts`)

- Pure translators and scans over a v2 message list. Each mirrors its v1 counterpart
  in `src/backend/v1-queries.ts` and `src/replay.ts`. The v1 stall threshold and
  `isTurnStale` are reused.
- `getHistory` returns `translateHistoryV2` output. It uses the first completed
  compaction, as v1 does. Blocks follow stored content order, which is start order.
- `hasPendingToolCalls` and `getLatestAssistantActivity` follow the v1 rules.
- `getTokenUsage` reads the newest post-compaction assistant message. The running
  cost sums the session and its direct children, on a best-effort basis.
- `getMissedHistory` (the resync read) returns only the complete messages that are not
  yet rendered. An assistant message counts as ended when it is completed, has a
  finish or an error, or is followed by an idle. The translator records every id it
  renders live, and every id that `getHistory` returns.
- Idle items: an idle item whose `outcome` is `interrupted` renders one "Interrupted" system
  message after the turn's `turn-end`. `isCompleteRenderable` is false for idle items, so
  `getMissedHistory` never selects them. The marker therefore appears on full replay only, and an
  incremental resync shows none.

### App integration (`src/app.tsx`, `src/components/FormModal.tsx`)

- `FormModal` shows one field at a time. `form-modal-logic.ts` builds the answer, and
  the footer hint depends on the field type. Submit calls `replyForm`. Esc and Ctrl-C
  call `cancelForm`. Form input is active only when no picker is open and no
  compaction is running.
- Discovery on attach lists permissions, questions and forms, oldest first.
- Resync: a `resync-needed` event runs through `ResyncGate`, which coalesces runs and
  allows one run at a time. A run renders the missed messages from `getMissedHistory`,
  reconciles the generating state from `backend.isSessionActive`, and runs the discovery
  pass. It does not clear the renderer or replay the whole session. A resync also ends the compacting
  state when `shouldEndCompacting` (`src/resync-gate.ts`) is true: the missed ops contain a
  `compaction-divider`, or `isSessionActive` reports the session as not active.
- Retry lines, the compaction state, the exit-code marker and `model-selected` are
  handled in `app.tsx`. `model-selected` is compared with `activeModelRef`. An equal model does
  nothing. Any other model is adopted (`adoptSessionModel`) with the `model-switched` wording.
- `/new` uses the server directory.
- Status line: the project label is `deriveProjectName(serverDirectory)`, the basename of the
  server directory (`src/utils/formatters.ts`). With `server.directory` unset it equals the
  basename of the launch directory.
- Error hint: an error line appends `abandonHint(badge)` (`src/utils/formatters.ts`) only while an
  orchestra run is active. A brain run names `/brain-abandon`, and a duo run names `/duo-abandon`.

### Startup (`src/index.tsx`)

- One startup flow serves v1 and v2. Protocol detection selects the backend.
- A v2 server starts and serves sessions. A major version mismatch refuses to start. Minor
  gate warnings are kept. No success line is printed.
- `server.directory` in `octmux.json` is the server-side directory. It must be
  absolute after substitution. It is the location for v2, and the `directory` for v1.
  When set, startup prints a line naming it and the file. When unset, the launch
  directory is used.
- `server.directory` is refused with `--worktree` and with `--auto-spawn`, both with
  exit 2. A local worktree or a locally spawned server cannot be the one that the
  server directory names.
- The default session creation at startup, when it fails, prints
  `octmux: could not create a session: <message>` and exits 1.

### Renderer and input fixes (v1 and v2)

- Non-text streaming (summary, reasoning and the like) accumulates complete lines per
  block. A per-block tail (`_nonTextTails` in `src/renderer/block-buffer.ts`) holds the
  partial line. The tail is flushed at `endBlock` and `retagBlock`. Thinking tails are
  flushed before the next text block. All tails are flushed before the turn separator.
- Paste filter: a lone ESC at the end of a chunk is released after 40 ms when no
  continuation arrives. Markers and escape sequences are handled as before. Escape
  therefore reaches the modals.
- Child stdio: the git branch lookup and the tmux `execFile` calls capture stdout
  and ignore stderr. Child stderr therefore never writes behind Ink.

### Known limits

- A message that is only partly received at a gap is not repaired. `getMissedHistory`
  renders only complete messages.
- A message whose opening frame was lost is not rendered until the next session
  switch or resync after it completes.
- The compaction summary carries no id on the live frame. A later gap may render it
  again.
- The resync path is covered by unit tests. Live, it was seen on a benign
  auto-title gap and on the server's compaction seq skip. A real dropped frame has not been
  observed live.
- Subagents of subagents (grandchildren) are not tracked live.
- The child's model is `""` when `session.created` omits it.
- `permission.replied` does not clear a modal that was answered elsewhere. This
  matches v1.
- Orchestra badge on v2: read over the API from the harness session's `metadata.orchestra`
  (`Backend.getOrchestraState`, contract in `src/backend/v2-orchestra.ts`). It works with a remote
  server, and stays empty until oconona publishes that metadata
  (`~/Gin-AI/tmp/oconona-OCv2-support.md`).
- Orchestra badge on v1 (legacy): v1 has no API channel for the run state, so `V1Backend` reads
  oconona's sidecar files under `~/.config/opencode/orchestra/sessions/` on octmux's own disk and
  matches the harness session by the local cwd. It works only with a server on the same host.
- A foreign turn that arrives before a command's echo takes the echo slot and is swallowed. The
  echo then renders as a user line, unless its text starts with the recorded prefix.
- A failed compaction whose frames fall in the seq hole unlocks input without an error line.
  This is not tested live.
- The "Interrupted" marker shows only on full replay, not after an incremental resync.
- A compaction rendered through resync appears in replay form: a summarized line, the summary
  with prefixed lines, and a divider after it. A live compaction renders differently.
- Auto-compaction is out of scope. Only the reason `manual` has been observed.
- `--auto-spawn` starts a local server and skips protocol detection, so it runs the v1 client. `--worktree`
  creates its worktree on the octmux host, so it suits a server on the same host. Both are refused with
  `server.directory` (exit 2).
- Two `/model` switches made back to back, before the first `session.model.selected` event
  arrives, can briefly show the stale model. The event carries no client id. This is accepted.

## Current state

- A v1 or v2 server is detected at startup by the Stage 14 probes. The matching
  backend (`V1Backend` or `V2Backend`) serves the session.
- The Backend session API uses flat named arguments and `SessionRecord`.
- v2 covers sessions, prompts, commands, compaction, model select, permissions,
  forms, streaming events, replay, incremental resync, and `server.directory`.
- `ReplEvent` carries the v2-only kinds. v1 never emits them.
- `/api/provider` is never called.
- v2 is at feature parity with v1. The limits are listed under "Known limits".

---

### 2026-10-13--23-59 — Stage 15.4 — client-only boundary: orchestra state and names over the API

**Implemented by:** Claude Code (Claude Opus 5.5) — 2026-10-13--23-59
**Commit(s):** `4962c17`

- **Principle (operator):**
  - octmux is an OpenCode client and does not read OpenCode server files.
  - oconona is server-side by definition and owns `~/.config/opencode/` and the server DB.
  - v2 is the main code path; v1 is kept for legacy use.
- **Orchestra badge:**
  - New `Backend.getOrchestraState(sessionID)` (`src/backend/types.ts`, `OrchestraState`).
  - `V2Backend` reads the session's `metadata.orchestra` with `GET /api/session/{id}`, parsed by
    `parseOrchestraMetadata` (`src/backend/v2-orchestra.ts`). The file documents the contract that
    oconona publishes:
    - `version`, `mode`, `title`, `active` and `updatedAt`, plus optional `parserWarnings`;
    - an entry older than 24 h, or with `active` not `true`, is ignored.
  - `V1Backend` keeps the sidecar-file read, moved unchanged into `src/backend/v1-orchestra.ts`
    (`V1OrchestraFileReader`). This is legacy, because v1 has no API channel for this state.
  - `OrchestraWatcher` (`src/orchestra-watch.ts`) is protocol-neutral:
    - it polls `getOrchestraState` every 5 s;
    - it keeps the subagent rows from the event stream;
    - it drops a result for a session the REPL has left.
- **Model display names:** taken from `listProviders()`, which both protocols serve. The
  `~/.config/opencode/opencode.json` read is removed.
- **Slash completion and highlighting:** take the server's command names (`setServerCommands` in
  `src/command-registry.ts`), fed by the same `listCommands` result that decides forwarding
  (`src/app.tsx`). The `~/.config/opencode/commands/*.md` scan is removed. Server commands appear
  in completion once the list arrives, shortly after startup.
- **Verification:**
  - `bun test src/`: 772 pass, 0 fail, 24 new tests (`v2-orchestra`, `v1-orchestra`, watcher refresh,
    `command-registry`, `V2Backend.getOrchestraState`). The tsgo error set is unchanged.
  - Live, OpenCode 2.0.28 on the MBP, octmux on another host:
    - a scratch session with published `metadata.orchestra` showed `♪ orchestra full - …` and the
      `brain` row;
    - `active: false` cleared the badge within 5 s;
    - `/ra` completed to `/rag` from the server list;
    - `PATCH /api/session/{id}` replaces `metadata` as a whole, with no key merge.
  - v1 smoke test (local): `/bra` completes to `/brain` and `/brain-abandon` from the server list.
  - Test sessions were deleted by recorded id.
- **v1 changes:**
  - The badge refresh runs on the 5 s poll only; the `fs.watch` trigger is gone.
  - Model labels come from the server catalog.

### 2026-10-13--23-33 — Stage 15.3.1 — refresh stale Backend and resync comments

**Implemented by:** Claude Code (Claude Opus 5.5) — 2026-10-13--23-33
**Commit(s):** `0d346d1`

- Comment-only; no behaviour change. Found while writing `docs/OpenCode-v1-v2-adaptation-layer.md`.
- `src/backend/types.ts`:
  - The file header describes both backends and the v1-derived neutral shapes.
  - `BackendEvents` names the `V2EventTranslator` forwarding next to the `src/events.ts` one.
  - `replyForm` and `cancelForm` state that `V2Backend` rejects on an error status.
- `src/events.ts`: the `resync-needed` comment describes the incremental resync.
- Verification: `bun test src/` passes 748 tests, 0 fail; the tsgo error set is unchanged.

### 2026-10-13--22-50 — Stage 15.3 — OpenCode v2 parity

**Implemented by:** Claude Code (Claude Haiku 5.5) — 2026-10-13--22-50
**Commit(s):** `a7a65a0`

- Command echo (`src/backend/v2-events.ts`, `src/backend/v2.ts`, `src/backend/types.ts` doc
  comment): one pending echo slot per own command. `recordOwnCommandPrefix` arms the slot, and
  `claimUserItem` is the one claim rule for the live inbox path and the resync path. `V2Backend`
  releases the slot when a command fails (`releaseCommandEcho`). `/review`, `/init` and `/rag`
  render once, without their expanded templates.
- `/model` (`src/backend/v2.ts`, `src/app.tsx`): the `V2Backend` model cache follows
  `session.model.selected`, so a switch made elsewhere is adopted and a later own reselect sends
  `switchModel`. `app.tsx` compares `model-selected` with `activeModelRef`. The one-shot
  `lastRequestedModelRef` is removed.
- `/compact` (`src/resync-gate.ts`, `src/app.tsx`): a resync ends the compacting state through
  `shouldEndCompacting`, because the server skips one durable seq between `compaction.started`
  and `compaction.ended`.
- Replay "Interrupted" marker (`src/replay.ts`, `src/backend/v2-queries.ts`): v1 uses
  `MessageAbortedError`, and v2 uses the idle outcome `interrupted`. The marker follows the
  turn's `turn-end`. It appears on full replay only.
- Status line (`src/utils/formatters.ts` `deriveProjectName`, `src/app.tsx`): the label is the
  basename of the server directory.
- Hint gating (`src/utils/formatters.ts` `abandonHint`, `src/app.tsx`): the error line appends
  `/brain-abandon` or `/duo-abandon` only while an orchestra run is active.
- Deliberate v1 output changes:
  - replay shows "Interrupted" after an aborted turn;
  - the abandon hint no longer appears after Ctrl-C without an active orchestra run.
- C3.1 (orchestra on a remote host): fenced off. Docs only, no code. See the Known limits.
- Tests: `src/backend/v2-events.test.ts`, `src/backend/v2.test.ts`,
  `src/backend/v2-queries.test.ts`, `src/replay.test.ts`, `src/resync-gate.test.ts`,
  `src/utils/formatters.test.ts`.
- Defects found and fixed during the stage:
  - Review 1 (MAJOR): the echo slot leaked when a command failed before its echo arrived. A
    failed command now releases its slot. A test covers the prefix-only path with the slot at 0.
  - Review 2 (MAJOR): the slot leaked when a successful command's echo was seen only through
    resync. The live and resync paths now share `claimUserItem`.
  - Live `/compact` wedge (shipped in 15.2): input stayed locked after a compaction, because
    the server skips durable seq N+1 between `compaction.started` (N) and `compaction.ended`
    (N+2). The gap dropped `compaction.ended`, and nothing cleared `isCompacting`. Seen at 46→48
    live and 83→85 in capture 3b. Fixed by `shouldEndCompacting`.
- Verification:
  - `bun test src/`: 743 pass, 0 fail.
  - tsgo: 67 errors, the same multiset as the baseline at `b1e205d`.
  - v1 smoke test against `127.0.0.1:4096`: 8/8.
  - v2 live checklist on OpenCode 2.0.28 (MBP): 11/11 after FIX-3. The items are: a subagent
    dispatch, with the child permission surfacing in the parent modal; `/review` and `/rag` each
    render once (the `# /`-prefixed custom commands were not run, because they act on the
    orchestra state); `/fork`, `/rename`, `/sessions` and `/new`;
    `/model` select changes the next `session.step.started.model`; a foreign REST `/model`
    switch is adopted; a later own reselect sends `switchModel`; a foreign REST prompt renders;
    `--multi-window`; `/compact`; `--resume` shows the "Interrupted" marker; the status line
    shows the server directory basename.
  - Fresh reviews: four rounds were dispatched. Round 3 was stopped unfinished when FIX-3 was about
    to change the tree. Rounds 1, 2 and 4 completed with FIX, FIX and PASS. Round 4 is the final
    verdict, with two minors recorded below.
  - Pre-existing items were classified by A/B against `b1e205d`, the 15.2 build.
- Remaining pre-existing follow-ups (not in 15.3):
  - v1 `/compact` prints a second divider before the last summary line. Same at `b1e205d`.
  - Burst-typed input (a paste, or multi-char input) leaves the cursor at 0, so Backspace deletes
    the first char. Same at `b1e205d`.
  - The session picker labels any session with `parentID` as a fork
    (`SessionPickerModal.tsx:35`). On v2 the subagent child is labelled a fork, and a real v2
    `/fork` (no `parentID`) gets no label.
  - `/fork` and `/new` print only the 8-char id prefix.
  - `GET /api/session` ignores the `location[directory]` filter (server side).
  - `isRendered`'s `userText` parameter is unused in production. Only the tests reach the prefix
    branch.
  - Carried from 15.2: tmux-window line buffers are keyed by role (F-d); short session-id
    prefixes collide in the pickers; tall pickers leave stale rows after Esc; an occasional 3 s
    health-probe timeout right after a previous octmux exit; replay hides tool output when
    tools-output is off.

### 2026-10-13--20-52 — Stage 15.2 — native OpenCode v2 core

**Implemented by:** Claude Code (Claude Haiku 5.5) — 2026-10-13--20-52
**Commit(s):** `390aa04`

- `V2Backend` (`src/backend/v2.ts`) on `@opencode/client`. Covers sessions, prompts
  with a client prompt id, commands, compaction, model select (`ModelInfo.id`),
  permissions (location-scoped), forms (list, reply, cancel), and cursor-only paging.
  `listProviders` uses `model.list()`. `/api/provider` is never called. Write errors
  are readable (`LocationNotFoundError` names `server.directory`).
- `V2EventTranslator` (`src/backend/v2-events.ts`): streaming text, reasoning and tools
  keyed by message and start order, shared with history. Tool exit markers. Turn ends
  and retries. Own-echo suppression. Subagents. Permissions (including discovery
  input). Forms. Compaction. `model-selected`. Durable `seq` gaps produce
  `resync-needed`.
- v2 queries and history: `src/backend/v2-queries.ts` (`translateHistoryV2`, the v2
  events reads, `getMissedHistory`), and `src/backend/v2-ancestry.ts`.
- App: `FormModal` (`src/components/FormModal.tsx`, `form-modal-logic.ts`,
  `form-state.ts`). Permission resources. Retry lines, compaction state, exit marker.
  Incremental resync through `ResyncGate` (`src/resync-gate.ts`), with discovery.
  `model-selected` handling. `turn-status.ts`.
- Startup: one flow for v1 and v2. v2 no longer exits. `server.directory` in
  `octmux.json`, refused with `--worktree` and `--auto-spawn` (exit 2). The default
  session creation failure is reported and exits 1.
- Renderer and input (v1 and v2): non-text streaming (summary, reasoning) accumulates
  complete lines instead of one prefixed line per delta. Reasoning tails are flushed
  before the turn separator (D-B). A lone ESC held by the paste filter is released after
  40 ms, so Escape reaches the modals. Child stderr from git and tmux no longer writes
  behind Ink (G1).
- Verification:
  - `bun test src/`: 712 pass, 0 fail.
  - tsgo: 67 errors, the same multiset as the baseline. None in `src/backend/v2*`.
  - Fresh reviewers: A (protocol layer) PASS, with one dead-code note fixed. B
    (integration and UI) FIX, with four findings fixed. Targeted re-review PASS.
  - Live checklist on OpenCode 2.0.28, with re-checks after each live fix.
  - v1 regression smoke tests against the local v1 server.
  - A/B checks against the previous build for the pre-existing bugs listed below.
- Live defects found and fixed:
  - D1: v2 write errors were swallowed. They now reject with a readable message.
  - D2: models were keyed by `modelID`. They are now keyed by `ModelInfo.id`.
  - D-A: the first prompt of a new session rendered twice. A benign seq gap triggered a
    full clear and replay. It is now an incremental resync that renders only the
    unrendered messages.
  - D-B: a reasoning block with no trailing newline was lost, or rendered after the
    turn separator. Fixed in the renderer.
  - G1: a frozen "generating 0:00" line after each v2 turn. Git's stderr was written
    to the TTY behind Ink.
  - G3: `getMissedHistory` skipped an interrupted or failed assistant message that had
    no completion time. It now counts such messages as ended.
  - G2: the v2 context meter stuck at about 8.0K. No defect was reproduced. Two paged
    regression tests were added. The final live re-check matched the status-line context
    value to `input + cache.read + cache.write` of the newest assistant message on all 9
    turns (8.0K to 8.1K).
  - Pre-existing, found while testing and fixed in this stage: non-text streaming
    fragmented into one line per delta, and a lone ESC held by the paste filter that
    never reached modals.
- Remaining pre-existing follow-ups (not in 15.2):
  - Replay shows no "Interrupted" marker for an aborted turn, and hides tool output
    when tools-output is off.
  - The "/brain-abandon" hint appears after Ctrl-C even without an active `/brain`.
  - An occasional 3 s health-probe timeout right after a previous octmux exit.
  - Tmux-window line buffers are keyed by role (F-d).
  - Short session-id prefixes collide in the pickers.
  - Tall pickers leave stale rows after Esc.

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
