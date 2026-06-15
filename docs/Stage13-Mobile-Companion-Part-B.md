---
title: "Stage 13 — Mobile Companion Part B (foreign-user-turn rendering)"
created_at: 2026-06-15--18-51
created_by: OpenCode Brain pipeline (Anthropic Opus 4.7 orchestrator + sohoai/minimax-m3 Planner + sohoai/qwen3-4b-q6 + sohoai/glm-5.1 Actors)
updated_by: Actor (sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-15--18-51
updated_at: 2026-06-15--18-51
context: >
  Stage 13 implements Mobile Companion Part B: render foreign (mobile-originated) operator turns in the octmux transcript while suppressing locally-submitted turns. Builds on Part A's whole-turn commitUserInput primitive (commit f5103b0). Unconditional (no flag/env); inert without a mobile peer. Implemented on the feat/mobile-app worktree, not main.
---

### 2026-06-15--18-51 — Stage 13 — Mobile Companion Part B — foreign-user-turn detection at turn boundary
**Implemented by:** Actor (sohoai/qwen3-4b-q6 + sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-15--18-51
**Commit(s):** `73d8fc7`

**Problem:** octmux suppresses ALL user-message SSE echoes (origin-blind, events.ts) because local turns are optimistically rendered by commitUserInput on submit; a mobile-submitted turn gets no optimistic render and is then suppressed → invisible. You see the phone-triggered reply but not the phone-typed question.

**Solution (Design 2, unconditional):** a FIFO of locally-submitted prompt texts discriminates local from foreign. Classification happens at the TURN BOUNDARY (assistant message.updated primary; session.idle backstop), NOT on the user message.updated — because the OC server emits the user message.updated BEFORE its text parts (verified against opencode prompt.ts:1121-1122: updateMessage(info) first, then the updatePart loop), so text is not yet available at user-message-updated time. User text parts accumulate per-messageID (excluding synthetic===true || ignored===true), are joined with "\n" at the boundary, compared to the FIFO head: match → suppress (local echo, already rendered); no match → emit a new foreign-user-turn ReplEvent, which app.tsx routes to renderer.commitUserInput(text) — the same Part A primitive, so multi-line inverse-video render is correct by construction.

**New events.ts API:** recordSubmittedUserText(text), peekSubmittedUserText() (test-only), consumeSubmittedUserText (private), flushOpenUserTurn (private). New ReplEvent variant foreign-user-turn. Module state: submittedUserTexts FIFO, accumulatedUserTexts Map, classifiedUserMessageIDs Set, openUserTurnMessageID; all cleared by resetEventState.

**app.tsx:** recordSubmittedUserText pushed at the two SSE-visible submit paths only (default promptAsync path + /cmd forward via session.command); the 11 local-only command paths (/exit /new /compact /sessions /fork /resync /rename /model /help /show /<key>-output) explicitly do NOT push. New applyReplEvents branch for foreign-user-turn → commitUserInput (no setIsGenerating).

**Tests:** 6 new unit tests in src/events.test.ts (local dedup + FIFO consumed, foreign single-part, foreign multi-part with synthetic/ignored exclusion, all-synthetic→no-emit, session.idle backstop, resetEventState clears). Full suite 217 pass, 0 fail.

**Decisions:** no flag/env (unconditional; inert without a peer); exclude synthetic/ignored parts; Design 2 (not Design 1). Verified facts: promptAsync returns 204 void (no id) so FIFO-of-texts is mandatory; user message has no time.completed; the only turn-complete signal is the next different messageID / session.idle.

**Reversibility:** Part B is confined to events.ts + a few app.tsx lines; with no mobile peer it is inert.
