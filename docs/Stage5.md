---
title: "octmux — Stage 5 implementation log"
created_at: 2026-05-25--17-10
created_by: Claude Code (Claude Opus 4.7 1M)
updated_by: Actor subagent (model from qwen3-4b-q6)
updated_at: 2026-06-10--04-00
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

### External command auto-discovery (Stage 5.4 — future-proof)

**`~/.config/opencode/commands/*.md` is scanned synchronously at startup** by
`loadExternalCommands()` in `src/command-registry.ts`, called from `src/index.tsx`
before `render()`. Each `.md` filename becomes a slash-command name (e.g.
`brain.md` → `/brain`) and is appended to `expandCommands()`'s output.

This makes the discovery **future-proof**: adding a new `.md` file to
`~/.config/opencode/commands/` is automatically picked up on the next octmux
start — no edit to `src/command-registry.ts` is required.

**What this gives external commands:**
- Bold-cyan `PromptInput` syntax highlighting (same as built-ins) from the first frame.
- Slash-completion overlay visibility (same as built-ins).

**What external commands do NOT get from auto-discovery:**
- A `CommandSpec` entry with `usage` / `description` — so they are absent from
  octmux's `/help` output and the overlay shows only the command name, no hint text.
  (The async `client.command.list()` fetch still populates `opencodeCommands` with
  descriptions for the `/help` "opencode commands" section, as before Stage 5.4.)
- A parser or dispatch handler — typing `/brain` and submitting still goes to the
  OpenCode server unchanged, via whatever fall-through path is eventually wired.

**Scope constraint:** Only `~/.config/opencode/commands/` is scanned — NOT
`.opencode/commands/` (per-project). This is deliberate: orchestra, RAG, and other
global custom commands live in the global config dir; per-project overrides are an
OpenCode-server concern, not an octmux UI concern.

**Deduplication:** `expandCommands()` deduplicates `extraCandidates` (from the
async fetch) against names already present from the built-in registry + filesystem
scan, so the overlay and `/help` show no duplicate entries.

**Not hot-reload:** External commands are scanned once at startup. Editing or adding
`.md` files while octmux is running requires a restart to take effect.

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

**Phase 0 finding:** The `Session.time.compacting` field was declared in the
OC server schema but **never written** by the server. The original Stage 5.1
design assumption that the server sets `time.compacting` and fires
`session.updated` with that field was incorrect.

**Actual server-side compaction flow:**

1. The OpenCode server runs an `isOverflow()` check after each LLM step
   (`packages/opencode/src/session/processor.ts` upstream). The check is:
   `current_tokens > model.limit.context - COMPACTION_BUFFER` (where
   `COMPACTION_BUFFER = 20_000`). When true:
   - The server runs a hidden compaction agent that generates a structured
     summary (using its `SUMMARY_TEMPLATE`: Goal / Constraints / Progress /
     Key Decisions / Next Steps / Critical Context).
   - The compaction agent's assistant message is marked with `info.summary === true`.
   - The OC server fires a **`message.updated`** SSE for that summary message
     carrying `info.summary === true`. This is the primary signal octmux uses
     to identify summary text.
   - Additionally, the compaction agent emits a **`CompactionPart`**
     (`part.type === "compaction"`) via `message.part.updated` — this acts as
     the in-band visual divider marker.
2. On completion: the server clears the compaction flag, emits
   `session.compacted` SSE with `{ sessionID }`.
3. If compaction was triggered by hard overflow (vs proactive), the
   server replays the last user message to restart the turn; otherwise
   it injects a synthetic "Continue if you have next steps" prompt.

Manual `/compact` uses the *same* code path. The only difference is who
flipped the switch: user vs `isOverflow()`. From octmux's perspective
both look identical on the wire — the same two SSE events fire with the
same shapes.

**Summary routing mechanism:** octmux now tracks summary message IDs via
`summaryMessageIDs` (a module-level Set). When `message.updated` arrives with
`info.summary === true`, the message ID is added to this set. Subsequent
`message.part.updated` events for text parts with that messageID get role
`"summary"` instead of `"text"`, enabling the renderer to distinguish them
visually with the `[compacted summary]` prefix.

A server-side env knob exists to disable auto-compaction:
`OPENCODE_DISABLE_AUTOCOMPACT=1` on the server process. octmux does not
set or inspect this; it's a server administration concern.

#### Status-line and modal: how octmux reflects compaction

The `session-compacting` ReplEvent kind (emitted when `session.updated`
carries `time.compacting`) was removed — the `time.compacting` field was
never written by the server (Phase 0 finding).

Instead, octmux now uses two new ReplEvent kinds:

1. **`block-retag`** — emitted when `message.updated` arrives with
   `info.summary === true` for a message whose text parts are already open.
   This retroactively retags any open parts to role `"summary"` so the
   renderer can apply the `[compacted summary]` prefix.
2. **`compaction-divider`** — emitted when `message.part.updated` carries
   `part.type === "compaction"` (the upstream CompactionPart). This renders
   as `── compaction ──` in the renderer.

The `isCompacting` state is still toggled by the `/compact` command handler
calling `setIsCompacting(true)` *before* the SDK call returns — so the modal
appears immediately, not after the round-trip. The modal also appears
automatically when the server fires the compaction agent's assistant message
with `info.summary === true` (octmux detects this via the `block-retag` path
or by the summary message's first text part). Either path clears when
`session.compacted` arrives.

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

### 2026-06-10--00-00 — Stage 5.8 — --single mode startup defaults: tools/thinking off + permissions allow

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-10--00-00
**Commit(s):** `75ff7ca`

**Motivation:** In `--single` mode, the operator is in a compact single-pane REPL — seeing raw tool call and thinking output by default is noisy and rarely useful. Auto-allowing permissions removes the modal interrupt for every tool invocation. `--multi-window` mode retains the current defaults (tools ON, thinking ON, permissions ask) where side windows absorb the extra output and the operator is explicitly in a multi-pane workflow.

**Default behavior:** In `--single` mode, startup state is: `/tools-output off`, `/thinking-output off`, `Permissions: allow`. Toggles and permission mode remain fully interactive at runtime (Ctrl-T, Ctrl-Shift-T, Shift-TAB).

**Files changed:**
- `src/app.tsx` — `singleMode: boolean` added to `AppProps`; `permMode` init, `gateStates` init, and renderer gate seeding all check `props.singleMode`
- `src/index.tsx` — `singleMode={single}` passed to `<App>`

---

### 2026-06-09--21-31 — Stage 5.7.1 — synchronous context-bar reset on /compact + remove Stage 5.7 sentinel
**Implemented by:** OpenCode (claude-opus-4-7) via /brain pipeline (Planner: minimax-m3, Actor: qwen3-4b-q6, Reviewer: claude-sonnet-4-6) — 2026-06-09--21-31
**Commit(s):** `314a63b`

**Problem:** After /compact completes, there was a race window where the status bar would briefly show a partial or stale token count until refreshTokenUsage() fetched the next post-summary assistant message. This created inconsistency between what the operator saw (compacted state) and what the bar displayed (potentially pre-compaction tokens or nothing if no new message had arrived).

**What changed:**
1. session-compacted event handler now synchronously resets tokenUsage to `{ used: 0, contextWindow: prev.contextWindow }` immediately on modal close, before refreshTokenUsage() runs.
2. Complete removal of the `compactedAwaitingTurn` sentinel state and its usage throughout app.tsx and StatusLine.tsx.
3. StatusLine rendering simplified to always show the context bar (with 0% when no tokenUsage), removing the conditional "compacted (send next turn)" indicator.

**Files modified:**
- `src/app.tsx` (session-compacted handler add setTokenUsage, remove compactedAwaitingTurn state and all usages)
- `src/components/StatusLine.tsx` (remove compactedAwaitingTurn prop, simplify rendering to bare context bar)
- `docs/Stage5.md` (this entry, frontmatter refresh)

**Impact:**
- Instant 0% reset on /compact modal close; bar fills in on first regular reply.
- Cleaner codebase with no sentinel state to manage.
- No behavioural change for sessions that have never been compacted.

**Out of scope:**
- Deeper UX work on compaction feedback.
- Block-renderer reconciliation concerns (separate Phase B work).

**Note:** Stage 5.7's sentinel design is SUPERSEDED.

---

### 2026-06-10--04-00 — Stage 5.7.2 — forward-from-summary scan in refreshTokenUsage, unified bar behaviour across entry points
**Implemented by:** Actor subagent (model from qwen3-4b-q6) — 2026-06-10--04-00
**Commit(s):** `1cffda2`

**Supersedes:** Stage 5.7.1 commits: `314a63b` (feat on main), `ec3ae69` (docs backfill on main), `ae4ab90` (merge into block-renderer).

**Problem:** Stage 5.7.1's synchronous `setTokenUsage` reset in the `session-compacted` SSE handler was clobbered by `refreshTokenUsage` within milliseconds of running (fire-and-forget HTTP round-trip). This meant the bar only ever showed a brief `0%` flash before settling back on stale pre-summary tokens.

**What changed:**
1. Extracted a pure module-scope helper `pickPostSummaryAssistantTokenUsage(messages)` that implements forward-from-summary scanning: finds the last assistant message with `info.summary === true`, then scans forward from that boundary for the latest non-summary assistant with non-zero tokens. Falls back to backward-walk semantics when no summary exists.
2. `refreshTokenUsage` now delegates token usage selection to the helper, removing the inline backward-walk code.
3. Removed the synchronous `setTokenUsage` reset from the `session-compacted` handler; the helper now correctly returns `null` (rendering as `0% 0K/?`) until the first post-summary reply lands.

**Files modified:**
- `src/app.tsx` (extract helper, update refreshTokenUsage, remove sync reset in session-compacted)
- `src/refresh-token-usage.test.ts` (new file, 7 tests covering forward-from-summary, zero-token fallback, multiple summaries, etc.)
- `docs/Stage5.md` (this entry, frontmatter refresh)

**Impact:**
- Unified token bar behavior across all entry points (original, --resume, --fork, post-compaction).
- Correct token display after compaction: bar shows `0% 0K/?` until first post-summary reply, then fills correctly.
- Cleaner codebase with pure helper for token scanning logic.

**Out of scope:**
- Block-renderer reconciliation concerns (separate Phase B work).

---

### 2026-06-09--20-28 — Stage 5.7 — post-compaction token-count sentinel + summary-skip in refreshTokenUsage

**Implemented by:** OpenCode (claude-opus-4-7) via /brain pipeline (Planner: minimax-m3, Actor: glm-5.1, Reviewer: claude-sonnet-4-6) — 2026-06-09--20-28
**Commit(s):** `b7d932d`

**Problem:** After /compact completes, the status bar continued to show the pre-compaction token count, because refreshTokenUsage() read tokens from the latest assistant message — which after compaction is the summary, whose `tokens.input` reflects the FULL pre-compaction context size (verified against OC server source: processor.ts:686-722 sets tokens unconditionally; compaction.ts:390-456 feeds the compaction agent the full pre-compaction history).

**What changed:**
1. refreshTokenUsage() now skips assistant messages where `info.summary === true` during both the primary latest-message scan AND the zero-tokens fallback scan.
2. New `compactedAwaitingTurn: boolean` state slot tracks "session has been compacted but no regular post-summary assistant message exists yet."
3. StatusLine gains optional `compactedAwaitingTurn?: boolean` prop. When true, displays yellow `· compacted (send next turn)` indicator INSTEAD of the percent/token-count block. Auto-clears when the next regular post-summary assistant message arrives with non-zero tokens (via refreshTokenUsage re-running on `message-completed` and `session-idle` events).

**Files modified:**
- `src/app.tsx` (refreshTokenUsage rewrite, compactedAwaitingTurn state, sentinel clear in switchSession, StatusLine prop wire-up)
- `src/components/StatusLine.tsx` (compactedAwaitingTurn prop + sentinel render branch)
- `docs/Stage5.md` (this entry, frontmatter refresh)

**Impact:**
- Post-compaction status bar accurately reflects "we just compacted, waiting for next turn to know new context" instead of showing stale pre-compaction number.
- Bar updates to real post-compaction count automatically when the next regular reply arrives (server's filtered LLM-feed produces a small `tokens.input` on that reply).
- No behavioural change for sessions that have never been compacted.

**Out of scope:**
- Removing CompactingModal.
- Heuristic estimates from summary.tokens.output (rejected per RESEARCH.md alternative D).
- Pre-existing renderer-interface concerns (separate bug; Phase B addresses them on feat/block-renderer).

---

### 2026-06-09--16-15 — Stage 5.6 — /compact UX fix: summary prefix + visible compaction divider
**Implemented by:** OpenCode (claude-opus-4-7) via /brain pipeline (Planner: minimax-m3, Actor: qwen3-4b-q6 + glm-5.1, Reviewer: claude-sonnet-4-6) — 2026-06-09--16-15
**Commit(s):** `2f641c8`

**Problem:** During `/compact`, the modal appeared but the summary message streamed behind it into scrollback, creating a visual discontinuity. On modal close, the operator saw the summary in full, diverging from the LLM-view where it would be collapsed. Additionally, the pre-summary assistant messages remained visible in diverging operator-view from the LLM-view. The `session-compacting` ReplEvent (emitted when `session.updated` carried `time.compacting`) was dead — the server never wrote that field.

**What changed:**

1. **New `"summary"` Role variant:** Added a new Role value `"summary"` to distinguish summary text from regular text. When `message.updated` arrives with `info.summary === true`, the message ID is tracked in `summaryMessageIDs`. Subsequent `message.part.updated` events for text parts with that messageID get role `"summary"` instead of `"text"`.

2. **`block-retag` event:** When `message.updated` with `info.summary === true` arrives for a message whose text parts are already open, octmux emits a `block-retag` event to retroactively retag those parts to role `"summary"`. This handles the case where the summary message arrives after its text parts have already started streaming.

3. **`compaction-divider` event:** Added a new ReplEvent kind `compaction-divider` emitted when `message.part.updated` carries `part.type === "compaction"` (the upstream CompactionPart). This renders as `── compaction ──` in the renderer, providing a visible separator between the summary and the following content.

4. **Dead path removal:** The `session-compacting` ReplEvent path was removed from `filterEvent` — the `time.compacting` field was never written by the server (Phase 0 finding).

5. **Replay handling:** `src/replay.ts` was updated to collapse pre-summary assistant messages to a single indicator line, so the operator sees the summary correctly on resume.

**Files modified:**
- `src/blocks.ts` (new `"summary"` Role variant)
- `src/events.ts` (summaryMessageIDs Set, partIDToMessageID Map, block-retag event, compaction-divider event, removed session-compacting path)
- `src/events.test.ts` (three new regression tests)
- `src/renderer/types.ts` (new Role variant)
- `src/renderer/stdout.ts` (render summary role with `[compacted summary]` prefix)
- `src/renderer/tmux-window.ts` (render summary role with `[compacted summary]` prefix)
- `src/renderer/visibility.ts` (handle summary role visibility)
- `src/replay.ts` (collapse pre-summary assistant messages)
- `src/app.tsx` (handle block-retag event)
- `docs/Stage5.md` (corrected compaction documentation, added implementation log entry)

**Impact:**
- During `/compact`, the modal blocks input as before. The summary message streams behind it with the `[compacted summary]` prefix per line, so the operator sees the same prefixed summary in scrollback (no surprise).
- On modal close, pre-summary assistant messages are collapsed to a single indicator line in the replay, matching the LLM-view behavior.
- The CompactionPart renders as a visible divider `── compaction ──`, providing clear visual separation between the summary and subsequent content.
- The dead `session-compacting` path is removed, simplifying the event handling logic.

**Out of scope:**
- Removing the CompactingModal (Alternative B rejected; the modal is still needed for the blocking UX).
- Auto-compaction modal (server-side concern; `time.compacting` is dead).
- Memory-file write-back.
- OC server-side changes.

---

### 2026-06-02--19-17 — Stage 5.5 — slash autocomplete: sort candidates + dismiss on space
**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-02--19-17
**Commit(s):** `3283238`

**Problem:** The slash-command completion overlay (Stage 5) had two UX issues when operators typed partial command names with common prefixes:

1. **Tab completion unpredictability:** Commands like `/brain` and `/brain-abandon` both match the token `/brain`. When the operator typed `/brain` and pressed Tab to complete, the overlay picked whichever candidate came first in the `filtered` array — which was insertion order, not semantic. The longer `/brain-abandon` could be selected instead of the exact match `/brain`, forcing the operator to manually edit the buffer or use arrow keys to swap the order.
2. **Space dismissal too strict:** The overlay dismissed when the operator typed a space *only* if `filtered.length === 1` AND `filtered[0] === token` (the exact match). If there were multiple candidates, the overlay stayed open even after the operator moved to typing arguments. This forced an extra Esc keystroke to dismiss.

**Solution:** Applied two fixes in `src/app.tsx` inside `recompute()`:

1. **Dismiss on any space:** Changed the condition from `if (firstLine.includes(" ") && filtered.length === 1 && filtered[0] === token)` to just `if (firstLine.includes(" "))`. Now the overlay closes immediately when the operator types a space anywhere on the line, regardless of how many candidates remain or whether one is an exact match. This is the correct UX — once the operator has typed past the command name to the arguments, they don't need the overlay anymore.
2. **Sort candidates by exactness then alphabetically:** Added a `sorted` array that sorts `filtered` with a custom comparator:
   - Exact token matches (e.g., `/brain` when token is `/brain`) sort to position 0.
   - All other candidates sort alphabetically.
   - This ensures `/brain` is always selected first on Tab, even if `/brain-abandon` is also in the list.

**What changed:**
- `src/app.tsx` lines 389–396: Replaced dismiss condition and added sorting logic before `setSlashCompletion()`.

**Impact:**
- **Tab key is now predictable:** Pressing Tab on `/brain` always completes to `/brain`, not `/brain-abandon`.
- **Space dismissal is consistent:** Typing a space closes the overlay immediately, improving input flow and reducing modal dismissal friction.
- **No breaking changes:** The overlay's keyboard shortcuts (Tab, Esc, arrows) and visual styling are unchanged.

**Files modified:**
- `src/app.tsx` (lines 389–396: dismiss condition + sorting logic)

**Build:** Binary rebuild succeeds with zero TypeScript errors.

---

### 2026-05-29--14-48 — Stage 5.4 — dynamic external command discovery
**Implemented by:** Claude Code (Claude Sonnet 4.6) — 2026-05-29--14-48
**Commit(s):** `d4050bc`

**Problem:** External slash commands defined as `*.md` files under
`~/.config/opencode/commands/` were not getting bold-cyan PromptInput highlighting
even though they appeared in the slash-completion overlay. Root cause: `PromptInput.tsx`
calls `expandCommands()` with no arguments — only the built-in `COMMANDS` registry and
the async `client.command.list()` fetch fed the overlay, but `PromptInput` never saw the
externally-discovered names.

**What changed:**

**`src/command-registry.ts`:**
- Added imports: `readdirSync` from `"fs"`, `homedir` from `"os"`, `join` from `"path"`.
- Added module-level `let _external: string[]` — populated once at startup, read-only thereafter.
- Added `loadExternalCommands(): void` — synchronously scans `~/.config/opencode/commands/`
  (and ONLY that directory — NOT `.opencode/commands/`), filters `*.md` files, maps each to
  `/<basename-without-.md>`, skips names already in the built-in registry, stores in `_external`.
  Silent on any FS error (directory absent, permission denied, etc.).
- Updated `expandCommands()` to append `_external` after the built-in entries, and to
  deduplicate `extraCandidates` against the existing set (so the async `client.command.list()`
  fetch no longer produces duplicate overlay entries for commands that appear in both the
  filesystem scan and the API response).

**`src/index.tsx`:**
- Added import of `loadExternalCommands` from `"./command-registry.ts"`.
- Added `loadExternalCommands()` call immediately before `render()` — synchronous, sub-ms,
  runs after all arg parsing and server setup.

**Net effect:**
- `/brain`, `/duo-plan`, `/duo-act`, `/duo-abandon`, `/brain-abandon`, `/rag`, and any
  future `*.md` file added to `~/.config/opencode/commands/` get bold-cyan highlighting
  and overlay visibility automatically on next octmux start.
- No `src/command-registry.ts` edit needed for new external commands.

**Files modified:**
- `src/command-registry.ts` (loadExternalCommands, _external, expandCommands dedup)
- `src/index.tsx` (import + call loadExternalCommands)

---

### 2026-05-28--09-41 — Stage 5.3 — runtime permission-mode toggle (Shift-TAB cycles ask/allow/deny)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-28--09-41
**Commit(s):** `2d440b9`, `bb28a46`, `cebfe3b`

**Permission levels**

OpenCode sends a `permission.asked` event whenever the AI agent wants to execute a tool — any operation that touches the filesystem, shell, network, or spawns subagents. The octmux permission mode controls how octmux responds to those events globally:

| Mode | Color | Meaning |
|------|-------|---------|
| `ask` | yellow | Show the permission modal for every tool call — user approves or denies each one manually. Default. |
| `allow` | green | Auto-approve all tool calls without prompting (replies `"always"` to OpenCode). AI runs freely. |
| `deny` | red | Auto-reject all tool calls without prompting (replies `"reject"` to OpenCode). AI is fully blocked. |

The permission system covers all OpenCode tool categories: filesystem (`read`, `edit`, `glob`, `grep`, `list`), shell (`bash`), network (`webfetch`, `websearch`), repository (`repo_clone`, `repo_overview`), agents (`task`, `skill`), and others (`external_directory`, `lsp`, `todowrite`). The mode applies globally — there is no per-tool or per-pattern override at the octmux layer.

Cycle with **Shift-TAB**: `ask → allow → deny → ask`.

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

### 2026-05-31--00-00 — v5.5 hotfix — normalize .project-dir realpath in OrchestraWatcher

**Implemented by:** Claude Code (Claude Sonnet 4.6) — 2026-05-31--00-00
**Commit(s):** `f7e5e3e`

Follow-up to v5.5: `OrchestraWatcher.scan()` used strict string equality to match the `.project-dir` sidecar against `process.cwd()`. The mismatch: Bun's `process.cwd()` returns the **realpath** (via `getcwd()` syscall — resolves symlinks), but brain.md writes `$PWD` which bash tracks as the **logical/symlink path**. On NFS setups where `/home/florian/Gin-AI` → `/mnt/nfs/Florian/Gin-AI`, the two strings never matched — the orchestra badge never appeared even when a brain session was active in the correct project.

Fix: read `storedDir` from the sidecar as before, then resolve it via `fs.realpathSync()` before the equality check. A `try/catch` fallback returns the raw value for stale/deleted paths.

**`src/orchestra-watch.ts`:** Lines 134–138 — added `resolvedStoredDir` local variable; changed equality check to use it instead of `storedDir`.

**Files modified:**
- `src/orchestra-watch.ts`

---

### 2026-05-30--00-00 — v5.5 — pass process.cwd() as session directory on create

**Implemented by:** Claude Code (Claude Sonnet 4.6) — 2026-05-30--00-00
**Commit(s):** `6a7bc65`

Root cause: OC's systemd unit sets `WorkingDirectory=%h`, so the OC daemon always starts with `cwd = $HOME`. Every `client.session.create({})` call without an explicit `directory` inherited that daemon cwd — the operator's actual launch directory was silently discarded, causing relative-path misidentification in both orchestra (`/brain`, `/duo`) and native sessions.

Fix: both `session.create()` call sites now pass `{ query: { directory: process.cwd() } }`. The SDK's `SessionCreateData.query.directory` field is the correct hook. `process.cwd()` in Bun captures the directory where `octmux` was invoked (via `getcwd()` — never changes without an explicit `chdir`).

The `--fork` startup path (`client.session.fork()`) is unchanged — it inherits the parent session's directory, which is the correct semantic.

**Files modified:**
- `src/index.tsx` — startup default-create path (line 247)
- `src/app.tsx` — `/new`/`/clear` in-session command handler (line 462)

---

### 2026-05-29--15-45 — Hot-fix: editable input buffer + pending queue during streaming

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-29--15-45
**Commit(s):** `a65f833`

Enable editing the input buffer while the model is streaming/thinking/calling tools (previously all input was blocked via `disabled=true` on `PromptInput`). Pressing Enter during streaming queues the text in `pendingQueue` state; the queue auto-submits as a single merged message when the model goes idle. Queued messages are visible via Up/Down history navigation as a single merged virtual entry.

**`src/editor.ts`:** Added `_queueMode`, `_pendingEntry`, `_viewingPending` private fields. New methods: `setQueueMode()`, `addToHistory()`, `setPendingEntry()`. Modified `enterOnLastRow()` to skip history.push when in queue mode. Modified `histPrev()`/`histNext()` to show `_pendingEntry` as virtual entry between live draft and real history. `isInHistoryNav()` now includes `_viewingPending`.

**`src/app.tsx`:** Added `pendingQueue` state + `pendingQueueRef`, `isGeneratingRef`, `handleSubmitRef` refs. Removed `isGenerating` from `PromptInput.disabled` prop (editing always allowed). Modified `handleSubmit` default path: if `isGeneratingRef.current`, push to queue and return; else call `editor.addToHistory(text)` before sending. Added two effects: one syncs `setQueueMode` + auto-submits on `session-idle`, one syncs `setPendingEntry` when queue changes. Added queue count indicator above input chrome.

**Files modified:**
- `src/editor.ts`
- `src/app.tsx`

---

### 2026-06-06--13-38 — Stage 5 hotfix.1 — edit-queued-msg: replace queue instead of append

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-06--13-38
**Commit(s):** `2dca3ec`

Bug fix against the Stage 5 hotfix (a65f833). Pressing arrow-up while a message is queued loads it for editing (`_viewingPending = true`). Submitting the edited version was unconditionally appending to `pendingQueue` instead of replacing it, producing "2 messages queued" and concatenated arrow-up recall.

**`src/editor.ts`:** Added `isViewingPending(): boolean` public accessor. Extended `enterOnLastRow()` to reset `histIdx`, `_draft`, and `_viewingPending` after the `emit("submit")` call — placed after the emit (not before) so `handleSubmit` can still read the flag during the synchronous event callback.

**`src/app.tsx`:** In `handleSubmit`, the `isGeneratingRef.current` branch now checks `editor.isViewingPending()`: if true, `setPendingQueue([text])` (replace); otherwise `setPendingQueue(prev => [...prev, text])` (append). Genuinely new queued messages still accumulate correctly.

**Files modified:**
- `src/editor.ts`
- `src/app.tsx`

---
