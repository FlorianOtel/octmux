---
title: "Stage 13 — Mobile Companion Part B (foreign-user-turn rendering)"
created_at: 2026-06-15--18-51
created_by: OpenCode Brain pipeline (Anthropic Opus 4.7 orchestrator + sohoai/minimax-m3 Planner + sohoai/qwen3-4b-q6 + sohoai/glm-5.1 Actors)
updated_by: Actor (sohoai/qwen3-4b-q6 + sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-17--02-05
updated_at: 2026-06-17--02-05
context: >
  Stage 13 implements Mobile Companion Part B: render foreign (mobile-originated) operator turns in the octmux transcript while suppressing locally-submitted turns. Builds on Part A's whole-turn commitUserInput primitive (commit f5103b0). Unconditional (no flag/env); inert without a mobile peer. Implemented on the feat/mobile-app worktree, not main.
---

### 2026-06-15--18-51 — Stage 13 — Mobile Companion Part B — foreign-user-turn detection at turn boundary
**Implemented by:** Actor (sohoai/qwen3-4b-q6 + sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-15--18-51
**Commit(s):** `0b932ec`

**Problem:** octmux suppresses ALL user-message SSE echoes (origin-blind, events.ts) because local turns are optimistically rendered by commitUserInput on submit; a mobile-submitted turn gets no optimistic render and is then suppressed → invisible. You see the phone-triggered reply but not the phone-typed question.

**Solution (Design 2, unconditional):** a FIFO of locally-submitted prompt texts discriminates local from foreign. Classification happens at the TURN BOUNDARY (assistant message.updated primary; session.idle backstop), NOT on the user message.updated — because the OC server emits the user message.updated BEFORE its text parts (verified against opencode prompt.ts:1121-1122: updateMessage(info) first, then the updatePart loop), so text is not yet available at user-message-updated time. User text parts accumulate per-messageID (excluding synthetic===true || ignored===true), are joined with "\n" at the boundary, compared to the FIFO head: match → suppress (local echo, already rendered); no match → emit a new foreign-user-turn ReplEvent, which app.tsx routes to renderer.commitUserInput(text) — the same Part A primitive, so multi-line inverse-video render is correct by construction.

**New events.ts API:** recordSubmittedUserText(text), peekSubmittedUserText() (test-only), consumeSubmittedUserText (private), flushOpenUserTurn (private). New ReplEvent variant foreign-user-turn. Module state: submittedUserTexts FIFO, accumulatedUserTexts Map, classifiedUserMessageIDs Set, openUserTurnMessageID; all cleared by resetEventState.

**app.tsx:** recordSubmittedUserText pushed at the two SSE-visible submit paths only (default promptAsync path + /cmd forward via session.command); the 11 local-only command paths (/exit /new /compact /sessions /fork /resync /rename /model /help /show /<key>-output) explicitly do NOT push. New applyReplEvents branch for foreign-user-turn → commitUserInput (no setIsGenerating).

**Tests:** 6 new unit tests in src/events.test.ts (local dedup + FIFO consumed, foreign single-part, foreign multi-part with synthetic/ignored exclusion, all-synthetic→no-emit, session.idle backstop, resetEventState clears). Full suite 217 pass, 0 fail.

**Decisions:** no flag/env (unconditional; inert without a peer); exclude synthetic/ignored parts; Design 2 (not Design 1). Verified facts: promptAsync returns 204 void (no id) so FIFO-of-texts is mandatory; user message has no time.completed; the only turn-complete signal is the next different messageID / session.idle.

**Reversibility:** Part B is confined to events.ts + a few app.tsx lines; with no mobile peer it is inert.

### 2026-06-16--11-29 — Model Adoption Fix (shared-session hijack prevention)
**Implemented by:** Actor (local/qwen3-4b-q6) — 2026-06-16--11-29
**Commit(s):** `672e202`

**Problem:** octmux's `activeModel` was being silently overwritten by foreign (mobile-app) turns in a shared OpenCode session. When the mobile app submitted a prompt with model `requesty/google/gemini-3-pro-preview`, that assistant message became the latest in the shared session. The next `message-completed`/`session-idle` SSE event triggered `refreshTokenUsage`, which read the latest assistant message's model via `pickPostSummaryAssistantTokenUsage` and called `setActiveModel(...)`, overwriting octmux's own model. The server then rejected the next prompt with `ProviderModelNotFoundError`.

**Root cause (confirmed):** `refreshTokenUsage` (src/app.tsx:665) computed token usage from the latest post-summary assistant but also mutated `activeModel` state. In a shared session, foreign turns hijack this state. The mount effect (lines 902-925) and session-switch effect (lines 1078-1090) already seed `activeModel` from `session.get().data.model` with `getDefaultModel` fallback, making `refreshTokenUsage`'s model-adoption redundant for the legitimate resume/fork case.

**Solution:**
1. **Stop refreshTokenUsage from overwriting activeModel** (src/app.tsx:686): Removed the `setActiveModel(...)` call inside `refreshTokenUsage`. The function now only updates display-only values (token bar and running cost). Added a comment explaining the shared-session rationale: "foreign turns must not hijack octmux's model."

2. **Verified seeding paths**: Confirmed that the mount effect (line 913) and session-switch effect (line 1087) both seed `activeModel` from `session.get().data.model` with `getDefaultModel` fallback. No gaps found.

3. **Defense-in-depth validation** (src/utils/formatters.ts + src/app.tsx:1379,1413): Added `validateModel(client, providerID, modelID)` helper that checks if the provider+model exist in the connected providers returned by `client.provider.list()` (iterating `data.all` filtered by `data.connected` — the same source the `/model` picker uses). Before sending (both `session.command` and `promptAsync` paths), if `activeModel` is not found among connected providers, emit a one-line system message (`"active model X not available — falling back to Y"`) and fall back to `getDefaultModel(props.client)`. This prevents ANY stale/foreign model from reaching the server.

4. **Unit test**: Added a regression test in `src/refresh-token-usage.test.ts` asserting that a message list whose latest assistant turn uses a foreign model still yields correct token usage, and documenting that `activeModel` is no longer derived from it. Full suite: 231 pass, 0 fail.

5. **Binary rebuild**: `bash scripts/build.sh` → `dist/octmux` builds clean.

**Risks mitigated:**
- Context-window display: `getContextWindow` still uses the latest turn's model for the token bar denominator (display-only, cosmetic, acceptable).
- Validation cost: submit-time only (not per-keystroke).

**Out of scope:** No change to the mobile app; no redesign of session sharing; no SSE event model changes; no persistence of `activeModel` to disk.

### 2026-06-17--02-05 — Stage 13.x — client-supplied messageID for own-turn echo suppression (regression fix)
**Implemented by:** Actor (sohoai/qwen3-4b-q6 + sohoai/glm-5.1) via /brain pipeline (Brain: anthropic/claude-opus-4-8) — 2026-06-17--02-05
**Commit(s):** `d1b7b20`

**Problem:** Two Stage 13 regressions: (1) operator input echoed TWICE during /brain and /duo (orchestra) sessions; (2) at the start of a /brain or /duo session the entire EXPANDED slash-command markdown template was rendered as a giant green-inverted operator-input block.

**Root cause:** Stage 13's text-FIFO echo-suppression compared the raw submitted text against the server's SSE user-message echo. For slash commands (`/brain`, `/duo`) the OpenCode server expands the command into its FULL template before creating the user message (opencode prompt.ts:1540-1589), so the SSE user text = the expanded template, which never equals the raw `/brain ...` line recorded in the FIFO → that turn renders as a foreign-user-turn (regression #2). And because the exact-equality FIFO only shifts on a MATCH (events.ts:157-163), the unmatched `/brain` entry stayed stuck at the head, poisoning every subsequent normal-prompt lookup → those also rendered a second time (regression #1). Native (non-orchestra) sessions were unaffected because they have no slash-command expansion (FIFO stayed clean). Question-modal answers were unaffected (they use commitSystemMessage + tool-result, not the FIFO).

**Solution:** octmux now MINTS its own user-message id (`msg_<ts36><rand36>`, server schema only requires the `msg` prefix per opencode session/schema.ts:10) and passes it as `body.messageID` on both SSE-visible submit paths (`session.promptAsync` default + `session.command` slash forward; server uses the client id verbatim per prompt.ts:722-723). events.ts records own ids in an `ownMessageIDs` Set and classifies each user turn PER messageID identity: own id → suppress; otherwise → emit foreign-user-turn. The text-FIFO machinery (`submittedUserTexts`, `recordSubmittedUserText`, `peekSubmittedUserText`, `consumeSubmittedUserText`, `flushOpenUserTurn`) and the single mutable `openUserTurnMessageID` slot were retired and replaced by `recordOwnMessageID(id)` + `classifyOpenUserTurns()`.

**Interleave safety:** because classification is by id identity (not order/count), a mobile (foreign) turn interleaved between two local turns is judged independently — foreign rendered once, both local suppressed. This was the explicit operator requirement (mobile + octmux operators interleaved on the same shared session). An explicit interleave unit test guards it. Mobile foreign-user-turn rendering is preserved (foreign ids are not in ownMessageIDs → still emitted/rendered).

**Tests:** the 6 Part B tests were migrated to the ID model; 2 new tests added (slash-command expanded-template suppression; interleave foreign-between-two-locals). events.test.ts 48/0; full suite 241 pass / 0 fail. Binary rebuilt via scripts/build.sh.
