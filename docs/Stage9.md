---
title: "Stage 9 — Question Deliberation Flow (Piece 2)"
created_at: 2026-06-07--17-23
created_by: OpenCode Brain pipeline (Anthropic Opus 4.7 orchestrator + sohoai/qwen3-4b-q6 + sohoai/glm-5.1 Actors)
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-06-08--08-34
context: >
  Stage 9 implements Piece 2 of the octmux UI architecture redesign: the AskUserQuestion tool's options are committed to scrollback (Piece 2A) and the operator can answer with prose in addition to digit selection (Piece 2B). Piece 2 is renderer-independent and works identically under both --single (StdoutRenderer) and --multi-window (TmuxWindowRenderer) modes.
---

## See also

- **`~/Gin-AI/tmp/Piece2-Question-Deliberation-Flow.md`** — Piece 2 design document: UI architecture redesign for question deliberation.
- **`docs/Stage8.md`** — previous stage: live cost display and orchestra inflight badge.
- **`docs/Stage7.md`** — native opencode /rag command + discovery and forwarding.

---

## Implementation log

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
