---
title: "Stage 9 — Question Deliberation Flow (Piece 2)"
created_at: 2026-06-07--17-23
created_by: OpenCode Brain pipeline (Anthropic Opus 4.7 orchestrator + sohoai/qwen3-4b-q6 + sohoai/glm-5.1 Actors)
updated_by: Actor (sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-16
updated_at: 2026-06-16
context: >
  Stage 9 implements Piece 2 of the octmux UI architecture redesign: the AskUserQuestion tool's options are committed to scrollback (Piece 2A) and the operator can answer with prose in addition to digit selection (Piece 2B). Piece 2 is renderer-independent and works identically under both --single (StdoutRenderer) and --multi-window (TmuxWindowRenderer) modes.
---

---

### 2026-06-16 — Stage 9.5 — External question resolution (mobile / Pocket)
**Implemented by:** Actor (sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-16
**Commit(s):** _(pending backfill)_

**Bug:** When a question is answered or rejected externally (e.g. via the Pocket mobile app POSTing `/question/{id}/reply` or `/question/{id}/reject`), octmux's question modal never clears and the answer isn't shown locally. octmux only handled the `question.asked` SSE event; OC's server also emits `question.replied` and `question.rejected` events, which were silently dropped.

**Fix:**
1. **src/events.ts** — Added `question-replied` and `question-rejected` variants to the `ReplEvent` union, and two new `filterEvent` branches that mirror the existing `question.asked` pattern: cast via `as unknown`, match on `sessionID`, and extract `requestID` (note: field is `requestID` with capital ID on replied/rejected, vs `id` on asked). `question-replied` also carries `answers: string[][]`.
2. **src/app.tsx** — Added `questionRef` (ref mirror of `question` state, synced via useEffect) to avoid adding `question` to the `applyReplEvents` dependency array. Two new `else if` branches in `applyReplEvents`:
   - `question-replied`: if `questionRef.current?.reqID === ev.reqID`, clears the modal (`setQuestion(null)`, resets `questionAnswersRef` and `currentSubIdx`), and echoes a human-readable summary of the external answers to scrollback via `renderer.commitSystemMessage`.
   - `question-rejected`: same guard, clears modal and echoes "▶ Question rejected externally".
   The `ev.reqID === question.reqID` guard makes stale events a no-op and covers the local-reply-then-SSE-echo race (local reply already set `question` to null → ref is null → no-op).
3. **src/events.test.ts** — Added 4 tests: replied with matching sessionID, replied with non-matching sessionID, rejected with matching sessionID, rejected with non-matching sessionID.

**Non-goal:** Surfacing subagent/descendant question resolutions via the descendant-walk block is explicitly out of scope for 9.5.

### 2026-06-16--18-54 — Stage 9.4 — Per-question collection (regression fix for 9.1 D4-α)
**Implemented by:** Actor (sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-16--18-54
**Commit(s):** `f0285e2`

**Root cause:** Stage 9.1's `handleSubmit` built a `padded: string[][]` array on every answer, filling only the `currentSubIdx` slot with the chosen answer and setting all other slots to `[]` (empty — "Unanswered"). It then immediately called `handleQuestion(padded)`, which POSTs to `/question/{reqID}/reply` and clears the modal (`setQuestion(null)`). For multi-question batches, this means the FIRST sub-question's answer submitted the ENTIRE batch, leaving remaining sub-questions as "Unanswered" on the server.

**Fix:** Replaced the D4-α padding + immediate-submit with per-question collection:
1. Added `questionAnswersRef = useRef<string[][]>([])` alongside `currentSubIdx`. Reset both in the `question?.reqID` useEffect.
2. In `handleSubmit`'s `if (question)` branch:
   - Early-return on empty buffer (`text.trim() === ""`) — prevents accidental POST of whitespace mid-collection.
   - PRESERVED the existing routing rule (digit → option label, else verbatim prose).
   - Store: `questionAnswersRef.current[currentSubIdx] = [chosen]`.
   - Echo per-sub-Q summary to scrollback (unchanged `formatAnswerSummary` call).
   - If NOT last sub-Q: `setCurrentSubIdx(currentSubIdx + 1); return;` — modal advances to next sub-Q.
   - If LAST sub-Q: `handleQuestion(questionAnswersRef.current); return;` — single POST with all collected answers.
3. Ctrl-C abort branch now also resets `questionAnswersRef.current = []` and `setCurrentSubIdx(0)` alongside the existing `setQuestion(null)`, preventing stale accumulator state after cancellation.

**Files changed:**
- `src/app.tsx`: Added `questionAnswersRef` (line ~269), reset in `useEffect` (line ~270), rewrote `handleSubmit` question branch (line ~1126–1152), added accumulator/subIdx reset in Ctrl-C branch (line ~1049–1051).

**Manual verification path** (app.tsx not unit-tested):
- **Repro A (fix):** Multi-question modal → answer sub-Q 1 → modal advances to sub-Q 2 (NOT dismissed). Answer sub-Q 2 → POST `/question/{reqID}/reply` with both answers, modal dismissed.
- **Repro B (regression):** Single-question modal → answer → POST as before, modal dismissed.
- **Repro C (regression):** Ctrl-C during question → modal dismissed, accumulator and subIdx reset.

### 2026-06-16--18-54 — Stage 9.3 — Orchestra badge re-emit storm (5s flicker fix)
**Implemented by:** Actor (sohoai/qwen3-4b-q6) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-16--18-54
**Commit(s):** `36d0b7e`

**Root cause:** During /brain or /duo sessions, the `OrchestraWatcher.scan()` method polls every 5 seconds and updates the badge. At lines 284 (duo branch) and 321 (brain branch) in `src/orchestra-watch.ts`, `lastActivityAt: Date.now()` is set fresh on every 5s scan. The `_updateBadge` method at line 435 compared badges using `JSON.stringify(this.badge) !== JSON.stringify(newBadge)`, which ALWAYS differed because the timestamp changed → emitted "changed" → triggered `setOrchestraBadge` in `app.tsx` → full TUI re-render every 5s → visible flicker. This only occurred during /brain or /duo when the polling was active.

**Fix:** Added a new private method `_badgeContentEquals(a: OrchestraBadge, b: OrchestraBadge): boolean` that compares two badges while ignoring `lastActivityAt` timestamps. The method:
1. Uses `structuredClone` to deep-clone both badges
2. Deletes `lastActivityAt` from the top-level badge
3. Deletes `lastActivityAt` from each subagent row
4. Compares the resulting JSON strings

The `_updateBadge` method now calls `!this._badgeContentEquals(this.badge, newBadge)` instead of the raw JSON.stringify diff. This ensures badge content changes only trigger re-renders when actual content (mode, title, subagents' content) changes, not when timestamps update. The `lastActivityAt` fields remain untouched, preserving their existing behavior for stale-row eviction.

**Files changed:**
- `src/orchestra-watch.ts`: Added `_badgeContentEquals` method (lines 430-450), updated `_updateBadge` to use it (line 457)
- `src/orchestra-watch.test.ts`: Added tests for timestamp exclusion behavior

**Manual verification:** The fix eliminates the 5s flicker during brain/duo sessions. Badge re-renders now only occur on actual content changes (e.g., new subagent added, subagent ended, parent activity bump). Timestamp updates no longer trigger re-renders.

### 2026-06-15--16-29 — Stage 9.2 — Ctrl-C cancels pending question (reject server-side)
**Implemented by:** Actor (sohoai/qwen3-4b-q6) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-15--16-29
**Commit(s):** `8c8d590`

**Bug:** Pressing Ctrl-C while a QUESTION modal was pending could silently submit the DEFAULT option as the answer. Root cause: the MCP question tool blocks the pipeline so isGenerating stays TRUE while the modal is up; the operator's typed answer sits in the live prompt buffer / pendingQueue (editor not disabled for `question` at src/app.tsx:1514); Ctrl-C's setIsGenerating(false) fires the queue-flush effect (app.tsx ~995-1002) → handleSubmit(merged) → handleSubmit's `if (question)` branch routes the buffered text as the question's answer (option[0]/default via handleQuestion) before setQuestion(null) commits.

**Fix** (two edits to src/app.tsx): (1) Ctrl-C abort branch now snapshots the pending question, fire-and-forget POSTs /question/{reqID}/reject to cancel it server-side, and clears pendingQueue + editor buffer so the typed default cannot leak; (2) the queue-flush effect is guarded with `!question && !permission` (and those added to deps) so a queued message is never flushed into a pending modal — defense-in-depth that also fixes the Enter-while-generating variant.

**Why safe:** explicit reject is the semantically-correct cancel (session.abort alone only probably unblocks the pending question via Effect-ts fiber interrupt — UNCLEAR; reject emits question.rejected and cleans the pending map; rejecting an already-resolved question 404s silently → idempotent). Preserves: idle queue flush, normal question answer (type number+Enter), Ctrl-C with no modal, double-Ctrl-C exit.

**Manual repro** (verification path; app.tsx not unit-tested):
- **Repro A (fix):** question modal up, type "1", Ctrl-C → NO /question/.../reply POST; ONE /question/.../reject POST IS sent; modal gone; empty prompt.
- **Repro B (regression):** plain prompt queued during NON-modal generation still auto-sends on idle.
- **Repro C (regression):** question up, type "2"+Enter → /question/.../reply sent as before.
- **Repro D (regression):** double-Ctrl-C at idle empty prompt still exits.

---

#### 2026-06-15--11-58 — Stage 9.2.1 — A5: Correct per-line invert for multi-line prose

**Implemented by:** local/qwen3-4b-q6 — 2026-06-15--11-58
**Commit(s):** `f5103b0`

**What shipped:**
- Corrected the false claim in §9.2.1: Ink's `<Text>` component collapses embedded newlines to a single row, so the invert state does NOT persist across `\n`. The fix in `formatAnswerSummary` splits multi-line prose on `\n`, applies `\x1b[7m`/`\x1b[0m` to each segment independently, then re-joins with `\n`. This ensures each line of the operator's answer is rendered with correct inverse-video styling, respecting the Ink row-collapse behavior.

---

## See also

- **`~/Gin-AI/tmp/Piece2-Question-Deliberation-Flow.md`** — Piece 2 design document: UI architecture redesign for question deliberation.
- **`docs/Stage8.md`** — previous stage: live cost display and orchestra inflight badge.
- **`docs/Stage7.md`** — native opencode /rag command + discovery and forwarding.

---

## Implementation log

### 2026-06-10--04-34 — Stage 9.2.1 — Prose answer inverted-text rendering
**Implemented by:** Claude Code (Claude Sonnet 4.6) — 2026-06-10--04-34
**Commit(s):** `e5e01e5`

`formatAnswerSummary` in `src/app.tsx` previously returned `` `${prefix}: ${trimmed}` `` for prose (non-digit or out-of-range digit answers), rendering the operator's prose identically to surrounding system narration. Stage 9.2 had replaced `commitUserInput(text)` (which applied the `"user"` role → `ANSI.invert`) with `commitSystemMessage(formatAnswerSummary(...))`, losing the inversion styling for prose.

Fix: change the prose-case return to `` `${prefix}:\n\x1b[7m${trimmed}\x1b[0m` ``. The `▶ Answered` header stays on one line; the operator's prose appears on the next line in ANSI reverse-video (`\x1b[7m` = `ANSI.invert` from `blocks.ts`, inlined since `ANSI` is not exported). Digit-selected case (lines 180–185) is unchanged. Multi-line prose is handled correctly by `formatAnswerSummary` in `src/app.tsx`: the trimmed text is split on `\n`, each line is mapped to independently inverted ANSI (`\x1b[7m... \x1b[0m`), then re-joined with `\n`. This works because Ink's `<Text>` collapses embedded newlines to a single row, so per-line inversion must be applied to each segment rather than relying on persistent invert state.

### 2026-06-07--17-23 — Stage 9.0 — Piece 2A: options-to-transcript persistence
**Implemented by:** OpenCode Brain pipeline (Anthropic Opus 4.7 orchestrator + sohoai/qwen3-4b-q6 Actors) — 2026-06-07--17-23
**Commit(s):** `cb695e2`

Adds `formatOptionsBlock(qs)` and `commitOptionsBlock(renderer, reqID, qs, seen)` as module-scope helpers in `src/app.tsx`. Wires three `setQuestion` call sites — SSE `question-asked` handler (line 640), `question-tool-detected` discovery branch (line 666), and the 5s discovery sweep for missed questions (line 265) — to commit the options block to scrollback before setting the modal state. Dedupe across sites via a single `useRef<Set<string>>` (`committedOptionsReqIDsRef` at line 175).

Result: options become first-class scrollback content. Operators can scroll back during deliberation; Ctrl-C no longer destroys the option list (it persists in the immutable `<Static>` region).

### 2026-06-07--17-23 — Stage 9.1 — Piece 2B: custom-text answers via PromptInput
**Implemented by:** OpenCode Brain pipeline (Anthropic Opus 4.7 orchestrator + sohoai/glm-5.1 heavy-tier Actors for the architectural seams; sohoai/qwen3-4b-q6 for routing and disabled-flag edits) — 2026-06-07--17-23
**Commit(s):** `cb695e2`

Strips `QuestionModal.tsx` to a pure display component: no `useInput`, no internal state. The modal now takes `{ questions, currentSubIdx }` props and renders `questions[currentSubIdx]` directly. The PromptInput is the sole input channel. The `disabled` flag drops `!!question` entirely — the prompt is enabled whenever no other modal blocks it.

Routing logic at the top of `handleSubmit` (added BEFORE all slash-command parsing): if a question is pending, trim the buffer; if it matches `/^\d+$/` AND parses to 1..N (where N = options length), POST `currentQ.options[n-1].label`; otherwise POST the prose. For multi-question batches, the current slot (`currentSubIdx`) is populated and the rest are padded with empty `[]` arrays — matching opencode's canonical convention (`questionAnswers` at `cli/cmd/run/question.shared.ts:105-107`).

Tactical fix during implementation: `handleQuestion` was relocated to be declared BEFORE `handleSubmit` in source order to avoid a React `useCallback` deps-array TDZ error ("Cannot access 'handleQuestion' before initialization").

### 2026-06-08--08-34 — Stage 9.2 — Answer-summary scrollback line

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-08--08-34
**Commit(s):** `b3ecc86`

Adds `formatAnswerSummary(q, subIdx, total, rawText)` module-scope helper (next to `formatOptionsBlock`) that builds a `▶ Answered Q{i+1}/{N}…` summary string. For in-range digit picks, expands the digit to its full option line `{n}. {label} — {description}`, mirroring the shape used in `formatOptionsBlock`. For prose (out-of-range digit, plain text, multi-line), uses the verbatim trimmed text.

In `handleSubmit`'s question-branch, replaces `renderer.commitUserInput(text)` (which produced a bare raw digit like `> 3` with no context) with `renderer.commitSystemMessage(formatAnswerSummary(...))`. The raw-text echo is suppressed; the new summary block is its sole replacement.

The original `▷ Question N/M` options block (committed by Stage 9 Piece 2A) is untouched — it remains in immutable `<Static>` scrollback.

## Decisions (canonical list)

| ID | Decision | Reasoning |
|---|---|---|
| D1 | Bare integer 1..N selects; everything else is prose | Lowest-friction routing rule; operator-typed `1 ` (trailing space) or `0` or out-of-range digits fall through to prose intentionally (treats the buffer verbatim as the answer) |
| D2 | Committed options block uses a distinct visual prefix ("▷ Question N/M") to avoid confusion with the live modal | Helps the operator distinguish "archived" question from "active" modal when scrolling |
| D3 | `multiple:true` deferred | UX rat-hole (prose vs multi-select semantics); current brain use-case is single-pick |
| D4-α | Prose on a multi-Q batch answers the current sub-Q and pads remaining sub-Qs with empty `[]` | Mirrors opencode's own client convention; model decides what to ask next based on the prose |
| D5 | Route X (reuse main PromptInput) | Avoids duplicating editor logic + Ink 5 input quirks |
| D6 | Plain-text formatted options block | Options are UI scaffolding, not model prose; immutable scrollback is correct semantic |
| D7 | Server-side schema accepts free text regardless of `custom` flag value | Verified against opencode dev fork at `~/Gin-AI/projects/opencode` (commit `98a4907c9`); the `custom` flag is purely a UI hint, not server-validated |
| D8 | Thin `commitOptionsBlock()` helper at app layer wraps `commitSystemMessage` | Future-proofs against Piece 1 wanting to render option blocks differently; one function to upgrade, no Renderer interface change |
| Pivot | Modal is display-only; prompt is always enabled when no other modal; `custom` flag ignored | Operator clarification mid-implementation; "the modal is a bounded visual decision frame, not a picker" |

## Harness vs Model Behaviour Boundary

octmux is a UI harness for opencode. The work in Stage 9 is intentionally scoped to UX — rendering questions, accepting input, mapping operator keystrokes to the protocol payload shape. It does **not** prompt the model, does **not** rewrite operator input, and does **not** invent protocol semantics.

However, one design choice in Stage 9.1 (D4-α — prose on a multi-question batch answers the current sub-question and pads remaining sub-questions with `[]`) does implicitly rely on a **server-side convention**: opencode's tool consumer renders empty `[]` slots as the literal string `"Unanswered"` (verified at `~/Gin-AI/projects/opencode/packages/opencode/src/tool/question.ts:31`). The model receives `"Unanswered"` for the slots octmux padded, and the model decides what to do next — typically it moves on without re-asking, or generates a summary acknowledging the skipped questions.

This means **D4-α's "deep-dive then resume" semantic depends on the model interpreting `"Unanswered"` as "operator wants to discuss, please continue"** rather than "operator deliberately skipped this." The protocol itself does not distinguish; both intents serialize identically. The harness's responsibility ends at sending the canonical payload shape that opencode's own clients send. Whether the model treats the unanswered slots as deferred-pending vs deliberately-skipped is the brain-prompt author's concern. If a brain wants explicit deferral, the brain prompt should communicate that intent in the question text itself (e.g., "If you want to discuss one question first, type prose for that one; the others will be re-asked after we resolve your concern.").

This boundary is **named, not policed**. octmux trusts the model. Operators trust the brain. The harness gets out of the way.

## Files touched

- `src/app.tsx`: +89/-6 (helpers, ref declaration, three setQuestion sites wired, currentSubIdx state + reset useEffect, handleSubmit routing branch, handleQuestion relocation, disabled-flag simplification, QuestionModal call-site prop update)
- `src/components/QuestionModal.tsx`: +13/-19 (modal rewritten as display-only component)
- `docs/Stage9.md`: new file (this document)

## Manual verification — smoke test results

Smoke test exercised 2026-06-07 with a 4-question multi-part batch ("color / shape / fruits / direction"). Operator typed prose for sub-Q 1 ("Half-way between 1 and 3 -- Yellow"); sub-Qs 2-4 were padded with `[]`. The model received the prose answer for sub-Q 1, "Unanswered" for sub-Qs 2-4, and produced a summary acknowledging the skipped questions. **Items 1-2 (single-question prose, multi-Q D4-α padding) confirmed end-to-end.** Items 3-5 (Ctrl-C, reconnect dedupe, `--multi-window`) accepted on symmetry: the diff does not touch the Ctrl-C handler, the dedupe `Set` ref pattern is exercised on first commit (confirmed by single-commit in 4-Q batch), and `TmuxWindowRenderer.commitSystemMessage` delegates directly to `_main` (verified in Phase 0 research). Operator will exercise items 3-5 manually after commit.

## Known follow-ups (deferred from Piece 2 scope)

- **`multiple:true` support**: defer; today the modal falls back to single-pick behaviour when `multiple:true` is set.
- **D4-β client-side pinning of remaining sub-questions across re-asks**: explicitly fenced by handoff doc; out of scope.
- **Slash command availability during pending questions**: under Stage 9.1 routing, typing `/exit` while a question is pending POSTs `"/exit"` as the answer (because `handleSubmit`'s question-routing branch executes before slash-command parsing). Escape from a pending question is Ctrl-C. Documented as known follow-up.
- **Sub-Q navigation within a batch**: `currentSubIdx` is owned by app.tsx but has no UI mechanism to advance it (the modal no longer captures input, so its old `qIdx` advance loop is gone). For multi-Q batches today, the operator answers the current sub-Q (whichever opencode considers current — index 0 from octmux's perspective) and the model handles the rest. A future Stage could add a keybind for cross-sub-Q navigation.
- **Piece 1 (block-buffered renderer)**: separate `/brain` session, separate branch (`feat/block-renderer`). Piece 2 uses only the existing `commitSystemMessage` from the `Renderer` interface, so Piece 1 can be implemented later without revisiting Piece 2 code.
