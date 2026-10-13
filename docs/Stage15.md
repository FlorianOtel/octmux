---
title: "Stage 15 — OpenCode v2 native session support, Backend seam"
created_at: 2026-10-13--16-41
created_by: Claude Code (Claude Haiku 5.5)
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
| 15.1 | `Backend` interface; `V1Backend` adapter; all call sites use `Backend` | shipped (this entry) |
| 15.2 | `V2Backend`; interface reshaped around protocol-neutral operations | planned |
| 15.3 | v2 parity with v1 features | planned |

Stage 15.1 does not make v2 usable. A v2 server still exits with the Stage 14
message "native v2 session support is not yet implemented".

## Backend seam design

### Interface layout

`Backend` (`src/backend/types.ts`) has three kinds of member:

- `session: BackendSession` — session-scoped REST operations: `getMessages`,
  `getChildren`, `get`, `abort`, `create`, `compact`, `list`, `fork`, `update`,
  `sendCommand`, `sendPrompt`. Each one mirrors the v1 `client.session.*` call it
  replaces.
- `events: BackendEvents` — the event pipeline helpers: `translateEvent`,
  `resetEventState`, `synthesizeSessionIdleEvents`, `hasOpenStreamingPart`,
  `recordOwnMessageID`, `recordOwnCommandPrefix`, `classifyUserTurn`.
- Flat operations: `listCommands`, `getDefaultModelConfig`, `listProviders`,
  `listQuestions`, `listPermissions`, `rejectQuestion`, `replyQuestion`,
  `replyPermission`, `isSessionDescendant`, `subscribeEvents`, `replaySession`.

`ReplEvent` is re-exported from `src/events.ts` unchanged. Stage 15.1 does not
neutralise the event type.

### Why option-object arguments

Session methods take the same option objects as the v1 SDK (`{ path: { id } }`,
`{ query: { directory } }`, `{ body: … }`). The types are derived from the
generated `*Data` types with `url` removed (`V1Request<TData>`). Call sites were
swapped without changing their argument shapes, so the swap is a rename. The
only renames are `summarize` → `compact`, `command` → `sendCommand`, and
`promptAsync` → `sendPrompt`. Stage 15.2 is expected to replace these shapes.

### `listProviders` and the v2 `/api/provider` route

`listProviders()` wraps the v1 `client.provider.list()`. It is not the v2 route
`/api/provider`, which returns plaintext API keys and must never be called from
octmux. The interface doc-comment carries this warning. A future v2 implementation
must back `listProviders` with a provider-metadata route that does not expose
credentials.

### Module placement

`src/backend/v1.ts` is the only file that imports the v1 event, replay and ancestry
code. The following modules are referenced by `V1Backend`, not moved:

- `src/events.ts` — event translation and the module-level pipeline state.
- `src/replay.ts` — `replaySession`, which still takes the raw v1 client.
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
- `V2Backend` is Stage 15.2.

---

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
