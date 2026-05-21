---
title: "octmux — Implementation Plan"
created_at: 2026-05-18--21-58
created_by: Claude Code (Claude Sonnet 4.6 1M)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-05-21--17-18
context: >
  octmux is a text-only barebones REPL UI for OpenCode that mimics the Claude
  Code CLI feel: text REPL, one bottom status line, Emacs-style line edits,
  multi-line via Alt-Enter, Esc / double-Esc semantics. Runs inside tmux (one
  octmux REPL per tmux window, independent sessions). Built on TypeScript +
  Bun using the official @opencode-ai/sdk. Sub-agent visualization is
  delegated to opentmux (existing OpenCode server-side plugin that auto-spawns
  tmux panes on session.created events). Orchestration is delegated to
  opencode-orchestra (slash-command framework: /brain, /duo-plan, /duo-act,
  etc.) which octmux invokes by forwarding unknown slash commands to the
  server. This document holds both the forward phase plan and a reverse-
  chronological implementation log; phases get logged at the top as they ship.
---

# octmux — Implementation Plan

## Context

octmux is a focused TUI client over OpenCode's HTTP API. It is NOT a tmux
manager, NOT a sub-agent orchestrator, NOT a plugin host. It lives in the
main pane of a tmux window and lets opentmux split sub-agent panes off to
the right (see `~/Gin-AI/projects/opentmux/assets/demo.png` for the target
layout). Orchestra slash commands (`/brain`, `/duo-*`) are forwarded to the
server's command endpoint — octmux does not implement orchestration logic
itself.

## Locked decisions

1. **Stack:** TypeScript on Bun. Use `@opencode-ai/sdk` (installed at
   `~/.config/opencode/node_modules/@opencode-ai/sdk`, v1.15.4). Ship via
   `bun build --compile` as a single executable.
2. **Server lifecycle:** dual mode.
   - Default — auto-spawn `opencode serve --port <free>` per tmux window.
     Port range `[4096, 4106]` (mirrors opentmux).
   - Flag — `--attach <port>` connects to an existing server.
3. **Input layer:** Ink (React for CLI) for region composition and resize/repaint.
   `LineEditor` state machine (`src/editor.ts`) preserved as a pure buffer/history
   container; Ink's `useInput` hook drives it. Bottom-anchor via Ink's
   Static-above-dynamic layout. All Emacs bindings, multi-line, bracketed paste,
   history, double-Esc clear preserved. No readline.
4. **Output layer + pane scope.** Output is a typed block model (`text` / `thinking`
   / `tool-call` / `tool-result` / `user` / `error`) with a `Renderer` interface.
   **Ink's responsibility is strictly bounded to the single origin pane's interactive
   chrome** — input editor, rules, status line, and modals. Ink does not own
   multi-pane/multi-window layout. The default `StdoutRenderer` writes ANSI-formatted
   lines via `<Static>` at line granularity; the terminal handles layout for streamed
   content. **tmux is the pane manager and framing engine** — pane/window creation,
   geometry, titles, focus, resize, detach/reattach. octmux issues no `set-option`
   or `set-window-option` commands except for `automatic-rename off` (needed to
   prevent tmux renaming `new-window` constructs to the running command).
   `TmuxPaneRenderer` (`--multi-pane`) and `TmuxWindowRenderer` (`--multi-window`,
   recommended default for SSH/TTY) are the two multiplex backends, both routing
   `tool-call` and `tool-result` to a shared `"tools"` sink. **opentmux is the
   future cross-pane coherence layer** — built on the role → log-file → tmux-construct
   contract that Phase 3-UX establishes.
5. **Slash commands:** full set with interactive UX.
   - Local with custom UX: `/exit`, `/clear`, `/help`, `/model`, `/agents`, `/show`.
   - All other `/foo` forwarded to `POST /session/{id}/command` (orchestra
     commands and any future server-registered command get it for free).
6. **tmux:** required (env `TMUX`). Soft override `--no-tmux-guard`.

## Architecture at a glance

```
src/
  index.tsx              entry: args, lifecycle, renderer selection, render(<App/>)
  server-lifecycle.ts    port scan, spawn `opencode serve`, health probe, dispose
  events.ts              SSE dispatcher: filter by sessionID, emit block events
  blocks.ts              typed Block model + formatLine() ANSI formatter
  app.tsx                <App>: chrome + Static scrollback, thin renderer translation
  editor.ts              LineEditor: pure state machine, Emacs keymap, history
  keybindings.ts         all Ink 5 key dispatch
  renderer/
    types.ts             Renderer interface
    stdout.ts            StdoutRenderer: Static-backed, default backend
    visibility.ts        per-role on/off toggles + /show slash-command parser
    fifo.ts              log-file IPC (regular append-mode temp files, not FIFOs)
    tmux-pane.ts         TmuxPaneRenderer: --multi-pane, 2 eager side panes
    tmux-window.ts       TmuxWindowRenderer: --multi-window, lazy side windows
  components/
    PromptInput.tsx      Ink input wrapper
    Rule.tsx             horizontal rule with optional title
    StatusLine.tsx       [idle] + hidden-role badges
    PermissionModal.tsx  y/a/n inline permission prompt
    QuestionModal.tsx    numbered-options question modal
```

One source file per concern. Grow organically; do not pre-explode.

## Document conventions

- The **Implementation log** below holds reverse-chronological entries (newest
  at top) for each completed phase. Format:

  ```
  ### YYYY-MM-DD--HH-MM — Phase N: <name>
  **Implemented by:** <agent name (model)>
  **What shipped:** <bullets>
  **What changed in this doc:** <e.g. "Phase N status flipped to ✓ in the
    Phase plan below; updated_at refreshed">
  **Suggested next steps for Phase N+1:** <bullets, including anything the
    next phase should know that wasn't in the original spec>
  ```

- The **Phase plan** further down is the design reference and execution
  order. When a phase ships, mark its status `✓ shipped — see log
  YYYY-MM-DD--HH-MM` but do not delete or rewrite the phase spec; it's the
  historical contract.
- After every save: update `updated_by` and `updated_at` in the frontmatter
  per global doc rules (timestamp = `date +"%Y-%m-%d--%H-%M"`).

## Implementation log (reverse chronological — newest at top)

### 2026-05-21 — Phase 3 UX: typed block renderer + tmux multiplex (3U.1–3U.7)

**Implemented by:** Claude Code (Claude Haiku 4.5 + Claude Sonnet 4.6, multiple sessions)

**What shipped:**
- **Typed block model** (`src/blocks.ts`): `Role` type, `Block` type, `formatLine()`
  ANSI formatter with per-role prefixes (`│ ` thinking, `⚙ ` tool-call, `↳ ` tool-result).
- **Static scrollback** (`src/app.tsx`): replaced `streamBuf`/debounce with line-granularity
  `<Static>` commits. The dynamic region holds only the chrome (≤8 lines). Flicker eliminated.
- **Per-role visibility** (`src/renderer/visibility.ts`): `/show thinking off` / `/show tools off`
  suppress roles; hidden counts displayed in StatusLine badges.
- **`Renderer` interface** (`src/renderer/types.ts`, `src/renderer/stdout.ts`): rendering
  logic extracted from `app.tsx`; `StdoutRenderer` is the default; `app.tsx` is a thin
  SSE-to-renderer translation layer.
- **`TmuxPaneRenderer`** (`--multi-pane`): 2 side panes (thinking + tools) spawned eagerly
  at startup. Layout: `main | thinking / tools` (tools below thinking in right column).
  `tool-call` and `tool-result` share the `tools` pane via `PANE_KEY` map.
- **`TmuxWindowRenderer`** (`--multi-window`, recommended default): up to 2 side windows
  spawned lazily on first block. Window names: `<session>-thinking`, `<session>-tools`.
  Sessions with no thinking get no thinking window; sessions with no tool calls get no
  tools window. `WINDOW_KEY` map routes both tool roles to `"tools"`.
- **IPC via regular log files** (`src/renderer/fifo.ts`): named FIFOs attempted and
  rejected — O_RDWR FIFOs cause libuv to consume data via event-loop readability
  monitoring. Regular append-mode files (`/tmp/octmux-PID-KEY.log`) + `tail -f` is reliable.
- **`--multi-window` / `--multi-pane` guard**: both flags require a real tmux pane; stale
  TMUX_PANE env (inherited by child terminals) detected via `/proc/self/fd/0` readlink
  vs `tmux display-message -p -t $TMUX_PANE "#{pane_tty}"`. Flags are mutually exclusive.
- **Cleanup (3U.7)**: `text-delta` compat alias removed from `ReplEvent` union; `blocks.smoke.ts`
  deleted; README rewritten with multiplex docs; this doc updated with locked decision #4.

**What changed in this doc:** locked decision #4 added; Phase 3 UX entry inserted in Phase
plan; "Architecture at a glance" updated to reflect actual source tree; "Critical files"
updated; this log entry prepended; frontmatter refreshed.

---

### 2026-05-20--17-40 — Phase 3 Extended: Ink rendering layer (3E.1–3E.6)

**Implemented by:** Claude Code (Claude Sonnet 4.6 + Actor Claude Haiku 4.5, across multiple sessions)

**What shipped:**
- **3E.1** — Ink + React installed under Bun; `tsconfig.json` JSX support; hello-world proof that `bun run dev` and `bun build --compile` both work with Ink + Yoga WASM.
- **3E.2** — `src/editor.ts` (pure `LineEditor` state machine, all I/O stripped); `src/components/PromptInput.tsx` (Ink wrapper with full Emacs binding table); `src/components/Rule.tsx` (horizontal rule with optional title + right-align); `src/keybindings.ts` (all key dispatch in one place, three Ink 5 quirks documented).
- **3E.3** — `src/app.tsx` (`<App>` with `<Static>` scrollback + full SSE loop); `src/components/StatusLine.tsx` (`[idle]` stub); `src/index.tsx` slimmed to lean entry (~110 lines). Draft preservation added to `LineEditor` (`_draft` field).
- **3E.4** — `src/components/PermissionModal.tsx` (y/a/n inline modal); `src/components/QuestionModal.tsx` (numbered-options modal); permission and question events wired into `<App>` replacing the auto-approve placeholder; `baseUrl` prop added.
- **3E.5** — Alternate scroll mode (`DECSET 1007`) maps wheel events to arrow keys without intercepting clicks, preserving text selection. Ctrl-C during generation: `session.abort()` + `editor.loadText(lastSubmitted)`. Ctrl-C on non-empty idle buffer: `clearBuffer()` (no exit prompt). Turn spacing: two blank lines after each scrollback entry.
- **3E.6** — Deleted `src/index.ts.phase2.bak`; README rewritten (Architecture, key bindings table, tmux config); this doc updated (locked decision #3, Phase 3 Extended phase entry); `docs/Phase3-Extended.md` log completed.

**What changed in this doc:** locked decision #3 updated to Ink; Phase 3 Extended inserted into Phase plan; Phase 3 status updated; log entry prepended; frontmatter refreshed.

**Suggested next steps for Phase 4:** `src/components/StatusLine.tsx` is already plumbed and renders `[idle]`. Phase 4 creates `src/state.ts` (model, tokens, cost, mode, orchestra badge) and feeds it into StatusLine props. The 4-line status area below the bottom rule is already reserved (`marginBottom={3}` on the bottom Box = StatusLine + 3 blank lines).

---

### 2026-05-19--15-37 — Phase 2: Auto-spawn server + tmux guard

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)

**What shipped:**
- src/server-lifecycle.ts (new): findFreePort (TCP bind probe, range [4096, 4106]),
  findOpencodeBin (~/.opencode/bin/opencode fallback), waitForHealth (200ms poll +
  10s deadline), spawnOpencodeServer (Bun.spawn + proc.unref + dispose handle).
- src/index.ts: --help, --version, --no-tmux-guard flags; tmux guard
  (process.env.TMUX check); auto-spawn vs --attach branch for baseUrl resolution;
  SIGTERM handler; serverHandle?.dispose() wired to rl.on("close") and SIGINT
  double-Ctrl-C exit path. Removed Phase 0 debug output (health: ok, sessions count).
- Ctrl-C behavior: single Ctrl-C during generation aborts (unchanged from Phase 1.5).
  Single Ctrl-C when idle now prints "(Press Ctrl-C again to exit)" — double Ctrl-C
  within 3s exits with dispose. Retroactively correct for attach mode (serverHandle
  is null → dispose() is a no-op).
- Phase 1.5 streaming/modal/abort behavior unchanged.

**Suggested next steps for Phase 3:** raw-mode input replaces readline.
  respondPermission/respondQuestion will need the raw-mode single-keypress path.

---

### 2026-05-19--15-03 — Phase 1.5c+1.5d: Status display + interactive modals

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)

**What shipped:**
- events.ts: added "permission-asked" (handles both v1 "permission.updated" and v2
  "permission.asked") and "question-asked" (v2, cast via unknown) event kinds.
  "session-status" retry now surfaced to index.ts (was previously returned but ignored).
- index.ts: respondPermission() — inline y/a/n prompt → client.postSessionIdPermissionsPermissionId().
  respondQuestion() — numbered options prompt → raw fetch /question/{id}/reply.
  SSE loop now handles all 8 ReplEvent kinds.
- Build check passed; TypeScript clean with zero errors.

**Why dual permission handler:** opencode server may fire v1 "permission.updated" or v2
  "permission.asked" depending on session type; handle both for safety.

**Graceful degradation:** respondQuestion() fetch failures write to stderr and resolve (don't crash the REPL).

**Suggested next steps for Phase 3:** raw-mode input layer replaces readline;
  respondPermission/respondQuestion will need to use the raw-mode single-keypress path.

---

### 2026-05-19--13-08 — Phase 1.5b: True streaming via `message.part.delta`

**Implemented by:** Claude Code (Claude Sonnet 4.6, interactive session)

**What shipped:**
- `events.ts`: replaced `seenPartLength` Map with `seenPartIDs` Set. Added handler for
  `"message.part.delta"` event type (field `"text"`) as the **primary streaming path** —
  each delta event carries an incremental text chunk that is emitted directly as
  `{ kind: "text-delta", text: delta }`. Simplified `"message.part.updated"` handler to
  only emit `"generating"` on the len=0 creation event; text content no longer comes
  from the len=N accumulated-text event.

**Root cause of previous batching:**
`EventMessagePartDelta` is a **separate event type** (`"message.part.delta"`) that is
not in the v1 SDK `Event` union but IS fired by the opencode server. The `delta` field
on `EventMessagePartUpdated.properties` is always null (that was correct). The Phase 1.5
plan confused these two events. Fix: cast via `unknown` and handle `event.type ===
"message.part.delta"` directly.

**Live verification (2026-05-19 ~13:08):**
```
13:05:25.612  message.part.delta  field='text'  delta='tm'
13:05:25.716  message.part.delta  field='text'  delta='ux is a terminal multiplexer...'
13:05:25.933  message.part.delta  field='text'  delta=' workflows. It allows...'
13:05:26.148  message.part.delta  field='text'  delta=', making it essential...'
13:05:26.246  message.part.delta  field='text'  delta='` to transform your...'
```
Chunks arrive ~100–200ms apart. Not token-by-token, but genuine streaming (the opencode
server accumulates ~50 chars / ~1 token-group per chunk before firing). `index.ts`
unchanged — `"text-delta"` kind is the same interface.

**Lesson learned:** `message.part.delta` (separate event) ≠ `EventMessagePartUpdated.properties.delta`
(always null). The v2 SDK types define `EventMessagePartDelta` with `delta: string`
(non-optional). The server fires it for all v1 sessions. No v2 API migration needed.

---

### 2026-05-19--10-38 — Phase 1.5a: Streaming UX scaffolding (indicator + abort)

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)

**What shipped:**
- `events.ts`: added `"generating"`, `"session-status"`, `"part-removed"` event kinds. Detection of len=0 creation event emits `"generating"` signal. `session.status` and `message.part.removed` now handled.
- `index.ts`: switched `session.prompt()` → `session.promptAsync()` (returns 204 immediately). `isGenerating` flag + `[generating…]` indicator on stdout. Ctrl-C during generation calls `session.abort()` instead of exiting; Ctrl-C when idle exits cleanly.

**Note:** This phase used the accumulated-slice approach from `message.part.updated`.
True streaming was missing; fixed in Phase 1.5b above.

---

### 2026-05-18--23-20 — Phase 1: Post-ship debugging + streaming investigation

**Implemented by:** Claude Code (Claude Sonnet 4.6 1M, interactive session)

**What shipped:**
- Fixed `src/events.ts`: removed the `e.properties.delta` guard (delta is always
  absent in real opencode events); now tracks accumulated `part.text` per `partID`
  via `seenPartLength` map and computes the new slice on each event.
- Fixed `src/events.ts`: added `message.updated` handler to record user-message
  IDs (`role: "user"`) into `userMessageIDs`; `message.part.updated` handler now
  skips parts whose `messageID` is in that set — prevents echoing the user's own
  input back to them.
- Fixed `src/events.ts`: added `session.error` handler — surfaces
  `EventSessionError.properties.error.data.message` to the REPL as
  `{ kind: "error" }`.
- Fixed `src/index.ts`: added `error` branch in the SSE loop to print
  `[error] <message>` to stderr so model failures are visible.

**Streaming investigation — what was tested and lesson learned:**

Three-layer test was run to locate where "output appears all at once" originates.

_Layer 1 — SoHoAI gateway (direct curl with `stream: true`):_
- Model **kimi-k2.6** (`ollama-cloud/kimi-k2.6`): SSE chunks arrive every ~70ms ✅
  streaming. But kimi-k2.6 is a **thinking model** — it streams `reasoning_content`
  tokens for ~1.5 s, then dumps all `content` tokens in a tight burst (~300 ms).
  So content appears all at once even though the transport is streaming.
- Model **claude-haiku-4-5** (`anthropic/claude-haiku-4-5`): response delivers in
  2 content chunks within 60 ms total ✅ gateway streams fine; too fast/small to
  observe gradual rendering for a short prompt.
- **Gateway verdict: not the bottleneck.** Both models stream correctly at the
  HTTP/SSE transport level.

_Layer 2 — opencode server SSE (`/global/event`):_
Captured `message.part.updated` events with millisecond timestamps while sending
a prompt. Pattern observed for **both** models:

```
T+0.0 s  text part created (len=0)     ← model starts generating
T+N.N s  text part complete (len=296)  ← full text in ONE event
T+N.N s  session.idle
```

opencode fires exactly **two** `message.part.updated` events per text part — one
at creation (len=0, no text yet) and one at completion (len=N, full text). It
accumulates all LLM tokens internally and never emits intermediate events. The
`delta` field defined in `EventMessagePartUpdated` is never populated.

- **opencode verdict: this is the buffering layer.** Regardless of model or
  whether the upstream LLM streams token-by-token, opencode collapses all tokens
  into a single final event.

_Layer 3 — octmux:_
- Correctly handles what opencode delivers. Code is not the issue.
- **octmux verdict: working as designed.** The "all at once" appearance is an
  opencode architectural decision, not a bug in octmux.

**Consequence for Phase 4 (status line):**
- Token-by-token streaming in the octmux viewport is **not achievable** with
  opencode's current event API. Do not design Phase 4 assuming incremental text.
- The correct UX pattern: show a `[generating…]` / spinner in the status line
  from the moment the text part is created (len=0 event) until `session.idle`
  fires. This gives the user feedback during the generation wait without requiring
  incremental text delivery.
- The `reasoning` part (kimi-k2.6 and other thinking models) follows the same
  two-event pattern: created at len=0, complete at len=N. It can be used to drive
  a `[thinking…]` status badge distinct from `[generating…]`.

**What changed in this doc:** new log entry prepended; Phase 1 entry below
unchanged (it recorded what Actor shipped, not the debugging). Frontmatter
`updated_by` and `updated_at` refreshed.

---

### 2026-05-18--22-31 — Phase 1: Hello-world REPL with streaming

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)

**What shipped:**
- `src/events.ts` — `filterEvent()` narrows SDK `GlobalEvent` payloads to
  `text-delta` and `session-idle` for our sessionID; sub-agent events dropped.
- `src/index.ts` — readline REPL: creates session, opens SSE via
  `client.global.event()`, streams token deltas to stdout, waits for
  `session.idle` between turns, exits on Ctrl-C.
- TypeScript builds clean with zero errors.
- Corrected plan: event subscription is `client.global.event({})` (not
  `client.event({})`); events arrive as `GlobalEvent.payload`.

**What changed in this doc:** Phase 1 status → ✓ shipped; frontmatter updated.

**Suggested next steps for Phase 2:**
- `server-lifecycle.ts`: port scan, spawn `opencode serve`, health probe,
  dispose — so `octmux` works without a separate `opencode serve` terminal.
- tmux guard: check `process.env.TMUX`; exit 1 with friendly message if absent.
- `src/index.ts` entry: branch on `--attach` vs. auto-spawn; pass `baseUrl`
  through to the rest of the code unchanged.

---


### 2026-05-18--22-16 — Phase 0: Skeleton + SDK smoke test

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)

**What shipped:**
- `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts` created.
- `bun install` resolves `file:` SDK dep from `/home/florian/.config/opencode/...`
- TypeScript builds clean (`bun build`, zero errors).
- Graceful-failure test: exits 1 with `health: failed` when no server.
- bun path: `/home/florian/.bun/bin/bun` (user-local; use full path in scripts).

**What changed in this doc:** Phase 0 status → ✓ shipped; frontmatter updated_at refreshed.

**Suggested next steps for Phase 1:**
- `createOpencodeClient({ baseUrl })` is confirmed working.
- Phase 1 can call `client.session.create()` and `client.event({})` directly.
- Keep `src/index.ts` as the single entry file; split to `events.ts` when needed.

---

### 2026-05-18--21-58 — Phase −1: Planning

**Implemented by:** Claude Code (Claude Sonnet 4.6 1M, plan-mode session)

**What shipped:**
- Explored `~/Gin-AI/projects/opencode-orchestra`,
  `~/Gin-AI/projects/opentmux`, and the `@opencode-ai/sdk` surface.
- Confirmed octmux's scope is narrow: opentmux owns sub-agent panes;
  orchestra owns orchestration; octmux only owns the primary REPL pane and
  forwards unknown slash commands.
- Locked 5 decisions (stack, server lifecycle, input layer, slash scope, tmux
  guard) — see "Locked decisions" above.
- Drafted 7 phases (Phase 0..7), each independently demoable in 0.5–3 days.
- Persisted plan to `docs/Implementation-plan.md` (this file) with metadata
  and reverse-chronological log structure.

**What changed in this doc:** initial creation.

**Suggested next steps for Phase 0:**
- Confirm `bun install` resolves `"@opencode-ai/sdk": "file:..."` pointing at
  `~/.config/opencode/node_modules/@opencode-ai/sdk` before writing real
  code.
- Pin Bun version (`bun --version`) in `package.json#engines` for
  reproducibility.
- Don't gold-plate Phase 0 — the smoke test exits after one `session.list`
  call; UI work starts in Phase 1.

## Phase plan (forward execution order)

### Phase 0 — Skeleton + SDK smoke test (½ day)

**Status:** ✓ shipped — see log 2026-05-18--22-16

**Goal:** confirm Bun + the SDK + a running opencode server can talk. No UI.

**Deliverable:** `bun run src/index.ts --attach 4096` connects, prints
`health: ok` and the session count, exits 0.

**Files to create:**
- `package.json` (`type: module`, dep `@opencode-ai/sdk` via `"file:..."`,
  devDep `@types/bun`, scripts `dev`/`build`/`compile`)
- `tsconfig.json` (`target: ES2022`, `module: ESNext`,
  `moduleResolution: bundler`, `types: ["bun"]`, `strict: true`)
- `.gitignore` (`node_modules/`, `dist/`, `*.log`)
- `src/index.ts` (parse `--attach`, `createOpencodeClient`,
  `client.session.list({})`, print, exit)

**Key SDK calls / reused patterns:**
- `createOpencodeClient({ baseUrl })` from `@opencode-ai/sdk`.
- Health-probe pattern from
  `~/Gin-AI/projects/opentmux/src/bin/opentmux.ts:122` (`isOpencodeHealthy`).

**Manual verification:**
1. In one terminal: `opencode serve --port 4096`.
2. In another: `cd /mnt/nfs/Florian/Gin-AI/projects/octmux &&
   bun run src/index.ts --attach 4096`.
3. Expect `health: ok` and the session count on stdout.

**Handoff to Phase 1:** server URL resolution and SDK client construction
proven; no UI, no streaming yet. Phase 1 can assume the SDK works.

---

### Phase 1 — Hello-world REPL with streaming (1 day)

**Status:** ✓ shipped — see log 2026-05-18--22-31

**Goal:** type a prompt, hit Enter, watch the response stream in. Ctrl-C to
quit. **No** raw mode (use Node `readline`). **No** slash commands. **No**
status line.

**Deliverable:** usable single-turn-at-a-time REPL with live streaming.

**Files to create / modify:**
- `src/index.ts` — replace smoke test:
  1. Resolve server URL (`--attach` only).
  2. Create session via `client.session.create({ body: { title: "octmux" } })`.
  3. Open SSE via `await client.event({})`; iterate `for await (const ev of
     stream.stream)`.
  4. `readline` loop reading from stdin; on each line, call
     `client.session.prompt({ path: { id }, body: { parts: [{ type: "text",
     text: input }] } })` (synchronous prompt for Phase 1; switch to
     `promptAsync` in Phase 4).
  5. On `EventMessageUpdated` with `info.role === "assistant"` and
     `info.finish` set, print newline + redraw `> ` prompt.
- `src/events.ts` — small dispatcher: takes a raw `Event` and the active
  `sessionID`, returns `{ kind, text? }`. Drop events whose
  `properties.part.sessionID` (or `properties.info.sessionID`) doesn't
  match — sub-agent events go to opentmux panes, not our main view.

**Key SDK calls / behaviors:**
- `client.event({})` — SSE subscription returns `{ stream }` async iterable.
- `client.session.prompt({ path, body })` — confirmed in `sdk.gen.d.ts`;
  blocks until completion.
- Event filtering: only show `message.part.updated` where
  `properties.part.type === "text"` and `properties.part.sessionID ===
  ourSessionID`.

**Manual verification:**
1. With opencode server on 4096, run `bun run src/index.ts --attach 4096`.
2. Type `tell me a haiku about tmux`. Tokens stream in. Enter works for a
   second turn.
3. Ctrl-C exits cleanly.

**Out of scope:** tool-call rendering (print `[tool: read]` stub), reasoning
blocks, multi-line input, history, status line, server spawn, slash commands.

**Handoff to Phase 1.5:** REPL loop and SSE dispatcher are working;
Phase 1.5 adds streaming polish (indicator, abort, permission/question modals) on top of the Phase 1 readline skeleton.

---

### Phase 1.5 — Streaming UX + interactive modals (½ day)

**Status:** ✓ shipped — see log 2026-05-19--15-03 (1.5c+1.5d), 2026-05-19--13-08 (1.5b), 2026-05-19--10-38 (1.5a)

**What was built (4 sub-phases):**

- **1.5a** — switch to `session.promptAsync()` (204 immediately); `isGenerating` flag;
  `[generating…]` indicator on first `message.part.updated` len=0 event; Ctrl-C during
  generation calls `session.abort()` instead of exiting.
- **1.5b** — true streaming via `message.part.delta` — a separate v2-style event type
  not in the v1 SDK `Event` union; cast via `unknown`; chunks arrive ~100–200ms apart.
  Replaced the accumulated-slice approach.
- **1.5c** — `session-status: retry` now prints `[retrying…]`; abort already wired.
- **1.5d** — `permission.updated` (v1) + `permission.asked` (v2, cast via unknown) →
  inline `? Allow: <title>  y=once  a=always  n=reject:` prompt → `postSessionIdPermissionsPermissionId()`.
  `question.asked` (v2, cast via unknown) → numbered-options prompt → raw `fetch()` to
  `POST /question/{reqID}/reply`. Without 1.5d, any agent tool that needs a permission
  or user input hangs the session silently.

**Key discovery:** `message.part.delta` is a v2 event type that the server fires for
all sessions regardless of SDK version. Same cast-via-unknown pattern applies to
`permission.asked` and `question.asked`. The v1 `Event` union omits all three.

**ReplEvent kinds after Phase 1.5:** `text-delta`, `session-idle`, `error`,
`generating`, `session-status`, `part-removed`, `permission-asked`, `question-asked` (8 total).

---

### Phase 2 — Auto-spawn server + tmux guard (1 day)

**Status:** ✓ shipped — see log 2026-05-19--15-37

**Goal:** default mode launches its own server with port rotation; refuses
outside tmux unless overridden.

**Deliverable:** `octmux` (no args) inside tmux picks a free port in
`[4096, 4106]`, spawns `opencode serve --port <port>`, waits for
`/health`, then enters Phase-1 REPL. Outside tmux: warning + exit 1.

**Files to create / modify:**
- `src/server-lifecycle.ts` (new):
  - `findFreePort(start, end)` via `net.createServer().listen(port)`
    (copy from `opentmux.ts:94-106`).
  - `findOpencodeBin()` — `which opencode`, fallback `~/.opencode/bin/opencode`
    (copy from `opentmux.ts:60`).
  - `spawnOpencodeServer(port)` via
    `Bun.spawn(["opencode","serve","--port", String(port)], { stdio:
    ["ignore","pipe","pipe"] })`; stderr → `/tmp/octmux-<port>.log`.
  - `waitForHealth(url, timeoutMs)` polling `GET /health`.
  - Returns `{ url, port, dispose() }`; dispose: SIGTERM + 2s grace +
    SIGKILL.
- `src/index.ts` — parse `--attach <port>`, `--no-tmux-guard`, `--help`,
  `--version`. tmux guard: if `!process.env.TMUX && !--no-tmux-guard`:
  warn + exit 1. SIGINT/SIGTERM → `dispose()`.

**Decision:** spawn the `opencode` binary, **not** the SDK's
`createOpencodeServer`. Keeps server lifetime independent of octmux crashes
and matches opentmux's port-rotation model.

**Manual verification:**
1. Outside tmux: refuses with friendly error.
2. Inside tmux: `bun run src/index.ts` → "spawned opencode server on port
   4097", then REPL.
3. Ctrl-C: `lsof -i :4097` empty within 3s (no orphans).
4. Two octmux instances in two tmux windows land on different ports.

**Handoff to Phase 3:** server lifecycle is solved end-to-end. Phase 3 is
pure UX work on the input layer — no server changes.

---

### Phase 3 — Custom raw-mode input layer (2–3 days) — **core UX phase**

**Status:** ✓ superseded — replaced by Phase 3 Extended (Ink migration). See log 2026-05-20--17-40 and `docs/Phase3-Extended.md`.

**Goal:** replace `readline` with our own input handler so typing feels like
Claude Code.

**Deliverable:** Emacs cursor motion, kill ring, multi-line via Alt-Enter,
bracketed-paste support, history with Ctrl-P/N, double-Esc clears buffer.

**Files to create / modify:**
- `src/input.ts` (new) — `LineEditor` class:
  - `process.stdin.setRawMode(true); setEncoding("utf8")`.
  - State: `lines: string[]`, `row`, `col`, `killRing`, `history`,
    `historyIdx`.
  - Escape-sequence parser (byte-by-byte state machine):
    - Arrows `\x1b[A/B/C/D`, ctrl-arrows `\x1b[1;5C/D`.
    - Alt-letters `\x1bb`/`\x1bf`/`\x1bd`.
    - `\x1b\r` (Alt-Enter) → insert newline.
    - `\x1b\x1b` (double-Esc) → clear buffer.
    - Lone `\x1b` (timeout-based) → emit `interrupt` if streaming else no-op.
    - Bracketed paste `\x1b[200~`…`\x1b[201~` → buffer + insert verbatim.
  - Emacs ops: Ctrl-A/E/K/U/W/Y/B/F, Alt-B/F/D, Ctrl-D (forward-delete or
    EOF-on-empty), Ctrl-L (redraw).
  - Enter on last line submits; Alt-Enter inserts a new line.
  - Events: `submit(text)`, `interrupt`, `clear-buffer`, `eof`.
- `src/render.ts` (new):
  - Scrollback above (terminal scrolls naturally).
  - Input area anchored to bottom: `\x1b[s` save / `\x1b[u` restore +
    `\x1b[J` clear-below. Repaint on each keystroke. Track
    `process.stdout.columns` + `SIGWINCH`.
  - Enable bracketed paste at startup (`\x1b[?2004h`), disable on exit.
- `src/index.ts` — swap readline for `LineEditor`. `interrupt` is wired in
  Phase 4.

**Manual verification:**
1. Ctrl-A/E, Alt-B/F, Ctrl-W behave as in bash.
2. Alt-Enter inserts newline; Enter submits the full multi-line block.
3. 30-line clipboard paste arrives as one logical input.
4. Ctrl-P recalls last submitted input.
5. Double-Esc on a populated buffer clears it.
6. Ctrl-C exits cleanly with terminal modes restored.

**Risk:** bracketed paste inside tmux needs `set -g extended-keys on` and
`set -ga terminal-features ",*:extkeys"`. Document in README; degrade
gracefully if open-paste sequence never arrives.

**Handoff to Phase 4:** input layer is feature-complete; Phase 4 layers the
status line, switches to async streaming, and wires Esc-to-abort.

---

### Phase 3 Extended — Ink rendering layer (3E.1–3E.6)

**Status:** ✓ shipped — see log 2026-05-20--17-40 and `docs/Phase3-Extended.md`.

All six sub-phases shipped. octmux is a working REPL: type a prompt, Enter submits to the LLM, streaming response displays in `<Static>` scrollback above the anchored input area, Ctrl-C Ctrl-C exits. Permission and question modals are real Ink components. Mouse wheel navigates history. Ctrl-C during generation aborts and restores the last submitted text.

---

### Phase 3 UX — Typed block renderer + tmux multiplex (3U.1–3U.8)

**Status:** ✓ shipped — see log 2026-05-21 and `docs/Phase3-UX.md`.

All eight sub-phases shipped. Highlights: flicker-free Static scrollback; typed Block model with ANSI role prefixes; per-role visibility toggles (`/show thinking off`); `Renderer` interface with `StdoutRenderer`, `TmuxPaneRenderer`, and `TmuxWindowRenderer` backends; `--multi-window` (recommended, lazy windows) and `--multi-pane` (eager panes) multiplex flags; `tool-call` + `tool-result` consolidated to a shared `"tools"` sink in both renderers. Origin window renamed to opencode session label; side windows use `<label>--<key>` naming convention (double-dash); `SubprocessStatus` component shows animated spinner + elapsed timer for active subprocesses. See `docs/Phase3-UX.md` for full spec, design rationale, and implementation log.

---

### Phase 4 — Status line + async streaming + Esc-interrupt + rich parts (2 days)

**Status:** planned.

**Goal:** bottom status line; Esc aborts a stream; tool calls and reasoning
render distinctly.

**Deliverable:** while streaming, status reads
`[streaming · <model> · in:<n> out:<n> · $<cost>]`. Idle:
`[idle · <model> · <session>]`. Esc aborts the stream.

**Files to create / modify:**
- `src/state.ts` (new) — `{ sessionID, mode: "idle"|"streaming"|
  "awaiting-permission", model, tokens, cost, lastAssistantMessageID,
  orchestraBadge? }` + `subscribe(listener)`.
- `src/render.ts` — `drawStatusLine()` at `rows - 1`, dim ANSI. Input area
  shifts up one row.
- `src/events.ts` — branch on `part.type`: `text` → stream delta; `tool` →
  `● Read(path)` + compact result; `reasoning` → dim italics under `·
  thinking`, collapse if long; `step-start` → blank line.
- `src/index.ts` — swap `prompt` for `promptAsync`. UX driven by SSE alone.
  On `submit`: `mode = streaming`, call `promptAsync`. On `interrupt`:
  `client.session.abort({ path: { id } })`. On `EventMessageUpdated` with
  `info.finish`: update `state.tokens`/`state.cost`, `mode = idle`.

**Constraint:** `promptAsync` returns 204 with no `messageID`. Correlation
is by `sessionID` only — single-user, single-flight. Acceptable.

**Manual verification:**
1. Long prompt → `[streaming]` → Esc aborts within ~500 ms → `[idle]`.
2. Token counter increments live; cost updates on message completion.
3. Tools render as compact `● tool(args)` lines.

**Handoff to Phase 5:** UX foundation is complete. Phase 5 layers slash
commands on top — `/` input branches before reaching `promptAsync`.

---

### Phase 5 — Slash commands: local + forwarded (2 days)

**Status:** planned.

**Goal:** built-ins with custom UX; forward everything else.

**Deliverable:** `/exit`, `/clear`, `/help`, `/model`, `/agents` all work.
`/brain`, `/duo-plan`, `/duo-act`, `/brain-abandon`, `/duo-abandon`, and any
unknown `/foo` forward to the server.

**Files to create / modify:**
- `src/slash.ts` (new) — `LOCAL` registry:
  - `/exit` — clean shutdown; `dispose()` spawned server.
  - `/clear` — `console.clear()` + new session.
  - `/help` — local help text listing built-ins + fall-through.
  - `/model` — `client.config.providers({})` → picker →
    `client.session.update({ path: { id }, body: { model: { providerID,
    modelID } } })`.
  - `/agents` — `client.app.agents({})` → picker → remember chosen agent on
    next `promptAsync` body.
  - Fall-through: `client.session.command({ path: { id }, body: { command,
    arguments } })`. Render 400/404 as a polite local error.
- `src/picker.ts` (new) — input enters "menu mode": j/k or arrows, Enter
  selects, Esc cancels.
- `src/index.ts` — if input starts with `/`, route to `slash.ts` instead of
  `promptAsync`.

**Manual verification:**
1. `/help` prints local help.
2. `/model` shows providers + models; pick; status line updates; next prompt
   uses new model.
3. `/agents` picker switches active agent.
4. `/brain do X` forwards; if orchestra is installed on the server, it acts;
   400/404 renders politely.
5. `/exit` shuts down cleanly; `/clear` resets to a fresh session.

**Handoff to Phase 6:** all command routing is in place; Phase 6 adds the
orchestra status badge and the inline permission-prompt UX.

---

### Phase 6 — Orchestra badge + permission prompts (1–2 days)

**Status:** planned.

**Goal:** status-line badge for orchestra phase; inline permission prompts.

**Deliverable:**
- Status line shows `[brain: PLAN]` / `[duo: act]` when an orchestra session
  is in-flight on the server.
- Server permission requests show inline `? Run X? (y/N/a)` above input;
  `y`/`N`/`a` reply via the API.

**Files to create / modify:**
- `src/orchestra-watch.ts` (new):
  - Resolve project root: `OPENCODE_PROJECT_DIR` env or `cwd`. With
    `--attach`, fall back to `GET /project/current` if available.
  - `fs.watch(<root>/.opencode/orchestra/sessions/, { recursive: true })`.
    Track subdirs with `.brain-inflight` / `.duo-inflight`. Pick most recent
    active; read adjacent `PLAN.md` first line or `TASKS.json` for stage
    label.
  - Debounce re-scans to 250 ms. Update `state.orchestraBadge`.
- `src/events.ts` — extend:
  - `EventPermissionUpdated` → `mode = awaiting-permission`, enqueue,
    render inline prompt above input.
  - Input enters "permission mode": `y`/`N`/`a` →
    `client.session.permissions({ path: { id, permissionID }, body: {
    response: "once"|"reject"|"always" } })`.
  - `EventPermissionReplied` → clear prompt, restore mode.

**Manual verification:**
1. `/brain do small task` → badge `[brain: PLAN]` appears; opentmux opens
   sub-agent panes on the right; badge clears after `.outcome` is written.
2. Write-tool prompt shows inline `? Run X? (y/N/a)`; `a` is remembered for
   the session.

**Handoff to Phase 7:** functionally complete; Phase 7 is polish + single
binary + README.

---

### Phase 7 — Polish + single-binary build + README (1 day)

**Status:** planned.

**Goal:** ship a self-contained binary.

**Deliverable:**
- `bun build --compile --target=bun-linux-x64 src/index.ts --outfile
  dist/octmux` produces a self-contained binary (~50–90 MB).
- README updated with install, tmux config tip (`set -g extended-keys on`,
  `set -ga terminal-features ",*:extkeys"`), `--attach` flag, slash-command
  reference, sample tmux launch.

**Files to create / modify:**
- `scripts/build.sh` — wraps `bun build --compile` for common targets.
- `src/index.ts` — final pass: restore terminal modes on every exit path via
  `process.on("exit")` and `process.on("uncaughtException")`. Graceful
  SIGTERM.
- `README.md` — expand.

**Manual verification:**
1. `./scripts/build.sh` produces `dist/octmux`.
2. `./dist/octmux` inside tmux behaves identically to `bun run`.
3. Demo: `tmux new-session`, run `./dist/octmux`, ask it to do something
   that triggers orchestra → opentmux splits sub-agent panes to the right;
   octmux owns the main pane.

**Handoff:** project is shippable; further work (memoryless mode,
multi-session views, themes) is post-MVP.

## Critical files

- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/index.tsx` — entry, arg parsing, renderer selection, render(`<App/>`)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/server-lifecycle.ts` — port rotation, spawn, health, dispose
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/events.ts` — SSE dispatcher, block event emission
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/blocks.ts` — typed Block model, `formatLine()` ANSI formatter
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/app.tsx` — `<App>`: chrome + Static scrollback, thin renderer translation
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/editor.ts` — LineEditor state machine
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/types.ts` — `Renderer` interface
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/stdout.ts` — `StdoutRenderer` (default)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/tmux-pane.ts` — `TmuxPaneRenderer` (`--multi-pane`)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/tmux-window.ts` — `TmuxWindowRenderer` (`--multi-window`)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/visibility.ts` — per-role visibility, `/show` parser

## Reused patterns (do not re-derive)

- Port scanning + health probe + bin lookup:
  `~/Gin-AI/projects/opentmux/src/bin/opentmux.ts:60,94-106,122`.
- SDK client construction + SSE subscription:
  `~/Gin-AI/projects/opentmux/src/index.ts`.
- Orchestra session-state file layout:
  `~/Gin-AI/projects/opencode-orchestra/docs/design.md`,
  `~/Gin-AI/projects/opencode-orchestra/commands/brain.md`.

## Risks / unknowns to resolve before Phase 1

1. **SDK package resolution.** SDK is at
   `~/.config/opencode/node_modules/@opencode-ai/sdk`, not on public npm.
   Phase 0 must confirm `bun install` resolves
   `"@opencode-ai/sdk": "file:..."` against that path. Compiled binary will
   inline it.
2. **`/command` shape.** `SessionCommandData.body = { command: string,
   arguments: string }` confirmed. Unknown commands return 4xx; render
   politely.
3. **Bracketed paste in tmux.** Needs `extended-keys on` +
   `terminal-features ",*:extkeys"`. Document; degrade gracefully.
4. **`OPENCODE_PROJECT_DIR` in `--attach` mode.** Server sets it. Fallback
   to `GET /project/current` or `cwd`.
5. **Sub-agent event filtering.** Top-level sessions have empty `parentID`;
   sub-agent sessions have `parentID !== ""`. Drop everything not matching
   our `sessionID`. Optional later: surface "sub-agent spawned" notification
   on `EventSessionCreated` where `parentID === ourSessionID`.

## End-to-end verification (after Phase 7)

1. `tmux new-session -s demo`.
2. In the main pane: `./dist/octmux`.
3. Status line shows `[idle · <model> · <session>]`. Bracketed paste, Emacs
   keys, Alt-Enter all work.
4. Send a normal prompt → tokens stream → `[streaming]` → Esc aborts.
5. `/model` → picker → switch model → status updates.
6. `/brain implement a small feature` → `[brain: PLAN]` badge appears;
   opentmux spawns Planner/Actor/Reviewer panes on the right; octmux remains
   the primary pane.
7. Permission prompt arrives inline; `y` proceeds.
8. `/exit` → server torn down, no orphan processes, terminal modes restored.

## Phase implementation checklist (for whoever picks this up)

When starting a phase:

1. Read this doc top-to-bottom, paying attention to the most recent log
   entry — it carries forward notes from the previous phase that the spec
   below may not capture.
2. Implement only the deliverables and files listed for the current phase.
   Do not pull work forward from later phases.
3. Run the phase's manual verification steps. All must pass.

When finishing a phase:

1. Add a new entry at the top of "Implementation log" with today's
   `YYYY-MM-DD--HH-MM` timestamp.
2. Flip the phase's status in "Phase plan" to `✓ shipped — see log
   YYYY-MM-DD--HH-MM`.
3. Refresh `updated_by` and `updated_at` in the frontmatter.
4. Commit with `feat(octmux): Phase N — <short title>`.
