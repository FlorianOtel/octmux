---
title: "octmux — Stage 5 implementation log"
created_at: 2026-05-25--17-10
created_by: Claude Code (Claude Opus 4.7 1M)
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-05-28--09-41
context: >
  Implementation log for Stage 5 (re-scoped) of octmux: /help slash command,
  live slash-command completion overlay, and bold-cyan input highlighting.
  Re-scoped from the original Stage 5 plan (see docs/Implementation-plan.md
  line 387) which is partially shipped (slash command primitives delivered
  in Stage 4.2); the remaining work is this Stage 5 entry.
---

# Stage 5: /help command + live slash-completion overlay + input highlighting

## Read first when expanding on this work

This section is the contract for anyone adding new slash commands, new command
families, or wiring orchestra commands (`/brain`, `/duo-plan`, etc.) into
octmux. The Stage 5 design deliberately keeps the registry minimal and
additive so the surface stays small as commands accrete.

### The three-layer model

1. **Registry** — `src/command-registry.ts` exports `CommandSpec` and the
   `COMMANDS` array. Every command (static or dynamic) lives here as
   metadata: `name`, `usage`, `description`, optional `dynamic` expander.
2. **Parser** — `src/commands.ts` (or any sibling module) exports a
   `parseXCommand(input, ...) → { handled: boolean; ... }` function. Parsers
   are the *only* place that interpret command-specific syntax.
3. **Dispatch** — `src/app.tsx:handleSubmit` runs the parsers in order. The
   first parser to return `{ handled: true }` short-circuits. No central
   registry mediates dispatch — the ladder is explicit on purpose (R1
   metadata-sidecar pattern; see §Design choices below for why).

`/help` and the completion overlay read the registry; they never read the
parsers. This decoupling is deliberate.

### Adding a static slash command

1. Add a `CommandSpec` entry to `COMMANDS` in `src/command-registry.ts`.
   Order in the array determines `/help` display order.
2. Add `parseXCommand` to `src/commands.ts` (or a new file). Match input
   with a `^/<name>...` regex; return `{ handled: false }` on no match.
3. Wire dispatch in `src/app.tsx:handleSubmit` — insert a block of the form:
   ```typescript
   const xResult = parseXCommand(text /*, deps */);
   if (xResult.handled) {
     renderer.commitUserInput(text);
     // ...act on xResult, possibly commitSystemMessage(reply)
     return;
   }
   ```
   Slot it into the ladder at the position you want it to take precedence.

That's all. `/help` and the completion overlay pick the new command up
automatically because they read `COMMANDS` at call time.

### Adding a dynamic command family

A dynamic family is one canonical pattern that expands to multiple concrete
commands at runtime — e.g. `/<key>-output` expanding to `/thinking-output`
and `/tools-output` from `OUTPUT_KEYS`.

1. In the `CommandSpec`, set `name` and `usage` to the pattern form
   (`/<key>-output`, `/<key>-output [on|off]`).
2. Add `dynamic: () => [...]` that returns the concrete instances
   (`["/thinking-output", "/tools-output"]`). The function is called every
   time `expandCommands()` runs, so it reflects current runtime state.
3. The parser regex still matches the pattern (e.g.
   `^/(\w+)-output(?:\s+(on|off))?\s*$`) and validates the captured key
   against the same source-of-truth list (`OUTPUT_KEYS`).

`/help` shows the pattern form. The overlay shows expanded instances.

### Adding orchestra commands (`/brain`, `/duo-plan`, etc.)

When orchestra integration ships, two patterns are valid:

**A. Local interception (preferred for orchestra status / abandon).** Add a
full `CommandSpec` + `parseXCommand` + dispatch wire-up. The command runs
in-process (talks to the orchestra session-dir, queries `.brain-inflight`,
etc.) and never leaves octmux.

**B. Metadata-only entry (preferred for `/brain do X` that must forward
to the OpenCode server).** Add the `CommandSpec` but NO parser. When the
deferred server fall-through path is implemented, unknown `/foo` will
forward to `client.session.command(...)`. The metadata-only entries become
discoverable via `/help` and the completion overlay immediately — only the
parse step is deferred until the orchestra integration is wired.

Either way, `CommandSpec` stays additive: future code never has to refactor
the existing entries.

### Backward-compat constraints — read before changing the registry shape

- **`CommandSpec` is additive.** New fields must be optional (e.g. a future
  `args?: ArgSpec[]` for argument completion). Renaming or removing
  existing fields breaks every command at once.
- **Static + dynamic mutual exclusivity is implicit, not enforced.** A spec
  with `dynamic` is treated as a pattern entry; one without is static. Do
  not add a "kind" discriminator — current callers branch on `dynamic`
  truthiness only.
- **`expandCommands()` order matches `COMMANDS` order**, with each dynamic
  entry's expansion inlined at its position. Completion overlay relies on
  this for predictable ordering; do not introduce alphabetical sorting.
- **Overlay assumes single-line, row-0 slash commands with at least one
  character past the leading `/`.** The buffer-watch effect in `app.tsx`
  only opens the overlay when `editor.getRow() === 0`,
  `lines[0].startsWith("/")`, AND `lines[0].length >= 2`. Multi-line
  buffers that happen to have `/` on row 0 with cursor elsewhere are
  intentional no-overlay state. Bare `/` is also intentional no-overlay
  state (the full unfiltered command list is too noisy — narrowing starts
  on the first character after `/`). If this changes, `loadText(candidate
  + " ")` in `handleSlashSelect` will destroy lines 1+ on completion —
  change `loadText` to a more surgical replace if multi-line slash
  commands ever become valid.
- **Input highlighting skips the cursor-inside-token case.** Highlight
  applies only when `cursorCol > highlightEnd`. If you ever need highlight
  while the cursor is inside the matched token, you must nest the
  bold-cyan `<Text>` around the inverse-cursor `<Text>` — non-trivial; see
  PromptInput.tsx comments before attempting.
- **`overlayOpen` guards in `keybindings.ts` cover Up/Down/Esc only.** Tab
  is intentionally NOT guarded (Tab fails the printable-char guard `input
  >= " "` because `\t` = 0x09 < 0x20). Any new keybinding that could
  conflict with the overlay must be wrapped in `if (!overlayOpen)`.
- **Both `SlashCompletionOverlay.useInput` and `PromptInput.useInput` fire
  concurrently when overlay is open.** This is by design — operators must
  still be able to type characters into the buffer while the overlay
  narrows the candidate list. Any new handler that should NOT fire while
  the overlay is open must either be on the overlay side (which only
  mounts when active) or guarded with `overlayOpen` on the PromptInput
  side.
- **`commitSystemMessage` is line-oriented.** One call → one `→ <text>`
  line. Multi-line replies (like `/help`) must be split by the caller
  (`reply.split("\n").forEach(line => commitSystemMessage(line))`).
  Returning a `\n`-joined string from a parser and letting the caller
  split is the established pattern — keep it.
- **`editor.loadText` replaces the entire buffer.** Acceptable for the
  current TAB-completion implementation because slash commands are
  single-line. Anything multi-line will lose state.

### Known backfixes / consistency items

These are minor cleanups that future work should be aware of but does not
need to address proactively:

- **Stage 5 commit hash** was initially recorded as `<pending>` in this
  log entry per the Stage 4.4.4 / 4.5 precedent. Backfilled to `3d11fad`
  in this docs-only update.
- **Memory file "Latest commits" line** was not updated as part of the
  Stage 5 commit (memory lives outside the repo and is not staged). The
  Stage 5 entry inside that file has been backfilled as part of this
  docs-only update.
- **`docs/Version5.md` initial draft** had three minor inaccuracies vs the
  actual code, corrected in this update: (1) `CommandSpec.expandFn` →
  `dynamic`; (2) `COMMANDS` includes `/<key>-output` (not `/clear`); (3)
  app state is `slashCompletion: { candidates, selectedIdx } | null`
  (not separate `overlayOpen` + `candidates` states); (4) handler names
  are `handleSlash*` not `handleOverlay*`; (5) overlay DOES close when
  the operator types a space after an exact command match (e.g. `/show `
  closes), not "does not close on space".

When adding the next phase, check this section first to confirm the
contracts above still hold. Update it if you change them.

---

##  Session and context window management -- first implemented in 5.1 (below)

### Read first when working with sessions, context windows, or compaction

This section is the contract for anyone touching session lifecycle, the
context-window status bar, compaction signalling, or the resume/fork flows.
These were added in Stage 5.1. The 5.1 section below explains *where state lives*, *how commands map to
SDK calls*, and *why some commands block input while others do not*.

#### The OpenCode server owns session state — octmux is a thin attaching client

octmux does not persist session data. The OpenCode HTTP server (typically
the systemd user service at `http://127.0.0.1:4096`) is the single source
of truth: sessions, messages, parts, model assignments, compaction state,
parent-child relationships all live in the server's SQLite store. octmux
holds only the *active sessionID* and a renderer view derived from the
live SSE stream.

This means:

- **Resume across restarts is free.** Quit octmux, restart it with
  `--resume <id>` or `--resume-last`, and the conversation picks up where
  it left off — because the server still has it.
- **Fork is one server call**, not a local copy. `session.fork(...)`
  produces a server-side child whose `parentID` points at the original;
  both then evolve independently.
- **Compaction is fully server-driven.** octmux *requests* it (`/compact`)
  or *observes* it (auto-fire), but does not run the summarising LLM or
  manage the SUMMARY_TEMPLATE itself.

#### Command + CLI matrix

| Command   | Aliases     | Startup flag        | Server call                                                | Blocks input? | Notes |
|-----------|-------------|---------------------|------------------------------------------------------------|---------------|-------|
| `/new`    | `/clear`    | *(default: no flag)*| `session.create({})`                                       | No            | Old session remains resumable; banner shows new 8-char ID. |
| `/compact`| `/summarize`| —                   | `session.summarize({ path:{id}, body:{providerID, modelID}})` | **Yes**       | `CompactingModal` overlay + yellow status-line suffix until matching `session.compacted` SSE arrives. |
| `/sessions`| `/resume`  | `--resume <id>`, `--resume-last` | `session.list()` → picker; CLI form also calls `session.get` (validate) or sorts list (`--resume-last`) | No            | Banner-only; we do not replay message history into the renderer (history is preserved server-side; the LLM still has it). |
| `/fork`   | —           | `--fork <id>`       | `session.fork({ path:{id}})`                               | No            | No `messageID` arg yet — forks at end of session. CLI form additionally validates parent via `session.get` first. |
| *(auto)*  | *(server-initiated)* | —          | (server detects overflow → fires `session.compacted` SSE)  | **Yes**       | Same `isCompacting` state → same `CompactingModal` as user-invoked `/compact`. |

The startup flags `--resume <id>`, `--resume-last`, and `--fork <id>` are
**mutually exclusive** — each picks a different initial session, so the
combination is rejected at arg-parse time with exit code 2.

#### How server-side compaction works (the bit that drives octmux's UX)

The OpenCode server runs an `isOverflow()` check after each LLM step
(`packages/opencode/src/session/processor.ts` upstream). The check is:
`current_tokens > model.limit.context - COMPACTION_BUFFER` (where
`COMPACTION_BUFFER = 20_000`). When true:

1. Server sets `Session.time.compacting = <unix-timestamp>` and emits
   `session.updated` SSE carrying the full `Session` object.
2. Server runs a hidden compaction agent that generates a structured
   summary (using its `SUMMARY_TEMPLATE`: Goal / Constraints / Progress /
   Key Decisions / Next Steps / Critical Context). The resulting
   assistant message is marked `summary: true`.
3. On completion: server clears `time.compacting`, emits
   `session.compacted` SSE with `{ sessionID }`.
4. If compaction was triggered by hard overflow (vs proactive), the
   server replays the last user message to restart the turn; otherwise
   it injects a synthetic "Continue if you have next steps" prompt.

Manual `/compact` uses the *same* code path. The only difference is who
flipped the switch: user vs `isOverflow()`. From octmux's perspective
both look identical on the wire — the same two SSE events fire with the
same shapes.

A server-side env knob exists to disable auto-compaction:
`OPENCODE_DISABLE_AUTOCOMPACT=1` on the server process. octmux does not
set or inspect this; it's a server administration concern.

#### Status-line and modal: how octmux reflects compaction

Two new `ReplEvent` kinds (`session-compacting`, `session-compacted`)
were added to `src/events.ts`. They are emitted by `filterEvent` whenever
the server's `session.updated` carries a non-null `time.compacting`
(start) or whenever `session.compacted` arrives (end). The App handles
them by toggling an `isCompacting: boolean` state.

`isCompacting` drives **two** UI surfaces simultaneously:

- `<CompactingModal>` — a full-attention overlay that disables the
  PromptInput and hides the slash-completion overlay.
- `<StatusLine isCompacting={…}>` — appends a yellow `· compacting…`
  suffix to the existing model/context/cost line so the operator sees
  the state in their normal scanning field.

When the operator triggers `/compact` manually, the handler also calls
`setIsCompacting(true)` *before* the SDK call returns — so the modal
appears immediately, not after the round-trip. Either path (manual or
auto) clears via the same `session.compacted` event.

#### Why `/compact` blocks input — and why auto-compaction does too

The operator chose, during Phase 0 of the /brain planning session, to
have *any* compaction (manual or auto) block input via the same modal.
The reasoning:

- **Manual `/compact`:** the operator explicitly asked the model to
  pause for a structural action; allowing further input during the
  ~2-20 second compaction window would make the next prompt land
  against the wrong context (pre- or post-summary depending on
  ordering). Blocking until `session.compacted` arrives makes the
  ordering deterministic.
- **Auto-compaction:** fires mid-turn. The token count is about to
  jump dramatically (typically 80%+ usage → ~30% usage). If the
  operator typed during this window, they'd be reasoning about the
  bar position that's about to change — and any prompt submitted
  during compaction would have to be queued by the server (with
  user-visible re-ordering). Blocking eliminates the ambiguity.

The cost of this choice: a brief modal interruption that's visually
loud. The alternative (silent yellow status-line indicator only) was
rejected — the operator preferred unambiguous "you cannot type right
now" over subtle "something is happening, you can probably keep going".

#### Why `/new`, `/sessions`, `/fork` do NOT block

These commands complete in <100 ms (`session.create` / `session.list` /
`session.fork` are pure metadata operations — no LLM in the loop). The
banner appears immediately on completion; if the call fails it appears
as an inline error. Blocking would add UI surface for no benefit, and
would couple unrelated state transitions to the compaction modal
component.

#### Why we do not replay message history on resume

**[SUPERSEDED BY STAGE 5.2 — see §5.2 for the current implementation.]**

The original Stage 5.1 design chose banner-only ("`resumed session
a1b2c3d4 — "title"`") for practical reasons:

- **The renderer is bound to the live SSE event stream.** Reconstructing
  history would require an ingest path that synthesises `block-start` /
  `block-delta` / `block-end` events from `session.messages()` response
  shapes — a non-trivial second code path with its own correctness
  surface.
- **The LLM still has full history.** Resuming a session and saying
  "continue from where we left off" works correctly because the server
  feeds the full message log into the next turn. The operator-facing
  view being empty does *not* mean the model is amnesiac.
- **Banner-only is future-proof.** Replay can be added later (a
  `--replay-on-resume` flag, an interactive `r` keybind in the picker,
  or simply unconditional replay) without breaking the current behavior.

**Stage 5.2 implementation:** All three reasons were addressed in Stage 5.2:
(1) the replay synthesiser (`src/replay.ts`) implements the second code path
cleanly, mapping message parts to renderer calls; (2) the operator still gets
full history in the LLM on next turn; (3) the feature is now unconditional
(no flags required), keeping the feature set minimal. The full prior
conversation now appears in scrollback on resume, the session title shows in
the chrome Rule label (not the hex ID), and past user prompts populate the
line editor history for up-arrow recall.

#### Why `sessionID` is App state, not a prop

Pre-Stage-5.1, `sessionID` was a prop set once at `<App>` mount from
`index.tsx`. Switching sessions at runtime requires mutability, so the
refactor moved it into `useState`. This is a small but load-bearing
change: every effect that depends on the active session ID now keys on
the state variable. The SSE iteration effect specifically reads from
`sessionIDRef` (a ref synced via a separate effect) so the long-lived
`for await` loop sees the *current* session ID without re-subscribing
to the single-consumer async iterable. See the FIX iteration 1 note in
the implementation log below — this was the load-bearing risk flagged
in the planner output.

#### Files that participate in session/compaction state

- `src/index.tsx` — startup flag parsing; initial `sessionID` resolution
  (one of: new, resume by id, resume last, fork). Three flags are
  mutually exclusive (`--resume`, `--resume-last`, `--fork`).
- `src/app.tsx` — `sessionID` state, `sessionIDRef`, `switchSession()`,
  `refreshTokenUsage()`, four command handlers, `isCompacting` state,
  modal/picker render.
- `src/events.ts` — `resetEventState()`, two new `ReplEvent` kinds,
  filter branches for `session.updated` / `session.compacted`.
- `src/components/CompactingModal.tsx` — blocking overlay.
- `src/components/SessionPickerModal.tsx` — interactive resume picker.
- `src/components/StatusLine.tsx` — yellow `· compacting…` suffix.
- `src/renderer/types.ts` + implementations — `clearAll()` on session
  switch.

#### Out of scope (deliberately deferred)

- `/fork <messageID>` (no UX for message-ID discovery yet).
- Message-history replay into the local renderer on resume.
- Tree visualization of fork relationships in the picker.
- Per-session local storage in octmux (server is source of truth).
- Clearing tmux side-window buffers on session switch (cosmetic — the
  banner message marks the boundary).
- `/undo`, `/export` (separate features unrelated to context management).
- Custom compaction prompts or threshold tuning (server-side concern;
  operator can set `OPENCODE_DISABLE_AUTOCOMPACT` on the server).

---

## Implementation log (reverse chronological — newest at top)

### 2026-05-28--09-41 — Stage 5.3 — runtime permission-mode toggle (Shift-TAB cycles ask/allow/deny)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-28--09-41
**Commit(s):** `2d440b9`

**What changed:**

**New `src/components/PermissionStatusLine.tsx` component:** Displays the current permission mode with color-coding (deny=#cc241d red, ask=#d79921 yellow, allow=#1dde00 green); all mode labels bold. Renders as a single-line status indicator below the main StatusLine, showing `Permissions: <mode>` with the mode text colored and bolded.

**Permission mode state and cycling:** Added `permMode` state variable to `src/app.tsx` tracking the current mode (`"ask" | "allow" | "deny"`, default `"ask"`). New `cyclePermMode` useCallback implements the cycle order: `ask → allow → deny → ask`. The callback is declared early (before any useEffect that references it) to avoid temporal dead zone issues.

**Permission mode ref for SSE handler:** Added `permModeRef` and a syncing useEffect to track the current permission mode without re-subscribing the SSE handler. The SSE effect's `permission-asked` event handler now branches on `permModeRef.current`: mode `"ask"` shows the modal (existing path); mode `"allow"` calls `client.postSessionIdPermissionsPermissionId()` with `response: "always"` (auto-reply); mode `"deny"` calls the same API with `response: "reject"` (auto-deny). Auto-replies silently swallow errors.

**Shift-TAB keybinding:** Added `key.tab && key.shift` detection to `src/keybindings.ts`'s `handleKey` function (inserted before the printable-char catch-all, after Ctrl/Alt key handlers). The binding calls the new `onCyclePermMode` callback parameter. The `PromptInput` component now accepts `onCyclePermMode?: () => void` as a prop and threads it as the 7th parameter to `handleKey`.

**Wire permission-mode cycling to PromptInput:** Updated `src/app.tsx` to pass `onCyclePermMode={cyclePermMode}` when rendering `<PromptInput>`.

**Render PermissionStatusLine in chrome:** Imported the new component and added `<PermissionStatusLine permMode={permMode} />` immediately after `<StatusLine>` in the main Box chrome, so the permission mode always displays below the model/context/project status line.

**Build:** Binary rebuild succeeds with zero TypeScript errors.

**Files modified:**
- `src/components/PermissionStatusLine.tsx` (new)
- `src/app.tsx` (import PermissionStatusLine, add permMode state + cyclePermMode callback, add permModeRef + sync effect, update SSE handler for permission-asked with auto-reply logic, pass onCyclePermMode to PromptInput, render PermissionStatusLine)
- `src/keybindings.ts` (add onCyclePermMode parameter, add Shift-TAB handler)
- `src/components/PromptInput.tsx` (add onCyclePermMode prop, pass to handleKey)
- `docs/Stage5.md` (added §5.3 entry, updated frontmatter)

**Out of scope:** Persistent permission-mode state across restarts, per-tool/per-model permission rules, permission-mode indicators in tmux window titles, auditing/logging of auto-replies, UI preferences for permission-mode toggle key.

---

### 2026-05-28--00-00 — Stage 5.2 — history replay synthesiser: visible scrollback + title label + up-arrow recall

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-28--00-00
**Commit(s):** `57f4ae9`

**What changed:**

**New `src/replay.ts` module:** Exports `replaySession(client, renderer, sessionID, editor)` async function that synthesises prior session history into the current view. On attach (--resume, --resume-last, --fork, /sessions picker selection, runtime /fork), the function fetches the full message history via `client.session.messages()`, iterates chronologically, and emits renderer calls to populate scrollback: `commitUserInput()` for user prompts, `beginBlock`/`appendToBlock`/`endBlock` for assistant text/thinking/tool-call/tool-result blocks, `commitSystemMessage()` with `[compacted summary]` prefix for compacted messages (summary:true), and finally `editor.seedHistory(userTexts)` to populate the line editor's history buffer so up-arrow recalls past user prompts. Fresh sessions (zero messages) are a no-op. Tool parts with `status === "completed"` emit both a tool-call block and an optional tool-result block (if `output` is non-empty); tool parts with `status === "error"` emit the tool-call block only with error status. Other part types (step-*, snapshot, patch, agent, retry, compaction, subtask, file) are skipped. Errors during replay are silently swallowed — replay is best-effort, not critical to startup.

**`LineEditor.seedHistory(items)`:** New public method in `src/editor.ts` that replaces the editor's history buffer and resets navigation state. Used by the replay synthesiser to load prior user prompts. Sets `this.history = [...items]`, `this.histIdx = -1`, `this._draft = null`. History is then navigable via ↑/↓ keys as usual.

**Title-aware session label (`src/index.tsx`):** Each of the four startup branches (`--resume`, `--resume-last`, `--fork`, default new) now computes a `sessionLabel` variable set to the session's title if present, otherwise the 8-character session ID prefix. The label is passed to `<App sessionLabel={…}>` and becomes the chrome Rule title — so resumed/forked sessions show their human-readable name in the banner instead of the hex ID. Default new sessions and fork children (which have no title yet) show the 8-char ID as before.

**Consolidate `setSessionLabel` into `switchSession`:** The `switchSession` callback in `src/app.tsx` now internally calls `setSessionLabel(sess?.title || newID.slice(0, 8))` after fetching the session metadata from `client.session.get()`. This centralises label-setting logic and eliminates three redundant `setSessionLabel` call sites that existed in the `/new`, `/fork`, and `/sessions` handlers. Those handlers now only call `switchSession(newID, banner)` without worrying about the label.

**Wire `runReplay` into startup and session switch:** Added stable `runReplay` useCallback in `src/app.tsx` declared AFTER `refreshTokenUsage` (critical for TDZ safety). The one-shot `session.get` effect now calls `await runReplay(sessionID)` after `refreshTokenUsage(sessionID)`, so history is replayed on mount. The `switchSession` callback also calls `await runReplay(newID)` after `refreshTokenUsage(newID)`, so history is replayed when switching sessions at runtime. Both paths now run replay unconditionally — the "no history replay" design decision from Stage 5.1 is superseded.

**Stage 5.1 doc update:** The §5.1 "Why we do not replay message history on resume" paragraph has been updated to acknowledge that Stage 5.2 supersedes that decision and now unconditionally replays. A forward-reference to Stage 5.2 is included for readers encountering the old rationale.

**Build:** Binary rebuild succeeds with zero TypeScript errors. Verified imports of SDK types match existing patterns (`@opencode-ai/sdk` for Part/Message types from events.ts).

**Files modified:**
- `src/replay.ts` (new)
- `src/editor.ts` (added `seedHistory()` method)
- `src/app.tsx` (import replaySession, add runReplay callback, wire to one-shot effect and switchSession, consolidate setSessionLabel into switchSession, remove three redundant calls)
- `src/index.tsx` (compute sessionLabel in each startup branch, pass to <App> component)
- `docs/Stage5.md` (added §5.2 entry, updated §5.1 paragraph on replay decision)

**Out of scope:** History progress indicator, scroll-event backfill, on-disk command history file, rendering of part types (step-*, snapshot, patch, agent, retry, compaction, subtask, file), spinner state restoration, isGenerating/lastSubmitted live state restoration, tree visualization of forks, TmuxWindowRenderer-specific changes (replay goes through Renderer interface only).

---

### 2026-05-27--21-15 — Stage 5.1 — context-management commands + session-switch plumbing

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-27--21-15
**Commit(s):** `2b47ebc`, `b0c71e4`, `c85c6f0`, `a44e2c3`

**What changed:**

**New context-management commands:** Added four slash commands for session management: `/new` (aliases: `/clear`) creates a new session and clears the view; `/compact` (aliases: `/summarize`) triggers server-side session compaction; `/sessions` (aliases: `/resume`) opens an interactive picker to resume a past session; `/fork` forks the current session into a child. All four commands registered in `src/command-registry.ts` and have corresponding parsers in `src/commands.ts` (`parseNewCommand`, `parseCompactCommand`, `parseSessionsCommand`, `parseForkCommand`).

**Session state refactor (`app.tsx`):** Moved `sessionID` from prop to state variable with `useState(props.sessionID)`, initialized from the prop at startup but mutable thereafter. This enables session switching without App re-rendering. All existing `useEffect` dependencies updated to read `sessionID` from state. Single-consumer SSE stream subscription from `index.tsx` is stable across session switches because the stream itself is long-lived; `sessionID` state change triggers the SSE effect to re-subscribe to filtering by the new session ID (kept intentional per risk analysis in plan Step 9-O). Extracted token-usage fetching logic into `refreshTokenUsage(sid: string)` callback, called on session-idle and post-compaction events.

**Session switching callback:** New `switchSession(newID: string, banner: string)` callback handles the full session switch: aborts any pending generation, resets SSE event tracking state with `resetEventState()`, clears renderer with `renderer.clearAll()`, resets UI state (procTimes, tokenUsage, isCompacting), updates sessionID state, fetches and sets the new session's model, commits a banner message, and refreshes token usage. Handlers for `/new`, `/fork`, and `/sessions` picker all use this callback.

**Compaction modal and event handling:** New `CompactingModal.tsx` component renders a blocking visual notice during session compaction. Two new `ReplEvent` kinds (`"session-compacting"` and `"session-compacted"`) filter server SSE events (`session.updated` and `session.compacted`). When `session.updated` fires with a `time.compacting` number, the modal appears and input is disabled. When `session.compacted` arrives, modal closes and token usage is refreshed.

**Session picker:** New `SessionPickerModal.tsx` component lets operators navigate and select from a list of past sessions, sorted by recency. Supports ↑↓ navigation, Enter to select, Esc to cancel, and digit shortcuts (1–9). Displays session ID (first 8 chars), title, fork parentage, and a current-session marker.

**Startup resume/fork flags:** Added `--resume <id>`, `--resume-last`, and `--fork <id>` flags to `index.tsx`. `--resume <id>` validates that the session exists and attaches to it; `--resume-last` picks the most recently updated session from `session.list()`; `--fork <id>` validates the parent exists, then calls `client.session.fork({ path: { id } })` and attaches to the returned child. The three flags are mutually exclusive (each picks a different initial session, so at most one can be active). No flag defaults to creating a new session (existing behavior). All flags error and exit if validation fails.

**StatusLine enhancement:** Added optional `isCompacting?: boolean` prop; when true, appends yellow ` · compacting…` indicator to the status bar.

**`renderer.clearAll()` interface:** Added `clearAll(): void` to the `Renderer` interface. `StdoutRenderer` implementation clears `_committed` array, `_tail`, `_tailBuf`, `_activePart`, and `_openBlocks`. `TmuxWindowRenderer` clears its tracking maps (`_openBlocks`, `_lineBufs`) and delegates to the main renderer's `clearAll()`. Called on session switch to visually clear the view.

**`resetEventState()` export:** New `resetEventState()` function in `events.ts` clears three module-level Sets used by SSE filtering (`userMessageIDs`, `openParts`, `seenPartIDs`). Called in `switchSession()` before the SSE subscription restarts, preventing stale event state from leaking across sessions.

**Key risk addressed (Step 9-O):** SSE streaming subscription is a single long-lived async iterable from `index.tsx`. Closing and re-subscribing would drop in-flight events. Instead, the subscription stays open; the effect re-runs on `sessionID` state change (closure refresh) and `filterEvent()` internally filters by the current sessionID in the closure, so each session only sees its own events. This is safe because `filterEvent()` is stateless relative to sessionID.

**Follow-up fix (FIX iteration 1):** Reviewer audit found three critical issues in the initial commit: (1) stale `props.sessionID` closure in SSE event loop line 181; (2) temporal dead zone (TDZ) on `refreshTokenUsage` callback — declared after the SSE `useEffect` dependency array that referenced it; (3) SSE effect re-running on every session switch, corrupting the single-consumer async iterable. All three fixed by: introducing `sessionIDRef` to track current session ID across the long-lived effect, moving `refreshTokenUsage` callback before the SSE effect, and removing `sessionID` from the effect's dependency array. SSE subscription now stable; all sessionID reads inside the loop use the ref.

**Backfill (2026-05-27--21-33):** Added `--fork <id>` startup flag to `src/index.tsx` for symmetry with the runtime `/fork` slash command. Validates the parent session via `client.session.get`, then calls `client.session.fork({ path: { id } })` and attaches to the returned child. Mutual-exclusivity guard rejects `--resume`/`--resume-last`/`--fork` if more than one is set. Belongs logically in Stage 5.1 — the CLI flag is the startup analogue of the in-session `/fork` command.

**Hotfix (2026-05-27--22-50) — startup banner + initial token-usage seed:** Operator reported that `octmux --single --resume <id>` "spawned an entirely new session". Server-side investigation showed the resume was working (no new session created; `session.get` returned the correct ID + model), but two UX gaps made it look broken: (1) the status-line token bar showed `0% 0/200K` even though the resumed session had ~28.5K used in its latest turn, because `refreshTokenUsage()` was only called on `session-idle` events and inside `switchSession()` — neither fires on startup; (2) there was no visible banner confirming "resumed session …" — that banner only existed for runtime switches via `/sessions` / `/new` / `/fork`. Together with the by-design empty scrollback (no history replay on resume), the UI looked identical to a fresh new session. **Fix:** (a) `src/app.tsx` — the one-shot `session.get` effect now also calls `refreshTokenUsage(sessionID)` after setting `activeModel`. The effect was relocated to AFTER the `refreshTokenUsage` `useCallback` declaration to avoid the same TDZ trap that bit FIX iteration 1 (deps array referencing a `const` declared later in the function). (b) `src/index.tsx` — each of the three startup branches (`--resume`, `--resume-last`, `--fork`) now sets a `startupBanner` string captured from `session.get` / `session.list` data (uses the session's `title` when present). After renderer construction, `renderer.commitSystemMessage(startupBanner)` is called so the banner appears in the first Ink frame. Verified by re-running against the same session ID: banner shows, token bar reads 14% 28.5K/200K, server session count unchanged.

**Files modified:**
- `src/renderer/types.ts` (added `clearAll()` interface method)
- `src/renderer/stdout.ts` (implemented `clearAll()`)
- `src/renderer/tmux-window.ts` (implemented `clearAll()`)
- `src/events.ts` (added `resetEventState()`, two new ReplEvent kinds, two new filterEvent branches)
- `src/commands.ts` (added four command parsers)
- `src/command-registry.ts` (registered four new commands)
- `src/components/CompactingModal.tsx` (new)
- `src/components/SessionPickerModal.tsx` (new)
- `src/app.tsx` (sessionID state, refreshTokenUsage callback, switchSession callback, four command handlers, session picker callbacks, SSE event branches, JSX updates)
- `src/components/StatusLine.tsx` (added isCompacting prop)
- `src/index.tsx` (added --resume and --resume-last flag parsing and session lookup)

**Out of scope:** Tree visualization in `/sessions` picker, clearing tmux side-window buffers on session switch (cosmetic; banner message marks boundary), replay of message history into renderer on resume (banner-only per design), `/fork <messageID>`, `/undo`, `/export`, custom compaction prompts.

---

### 2026-05-25--19-40 — Stage 5 hotfix — delay overlay until first char after `/`

**Implemented by:** Claude Code (Claude Opus 4.7 1M) — 2026-05-25--19-40
**Commit(s):** `2325dec`

**What changed:** Buffer-watch effect in `src/app.tsx` now also bails out when `lines[0].length < 2` (i.e. the buffer is exactly `/`). Bare `/` no longer pops the overlay with the full unfiltered command list — operator must type at least one character past the slash to start narrowing. All other overlay logic (Tab/Enter/Esc, arrow nav, exact-match close-on-space, highlight) unchanged. Inline description in §Design choices and the "Read first" section's row-0 / single-line constraint were updated accordingly.

### 2026-05-25--17-10 — Stage 5 — /help + slash completion overlay + input highlighting

**Implemented by:** Claude Code (Claude Opus 4.7 1M) via /brain pipeline (Planner: Sonnet 4.6, Actor: Haiku 4.5, Reviewer: Sonnet 4.6) — 2026-05-25--17-10
**Commit(s):** `3d11fad`

**What changed:**

**New `src/command-registry.ts`:** Single source-of-truth for command metadata. Exports `CommandSpec` type (fields: `name`, `usage`, `description`, `dynamic?: () => string[]`) and `COMMANDS` array of 6 entries: `/exit`, `/rename`, `/model`, `/show`, `/<key>-output` (the only dynamic entry — its `dynamic` returns `OUTPUT_KEYS.map(k => "/" + k + "-output")`), and `/help`. Mirrors the Stage 4.5 `src/renderer/output-keys.ts` precedent. Also exports `expandCommands()` helper that resolves dynamic entries to their concrete completion candidates inline at the entry's position. Future commands (e.g., orchestra `/brain`, `/agents`) plug into the same registry — no `/help` or completion rework required.

**New `src/components/SlashCompletionOverlay.tsx` Ink component:** Renders a floating dropdown overlay of up to 10 slash command candidates with a `…N more` footer when there are more than 10. Keyboard navigation: Tab (completes selected candidate), Esc (dismisses overlay), Up/Down arrows (move selection). Selected row rendered bold (visual highlight). Overlay listens for input via Ink's `useInput` hook. Display logic: `displayCount = Math.min(candidates.length, 10)` rows shown; if more than 10, footer displays `…N more` (where N = `candidates.length - 10`). The initial draft had an off-by-one (`Math.min(..., 9)` and `length > 10` together silently dropped candidate #10); fixed in this same commit after Reviewer flagged it.

**`src/commands.ts` new `parseHelpCommand`:** Reads the registry, constructs a multi-line reply (`"slash commands:"` header + one `"  <usage>  — <description>"` line per registry entry). Returns the multi-line text as one `\n`-joined string in `{ handled: true, reply }`. Caller in `app.tsx` splits on `\n` and calls `renderer.commitSystemMessage` once per line. Help is always local; no server round-trip.

**`src/app.tsx` changes:** Added one state hook `slashCompletion: { candidates: string[]; selectedIdx: number } | null`. New `useEffect` subscribes to `editor`'s `"changed"` event; on change, if `editor.getRow() === 0` and `lines[0].startsWith("/")`, extract the slash token (first whitespace-delimited word) and call `expandCommands().filter(c => c.startsWith(token))`. If the buffer has a space and the token exact-matches the single remaining candidate, close the overlay (operator has finished the command name and moved to args). Four new handlers: `handleSlashSelect` (`editor.loadText(candidate + " ")` then clear overlay state), `handleSlashCancel` (clear state), `handleSlashMoveUp` / `handleSlashMoveDown` (clamp `selectedIdx` within candidates length). JSX conditional render places `<SlashCompletionOverlay>` between modelPicker modal and the main chrome block, gated on `slashCompletion && !permission && !question && !modelPicker`.

**`src/keybindings.ts` changes:** Added new `overlayOpen: boolean = false` parameter to `handleKey()` signature (last parameter, optional with default — existing call sites unchanged). Up/Down arrow handling now guarded by `if (!overlayOpen)`: when the overlay is open, those branches no-op (Up/Down are consumed by the overlay's own `useInput`). Esc handling also guarded by `if (!overlayOpen)`: when the overlay is open, the keybindings.ts Esc branch returns `lastEscTime` unchanged — the overlay's own `useInput` calls `onCancel` to dismiss. When the overlay is NOT open, normal Esc semantics apply (first Esc records timestamp, second Esc within 500 ms clears the buffer). This prevents keybinding conflicts between the line editor and the overlay.

**`src/components/PromptInput.tsx` changes:** Added `overlayOpen?: boolean` prop. Implemented bold-cyan highlighting of the matched command name when the typed prefix exactly matches a known command and the cursor is past the token (i.e., `cursorCol > highlightEnd`). Logic: scan `editor.buffer` from start until first space or end; if that prefix is a registered command name, highlight it in bold cyan; otherwise, no highlight. Highlight is visual-only and does not affect completion.

**Design choices documented:**

- **R1 (Registry pattern):** Command metadata lives in one shared registry (`src/command-registry.ts`). Dispatch (in `app.tsx`) is a simple if/elif chain. This avoids a complex rewrite to support dynamic command lists — no ladder climbing, minimal refactor.
- **D3 (Expansion pattern):** `/help` reads the registry and outputs all commands. Completion overlay uses `expandCommands()` from the same registry; future dynamic commands (orchestra `/brain`, `/agents`) simply add an `expandFn` to their `CommandSpec`, and the overlay automatically shows them. No completion-layer rebuild.
- **C1 (Overlay lifecycle):** Overlay opens automatically when buffer starts with `/`, cursor is on row 0, AND at least one character has been typed past the leading slash (live buffer watch via `editor.changed`). Bare `/` alone does NOT open the overlay — the unfiltered list is too noisy; narrowing starts on the first key after `/` (hotfix 2026-05-25--19-40). Closes on: Tab (complete), Enter (submits the whole line; the buffer-clear that follows triggers the effect to set overlay state to null — overlay does not itself intercept Enter), single Esc (dismiss overlay only, keep buffer untouched — the existing double-Esc clear-buffer flow only fires when no overlay is open). The overlay also closes when the operator has typed a space after an exact-match command name (e.g. typing `/show ` closes because `/show` is exactly one candidate and the operator has moved past the command name to type args).
- **TAB completes, Enter submits:** Tab key within overlay completes the selected candidate into the buffer and dismisses overlay. Enter key is never intercepted by the overlay — it always submits the whole line to the server/parser. This matches typical shell/REPL UX.

**Status:** pending operator verification. Reviewer reported one off-by-one fix (lines 42–44 in `SlashCompletionOverlay.tsx`): `Math.min(candidates.length, 9)` → `Math.min(candidates.length, 10)` + `moreCount = candidates.length - 9` → `candidates.length - 10`. Fixed and verified in this commit.

**Out of scope and deferred:**
- `/clear`, `/agents` — not implemented (original Stage 5 scope).
- Server fall-through for unknown `/foo` — not implemented (original Stage 5 scope).
- Argument-level completion (e.g., `/model <TAB>` showing provider/model names) — deferred.
- Orchestra command stubs (`/brain`, `/duo-plan`, `/duo-act`) — deferred; will be added to registry as dynamic expanders when orchestra is integrated.

**Files modified:**
- `src/command-registry.ts` (new)
- `src/commands.ts` (new parseHelpCommand)
- `src/components/SlashCompletionOverlay.tsx` (new)
- `src/app.tsx` (slash-completion state + handlers)
- `src/keybindings.ts` (overlayOpen parameter + key guards)
- `src/components/PromptInput.tsx` (bold-cyan input highlighting)

**Verified (pending operator):** This phase is awaiting operator smoke-testing of the live overlay, Help command, and input highlighting.

---
