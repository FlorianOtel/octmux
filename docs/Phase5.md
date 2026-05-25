---
title: "octmux — Phase 5 implementation log"
created_at: 2026-05-25--17-10
created_by: Claude Code (Claude Opus 4.7 1M)
updated_by: Claude Code (Claude Opus 4.7 1M)
updated_at: 2026-05-25--19-40
context: >
  Implementation log for Phase 5 (re-scoped) of octmux: /help slash command,
  live slash-command completion overlay, and bold-cyan input highlighting.
  Re-scoped from the original Phase 5 plan (see docs/Implementation-plan.md
  line 387) which is partially shipped (slash command primitives delivered
  in Phase 4.2); the remaining work is this Phase 5 entry.
---

# Phase 5: /help command + live slash-completion overlay + input highlighting

## Read first when expanding on this work

This section is the contract for anyone adding new slash commands, new command
families, or wiring orchestra commands (`/brain`, `/duo-plan`, etc.) into
octmux. The Phase 5 design deliberately keeps the registry minimal and
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

- **Phase 5 commit hash** was initially recorded as `<pending>` in this
  log entry per the Phase 4.4.4 / 4.5 precedent. Backfilled to `3d11fad`
  in this docs-only update.
- **Memory file "Latest commits" line** was not updated as part of the
  Phase 5 commit (memory lives outside the repo and is not staged). The
  Phase 5 entry inside that file has been backfilled as part of this
  docs-only update.
- **`docs/Phase5.md` initial draft** had three minor inaccuracies vs the
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

## Implementation log (reverse chronological — newest at top)

### 2026-05-25--19-40 — Phase 5 hotfix — delay overlay until first char after `/`

**Implemented by:** Claude Code (Claude Opus 4.7 1M) — 2026-05-25--19-40
**Commit(s):** `<pending>`

**What changed:** Buffer-watch effect in `src/app.tsx` now also bails out when `lines[0].length < 2` (i.e. the buffer is exactly `/`). Bare `/` no longer pops the overlay with the full unfiltered command list — operator must type at least one character past the slash to start narrowing. All other overlay logic (Tab/Enter/Esc, arrow nav, exact-match close-on-space, highlight) unchanged. Inline description in §Design choices and the "Read first" section's row-0 / single-line constraint were updated accordingly.

### 2026-05-25--17-10 — Phase 5 — /help + slash completion overlay + input highlighting

**Implemented by:** Claude Code (Claude Opus 4.7 1M) via /brain pipeline (Planner: Sonnet 4.6, Actor: Haiku 4.5, Reviewer: Sonnet 4.6) — 2026-05-25--17-10
**Commit(s):** `3d11fad`

**What changed:**

**New `src/command-registry.ts`:** Single source-of-truth for command metadata. Exports `CommandSpec` type (fields: `name`, `usage`, `description`, `dynamic?: () => string[]`) and `COMMANDS` array of 6 entries: `/exit`, `/rename`, `/model`, `/show`, `/<key>-output` (the only dynamic entry — its `dynamic` returns `OUTPUT_KEYS.map(k => "/" + k + "-output")`), and `/help`. Mirrors the Phase 4.5 `src/renderer/output-keys.ts` precedent. Also exports `expandCommands()` helper that resolves dynamic entries to their concrete completion candidates inline at the entry's position. Future commands (e.g., orchestra `/brain`, `/agents`) plug into the same registry — no `/help` or completion rework required.

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
- `/clear`, `/agents` — not implemented (original Phase 5 scope).
- Server fall-through for unknown `/foo` — not implemented (original Phase 5 scope).
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
