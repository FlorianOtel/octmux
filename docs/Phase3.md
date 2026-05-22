---
title: "octmux — Phase 3: Custom raw-mode input + Ink rendering + typed block renderer + tmux multiplex"
created_at: 2026-05-20--00-34
created_by: Claude Code (Actor, Claude Haiku 4.5)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-05-22--23-00
context: >
  Phase 3 is the foundational UX phase split across three major sub-initiatives:
  Phase 3 (original raw-mode input), Phase 3 Extended (Ink-based rendering layer),
  and Phase 3 UX (typed block model + tmux multiplex). The original Phase 3 was
  superseded by Phase 3 Extended, which then was extended by Phase 3 UX. This
  document contains the complete implementation logs and planning documents for
  all three initiatives in chronological order, with full details of each sub-phase.
---

# Phase pre-implementation checklist - Read this first

When starting a phase:

1. Read this doc top-to-bottom, paying attention to the most recent log
   entry — it carries forward notes from the previous phase that the spec
   below may not capture.
2. Implement only the deliverables and files listed for the current phase.
   Do not pull work forward from later phases.
3. Run the phase's manual verification steps. All must pass.

When finishing a phase:

1. Add a new entry at the top of "Implementation log" with today's
   `YYYY-MM-DD--HH-MM` timestamp. Each entry must include:
   - **Implemented by:** `<agent name (model)> — YYYY-MM-DD--HH-MM`
   - **Commit(s):** `hash1`, `hash2` — all hashes comma-separated on one line
2. Flip the phase's status in the parent plan to `✓ shipped — see log
   YYYY-MM-DD--HH-MM`.
3. Refresh `updated_by` and `updated_at` in the frontmatter.
4. Commit with `feat(octmux): Phase N — <short title>`.

---

## Phase 3 Extended: Ink-based rendering layer

_This section contains the full planning and implementation log for Phase 3 Extended,
dated 2026-05-20. This phase replaced the custom raw-mode input renderer with an
Ink-based (React for CLI) component tree, reducing LineEditor to a pure state
container. All Phase 3 behavior was preserved under the new Ink rendering model._

### Implementation log (reverse chronological — newest at top)

#### 2026-05-20--19-00 — UX papercuts: cursor rendering, navigation, streaming flicker

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `376d2536`, `6f22cb05`

**What shipped:**

- **Cursor on wrapped lines fixed** (`src/components/PromptInput.tsx`): The cursor
  row was rendered as `<Box flexDirection="row">` containing three sibling `<Text>`
  children (before, cursor char, after). When `prefix + before` hit the terminal
  width, Yoga could not wrap the cursor character to the next terminal row inside
  the flex row → cursor disappeared. Fixed by replacing the `<Box>` wrapper with a
  single parent `<Text>` containing a nested `<Text inverse>` for the cursor char.
  Ink 5 supports nested `<Text>` with per-section styling and treats the content as
  one text flow — Yoga wraps the full line correctly regardless of length.

- **Navigation garbling on line 2+ fixed** (`src/components/PromptInput.tsx`): The
  same `<Box>` vs `<Text>` element-type flip was the root cause. Non-cursor rows were
  `<Text key={i}>` but the cursor row was `<Box key={i}>`. When the cursor moved to
  another row, React saw the same key with a different type → unmount + remount → Ink
  partial-update diffing produced corrupted terminal output. With the nested-`<Text>`
  fix both cases are always `<Text>` at the same key; React diffs in-place, no
  garbling.

- **Streaming flicker reduced** (`src/app.tsx`): `setStreamBuf` was called on every
  incoming SSE text-delta event, causing a full Ink screen repaint per chunk (~20-50
  repaints/sec → visible flicker). Added a 50 ms debounce timer (`flushTimerRef`):
  the ref accumulates text as before; the state update is batched at most once per
  50 ms (~20 repaints/sec → smooth). The timer is flushed immediately on
  `session-idle` and `error` events (so the final text always commits), and cancelled
  in the `useEffect` cleanup.

**Future work noted:** A typed `StreamItem` union (`text | thinking | tool-use |
tool-result`) with a `<StreamingView>` component will replace the raw `streamBuf`
string for the per-kind styling and ON/OFF toggles needed when thinking blocks and
tool calls are enabled. The 50 ms debounce is compatible — same pattern with an array
push instead of string concat.

---

#### 2026-05-20--17-40 — Phase 3E.6: Cleanup + doc updates

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `7059f5c4` (shared with 3E.4+3E.5 session)

**What shipped:**
- `src/index.ts.phase2.bak` deleted (leftover safety copy from 3E.1).
- `README.md` rewritten: Architecture section explains the Ink Static/dynamic layout model and why bottom-anchor is automatic; Key bindings table documents all Emacs and navigation bindings; tmux configuration subsection covers `mouse on`, `extended-keys on`, `terminal-features extkeys`, and clarifies that text selection still works (alternate scroll mode does not intercept clicks).
- `docs/Implementation-plan.md` updated: locked decision #3 rewritten to Ink language; Phase 3 Extended inserted as a new Phase plan entry between Phase 3 and Phase 4; Phase 3 status changed to "superseded"; consolidated log entry prepended; frontmatter refreshed.
- This doc: 3E.6 status → ✓ shipped; log entry prepended; frontmatter refreshed.

**Bug fixes included in this session (not 3E.6-spec but landed here):**
- `stdin.ref is not a function` crash on startup: the `Transform`-stream-as-stdin approach was dropped entirely. Mouse tracking now uses `DECSET 1007` (alternate scroll mode) instead of `?1000h` (button-event mode). Wheel events arrive as arrow keys to Ink's normal input path; no Transform stream or TTY-proxy needed. Text selection restored.
- Two blank lines between turns not rendering: `measureText("")` returns `{width:0, height:0}` so `<Text>{""}</Text>` was a zero-height Yoga node. Fixed to `<Text>{" "}</Text>`.

**What changed in this doc:** 3E.6 status → ✓ shipped; all sub-phases now ✓; Phase 3 Extended is complete.

---

#### 2026-05-20--17-47 — Phase 3E.4 + 3E.5: Modals, mouse scroll, Ctrl-C recall, UX anchoring

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `7059f5c4` (shared with 3E.6 session)

**What shipped:**

- **Terminal clear + bottom anchor** (`src/index.tsx`): On startup, clears the screen and positions the cursor so the input area anchors at the bottom. Uses `\x1b[2J\x1b[H` + `rows - 7` newlines to pre-fill space above the dynamic area.
- **4-line status area** (`src/app.tsx`): `marginBottom={3}` on the bottom Box makes StatusLine(1) + 3 blank lines = 4 lines reserved for status. Phase 4 will fill the 3 blank lines with model/tokens/cost/orchestra badge.
- **Turn spacing** (`src/app.tsx`): Each scrollback entry is followed by 2 blank lines, separating operator input from LLM output visually.
- **PermissionModal** (`src/components/PermissionModal.tsx`): Inline y/a/n prompt replaces the auto-approve placeholder in app.tsx. `y`=once, `a`=always, `n`=reject.
- **QuestionModal** (`src/components/QuestionModal.tsx`): Numbered-options prompt for `question.asked` events. Accepts digit keys, advances through multi-question flows, POSTs answers to `/question/{reqID}/reply`.
- **Mouse wheel scroll** (`src/hooks/useMouseScroll.ts`, `src/index.tsx`, `src/app.tsx`): `attachMouseStream` intercepts SGR mouse sequences on stdin, fires wheel callbacks, passes cleaned bytes to Ink. Wheel-up = `editor.histPrev()`, wheel-down = `editor.histNext()`. SGR mode enabled on start, disabled on exit.
- **Ctrl-C semantics** (`src/app.tsx`): Three cases: (1) generating → `session.abort()` + `editor.loadText(lastSubmitted)`; (2) idle non-empty buffer → `editor.clearBuffer()`; (3) idle empty buffer → double-press exit guard (preserved from 3E.3).
- **`baseUrl` prop** (`src/app.tsx`, `src/index.tsx`): Added to AppProps so QuestionModal can POST answers without reimporting lifecycle state.
- **`onWheelRegister` prop** (`src/app.tsx`, `src/index.tsx`): Callback for App to register its wheel handler with the index.tsx dispatcher.

**What changed in this doc:** log entry prepended; 3E.4 and 3E.5 status → ✓ shipped; frontmatter updated_by and updated_at refreshed.

---

#### 2026-05-20--16-36 — Feature: history draft preservation in LineEditor

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `ddc065f0` (shared with 3E.3 session)

**What shipped:**
- `src/editor.ts`: Added `_draft: string | null` field to `LineEditor`. When the
  user presses Up (histPrev) for the first time, the current unsaved buffer is saved
  to `_draft`. When they navigate back to "present" (histNext past the newest history
  entry), `_draft` is restored instead of clearing to empty. `_draft` is cleared on
  submit (`enterOnLastRow`) and on double-Esc (`clearBuffer`).

**Why:** Without this, any text typed but not submitted was silently lost whenever
  the user scrolled through history and returned. Expected behaviour: the draft
  survives the round-trip.

**How it works:**
- `histPrev()`: on first call (histIdx === -1), `this._draft = this.getText()` before
  overwriting the buffer.
- `histNext()` return-to-present path: restores `const draft = this._draft ?? ""`
  instead of `this.lines = [""]`.
- `enterOnLastRow()` and `clearBuffer()`: both set `this._draft = null`.

---

#### 2026-05-20--16-21 — Phase 3E.3: <App> shell + Static scrollback

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `ddc065f0` (shared with history-draft session)

**What shipped:**
- `src/app.tsx` (new): `<App>` component with `<Static>` scrollback, session label
  prop, onExit prop, StatusLine in layout. All SSE wiring moved from index.tsx.
  Uses module-level `nextId` counter to track scrollback entry IDs. Accepts
  client, sessionID, sessionLabel, eventStream, and onExit as props.
- `src/components/StatusLine.tsx` (new): `[idle]` placeholder stub.
- `src/index.tsx`: slimmed to ~80 lines; App component moved to app.tsx; passes
  client, sessionID (first 8 chars as sessionLabel), eventStream, and onExit as props.
  Preserves all server lifecycle logic (arg parsing, port scan, spawn, health check,
  SIGTERM handler). Removed App definition, HistoryEntry type, SSE loop, useInput
  handlers, handleSubmit callback, and all React imports except render.

**Suggested next steps for 3E.4:** PermissionModal.tsx and QuestionModal.tsx
  components to replace the auto-approve placeholder in app.tsx; QuestionModal
  for question.asked events. Add streaming buffer state and mode tracking to
  support [generating…] indicators and session-idle text flushing.

---

#### 2026-05-20--10-45 — Phase 3E.2 fixes: Keybinding fixes, keybindings.ts, LLM wiring, UX polish

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `d39ed8ed`

**What shipped:**

**Keybinding bug fixes — three Ink 5 quirks discovered and resolved:**

The Phase 3E.2 dispatch table had three bugs rooted in non-obvious Ink 5 behaviour. All three
were diagnosed by reading `node_modules/ink/build/parse-keypress.js` and
`use-input.js` directly. See memory documentation for the Ink 5 keybinding quirks.

1. **Backspace → `key.delete`, not `key.backspace`**: Modern terminals send
   `\x7f` for Backspace; Ink maps it to `key.delete`. Fix: check
   `key.backspace || key.delete`. The original check `if (key.backspace)` never
   fired on any modern terminal.

2. **Alt-Enter → `key.return=false, key.meta=false, input='\r'`**: Ink strips
   the `\x1b` prefix from `\x1b\r`, leaving a bare CR with no flags. Fix:
   `else if (input === '\r' || input === '\n')` placed after the `key.return`
   branch. The original check `key.return && key.meta` never fired.

3. **Ctrl-X → `(key.ctrl=true, input="x")`**: Ink converts control bytes to
   their letter name. Fix: `key.ctrl && input === "a"` etc. The original
   `input === "\x01"` checks never matched.

**`src/keybindings.ts` (new file):**
All key dispatch was extracted from `PromptInput.tsx` into a standalone
`src/keybindings.ts` module exporting `handleKey(input, key, editor, lastEscTime)`.
The file has three header sections documenting each Ink 5 quirk with byte-level
detail and source references, plus a full annotated binding table. `PromptInput.tsx`
is now a thin wrapper that calls `handleKey` in its `useInput` handler.

---

#### 2026-05-20--00-34 — Phase 3E.2: LineEditor state machine + PromptInput component

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `a7560509`, `b23965e4`

**What shipped:**
- `src/editor.ts` (new): pure LineEditor EventEmitter state machine ported from
  Phase 3. I/O stripped: no start()/stop(), no escape-sequence parser, no modal helpers.
  All buffer ops made public. New methods: moveUpRow(), moveDownRow(), loadText(),
  getText(), isAtTopRow(), isAtBottomRow(), enterOnLastRow(). Events kept: "changed", "submit".
- `src/components/PromptInput.tsx` (new): Ink component rendering multi-line buffer
  with cursor. useInput dispatcher covers full Emacs binding table. Double-Esc
  (within 500ms) clears buffer. Paste arrives as single input string via Ink 5.x.
- `src/components/Rule.tsx` (new): horizontal rule with optional embedded title.
- `src/index.tsx`: updated to 3E.2 harness (history list + Rule + PromptInput + Rule).
  Both bun run dev and bun run compile verified.

---

#### 2026-05-20--00-10 — Phase 3E.1: Bootstrap Ink + React under Bun

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `6c52cdd3`, `02f09ce3`, `9d43e9c1`

**What shipped:**
- `package.json`: added `ink@^5.0.0`, `react@^18.3.1` as deps; `@types/react@^18.3.0` as devDep; also added `react-devtools-core@^7.0.1` as optional dep (required for Ink 5.x compile support).
- `tsconfig.json`: added `"jsx": "react-jsx"`, `"jsxImportSource": "react"` to compilerOptions.
- `src/index.ts.phase2.bak`: copy of the Phase 2 readline REPL (safety net for in-progress session).
- `src/index.tsx`: replaced Phase 2 REPL with 20-line Ink hello-world demo — bordered single-line box "octmux — Ink hello", auto-exits after 2 s. Both `bun run dev` and `dist/octmux` binary verified working (exit code 0).
- Build scripts updated: `dev`, `build`, `compile` now reference `src/index.tsx` instead of `src/index.ts`.

---

## Phase 3 UX: Typed block renderer + tmux multiplex

_This section contains the full planning and implementation log for Phase 3 UX,
dated 2026-05-21. This phase introduced a typed Block model, eliminated streaming
flicker through Static scrollback, added per-role visibility toggles, and implemented
two tmux multiplex backends (panes and windows)._

### Implementation log (reverse chronological — newest at top)

#### 2026-05-21 — Phase 3U.7 (cleanup)

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `cc634edd`

**What shipped:**
- `src/events.ts`: removed `text-delta` from `ReplEvent` union; removed dual-emit in `message.part.delta` branch (now emits only `block-delta`). No consumers existed after 3U.4; the alias was a temporary bridge for the 3U.1→3U.2 transition.
- `src/blocks.smoke.ts`: deleted (was gitignored; left over from 3U.1 development).
- `README.md`: major update — added Output architecture section, documented `/show` slash commands and both multiplex modes.
- Updated documentation reflecting final dual-renderer architecture.

---

#### 2026-05-22 — Phase 3U.6 (TmuxWindowRenderer) + post-implementation fixes

**Implemented by:** Claude Code (Claude Haiku 4.5 + Claude Sonnet 4.6); post-implementation fixes by Claude Code (Claude Sonnet 4.6) — 2026-05-22--23-00
**Commit(s):** `c3d6fcc5`, `437d37bf`, `fcb2ef94`, `1a2f58b`

**What shipped (post-implementation fix — 2026-05-22):**
- **No-args → help + explicit mode selection (`src/index.tsx`)**: `octmux` started without arguments
  now prints help and exits (exit 0). A display mode is required on every invocation:
  `--single` (new flag; all output inline, no tmux required — equivalent to the previous implicit
  default), `--multi-pane`, or `--multi-window`. The three flags are mutually exclusive.
  `--single` bypasses the tmux guard; `--multi-pane`/`--multi-window` still require an active tmux
  pane. Help text extracted to a top-level `HELP` const and shared between `--help` and the
  no-mode exit path.

**What shipped (initial — 2026-05-21):**
- `src/renderer/tmux-window.ts` (new, ~140 lines): `TmuxWindowRenderer extends EventEmitter implements Renderer`.
  Lazy window creation via `_ensureWindow(windowKey)` called from `beginBlock()` when a side-role block opens
  for the first time. `setup()` only records `_originWindowId` and `_sessionName` via tmux queries; no windows
  created until first use.
- Tool consolidation: `tool-call` and `tool-result` now share a single `tools` sink.
- Both renderers updated with `WINDOW_KEY` / `PANE_KEY` maps.

---

#### 2026-05-21 — Phase 3U.5 (+ post-implementation fixes)

**Implemented by:** Claude Code (Claude Haiku 4.5 + Claude Sonnet 4.6)
**Commit(s):** `60083c01`, `5e76fbc6`, `9441308`, `dbe280b0`, `e7240e2d`, `583ea025`, `541d70f8`, `461c572e`, `11402435`

**What shipped:**
- `src/renderer/fifo.ts` (new): Regular temp files (`/tmp/octmux-PID-ROLE.log`, O_WRONLY|O_APPEND) instead of named FIFOs.
- `src/renderer/tmux-pane.ts` (new): `TmuxPaneRenderer extends EventEmitter implements Renderer`; spawns side panes via `tmux split-window`.
- Guard using `/proc/self/fd/0` readlink vs tmux display-message for stale-env detection.
- Per-role line buffers with ANSI prefixes.

---

#### 2026-05-21 — Phase 3U.4

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `0f09e793`, `9f468fd6`

**What shipped:**
- `src/renderer/types.ts` (new): `Renderer` interface with streaming and one-shot primitives.
- `src/renderer/stdout.ts` (new): `StdoutRenderer extends EventEmitter implements Renderer`.
- `src/app.tsx`: pure refactor — all rendering state/logic removed; accepts `renderer: Renderer` prop.
- `src/index.tsx`: constructs `new StdoutRenderer(new Visibility())`; passes as prop; disposes on exit.

---

#### 2026-05-21 — Phase 3U.3

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `cd537372`

**What shipped:**
- `src/renderer/visibility.ts` (new): `Visibility` EventEmitter class with per-role on/off state + hidden counts.
- `parseShowCommand()` parser for `/show [role] [on|off]`.
- `src/app.tsx`: `Visibility` singleton; `handleBlockDelta` gated on `vis.isVisible`; `/show` commands intercepted.
- `src/components/StatusLine.tsx`: accepts `vis: Visibility`; renders hidden badge indicators.

---

#### 2026-05-21 — Phase 3U.2

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `d78690bb`, `9fe87af7`

**What shipped:**
- `src/app.tsx`: replaced `streamBuf`/debounce/`history` model with `<Static>`-backed line-granularity rendering.
- `committed: CommittedLine[]` accumulates pre-formatted ANSI lines; `tail` holds the single in-progress partial line.
- Dynamic region is now ≤ ~9 lines regardless of response length — flicker is structurally impossible.

---

#### 2026-05-21 — Phase 3U.1

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `cdee8f5e`, `5fbcec1f`

**What shipped:**
- `src/blocks.ts` (new): `Role` type, `Block` type, inline ANSI constants, `formatLine()`, `formatBlock()`.
- `src/events.ts`: extended `ReplEvent` union with `block-start`/`block-delta`/`block-end`; added `openParts` Map for part tracking.
- `message.part.delta` emits `block-delta` for all tracked roles (plus `text-delta` compat alias for text parts).
- `.gitignore`: added `*.smoke.ts`.

---

## Summary of Phase 3 (Combined)

Phase 3 represents three major architectural iterations of the octmux UX layer:

1. **Phase 3 (original)** — planned custom raw-mode input with Emacs bindings, bracketed paste, and history.

2. **Phase 3 Extended** — replaced the raw-mode renderer with Ink (React for CLI), preserving all Phase 3 behavior under a cleaner component architecture. LineEditor became a pure state machine; Ink's `useInput` hook drives it. All features preserved: Emacs bindings, multi-line via Alt-Enter, history, bracketed paste, double-Esc clear. This enabled a bottom-anchored layout and proper modal flows.

3. **Phase 3 UX** — eliminated streaming flicker by moving content to `<Static>` at line granularity, introduced a typed Block model with role-based rendering, added per-role visibility toggles, and implemented two tmux multiplex backends (panes and windows) via the Renderer interface.

The result: a fully functional REPL with streaming responses, interactive modals, proper layout anchoring, and the infrastructure for future multi-pane sub-agent support.

