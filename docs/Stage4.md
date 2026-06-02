---
title: "octmux — Stage 4: Status line + async streaming + Esc-interrupt + rich parts (planned)"
created_at: 2026-05-21--20-18
created_by: Claude Code (Claude Sonnet 4.6)
updated_by: Claude Code (Claude Haiku 4.5 via /brain pipeline — Actor)
updated_at: 2026-06-02--14-43
context: >
  Stage 4 is the next major phase focusing on the status line, async streaming,
  Esc-interrupt capability, and rich part rendering. This document contains
  the complete planning and implementation logs for Stage 4. Stage 5 work
  (/help command, live slash-completion overlay, input highlighting) continues
  in docs/Version5.md as of 2026-05-25--17-10.
---

# Read first when adding a streaming output toggle (e.g. /subagent-output)

This section is the contract for adding a new per-block-class streaming output toggle on top of the renderer machinery built in Stage 4.4.3 + 4.4.4 + 4.5 + 4.5.1. Read it before adding a new gate key (current keys: `thinking`, `tools`; planned: `subagent`).

## The pure-gate invariant

`TmuxWindowRenderer.setOutputEnabled(key, on)` and `StdoutRenderer.setOutputEnabled(key, on)` are **pure setters** on a `Map<string, boolean>`. They mutate the gate entry and do nothing else. No window creation. No FIFO open/close. No tmux subprocess. No events emitted.

Window / FIFO / streaming lifecycle is owned exclusively by `TmuxWindowRenderer._ensureWindow(key)`, invoked exclusively from `beginBlock` (the Stage 4.4.3 load-bearing path). Re-entry safety (detect manually-killed windows and recreate) and the Stage 4.4.4 async liveness cache (`_liveIds`) live there.

When the gate is off:
- `beginBlock` registers partID in `_openBlocks` THEN early-exits before `_ensureWindow`. This is intentional — it lets a mid-block toggle-on flip seamlessly with no lost block bookkeeping.
- `appendToBlock` and `endBlock` early-exit after the gate check, writing nothing.

When the gate flips back on, the next matching block-start runs `_ensureWindow` and the window materializes on its own.

This invariant is uniform across both renderers and across all gate keys, current and future. Future toggles (`/subagent-output`, etc.) inherit it for free.

## How to add a new toggle

The single source of truth for which roles route to which gate is `src/renderer/output-keys.ts`. To add e.g. a `subagent` toggle:

1. Add `subagent` to `Role` in `src/blocks.ts` (if not already a role) and ensure the upstream event source (currently `src/events.ts`) emits `block-start` / `appendToBlock` / `block-end` for it.
2. Add one line to `OUTPUT_KEY` in `src/renderer/output-keys.ts`: `subagent: "subagent"`.
3. That's it. The rest auto-wires:
   - `parseBlockOutputCommand` validates against `OUTPUT_KEYS` — `/subagent-output [on|off]` works immediately.
   - `parseShowCommand` iterates `OUTPUT_KEYS` — `/show` lists it immediately.
   - `command-registry.ts`'s `/<key>-output` dynamic entry expands via `OUTPUT_KEYS.map(...)` — `/help` and the completion overlay show it.
   - Both renderers' constructors iterate `OUTPUT_KEYS` to default the gate to true.

No code changes in `commands.ts`, `app.tsx`, `tmux-window.ts`, `stdout.ts`, or `command-registry.ts` are required.

## Why the eager-creation experiment was rejected

Stage 4.5 (commit `25c644a`) tried adding an eager `_ensureWindow` call inside `setOutputEnabled` so the side window would appear immediately on `/<key>-output on`. The operator reported that the window appeared re-created but no content streamed to it, and `dispose` printed `can't find window: @17` to stderr at session end.

The eager call broke the Stage 4.4.3 invariant in two ways:
1. **Stale-cache hit** — `_liveIds` reports the cached ID alive when it's actually dead; the eager call returns early without recreating; the map still points at the dead ID, and no block-start has fired to trigger lazy recreation; later `dispose` tries to kill the dead window.
2. **Cache-miss recreation** — runs the cleanup-then-fresh-create sequence outside any active streaming context; subsequent block-start may not race favorably with the file-handle / tail-pipe lifecycle the eager call set up.

Stage 4.5.1 reverted the eager call. The lazy-on-block-start UX (window appears on the next matching block, not on toggle) is the accepted trade-off. Future toggle implementers MUST NOT re-introduce eager window creation in `setOutputEnabled` — doing so re-introduces the same regression class for every gate key.

**Stage 4.5.2 follow-up — the one permitted side effect.** Stage 4.5.1's strict invariant exposed a second-order issue: during a long gate-off period, no `beginBlock` fires `_ensureWindow`, so the Stage 4.4.4 `_liveIds` cache never gets refreshed. If the operator killed the side window during gate-off, the next block-start after toggle-on would silently write to a dead FIFO (block 1 lost). Stage 4.5.2 (commit `bde7d9a`) added a single permitted side effect to `setOutputEnabled`: on `on=true`, kick a non-blocking `_refreshLiveIdsAsync()` so the cache is fresh by the next block-start. Cache mutation only — no window/FIFO/block touched, no blocking I/O. The full pure-gate prohibitions on `_ensureWindow`, window spawning, FIFO open/close, and synchronous tmux subprocesses remain in force. See the Stage 4.5.2 implementation log entry for the design rationale and a fully-specified Option B (force-sync-probe via flag) held in reserve for the rare sub-50ms toggle-then-submit race.

---

# Read first — Stage 4.6: Inline Markdown rendering

This section records the design decisions for Stage 4.6 (inline markdown rendering in `formatLine`). Read it before modifying `renderInlineMarkdown`, changing the role scope, or adding block-level constructs.

## What was built and why

Octmux previously printed markdown formatting markers literally — `**Rank 1**` appeared on screen with visible asterisks, rather than rendering as bold text. The goal of Stage 4.6 is to match Claude Code's rendering of the same model output, transforming inline markdown constructs to ANSI styling while keeping the implementation minimal and safe.

The transformation is inline-only (bold `**text**`, italic `_text_` / `*text*`, and inline code `` `text` ``) and runs per-line in the `formatLine` function in `src/blocks.ts`. This approach works within the existing per-line commit model and requires no new dependencies.

## The four alternatives considered

### Option A — Inline regex in `formatLine` (chosen)

A pure-function approach: new exported function `renderInlineMarkdown(line)` applies regex transformations on plain strings and is called from `formatLine` for exactly three roles (`text`, `thinking`, `tool-result`). Both `StdoutRenderer` and `TmuxWindowRenderer` reach `formatLine` through the same code path, so behaviour is identical in `--single` and `--multi-window` modes. No new dependency. No architecture change. Simplicity and locality win.

### Option B — Library-based full markdown (`marked` + terminal renderer)

This approach would add a ~1 MB dependency (`marked` for parsing + a terminal-output library). It requires a block-accumulator architecture where `<Static>` items become non-immutable, deferred until paragraph/fence boundaries. Critically, it would destroy the live-streaming feel of `--multi-window` side panes. Currently, thinking and tools panes stream character-by-character via `tail -f`; with per-block buffering they would only update on block boundaries, introducing artificial delay and jank. Rejected for v1; revisit if/when fence rendering becomes a hard requirement.

### Option C — Hybrid (raw on the wire, rewrite committed lines)

Post-hoc rewriting of already-committed lines. Impossible for `--multi-window` side panes because once bytes are written to the FIFO they are in tmux's scrollback and cannot be rewritten. Would force a behavioural inconsistency between modes (rich main pane vs. raw side panes) or limit the rewrite to `--single` only. Rejected.

### Option D — Wider construct set (headings, bullet lists, code fences)

Headings and bullet lists can be handled per-line; code fences cannot (they span multiple lines) and would break the per-line commit model. The operator explicitly excluded wider constructs to keep the change small and safe. Rejected for this version.

## Why inline-only rendering was chosen

The multi-window constraint is decisive. The per-line commit model and FIFO-write architecture cannot be unwound without rearchitecting the renderer. Inline constructs are self-contained on a single line and are safe under partial-delta streaming. An unbalanced `**fo` arriving mid-stream renders raw until the closing `**` arrives — slight visual flicker on a rare edge case, acceptable in exchange for simplicity.

## Role scope rationale

Three roles receive `renderInlineMarkdown`:

- **`text`** — model-generated prose that legitimately contains markdown formatting
- **`thinking`** — model-generated reasoning that may contain markdown
- **`tool-result`** — tool output that may contain markdown (including RAG results)

Three roles are left untouched:

- **`user`** — preserved literal (users may type `**foo**` and expect it kept exactly)
- **`tool-call`** — typically structured / JSON-like preamble where markdown rarely helps
- **`error`** — always plain text from the system

## Explicit out-of-scope list

- Block-level markdown (headings, bullet lists, ordered lists, code fences, block quotes, horizontal rules, tables, links)
- Any change to the per-line commit model in `StdoutRenderer` or the FIFO write loop in `TmuxWindowRenderer`
- Any change to `<Static>` mutability or the Ink component tree
- Any new npm/bun dependency
- Markdown in `user` or `tool-call` roles
- A runtime toggle or CLI flag for this feature
- Re-formatting already-committed scrollback
- Syntax highlighting

## Invariants this change explicitly does not modify

1. **Stage 4.5.1 pure-gate invariant** — `setOutputEnabled` remains a pure Map setter; no side effects added.
2. **Lazy-window invariant** — `TmuxWindowRenderer._ensureWindow` is called only from `beginBlock`; this change does not touch `tmux-window.ts`.
3. **Per-line commit model** — `StdoutRenderer.appendToBlock` still commits one line at a time; `renderInlineMarkdown` is called from `formatLine`, which runs before the line text reaches the persistent committed-line array.
4. **`<Static>` items remain immutable** — committed lines are not rewritten after the fact.

## Implementation notes for future maintainers

The bold pass runs before the single-asterisk italic pass to avoid `*` ambiguity in mixed content. Code spans are extracted to placeholders before bold/italic passes and re-expanded after, so backtick content is never transformed. Italic on `_word_` requires non-letter/digit characters on both sides (enforced via regex word-boundary guards) to avoid matching `snake_case`. The `\x1b[0m` reset that `formatLine` already appends clears any open inline SGR state, so no extra reset is needed inside `renderInlineMarkdown`.

ANSI codes are zero-width to Ink's measurement and do not affect line-wrapping. Italic codes may silently degrade on older terminals (renders as plain text or inverse video) — acceptable. On `thinking` and `tool-result` lines (which wrap the result in `ANSI.gray` / `ANSI.dim`), inline bold/italic nest as bold-gray / dim-cyan-on-dim — distinguishable on modern terminals.

---

# Stage pre-implementation checklist - Read this first

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
4. Commit with `feat(octmux): Stage N — <short title>`.

---

## Implementation log (reverse chronological — newest at top)

### 2026-06-02--14-43 — Stage 4.5.7: per-message cost refresh + ticker reset

**Implemented by:** Claude Code (Claude Sonnet 4.6 — Planner; Claude Haiku 4.5 — Actor) via /brain pipeline — 2026-06-02--14-43
**Commit(s):** `1e08d2b`

**A. Motivation and OC protocol context**

The OC protocol fires `session.idle` exactly once at the end of an assistant-message chain. In the investigated run (36 assistant messages over 10.5 minutes), this meant `Σ$` cost display was static — updated only when the entire pipeline completed. Operators working long-running multi-turn chains observed the running cost "stuck" at an old value while the spinner/ticker accumulated full pipeline wall time, creating false impression that no billing was happening during the 10+ minute chain. Root cause: both `refreshTokenUsage` and the `procTimes.generating` reset were wired exclusively to the `session-idle` handler in `applyReplEvents`.

**B. Implementation approach**

New `message-completed` ReplEvent variant added to the `ReplEvent` union in `src/events.ts`. Module-scope `completedAssistantMessageIDs: Set<string>` tracks assistant messageIDs to prevent re-firing on repeated `message.updated` events after OC sets `time.completed`. The Set is cleared in `resetEventState()` on session switch. In `filterEvent`, the `message.updated` handler now reads assistant messages and emits `message-completed` at most once per messageID when `info.time?.completed` is non-null. In `src/app.tsx`, the `applyReplEvents` handler adds a new arm for `message-completed`: calls `refreshTokenUsage(sessionIDRef.current)` to update Σ$ incrementally + calls `setProcTimes(p => ({ ...p, generating: Date.now() }))` to reset the "generating" ticker to zero for the next logical turn. `isGenerating` remains untouched — the OC pipeline is still running; only the display timer resets.

**C. Ground-truth cost data table**

| Tier | OC Session ID | cost ($) | tokens_input | tokens_output | tokens_reasoning | cache_read | cache_write |
|------|---------------|----------|--------------|---------------|------------------|------------|-------------|
| Brain (Opus-4.7) | `ses_1785516e0ffe93IUMMdfoJDzZS` | $1.993335 | 41 | 23262 | 0 | 1841435 | 78538 |
| Plan (free — sohoai/ollama-cloud/glm-5.1) | `ses_1784f1abbffe65fEMrJAUbHzGq` | $0.0 | 24264 | 538 | 324 | 0 | 0 |
| Actor (free — sohoai/ollama-cloud/qwen3-coder-next) | `ses_1784caa22ffeZig8EU39QZGxTS` | $0.0 | 83257 | 1305 | 0 | 0 | 0 |
| Reviewer (Sonnet-4.6) | `ses_1784bd40fffeJW3j02ShMKT6zm` | $0.05470815 | 5 | 870 | 0 | 17548 | 9701 |

Note: non-Anthropic free tiers correctly show cost=$0 with non-zero tokens.

**D. Three numbers, two gaps**

Status-bar live $2.78; telemetry.json $1.847182; DB sum $2.048043. Gap A: −$0.20 (T2 summariser ran at ~09:40:34 when brain.session.cost was ~$1.79; row grew to $1.993 by 09:41:04 — oconona cleanup-block ordering artifact; deferred). Gap B: +$0.73 (open mystery; hedged hypotheses: stale runningCost from earlier turns, grandchildren beyond one-level walk, SDK/DB skew; no fix attempted).

**E. UX root cause this stage fixes**

`refreshTokenUsage` and `procTimes.generating` reset were both wired exclusively to the `session-idle` handler; correct for single-turn interactive use but produced two UX failures during long pipelines: (1) Σ$ frozen at old value while chain runs, (2) "generating" ticker accumulates full wall time instead of counting from zero on each message boundary. Fix: `message-completed` fires both updates at each assistant message boundary, so operators see Σ$ and timers refresh incrementally.

**F. Dedup correctness argument**

OC broadcasts `message.updated` repeatedly after `time.completed` is set (e.g. follow-up metadata updates). The `completedAssistantMessageIDs` Set guarantees at-most-once emission per messageID via the `!completedAssistantMessageIDs.has(info.id)` guard before emission and the `add(info.id)` before return. Bounded by message count per session (Set is cleared on session switch via `resetEventState()`). No memory leak.

### 2026-06-01--22-00 — Stage 4.5.6: Bordered modal chrome for QuestionModal + PermissionModal

**Implemented by:** Claude Haiku 4.5 (Actor, direct Brain spec — no /brain pipeline per operator's request) — 2026-06-01--22-00
**Commit(s):** `9a7a478`

**Motivation:** Stage 4.5.5 unblocked the question modal end-to-end (directory header now threaded everywhere), but operator-side testing surfaced a separate UX issue — the modal was opening but operators didn't recognise it as a modal. Root cause: `QuestionModal.tsx` and `PermissionModal.tsx` previously rendered as bare `<Box flexDirection="column">` with `<Text bold>` + dim numbered options. No border, no header label, no key hint, no visual distinction from inline scrollback content (streamed text, tool-call output). Compounded by OC's protocol behaviour: while the question tool is `status=running`, OC's `time.completed=null` keeps the assistant turn in-flight, and octmux faithfully shows the "generating" + "tools" tickers — operators interpreted this as "model still working" rather than "modal awaiting input". Live observed in OC session ses_17b53d0fcffeRdCTxw3CVo6JYf (cwd-bug-fix-test-too) where the operator did not realise the QuestionModal had already opened and was waiting on keystroke 1/2/3.

**Fix — bordered chrome for both modals (gruvbox palette consistent with `src/components/StatusLine.tsx`):**

- **QuestionModal.tsx:** wrap return JSX in `<Box borderStyle="round" borderColor="#83a598" paddingX={1}>`; add header line `▶ Question N/M — <header>` in blue (#83a598) bold; body `<Text bold color="#ebdbb2">` ivory; options block `flexDirection="column" marginTop={1}` with each option rendered as nested `<Text>` — bold yellow (#fabd2f) numbered prefix + label + dim description; footer `Press 1–N to answer` with `· X more after this` suffix when `questions.length > 1`. `useInput` handler, Props type, imports — unchanged.

- **PermissionModal.tsx:** same chrome pattern but with amber border `#fe8019` (deliberately distinct from question blue so the operator immediately registers "warning, decision required" vs. informational). Header `▶ Permission requested` in amber bold; body `<Text bold color="#ebdbb2">{title}</Text>` ivory; footer with coloured key letters — bold yellow (#fabd2f) `y`, `a`, `n` interleaved with `= allow once`, `= always`, `= reject`. `useInput` handler unchanged.

- **app.tsx ~line 1080:** 3-line invariant comment immediately above the `permission` / `question` render expressions documenting that modal-bearing events bypass the renderer's output gates by design — interactive prompts must always surface to the operator regardless of `/tools-output` or `/thinking-output` toggle state. Codifies the architectural separation between modal rendering (direct in App tree) and scrollback rendering (gated through `_outputEnabled`).

**No behavioural change:** both modals' `useInput` handlers, Props types, and imports are byte-identical to pre-diff state. Only JSX `return` blocks changed. Diff total: 40 insertions, 8 deletions across 3 files.

**Trade-off considered:** routing modals through `renderInlineMarkdown` was raised as an alternative but rejected — QuestionModal bypasses the renderer entirely (intentional Stage 4.5.6 invariant), so markdown layer-tuning would be the wrong level. Adding scrollback boundary markers via `renderer.commitSystemMessage("── Operator question ──")` before/after `setQuestion` was a viable Option B but deferred — the bordered modal alone delivers the visibility the operator needed; Option B can be added later as an audit-trail enhancement if requested.

Build verified: `dist/octmux` mtime `2026-06-01 21:54` (newer than source). No new dependencies. Out-of-scope hard fence respected — events.ts, SubprocessStatus.tsx, Ctrl-C handler, session.abort semantics, reconciler logic all untouched.

### 2026-06-01--21-30 — Stage 4.5.5: x-opencode-directory header + stall watchdog

**Implemented by:** Claude Opus 4.7 (Actor under /brain) — 2026-06-01--21-30
**Commit(s):** `d54560d`

**Fix A — directory-header threading:**

Root cause: OC daemon scopes `/question`, `/permission`, `/session` by `x-opencode-directory` header. Without it, these endpoints return `[]` silently. Confirmed live: `GET /question` returned `[]` in OC session ses_17b81f462ffeFFLuu2hRLkwNBq even though a registered question existed (que_e848a00330016chnFfeW6N39oF, callID toolu_01GTiqX3KisQ4KBwgBhogTzU); adding `x-opencode-directory: /mnt/nfs/Florian/Gin-AI/projects/octmux` made it appear.

Fix: capture `process.cwd()` once in `src/index.tsx` at startup; pass to `createOpencodeClient({ baseUrl, directory: cwd })` so the SDK auto-attaches the header on all SDK calls including `client.global.event({})` (the SSE event stream). Thread `cwd` as a `cwd: string` prop on `<App>`. Add explicit `headers: { "x-opencode-directory": props.cwd }` to all 5 raw fetch sites (lines 217, 248, 522, 988 in app.tsx; line 32 in session-ancestry.ts). Add `cwd` parameter to `getSessionList` and `isSessionDescendant` in session-ancestry; update 3 call sites in app.tsx.

Side effect: **Stage 4.5.4.1's descendant-aware modal surfacing (commit 66cb73b) has been silently broken since shipping** because the ancestry walk's `GET /session` returned `[]` without the directory header. Without sessions, the parentID chain walk always returned false. Live verification: `curl http://127.0.0.1:4096/session` returns `total sessions: 0` without the header; with the header, sessions appear. Stage 4.5.5 makes the 4.5.4.1 descendant path functional for the first time.

**Fix B — stalled-generation watchdog:**

Symptom: OC daemon ↔ Anthropic API hang produces an assistant message with `time.completed=null`, zero parts, zero tokens, zero cost. Live observed in the same session: msg_e847f5061001U48BIWbtMaS5N6 was in-flight for 10+ minutes in this state. The existing f899e91 spinner+timer + Ctrl-C UX surfaces that a turn is taking long but does not distinguish "stalled" from "slow".

Fix: new useEffect at `src/app.tsx:302-327` arms a 30-second setInterval while `isGenerating === true`. On each tick, if `Date.now() - lastSseEventTimeRef.current > 180_000` ms AND `stallBannerShownRef` is not yet set, AND a REST cross-check (`client.session.messages`) confirms the newest assistant message has `parts.length === 0` AND `time.completed === null`, then `renderer.commitSystemMessage("Generation stalled — press Ctrl-C to abort")` is called and the ref is set. Reset to false on `isGenerating → false` so the next turn's stall can re-fire.

No auto-abort; the operator's existing Ctrl-C path (synchronous `setIsGenerating(false)`) remains the abort mechanism. f899e91's "Interrupted: What next?" UX is unchanged.

**Reviewer iter 1 found 2 blocker bugs (SDK shape):** the watchdog initially used `m.role` / `newest.time` but the SDK returns `Array<{ info: Message; parts: Part[] }>`. Fixed to `m.info.role` and `newest.info.time` in iter 2. Canonical reference: `refreshTokenUsage` at `src/app.tsx:412`. Memory note: see new `feedback-oc-directory-header.md`.

---

### 2026-06-01--18-20 — Stage 4.5.4.2: Question modal openParts gate removal + unconditional discovery loop

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent dispatched by Claude Opus 4.7) — 2026-06-01--17-55
**Commit(s):** `81bb718`

**Why this hotfix:**

Live repro on `ses_17c415ad7ffedNz4F1UQnoy1Lw` (parent session, no descendants — so 4.5.4.1's descendant-aware path was not even involved). Assistant message `msg_e83c2da13001TWJe31vyLWHn46` ended with `tool=question status=running, callID=toolu_0167ud9mfETWCjZ6AgBQd4Mt`; OC's `/question` registry had the matching entry (`que_e83c3bec0001edF3fHbCQlyWC1`, 4 questions). Modal never opened. Operator on octmux Stage 4.5.4.1 binary, attached to the right session, with `permMode=allow` — none of the prior known issues could explain it.

**Root cause (octmux, two layers):**

1. **`src/events.ts:198-208`** (question-tool-detected emit, post-Stage 4.5.3 iter 4) required `openParts.get(toolPart.id) === "tool-call"` as a precondition for emission. `openParts` is only seeded by the `state.status === "pending"` branch above. When OC publishes the MCP-question tool part directly at `state.status === "running"` (which MCP-bridged tools may do because the tool begins running the moment the LLM dispatches it — no daemon-side `pending` lifecycle phase), the openParts gate fails silently and `question-tool-detected` is never emitted. The dedup intent (one-shot per callID) was already provided by `detectedQuestionToolCallIDs`; the openParts gate was a redundant defensive layer introduced in iter 3 that turned out to be too strict.

2. **`src/app.tsx` reconciler arming useEffect** was gated on `isGenerating && sseHealth !== "ok"`. In steady-state healthy SSE the polling reconciler never armed, so the question/permission discovery REST poll (which 4.5.4.1 correctly fixed for descendant-session matching via `Promise.all` + `isSessionDescendant`) was unreachable. The inline comment "Question/permission discovery: run unconditionally (safe modal recovery, no stream mutation)" referred to within-pass unconditionality, NOT loop-arming unconditionality — a subtle mismatch between intent and implementation.

**Fix (Track B):**

##### Fix A — drop the openParts gate

`src/events.ts:199-201`:

```ts
// before:
if (state.status === "running" && toolPart.tool === "question"
    && openParts.get(toolPart.id) === "tool-call"      // ← removed
    && !detectedQuestionToolCallIDs.has(toolPart.id)) {

// after:
if (state.status === "running" && toolPart.tool === "question"
    && !detectedQuestionToolCallIDs.has(toolPart.id)) {
```

The `detectedQuestionToolCallIDs` set (added in the same emit branch, deleted on tool `completed`/`error` transitions, cleared on `resetEventState`) is the real one-shot dedup. The openParts gate added no safety it provides — only fragility.

##### Fix B — split the reconciler-arming useEffect; ungate discovery

Factored question/permission discovery sub-blocks out of `runReconcilerPassRef` into a new `runDiscoveryPassRef`:

- New ref `runDiscoveryPassRef = useRef<(() => Promise<void>) | null>(null)` declared immediately after `runReconcilerPassRef` (TDZ-safe per [[feedback-react-effect-tdz]]).
- New `useEffect(() => { runDiscoveryPassRef.current = async () => { <question discovery> <permission discovery> } });` — no deps array, re-assigned every render.
- `runReconcilerPassRef.current` now ends with `await runDiscoveryPassRef.current?.();` so discovery still runs from the degraded-SSE reconciler.
- The single gated arming useEffect was SPLIT into two:
  1. **Idle-synthesis loop** (unchanged): gated on `isGenerating && sseHealth !== "ok"`, 3-second interval, runs `runReconcilerPassRef` which includes the discovery delegation. This preserves the Stage 4.5.3 four-layer-guard semantics.
  2. **Discovery loop** (new): empty deps array, fires `runDiscoveryPassRef.current?.()` immediately on mount + every 5 seconds thereafter, regardless of SSE health or `isGenerating` state. Mount-time fire catches pre-existing pending questions/permissions on resume/fork (OQ-B1: yes).

Idempotency when both loops fire concurrently (degraded SSE + isGenerating): preserved by the existing `oldest.id !== questionIDRef.current` / `permissionIDRef.current` checks. No race.

##### Files modified

- `src/events.ts` (-1: openParts gate removed)
- `src/app.tsx` (+22, -2: runDiscoveryPassRef declaration + assignment useEffect + reconciler delegation + split arming useEffects)
- `dist/octmux` rebuilt; not committed (gitignored).
- `docs/Stage4.md` (this section appended + frontmatter refresh — left uncommitted for next-session pickup per established pattern).

##### Verification

Live repro is the test: after restarting octmux on the new binary and attaching to a session with a pending MCP question, the modal should appear within 5 seconds of mount (cold-start case) or instantly via SSE (warm case). The fact that the SSE event path now fires regardless of OC's pending/running lifecycle for tool parts is the primary fix; the 5-second discovery loop is the safety net for missed/dropped SSE events.

##### Multi-track context

Track B of a two-track /brain. Track A was the upstream OC daemon fix (subagent session.create now inherits parent's directory + workspaceID — addresses the systemic root cause that motivated Stage 4.5.4.1's surface-level workaround). Track A ships as a PR-ready commit in the operator's OC fork at `~/Gin-AI/projects/opencode` branch `fix/subagent-session-directory-inheritance` — not part of octmux's history but documented at `~/Gin-AI/tmp/opencode-upstream-fix.md` for PR submission.

---

### 2026-06-01--15-22 — Stage 4.5.4: Slow-generation indicator + Ctrl-C "Interrupted" UX + early-Ctrl-C abort

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent dispatched by Claude Opus 4.7) — 2026-06-01--15-22
**Commit(s):** `f899e91`

Three UX improvements surfaced by an OC daemon ↔ Anthropic API hang observed during Stage 4.5.3 iteration-4 verification. Live evidence: OC session `ses_17cdba9cfffeC5A6FQLkMAFYtM`, `msg[62]` in-flight for **7.8 minutes** with `parts=0, tokens.input=0, tokens.output=0, cost=$0.00`. The hang is server-side (OC's HTTP call to Anthropic was not progressing). Octmux correctly showed `[generating…]` but the operator had:
- No visibility into how long the call had been silent
- No "Interrupted" feedback after Ctrl-C
- A window after-submit-before-first-text-part where Ctrl-C fell through to the double-tap exit path instead of aborting

The OC-side hang itself is out of scope for this work (separate /brain). This entry covers the octmux UX gaps.

##### A. Slow-generation indicator — `generating` ProcLine in SubprocessStatus

The existing `SubprocessStatus` component (`src/components/SubprocessStatus.tsx`) renders animated spinner + M:SS timer lines above the input chrome for `thinking` and `tools` proc states. Extended to render a third `generating` ProcLine driven by a new `procTimes.generating: number | null` field.

State changes in `src/app.tsx`:
- `procTimes` shape extended: `{ thinking, tools, generating: number | null }`. All `setProcTimes(...)` reset sites updated (session-idle handler at line 446 and `switchSession` callback at line 640).
- New `useEffect([isGenerating])` syncs `procTimes.generating` with `isGenerating` via `===null` guard to suppress redundant setState. The guard matters because `setIsGenerating(true)` is now called from multiple sites (per change C); the effect must be idempotent.

Component changes in `src/components/SubprocessStatus.tsx`:
- Signature accepts `generating: number | null`; null-check covers all three; render adds `<ProcLine label="generating" startTime={generating} />`. The `ProcLine` already had spinner + timer logic; no changes there. `padEnd(10)` accommodates the 10-char "generating" label exactly.

Inline `[generating…]` scrollback indicator removed (was at the post-tail / pre-modal slot). All generation feedback now lives in `SubprocessStatus`.

##### B. "Interrupted: What next?" feedback after Ctrl-C abort

In the Ctrl-C handler's `isGenerating` branch (`src/app.tsx:611-622`), after the iteration-3 abort + state-reset sequence (`setIsGenerating(false)`, `setLastSubmitted("")`, then the five PromptInput-disable flag resets), the last statement before `return;` now commits a system message:

```ts
renderer.commitSystemMessage("Interrupted: What next?");
```

Renders as a dim `→ Interrupted: What next?` line in scrollback, matching the existing `commitSystemMessage` UX used for `tool_call=false` warnings, `/new`/`/compact` banners, etc. Matches Claude Code's Ctrl-C UX pattern.

##### C. Early-Ctrl-C abort — synchronous `setIsGenerating(true)` in handleSubmit

Previously `isGenerating` only became `true` when the SSE `generating` event fired, which is bound to the first TEXT part opening (`src/events.ts:148`). For:
- Reasoning-first models (Opus 4.7 with extended thinking), reasoning parts come before text — `isGenerating` stayed false during the entire reasoning phase
- Hung calls, no parts ever arrive — `isGenerating` stayed false until session-idle (which itself never fires when there's no completion)

The Ctrl-C handler's `if (isGenerating)` branch therefore did NOT fire in the window between submit and the first text part. Operators hit Ctrl-C expecting a fresh-turn abort and instead got the double-tap exit prompt.

Fix: `setIsGenerating(true)` immediately before the OC RPC in both `handleSubmit` paths:
- Before `client.session.promptAsync(...)` at `src/app.tsx:908` (default text submit)
- Before `client.session.command(...)` at `src/app.tsx:882` (slash-command-forward path for `/brain`, `/duo`, etc.)

Client-side-only slash command handlers (`/exit`, `/new`, `/compact`, `/sessions`, `/fork`, `/resync`, `/rename`, `/model`, `/help`, `/show`, output-gate toggles) return early before reaching these sites — none receive the synchronous setIsGenerating(true). Existing catch blocks at both RPC sites already call `setIsGenerating(false)` on error, so no double-toggle issue.

##### Files modified

- `src/app.tsx` (3 changes: procTimes shape + new useEffect; commitSystemMessage after Ctrl-C abort; two synchronous setIsGenerating(true) sites in handleSubmit; inline [generating…] removed; SubprocessStatus call site updated).
- `src/components/SubprocessStatus.tsx` (signature + render extended with `generating`).
- `dist/octmux` rebuilt; not committed (gitignored).
- `docs/Stage4.md` (this section appended + frontmatter refresh — left uncommitted for next-session pickup per the established pattern).

---

### 2026-06-01--17-05 — Stage 4.5.4.1: Surface permission/question modals for descendant (subagent) sessions

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent dispatched by Claude Opus 4.7) — 2026-06-01--16-50 (iter 1 + iter 2)
**Commit(s):** `66cb73b`

**Why this fix:**

After Stage 4.5.4 shipped, a `/brain` Planner subagent dispatched against parent session `ses_17cdba9cfffeC5A6FQLkMAFYtM` hung indefinitely on its first turn. SoHoAI gateway log showed the model returned 200 OK in ~1 s with 5 parallel `read` tool_use blocks; octmux UI sat on `[generating…]` for 60+ minutes with no modal, no progress. Live REST probe revealed 4 `external_directory` permission asks pending on the **child** session, none on the parent. Operator had no way to see or answer them — the deferred in OC's permission layer (`permission/index.ts:209`, `Deferred.await`) never resolved.

**Root cause (octmux side, two-layer):**

1. **`src/events.ts:filterEvent`** rejected every `permission.asked` / `permission.updated` / `question.asked` event whose `properties.sessionID` was not the currently-attached parent session ID — a strict-equality gate. The Planner subagent runs in a **child** session (`parentID = parent`); its permission events carry the child's `sessionID` and were silently dropped on the floor. Same shape applied to the reconciler poll's `/permission` and `/question` REST consumers in `src/app.tsx`.
2. **`src/app.tsx:handlePermission` and the auto-allow/auto-deny SSE branches** passed the parent's `sessionID` as `path.id` to `postSessionIdPermissionsPermissionId(...)`. Even if Layer 1 had been fixed first, the reply URL would have hit the parent session — which doesn't own the pending permission — so the child would have stayed stuck regardless. Both layers had to ship together.

The OC daemon itself was doing the right thing — publishing `permission.asked` with the correct child sessionID and registering the pending permission against the child. Octmux was the consumer that mis-routed everything.

**Fix:**

##### Layer A — accept events from descendant sessions

New file `src/utils/session-ancestry.ts`:
- Module-scope cached `GET /session` list, 5 s TTL.
- `knownMissIDs: Set<string>` (cleared on each refresh) prevents repeated revalidations of a truly unknown ID within one cache window.
- `isSessionDescendant(candidate, ancestor, baseUrl)`: walks `parentID` chain up to depth 5; on first cache miss for `candidate`, force-refreshes once and retries (one-shot anti-stale-miss). Returns `false` after one failed revalidation.

`filterEvent` stays synchronous — async ancestry walking would have cascaded through every SSE call site. Instead, the looser check lives in `src/app.tsx`'s SSE consumer:
- When `filterEvent` returns `null` AND the incoming event type is `permission.asked` / `permission.updated` / `question.asked` AND `properties.sessionID` is not the parent's, `await isSessionDescendant(...)`. If descendant, re-call `filterEvent` with the **child's** `sessionID` so its property-extraction branches succeed, then `applyReplEvents`.
- The reconciler poll loops over `/permission` and `/question` apply the same logic via `Promise.all` + index-aligned filter (`flags.map((_, i) => flags[i])`). When synthesising the recovery event for `applyReplEvents`, the second argument to `filterEvent` is `oldest.sessionID` (the child), NOT `sessionIDRef.current` — Reviewer caught this on iteration 1 (`PLAN.md` Step 7 had drifted to use the parent ID at both reconciler call sites; iteration 2 fixed both lines).

Strict-equality gates on `session.idle` / `session.error` / `message.part.*` events were **deliberately preserved** — we do not want child-session streaming output (text, tool calls, reasoning) to leak into the parent's viewport. Only modal-bearing events propagate.

##### Layer B — reply to the permission's own sessionID

- `permission` React state shape extended to carry `sessionID` in addition to `permID` and `title`.
- `handlePermission` modal reply path uses `permission.sessionID` for `path.id`.
- SSE auto-allow / auto-deny branches in `applyReplEvents` use `ev.sessionID` (already present on the `permission-asked` ReplEvent variant) for `path.id`.

Question reply needs no path fix — `POST /question/{reqID}/reply` has no sessionID in the URL.

##### Files modified

- `src/utils/session-ancestry.ts` — new file (~106 lines): cache + `isSessionDescendant` walk.
- `src/app.tsx` — `permission` state shape + SSE descendant-aware re-call + reconciler `Promise.all` ancestry filter + correct reply-path `sessionID` in 3 sites (handlePermission, auto-allow branch, auto-deny branch).
- `dist/octmux` rebuilt; not committed (gitignored).
- `docs/Stage4.md` (this section appended + frontmatter refresh — left uncommitted for next-session pickup per the established pattern).

##### Verification

- Live repro present at investigation time: `ses_17cdba9cfffeC5A6FQLkMAFYtM` parent + 2 child Planner sessions with 8 pending `external_directory` asks. Operator confirmed they had `permission` set to `allow` globally; root cause was the agent ruleset's specific `external_directory: ask` override (`*=allow` defeated by more-specific `external_directory: ask` rule) — a config-level inheritance, not the bug. The bug was octmux dropping the asks before they could be auto-allowed by `permMode === "allow"`.
- Acceptance test: dispatch a fresh `/brain` Planner against the rebuilt binary in a project whose subagent will read external paths; PermissionModal should appear; selecting "always" should auto-allow the path family for the rest of the session; subagent unblocks and continues.

##### Multi-window safety

`PermissionModal` and `QuestionModal` live in the main App Ink tree; `TmuxWindowRenderer` only routes block-streaming output to FIFOs. Even with `--multi-window` enabled and a sibling `tools` window, modals render to the operator's main interaction window. This fix changes no rendering path.

---

### 2026-06-01--11-30 — Stage 4.5.3: Redesigned reconciler with four-layer guard (SSE + polling + resync) — iterations 2 + 3 + 4

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent dispatched by Claude Opus 4.7) — 2026-06-01--11-26 (iter 2), 2026-06-01--13-45 (iter 3), 2026-06-01--14-19 (iter 4)
**Commit(s):** `8ee7b36` (iter 2), `fc8c5ae` (iter 3 — MCP question modal + Ctrl-C un-wedge), `6afdda6` (iter 4 — use tool callID not partID for registry match)

**Why this redesign:**

The first Stage 4.5.3 attempt (commit `994952a`) introduced a 3-second polling reconciler to handle missed SSE events. However, the implementation had a critical flaw: the reconciler's idle-detection logic relied solely on `anyPending` (inspection of `tool` parts), which is insufficient for pure-text assistant turns. During a text-only streaming response, `anyPending` is false (no tool parts in pending/running state), causing the reconciler to fire `synthesizeSessionIdleEvents()` at the 3-second polling mark. This cleared the `openParts` map mid-stream, and all subsequent `message.part.delta` events were silently dropped at the `filterEvent` guard (`openParts.get(partID)` returned undefined). Operators reported 5–25% of long messages were lost before reaching the UI.

The redesign eliminates unconditional polling during steady-state SSE. Instead, the reconciler arms only when SSE health degrades, and guards the idle-synthesis path with three additional layers of defense.

**The four-layer guard design:**

1. **Layer 1 — SSE health gate:** Polling reconciler (3s interval) runs only when `sseHealth !== "ok"` (i.e., during SSE reconnect or >5s silence). Steady-state good SSE has zero polling overhead.

2. **Layer 2 — Recency guard:** Inside the reconciler, idle synthesis only fires if the last SSE event was delivered >5 seconds ago (`Date.now() - lastSseEventTime > 5000`). This prevents a race where the reconciler fires just before SSE recovers.

3. **Layer 3 — Active stream inspection:** Before synthesizing idle, call the new `hasOpenStreamingPart()` pure-read helper (exported from `src/events.ts`). This inspects all open parts in the `openParts` map for any text or reasoning blocks currently streaming. If true, idle synthesis is skipped — the stream is still active, even if it has no pending tool parts.

4. **Layer 4 — REST fallback check:** As a final safety net, poll `/session/{id}?query=anyPending` via REST. If `anyPending` is true, skip idle synthesis.

Together, these four guards prevent the reconciler from firing `synthesizeSessionIdleEvents()` during any active text or reasoning stream.

**New helper in `src/events.ts`:**

```typescript
export function hasOpenStreamingPart(): boolean {
  // Pure read: returns true if openParts contains any text or reasoning block
  for (const role of openParts.values()) {
    if (role === "text" || role === "thinking") {
      return true;
    }
  }
  return false;
}
```

**Changes to reconciler polling effect (`src/app.tsx`):**

- The `sseHealth` state is updated: `ok` (steady-state), `reconnecting` (attempting reconnect), `silent` (>5s no event).
- Polling effect dependency changed from `isGenerating` alone to a composite: `[isGenerating, sseHealth]`.
- When `isGenerating && sseHealth !== "ok"`, the 3-second interval runs; when `sseHealth === "ok"`, the interval is cleared (no polling).
- Inside the reconciliation pass, idle synthesis gates on `lastSseEventTimeRef.current` (Layer 2), `hasOpenStreamingPart()` (Layer 3), and REST anyPending check (Layer 4) before calling `synthesizeSessionIdleEvents()`.

**Why this is compatible with Stage 4.5.1 pure-gate invariant + Stage 4.5.2 single-side-effect carve-out:**

Unchanged — the reconciler does NOT call `renderer.setOutputEnabled(...)` or `_ensureWindow(...)`; it only emits `block-end` events via `applyReplEvents()` and reads REST state. The Stage 4.5.2 `_refreshLiveIdsAsync` kick is untouched. Stage 4.4.3 lazy-on-block-start window lifecycle remains the exclusive window creation path.

**Regression history:**

The first Stage 4.5.3 implementation (commit `994952a`) deployed a 3-second polling reconciler that ran unconditionally while `isGenerating === true`. The idle-detection branch checked `anyPending` (tool-part inspection only) to decide whether to synthesize `session.idle`. For assistant turns containing only text or reasoning output (no tool calls), `anyPending` is false during the entire streaming phase — it only becomes true when the *next* turn's tool calls arrive. At the 3-second polling mark, the reconciler fired `synthesizeSessionIdleEvents()`, which cleared the `openParts: Map<partID, Role>` state. All subsequent `message.part.delta` SSE events for that text/reasoning part failed the `filterEvent` guard at `openParts.get(partID)` (undefined), and their content was silently dropped. Operators observed 5–25% loss on messages longer than ~3 seconds to stream.

The redesigned Stage 4.5.3 (commit `8ee7b36`) addresses the root cause: never rely on tool-part state alone to infer session idleness. The four-layer guard ensures the reconciler cannot fire idle synthesis while *any* text or reasoning part is actively streaming.

**Multi-window safety verification (six invariants):**

1. **Polling is conditional, not unconditional:** The reconciler interval runs only when `sseHealth !== "ok"`. Steady-state SSE has zero polling.
2. **Idle synthesis is triple-guarded at the source:** Before calling `synthesizeSessionIdleEvents()`, the reconciler checks (a) `lastSseEventTime` recency, (b) `hasOpenStreamingPart()` result, (c) REST anyPending fallback. All three must pass.
3. **No new call to `renderer.setOutputEnabled(...)`** anywhere in reconciler / SSE-reconnect / resync paths.
4. **No new call to `_ensureWindow(...)`** outside `beginBlock`.
5. **Reconciler's synthesised `session-idle` routes through `applyReplEvents`**, not direct renderer calls.
6. **`endBlock` idempotency relied upon** — no new guards in reconciler around synthesised endBlock calls; both renderers handle via existing gate checks and early-returns.

**Files modified (iteration 2 — commit `8ee7b36`):**
- `src/app.tsx` (SSE health state with conditional polling, three-layer guard inside reconciler, applyReplEvents helper, runReconcilerPassRef + effect, SSE reconnect, handleResync callback, onResync threading)
- `src/events.ts` (new `hasOpenStreamingPart()` export, comment blocks on question/permission handlers)
- `src/keybindings.ts` (Ctrl-R handler)
- `src/commands.ts` (parseResyncCommand)
- `src/command-registry.ts` (/resync entry)
- `src/components/PromptInput.tsx` (onResync prop threading)
- `src/components/StatusLine.tsx` (sseHealth prop + badge rendering)
- `docs/Stage4.md` (this completely rewritten entry + frontmatter refresh)
- `docs/design.md` (refreshed Principles 1 and 3, removed first-attempt language)

---

#### Iteration 3 (commit `fc8c5ae`, 2026-06-01--13-45) — MCP question modal + Ctrl-C un-wedge

The four-layer guard in iteration 2 fixed the streaming-text wedge, but live testing exposed two follow-on failures that iteration 2 did not cover. Both are downstream of the same architectural mismatch: opencode delivers some events as `message.part.updated` shadow carriers rather than as the first-class `question.asked` / `permission.asked` SSE events that the reconciler is built around.

##### Bug 2 (primary failure) — MCP question modal never opens

**Symptom.** Operator runs `/brain` against opencode; the Opus-driven Phase-0 subagent calls its `AskUserQuestion` equivalent; octmux shows a streaming `tool=question` block in the chat but no question modal opens. The operator has no in-band way to answer; the model stalls awaiting `tool_result`. Permissions are set to `ask` mode; SSE health is `ok`.

**Root cause.** Two interlocking facts:

1. opencode does **not** emit the SSE `question.asked` event for the MCP-tool-style `question` carrier. The model's tool call surfaces as `message.part.updated` with `part.type=tool, tool=question, state.status=running`. `filterEvent` in `src/events.ts` (pre-fix) handles this exactly like any other tool call — opens a tool-call block and renders the streaming JSON input as tool output. No question event fires.
2. The Stage 4.5.3 iteration-2 reconciler is structurally gated on `sseHealth !== "ok"`. The question-discovery branch (poll `/question`, synthesise a missed event) was correct, but in steady-state healthy SSE the reconciler interval is never armed — the whole branch is unreachable.

Empirical evidence: the MCP question IS in opencode's `/question` registry with a real `que_…` requestID and the exact modal-friendly `questions[]` shape that the existing `QuestionModal` consumes. The back-reference `tool: { messageID, callID }` links each registry entry to its tool part. So the missing piece is purely discovery: detect the MCP-question carrier and fire a one-shot registry lookup.

**Fix.** Add a side-channel SSE detector that runs whether or not the reconciler is armed.

In `src/events.ts`:
- New ReplEvent variant `{ kind: "question-tool-detected"; sessionID: string; callID: string }`.
- New module-scope `detectedQuestionToolCallIDs: Set<string>` (cleared in `resetEventState`; also cleared on each tool's `completed` / `error` transition so the set stays bounded to in-flight question tools, typically ≤1).
- In `filterEvent`'s tool-part branch, when `state.status === "running" && toolPart.tool === "question"` and the callID has not been detected yet, return the new event and add the callID to the dedupe set. Detection happens on the `running` transition (not `pending`) because the opencode `/question` registry is only populated after the MCP handler receives the dispatched tool call.

In `src/app.tsx applyReplEvents`:
- New branch for `question-tool-detected` that fires a background `GET /question` (unfiltered — the `directory` filter is keyed by opencode's per-session `projectID` which mismatches `session.directory` for orchestra sessions), finds the entry by `(sessionID, callID)`, and calls `setQuestion({ reqID, questions })`. The existing `questionIDRef` dedupe prevents reopening an already-active modal; the existing modal-answer path (`POST /question/{reqID}/reply`) is unchanged.

The reconciler stays disarmed under healthy SSE — no change to the iteration-2 gating. The MCP-question path is a new SSE-side detection, not a polling revival.

##### Bug 1 (escape-hatch safety net) — Ctrl-C left octmux input-dead

**Symptom.** With Bug 2 unfixed, the operator's only escape from a stalled MCP question was Ctrl-C. The server-side abort succeeded cleanly (tool transitioned to `status=error`; message `info.error = MessageAbortedError`), but the client-side state left octmux functionally wedged: only the App-level Ctrl-C handler still responded, normal typing did nothing. The operator's only recovery was Ctrl-C twice to trigger the double-tap exit (i.e. kill the whole TUI).

**Root cause.** Two contributing mechanisms that share a single trigger.

1. **Editor backpressure.** The Ctrl-C handler at `src/app.tsx:559-582` (pre-fix) called `editor.loadText(lastSubmitted)` to restore the previously-submitted text into the buffer. For a `/brain ...` invocation, `lastSubmitted` is the *full* skill body — ~26 KB / ~500 lines. `loadText` splits on `\n` and emits one `"changed"` event; PromptInput's `lines.map(...)` then creates ~500 `<Text>` elements for Ink to measure and reconcile. The reconciler exceeds the stdin event arrival rate and keystrokes appear dropped (they are not actually dropped — they are buried behind the layout queue). If `lastSubmitted` starts with `/` (as `/brain ...` does), the first `"changed"` emission also triggers `SlashCompletionOverlay`, which registers its own `useInput` and contends for the same stdin stream.
2. **PromptInput disabled by stale modal/compacting flag.** Operator clarified after a second test that the wedge persisted even after the initial reconciler backlog should have drained: only App-level Ctrl-C responded; PromptInput's keystroke handler was inactive. PromptInput's `useInput` is registered with `{ isActive: !disabled }`, and `disabled = !!permission || !!question || !!modelPicker || isCompacting || !!sessionPicker`. With no visible modal, the most likely path is a race during abort cleanup that leaves one of these flags truthy (e.g. a `session.updated` event with a transient compacting time field, or a `permission.asked` event arriving moments after the abort fires).

**Fix.** Drop the `editor.loadText` call entirely and explicitly reset every flag that controls `PromptInput.disabled` whenever Ctrl-C is pressed during in-flight generation:

```ts
if (isGenerating) {
  props.client.session.abort({ path: { id: sessionID } }).catch(() => {});
  setIsGenerating(false);
  setLastSubmitted("");
  // Defensive: ensure PromptInput cannot be left disabled by a stale modal
  // or stray session.updated event. Ctrl-C-during-generation explicitly
  // means "bail to a fresh prompt"; any modal in flight is intentionally
  // dismissed. The non-isGenerating Ctrl-C branches below stay unchanged.
  setPermission(null);
  setQuestion(null);
  setModelPicker(null);
  setSessionPicker(null);
  setIsCompacting(false);
  return;
}
```

Editor is left in its post-submit empty state (no `loadText`, no `clearBuffer` needed — pendingQueue-while-generating is a separate state, not the editor's `lines`). PromptInput renders one line, so there is no reconciler backpressure. No buffer starts with `/`, so no SlashCompletionOverlay auto-opens. Every disable-causing flag is explicitly cleared, so PromptInput's `useInput` is guaranteed `isActive: true`.

The non-`isGenerating` Ctrl-C branches (clear-buffer-if-text, double-tap-exit) are untouched — Ctrl-C when not generating still preserves any modal that is legitimately open.

**Why this is the safety net, not the main fix.** With Bug 2 fixed, the modal opens automatically and the operator answers in-band. They never need to Ctrl-C in this scenario. Bug 1 exists for the case where Bug 2's lookup races, opencode emits an unexpected variant, or future regressions reintroduce a wedge. A safe Ctrl-C is the floor.

##### Multi-window safety (operator constraint)

Operator required confirmation that the modal-opening path is re-entry safe under `--multi-window` — specifically that if the operator has killed the "tools" output window in some earlier turn, the question modal must still appear in the operator's main interaction window, not be lost to a defunct pane.

Confirmed safe by construction. `QuestionModal` (`src/components/QuestionModal.tsx`) is a React component mounted in the main App JSX tree at `src/app.tsx:952` via `{question && <QuestionModal ... />}`. Ink renders this directly to the operator's main stdout in both single-window and `--multi-window` modes. The `TmuxWindowRenderer` only routes block-streaming output (`beginBlock/appendToBlock/endBlock` for roles with an `OUTPUT_KEY` entry) to FIFOs and secondary windows. React component renders bypass it entirely. The new `setQuestion(...)` call from `applyReplEvents`:
- triggers a React state update — no `beginBlock`, no FIFO write, no `_ensureWindow`
- mounts `QuestionModal` via Ink to the main stdout
- has zero dependence on `_fifos`, `_liveIds`, or any window-lifecycle state

If the operator has killed the "tools" window, the question modal still appears in their main interaction window. No additional safeguards required.

##### Files modified (iteration 3 — commit `fc8c5ae`)

- `src/events.ts` — added `question-tool-detected` ReplEvent variant; added module-scope `detectedQuestionToolCallIDs: Set<string>` with clear/add/delete maintenance across `resetEventState`, the running guard, and the completed/error transitions.
- `src/app.tsx` — new `question-tool-detected` branch in `applyReplEvents` (one-shot `/question` fetch, match by `(sessionID, callID)`, `setQuestion`); rewritten Ctrl-C-during-isGenerating branch (removed `editor.loadText`, cleared `lastSubmitted`, defensive reset of all five PromptInput-disable flags).
- `dist/octmux` rebuilt; not committed (gitignored).
- `docs/Stage4.md` (this section appended; backfilled with commit hash per operator instruction — left uncommitted for next-session pickup).

---

#### Iteration 4 (commit `6afdda6`, 2026-06-01--14-19) — use tool callID, not partID, for question registry match

Operator-tested commit `fc8c5ae` against live session `ses_17cea1503ffeJ7TdRC6yGFIbwF`: bug persisted. Tool spinner still spun; no modal opened. Investigation revealed a two-ID confusion that iteration 3's Actor reported having verified but had not.

##### Root cause

OpenCode's `message.part.updated` payload for a `tool` part carries TWO distinct ID fields:
- `id` — the part's own database ID, prefixed `prt_` (e.g. `prt_e83192971001U6siLjvs80ovg1`).
- `callID` — the model's tool-call ID, prefixed `toolu_` (e.g. `toolu_016km24yKxyDVss4Y8yjbkpn`). This is a top-level field on the tool part, **not** inside `state`.

OpenCode's `/question` registry entry's back-reference to its originating tool part is `tool.callID = toolu_…` (the model's tool-call ID, not the part's database ID). For the live session:
- Tool part: `id=prt_e83192971001U6siLjvs80ovg1, callID=toolu_016km24yKxyDVss4Y8yjbkpn`.
- Registry entry: `id=que_e8319737e001tjYue6g5xhJK7L, tool.callID=toolu_016km24yKxyDVss4Y8yjbkpn`.

Iteration 3's emit in `src/events.ts` was:
```ts
return { kind: "question-tool-detected", sessionID: toolPart.sessionID, callID: toolPart.id };
```
This sent the `prt_…` value as the event's `callID`. In `src/app.tsx`, the handler's match comparison `q.tool?.callID === ev.callID` compared `toolu_…` (from the registry) against `prt_…` (from the event) — **always false**. `setQuestion(...)` was therefore never called.

##### Fix

Two-line correction in `src/events.ts`:

1. Extend the inline `toolPart` cast (lines 175-180) to declare the top-level `callID: string` field:
   ```ts
   const toolPart = part as unknown as {
     id: string; messageID: string; sessionID: string;
     type: "tool"; tool: string;
     callID: string;   // ← added
     state: { status: string; input?: unknown; raw?: string; output?: string; error?: string; title?: string };
   };
   ```

2. In the `question-tool-detected` emit block, change `callID: toolPart.id` to `callID: toolPart.callID`:
   ```ts
   return {
     kind: "question-tool-detected",
     sessionID: toolPart.sessionID,
     callID: toolPart.callID,
   };
   ```

The `detectedQuestionToolCallIDs` dedupe `Set` continues to key on `toolPart.id` (the part's stable database ID). The set is about whether THIS part has already triggered an emission; using the part ID is correct. Only the value carried OUT of the emission needed to change.

`src/app.tsx` is unchanged. The handler's match logic was correct all along; it was just receiving wrong data.

##### Process failure (for posterity)

The iteration-3 PLAN.md explicitly flagged this exact risk: "**`toolPart.id` vs `callID`.** Live evidence: both are equal `toolu_…` for MCP questions. Actor should verify against one live message in the OC API before committing." That risk note was wrong on its facts (the "live evidence" cited only listed one ID field; both IDs ARE in the payload but I had not noticed the `callID` was separate at the top level). The iteration-3 Actor reported "verified", but did not actually inspect a live tool part to confirm. Reviewer 1 and Reviewer 2 missed it because the local cast and the comparison were internally self-consistent — the code looked right but the inputs were wrong. Captured as a lesson in the related memory file.

##### Files modified (iteration 4 — commit `6afdda6`)

- `src/events.ts` — extended inline `toolPart` cast to declare `callID: string`; changed the emit to use `toolPart.callID` instead of `toolPart.id`.
- `dist/octmux` rebuilt; not committed.
- `docs/Stage4.md` (this section appended; backfilled with commit hash per operator instruction — uncommitted for next-session pickup).

---

### 2026-05-27--18-28 — Stage 4.6: Inline markdown rendering (bold / italic / inline code)

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent dispatched by Claude Opus 4.7) — 2026-05-27--18-28
**Commit(s):** `3656459`

**What changed:**

New pure function `renderInlineMarkdown(content: string): string` added to `src/blocks.ts`, called from `formatLine()` for roles `text`, `thinking`, and `tool-result`. Transforms three inline constructs using regex on plain strings (no new dependency):
- Inline code `` `text` `` → dim-cyan ANSI (`\x1b[2;36m`…`\x1b[0m`); extracted before bold/italic passes to protect code-span contents.
- Bold `**text**` → `\x1b[1m`…`\x1b[22m`.
- Italic `_word_` / `*word*` → `\x1b[3m`…`\x1b[23m`; word-boundary enforcement on `_word_` prevents `snake_case` false-positives.

Unit tests added in `src/blocks.test.ts` (Bun built-in test runner; no configuration required). Design rationale section added near top of this doc as a peer to the existing "Read first" contract.

**Roles affected:** `text`, `thinking`, `tool-result`. Roles `user`, `tool-call`, `error` unchanged.
**Files modified:** `src/blocks.ts`, `src/blocks.test.ts` (new), `docs/Stage4.md` (this entry + design section).
**No files modified:** `src/renderer/tmux-window.ts`, `src/renderer/stdout.ts`, `src/renderer/output-keys.ts`, `src/app.tsx`, any other file.

---

### 2026-05-25--20-59 — Stage 4.5.2: Hotfix for Stage 4.5.1 — non-blocking liveness-cache refresh on toggle-on (Option A); Option B held in reserve

**Implemented by:** Claude Code (Claude Opus 4.7 1M) — 2026-05-25--20-59
**Commit(s):** `bde7d9a`

**Why this hotfix on top of 4.5.1:**

After Stage 4.5.1 made `setOutputEnabled` a pure Map setter, the operator hit a specific scenario in `--multi-window` mode that the strict invariant did not handle gracefully:

1. Trigger something that requires thinking → side window `<label>--thinking` is created (lazy, via `beginBlock` → `_ensureWindow` — the Stage 4.4.3 path).
2. `/thinking-output off` and then **manually kill** the side window in tmux. More thinking turns happen (gated; correctly produces no streaming, no window management).
3. `/thinking-output on`. The next thinking block (block 1 after toggle-on) is **silently lost** — no streaming. Streaming only resumes from block 2 onward.

This is structurally the Stage 4.4.4 "at most one block of deltas may write to a dead FIFO" trade-off, but **magnified** by the quiescent gate-off period. During gate-off, `beginBlock` short-circuits before `_ensureWindow`, so the in-memory `_liveIds` cache (Stage 4.4.4) receives no refresh kicks for the entire duration. By the time `/thinking-output on` is followed by a thinking-producing prompt, the cache is guaranteed stale — it still reports the long-since-killed window as alive. The first `_ensureWindow` call returns early from the cache check, `appendToBlock` writes to a stale FIFO, and only the async refresh kicked by that same `_ensureWindow` lands in time for block 2 to see a fresh cache and recreate.

In Stage 4.4.4's original verification the kill happened mid-stream of an in-flight block, so refresh kicks had already been firing — the staleness was racy and usually resolved before the next block-start. In this 4.5.1 scenario the staleness is deterministic.

**What changed (Option A — adopted):**

Single line added to `TmuxWindowRenderer.setOutputEnabled`: on `on=true`, kick `_refreshLiveIdsAsync()`. This is a non-blocking, single-flighted, fire-and-forget tmux subprocess that updates the in-memory `_liveIds: Set<string>` cache. By the time the operator finishes typing the follow-up prompt (typically multi-second), the cache is fresh, and the next `_ensureWindow` correctly identifies the dead window and runs the recreation path during block 1's setup. Block 1 streams to the freshly recreated window with no loss.

**Why this is compatible with the Stage 4.5.1 pure-gate invariant:**

The Stage 4.5.1 CONTRACT comment in `src/renderer/output-keys.ts` was widened from "MUST NOT … have any other side effect" to "MUST NOT call `_ensureWindow`, spawn windows, open or close FIFOs, kill windows, run any SYNCHRONOUS tmux subprocess, or emit events" — with a single explicit Stage 4.5.2 exception for the non-blocking cache refresh. The structural concerns that motivated 4.5.1 (window/FIFO/block lifecycle leaking into `setOutputEnabled`, blocking I/O on toggle, eager creation racing with the next block-start) all remain prohibited. What is permitted is a single cache-only mutation in a background subprocess that touches no window, no FIFO, no block, and never blocks the caller.

**Failure mode still possible (rare):**

If the operator types and submits the follow-up prompt fast enough (and the network + model are fast enough) that the next block-start arrives in less than ~50 ms after `/<key>-output on`, the refresh may not have landed yet, and block 1 will still be lost (same as the pre-4.5.2 behavior, same as Stage 4.4.4's documented trade-off). Empirically rare for human operators; common for scripted tests that toggle and submit programmatically. If this becomes a real concern, see **Option B** below.

---

#### Option B — alternative for future exploration (NOT implemented; held in reserve)

**Premise:** make block 1 recovery 100% reliable, at the cost of re-introducing a single Stage 4.4.3-style burst-pattern moment for that one block.

**Design:**

1. Add a private field to `TmuxWindowRenderer`:
   ```typescript
   private _forcedProbeKeys = new Set<string>();
   ```
2. In `setOutputEnabled(key, on)`, on `on=true`, also add the key:
   ```typescript
   if (on) {
     this._refreshLiveIdsAsync();  // Option A — keep as fast path for typical case
     this._forcedProbeKeys.add(key); // Option B — guarantee for fast-path race
   }
   ```
3. In `_ensureWindow(windowKey)`, BEFORE the cache check, consume the flag with a sync probe:
   ```typescript
   if (this._forcedProbeKeys.has(windowKey)) {
     this._forcedProbeKeys.delete(windowKey);
     try {
       const ids = execFileSync("tmux", ["list-windows", "-F", "#{window_id}"])
         .toString().split("\n").map(s => s.trim()).filter(Boolean);
       this._liveIds = new Set(ids);
     } catch { /* keep existing cache on tmux error */ }
   }
   // ... existing cache check + recreation logic unchanged
   ```
4. The flag is per-key and consumed exactly once (next `_ensureWindow` for that key). Subsequent block-starts hit the normal async-cached fast path.

**Cost:** one synchronous `tmux list-windows` (~10–50 ms on the operator's machine) blocking the event loop for exactly the first `_ensureWindow` call after each toggle-on. This is the same burst-pattern cost Stage 4.4.3 had on every block before Stage 4.4.4 optimized it away — Option B accepts that cost only on the first block after a toggle event, not per block.

**Effectiveness:** 100% reliable block 1 recovery. No race window.

**Pure-gate compatibility:** the flag mutation in `setOutputEnabled` is the same kind of cheap Map/Set mutation as the gate write itself; the sync probe runs in `_ensureWindow`, which is the structurally correct place for tmux subprocess work. No widening of the contract is required beyond what Stage 4.5.2 already permits.

**When to revisit:** if operator testing shows the Stage 4.5.2 async approach loses block 1 in real workflows (not just synthetic fast-toggle tests), promote Option B from "held in reserve" to the active implementation. Both options are additive — Option B can be layered on top of Option A without removing the async kick (the async kick is still useful as a fast-path warmup for the cases where the operator IS slow enough).

**Decision rationale for choosing A first:** smallest blast radius (one line vs. ~10 lines + new field + new control flow in `_ensureWindow`), zero burst-pattern regression, handles the operator's reported scenario in the typical human-timing case. Hard guarantees can come later if needed.

**Files modified:**
- `src/renderer/tmux-window.ts` (one-line addition to `setOutputEnabled`; comment block explaining the Stage 4.5.2 rationale)
- `src/renderer/output-keys.ts` (CONTRACT comment widened: rules 2 and 3 clarified; new rule 4 explains the cache-refresh exception)
- `docs/Version4.md` (this entry; Stage 4.5.1 entry annotated below)
- `docs/Implementation-plan.md` (new "Open questions" section at bottom summarising Option B → pointer here)

**Verified:** pending operator smoke test (re-run sequence: trigger thinking → `/thinking-output off` → manually kill window → more turns → `/thinking-output on` → next thinking block — expect streaming to a freshly recreated window from block 1).

---

### 2026-05-25--19-43 — Stage 4.5.1: Hotfix — revert eager window creation in setOutputEnabled + codify pure-gate contract for all current/future toggles

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent dispatched by Claude Opus 4.7) — 2026-05-25--19-43
**Commit(s):** `0a2aa07`

**What changed:**

Removed the eager `_ensureWindow(key)` call from `TmuxWindowRenderer.setOutputEnabled` (introduced in Stage 4.5, commit `25c644a`). `setOutputEnabled` is now a pure setter on the `_outputEnabled` Map for all gate keys in `OUTPUT_KEYS` — current (`thinking`, `tools`) and future (e.g. `subagent`). Window lifecycle reverts entirely to the Stage 4.4.3 + 4.4.4 lazy-on-block-start mechanism via `beginBlock` → `_ensureWindow`.

Added top-of-file CONTRACT comment block to `src/renderer/output-keys.ts` codifying the pure-gate invariant at the file every future toggle implementer will edit. Added new top-of-doc "Read first when adding a streaming output toggle (e.g. /subagent-output)" section to `docs/Version4.md` with the full contract in prose form, including the worked example of adding a hypothetical `/subagent-output` toggle and a post-mortem of why the eager-creation experiment was rejected.

**Why the fix:**

Operator-reported regression in `--multi-window` mode: after `/thinking-output off` then `/thinking-output on`, the side window appeared re-created but no content streamed to it, and `dispose` printed `can't find window: @17` to stderr at session end. Root cause: the eager `_ensureWindow` call interacted with the Stage 4.4.4 async liveness cache in two ways the Stage 4.4.3 invariant never anticipated — stale-cache hit (leaves dead window ID in map; later `dispose` errors) and cache-miss recreation (runs cleanup-then-fresh-create outside any active streaming context, leaving the renderer in a state the rest of the code wasn't designed for).

Fix scope is uniform across all toggles: `setOutputEnabled` becomes a pure Map setter for every gate key, present and future. The contract is codified in two surfaces (code comment in `output-keys.ts` + prose section in `Version4.md`) so future toggle implementers cannot miss it.

**Behavioral consequences (explicit trade-off):**

- `/<key>-output on` with no prior content: no window appears immediately. The window materializes on the next matching block-start.
- `/<key>-output on` with side window still alive: gate flips, next `appendToBlock` writes to the existing window.
- `/<key>-output on` after operator manually killed the window: identical to Stage 4.4.3 / 4.4.4 behavior — next block-start runs `_ensureWindow`, async cache refresh from a prior block invalidates the stale ID, recreation happens, stream resumes. Stage 4.4.4 trade-off ("at most one block of deltas may write to a dead FIFO") preserved. **(Updated in Stage 4.5.2 — see entry above. The async-refresh kick on toggle-on now warms the cache during the typical operator window between toggling and submitting the next prompt, so block 1 streams to a freshly recreated window in the normal case. The race window survives only for sub-50ms toggle-then-submit timing.)**
- `/<key>-output off`: no window management, no streaming.
- `/show` reports live gate state, unaffected.

**Files modified:**
- `src/renderer/tmux-window.ts` (revert eager block in setOutputEnabled)
- `src/renderer/output-keys.ts` (add CONTRACT comment)
- `docs/Version4.md` (new "Read first" top-of-doc section + Stage 4.5.1 entry + Stage 4.5 forward-pointer)

**Verified:** pending operator smoke test.

---

### 2026-05-25--14-11 — Stage 4.5: /show + /<key>-output slash commands on 4.4.3+4.4.4 foundation

**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-05-25--14-11
**Commit(s):** `25c644a`

**What changed:**

New shared module `src/renderer/output-keys.ts` exports `OUTPUT_KEY` (Role → output-key mapping) and `OUTPUT_KEYS` (deduped key list). This is the single source of truth for both renderers + commands.ts.

`TmuxWindowRenderer` migrated to import `OUTPUT_KEY`/`OUTPUT_KEYS` from the shared module (removed local `WINDOW_KEY`). Behaviour-preserving — the constructor and gate machinery still operate as in Stage 4.4.3+4.4.4. Gate checks in `beginBlock`/`appendToBlock`/`endBlock` remain uniform. `setOutputEnabled(key, true)` now eagerly calls `_ensureWindow(key)` so the side window appears the moment the gate is flipped on — fixes the lazy-creation asymmetry where toggling on after toggling off (or before any content has streamed) would leave the operator with no visible window until the next block-start.

`StdoutRenderer` upgraded from no-op gate (Stage 4.4.3 placeholder) to real gate: `_outputEnabled: Map<string, boolean>` field, real `isOutputEnabled`/`setOutputEnabled` methods, gate checks in `beginBlock`/`appendToBlock`/`endBlock`. In `--single` mode, `/<key>-output off` now suppresses inline scrollback rendering for that block class.

`commands.ts`: `parseShowCommand` replaced — old visibility-toggle behaviour (with `/show <role> on|off` syntax) is gone. New `/show` (no args) reads renderer state and emits a coloured one-line status (ANSI green for on, red for off, pipe-separated). New `parseBlockOutputCommand` handles `/<key>-output [on|off]` — generic regex captures any key, validates against `OUTPUT_KEYS`, returns discoverable error for unknown keys, reports current state when no arg given (`"<key>-output is <on|off>"`), and on toggle replies with the transition (`"<key>-output prev->new"`, e.g. `on->off`, `off->on`, or no-op forms `on->on` / `off->off`) so the operator always sees the resulting state. ANSI constants `GREEN`/`RED`/`RESET` defined inline. `Visibility` and `Role` imports removed (no longer needed). Other parsers (`parseExitCommand`, `parseRenameCommand`, `parseModelCommand`) unchanged.

`app.tsx`: import line extended with `parseBlockOutputCommand`. Old `/show` dispatch block replaced with new pair (`/show` status + `/<key>-output` toggle/query). Dispatch order unchanged: `/exit`, `/rename`, `/model`, `/show`, `/<key>-output`, default send.

`Visibility` class is left intact — only its slash command was removed. `isVisible(role)` checks in both renderers' `beginBlock`/`appendToBlock` paths continue to run (defaulting to all-visible since no user command can toggle them anymore). Kept as inert internal infrastructure.

Gate is uniform across both `--single` and `--multi-window` mode semantics. Per-renderer mechanism differs (FIFO write suppression in multi-window; `_openBlocks` registration + commit suppression in single) but observable user behaviour is the same.

**Files modified:**
- `src/renderer/output-keys.ts` (new)
- `src/renderer/tmux-window.ts`
- `src/renderer/stdout.ts`
- `src/commands.ts`
- `src/app.tsx`

**Verified (operator, 2026-05-25):** `/show`, `/thinking-output [on|off]`, `/tools-output [on|off]` all behave as designed in both `--single` and `--multi-window` modes. Toggle reply transition format (`prev->new`, including no-op `on->on` / `off->off`) confirmed. Unknown `/<key>-output` returns the discoverable error.

> **Note (Stage 4.5.1, see entry above):** the eager window creation on toggle-on introduced in this entry caused a streaming regression in `--multi-window` mode (window re-created but no content streamed; `dispose` printed `can't find window: @17`) and was reverted in Stage 4.5.1. The trade-off: side windows no longer appear immediately on `/<key>-output on`; they appear on the next matching block-start (Stage 4.4.3 lazy creation). Stage 4.5's other deliverables (`/show`, `/<key>-output` toggle/query/transition-reply, `StdoutRenderer` gate uniformity, shared `output-keys.ts` registry) remain in effect and are the foundation that all future `/<key>-output` toggles inherit from.

---

### 2026-05-23--23-15 — Stage 4.4.4: async background liveness refresh (eliminate per-block tmux overhead)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--23-15
**Commit(s):** `ad60b1c`

**What changed:** Moved the tmux liveness probe off the hot path. `_ensureWindow` now reads an in-memory `_liveIds: Set<string>` cache (zero subprocess cost on warm path); cache refreshed fire-and-forget via `execFile` (callback form) after every `_ensureWindow` call. `_liveIdsRefreshInFlight` single-flight guard prevents concurrent subprocess spawns. Eliminates the per-block ~10–50 ms event-loop block introduced in Stage 4.4.3 that caused thinking deltas to flush in bursts.

**Trade-off:** at most one block of deltas may write to a dead FIFO (lost) if the operator kills a window mid-stream; the async refresh kicked at that block-start lands ~50 ms later and the next block-start recreates the window. Acceptable per operator priority: real-time streaming > zero-loss on manual kill.

**Verified (operator, 2026-05-23):** real-time streaming to side windows confirmed; thinking content now arrives smoothly without the burst pattern observed under Stage 4.4.3's synchronous probe. Window re-creation after manual `tmux kill-window` works on next block-start with no perceptible delay.

---

### 2026-05-23--22-42 — Stage 4.4.3: re-entry safety + outputEnabled gate (TmuxWindowRenderer foundation)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--22-42
**Commit(s):** `1a4523c`

**What changed:**
Added re-entry safety to `TmuxWindowRenderer` via a liveness check in `_ensureWindow` that detects stale window IDs (e.g., when the operator manually kills a side window mid-session) and recreates them. Also added a gating mechanism (`_outputEnabled` map + `isOutputEnabled`/`setOutputEnabled` methods) to suppress output streams for side windows without destroying them, enabling future slash-command controls (e.g., `/thinking off`).

**Key architectural changes:**

1. **Renderer interface** — added two methods:
   - `isOutputEnabled(key: string): boolean` — query gate state
   - `setOutputEnabled(key: string, on: boolean): void` — set gate state

2. **TmuxWindowRenderer** — added three pieces:
   - `_outputEnabled: Map<string, boolean>` initialized with defaults (true for "thinking", "tools")
   - Public `isOutputEnabled`/`setOutputEnabled` methods
   - Hardened `_ensureWindow` with liveness check: runs `tmux list-windows` to get live IDs; if cached ID is stale, closes FIFO, deletes map entries, and clears line buffers before creating a fresh window

3. **Gate checks at three points:**
   - `beginBlock`: skips `_ensureWindow` and window setup if gate is off
   - `appendToBlock`: skips FIFO write if gate is off
   - `endBlock`: skips final flush if gate is off

4. **StdoutRenderer** — added no-op implementations for both new methods (always returns true for query; no-op for set).

**Files modified:**
- `src/renderer/types.ts` — added two methods to Renderer interface
- `src/renderer/stdout.ts` — no-op implementations
- `src/renderer/tmux-window.ts` — _outputEnabled map, public methods, hardened _ensureWindow with liveness check, gate checks in beginBlock/appendToBlock/endBlock

> **Forward-pointer (Stage 4.5 + Stage 4.5.1):** this entry's `_outputEnabled` map + `isOutputEnabled` / `setOutputEnabled` methods are the load-bearing foundation that the Stage 4.5 user-facing `/<key>-output [on|off]` slash commands (commit `25c644a`) wire into. Stage 4.5 also added an eager `_ensureWindow` call inside `setOutputEnabled` to make the side window appear immediately on toggle-on; that experiment regressed streaming in `--multi-window` mode and was reverted by **Stage 4.5.1** (see top of log), which restored the strict invariant established here: `setOutputEnabled` is a pure Map setter and window lifecycle belongs exclusively to `_ensureWindow` invoked from `beginBlock`. The Stage 4.5.1 docs include a "Read first when adding a streaming output toggle" section at the top of this file plus a CONTRACT comment block in `src/renderer/output-keys.ts` codifying the invariant for all current and future toggles (`thinking`, `tools`, future `subagent`, etc.).

---

### 2026-05-23--18-48 — Stage 4.4.1: orchestra-style status bar (model, ctx bar, project, branch)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--17-20 (initial); Claude Code (Claude Sonnet 4.6) — 2026-05-23--18-48 (UX fixes)
**Commit(s):** `ecf35f9`, `6834548`, `4f702a8`

**What changed:**
Replaced the basic `[idle] hidden: ...` status line with an orchestra-style status bar that renders the active model name + context window, a 20-cell gruvbox-colored context-usage bar (updated on `session-idle`), a cost placeholder, the project basename, and git branch name.

**Design (initial — ecf35f9, 6834548):**
- New `src/utils/formatters.ts` with helper functions: `formatTokens()` (human-readable K/M notation), `fetchGitBranch()` (one-shot git read), `getContextWindow()` (cached lookup via `provider.list()` or fallback map), `prettyModelName()` (display alias), `contextLabel()` (formatted context label).
- New `src/components/StatusLine.tsx`: single `<Text>` line component (preserves fixed height). Accepts `modelLabel`, `tokenUsage`, `projectName`, `gitBranch` props. Bar fill uses `▓`/`░` glyphs with three-stop gruvbox color gradient: green <50%, yellow 50–79%, red ≥80%.
- `src/app.tsx` wired: new `gitBranch` + `tokenUsage` state; mount effects (git fetch, session init); `session-idle` IIFE updates token counts; StatusLine invocation with new props.

**Dropped:**
- The `[idle]` indicator and hidden-role badges are no longer displayed (operator accepted).

**UX bug fixes (4f702a8):**

1. **Context window stuck at 200K** — `getContextWindow` now uses a two-pass lookup: first matches by provider ID + model dict key or `mInfo.id` field; then falls back to all providers regardless of provider ID. Handles cases where `sess.model.id` (e.g. `"kimi-k2.6"`) differs from the provider list's dict key (e.g. `"moonshot/kimi-k2.6"`).

2. **tokenUsage never initialized after `/model` switch** — Added a `useEffect` keyed on `activeModel`. It fetches the context window and updates `tokenUsage.contextWindow` (preserving `used`) whenever the model changes. The startup effect was simplified to only set `activeModel`; the new effect handles the rest.

3. **No token consumption recorded after turns** — The `session-idle` IIFE now reads `msg.providerID` / `msg.modelID` directly from the latest `AssistantMessage` instead of the `activeModel` closure. This eliminates the stale-closure timing dependency and handles mid-session model switches. Also added null guard on `msg.tokens` for non-Anthropic providers. `activeModel` removed from SSE `useEffect` deps to prevent loop teardown/restart on model changes.

**Files modified:**
- `src/utils/formatters.ts` (new in ecf35f9, updated in 4f702a8) — formatters + two-pass context window lookup.
- `src/components/StatusLine.tsx` — orchestra-style bar component (color on bar only).
- `src/app.tsx` — state, effects, event handler, StatusLine invocation; UX fixes in 4f702a8.

---

### 2026-05-23--16-40 — Stage 4.3: /show status + /thinking /tools toggle commands

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--16-40
**Commit(s):** `105b17a`

**What changed:**
Refactored `/show`, `/thinking`, and `/tools` commands to unify visibility toggle logic and enable tmux window creation and destruction on demand. All local command parsing and execution now lives in `src/commands.ts`; tmux lifecycle management is delegated to renderer implementations. The `/show` command becomes a pure status display; `/thinking` and `/tools` are dedicated toggle commands that manage tmux resource lifecycle.

**Key architectural changes:**

1. **Renderer interface** — added `setToggleEnabled(key: string, on: boolean): void` to enable uniform toggle control across all renderer backends.

2. **Command layer (`src/commands.ts`)** — two new functions replace the legacy `parseShowCommand`:
   - `handleShowCommand(input: string, renderer: Renderer): boolean` — matches `/show` with no arguments, reads visibility state, reports status in format `"thinking: on | tools: off"`, commits user input + system message, returns true/false.
   - `handleToggleCommand(input: string, renderer: Renderer): boolean` — matches `/thinking` or `/tools` with optional `on|off` action. Query mode (no action): reads state and reports. Toggle mode (action specified): calls `renderer.setToggleEnabled()` to update visibility and manage tmux resources.

3. **Renderer implementations:**
   - `StdoutRenderer.setToggleEnabled()` — uses local `ROLES_BY_KEY` constant to map keys ("thinking", "tools") to roles; calls `visibility.set()` for each.
   - `TmuxWindowRenderer.setToggleEnabled()` — same visibility update; if turning off, calls `_destroyWindow()` to close and clean up the window and FIFO.

4. **Lazy window creation** — `TmuxWindowRenderer._ensureWindow()` includes a hardening check: verifies the stored window still exists; if it's gone, clears maps and recreates.

5. **App dispatch** — `app.tsx` `handleSubmit()` replaced the single `/show` block with:
   ```typescript
   if (handleToggleCommand(text, renderer)) return;
   if (handleShowCommand(text, renderer)) return;
   ```
   Both functions handle commitUserInput/commitSystemMessage internally.

**Files modified:**
- `src/renderer/types.ts` — added `setToggleEnabled(key: string, on: boolean): void` to Renderer interface.
- `src/renderer/stdout.ts` — added `ROLES_BY_KEY` constant; implemented `setToggleEnabled()`.
- `src/renderer/tmux-window.ts` — added `ROLES_BY_KEY` constant; hardened `_ensureWindow()` with existence check; added `_destroyWindow(key)` method; implemented `setToggleEnabled()`.
- `src/commands.ts` — replaced `parseShowCommand()` with `handleShowCommand()` and `handleToggleCommand()`; removed import of `Visibility` (no longer needed directly).
- `src/app.tsx` — updated import to use `handleShowCommand`, `handleToggleCommand`; replaced `/show` dispatch block with the two new function calls.

> **Status (2026-05-25): DEPRECATED — superseded by Stage 4.5.** This first attempt failed because tmux window (re)creation was not re-entry safe; the load-bearing preparation was subsequently delivered in **Stage 4.4.3** (`1a4523c` — re-entry safety + `outputEnabled` gate) and **Stage 4.4.4** (`ad60b1c` — async background liveness refresh). The user-facing commands originally scoped here shipped in **Stage 4.5** (`25c644a` — see that entry for the authoritative description). This entry is retained as historical record of the failed first attempt.

---

### 2026-05-22 — Stage 4.2 fix: /model interactive picker + context window display

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `357fd181`, `487074d8`

**What changed:**
Two fixes to the `/model` command:

1. **Context window defensive coding** — The previous code accessed `mInfo.limit.context` directly; when `limit` or `limit.context` is absent at runtime the output showed `ctx:0`. Now uses optional chaining with a `"?"` fallback.

2. **Interactive model picker** — `/model` no longer prints a static list to scrollback. It now opens an inline picker above the input chrome (same modal pattern as `PermissionModal`/`QuestionModal`). Arrow keys navigate the list, `Enter` selects, `Esc` cancels, number keys `1`–`9` are shortcuts. The current model is marked `←current`. PromptInput is disabled while the picker is open. `/model <providerID>/<modelID>` still works as a direct set (bypasses picker).

**Design note — merged model list (intentional, see source comment):**
`/model` uses `client.provider.list()` (`GET /provider`), which returns OpenCode's **merged** view: the user's `~/.config/opencode/opencode.json` combined with OpenCode's full upstream model catalog. The merge happens server-side inside the OpenCode process; user config entries take precedence (they can override names, limits, costs). The `connected` filter means "has an API key available from any source" (config file, environment variable, or occasionally a provider with free/built-in access) — it is broader than "explicitly configured by the user".

This means the picker shows more models than the user may have consciously set up: any provider whose key happens to be in the environment will appear alongside explicitly configured ones.

**To revert to user-configured models only:** switch `provider.list()` to `client.config.providers()` (`GET /config/providers`) in the `/model list` handler in `src/app.tsx`. That endpoint reads `opencode.json` directly and returns `Provider[]` with a `source` field (`"config" | "env" | "custom" | "api"`). Filter to `source !== "api"` to exclude pure catalog entries, or `source === "config"` for only what is explicitly in `opencode.json`. The `Model` type from that endpoint has `limit.context` non-optional, so the defensive optional-chaining in the loop can be removed.

**Files modified:**
- `src/components/ModelPickerModal.tsx` (new) — picker component with `useInput` for navigation.
- `src/app.tsx` — added `ModelPickerModal` import; added `modelPicker` state; replaced static list with picker-open logic; added `handleModelSelect`/`handleModelCancel` callbacks; rendered picker in JSX; updated PromptInput `disabled` prop.

---

### 2026-05-22 — Stage 4.2: /model, /rename, /exit slash commands + /show consolidation

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `0bdd5174`

**What changed:**
Four slash-command implementations and command parsing consolidation. All local (non-forwarded) slash commands now live in a dedicated `src/commands.ts` module. The `parseShowCommand` function was moved from `visibility.ts` to `commands.ts` to keep all local parsers together. New commands: `/exit` (clean shutdown), `/rename <name>` (rename session in DB and tmux), `/model` (list providers/models or set active model for next prompt).

**Files modified:**
- `src/renderer/types.ts` — added `rename(newLabel: string): void;` to Renderer interface.
- `src/renderer/stdout.ts` — implemented rename as no-op.
- `src/renderer/tmux-window.ts` — implemented rename: renames origin window and all side windows to `<newLabel>--<key>`.
- `src/commands.ts` (new) — consolidated command parsers: `parseShowCommand` (moved from visibility.ts), `parseExitCommand`, `parseRenameCommand`, `parseModelCommand`.
- `src/renderer/visibility.ts` — removed `parseShowCommand` function (moved to commands.ts).
- `src/app.tsx` — rewired command dispatch in `handleSubmit`; added `sessionLabel` and `activeModel` state; updated import to use new `src/commands.ts` module; /model list shows current + available models from connected providers with context window sizes; /model set accepts `<providerID>/<modelID>` syntax and applies to next prompt.

**Design notes:**
- `/rename` updates the session title in the DB (via `client.session.update`) and renames tmux windows via `renderer.rename()` immediately.
- `/model list` fetches provider list and current session model, displays connected providers' models with context limits in human-readable form (e.g., "4k"), marks current model with asterisk.
- `/model set <providerID>/<modelID>` sets local `activeModel` state which is included in next `promptAsync()` body. Does not persist to DB — applies only to the current prompt.
- Command dispatch order: /exit, /rename, /model, /show, then default promptAsync.

---

### 2026-05-22 — Stage 4.1c: Default attach to port 4096 + --auto-spawn warning

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `55581900`, `8e793430`, `fe9a72db`

**What changed:**
The startup behavior has been inverted: `octmux` with no arguments now attaches to the default port 4096 (the systemd service) instead of auto-spawning. Auto-spawn is now an explicit opt-in via `--auto-spawn` flag.

**Rationale:**
- Running multiple opencode instances concurrently risks SQLite locking errors (second instance crashes) and memory bloat from duplicate MCP/LSP processes.
- A single persistent server (managed by `scripts/opencode-server.service`) is the recommended pattern.
- On connection failure to port 4096 (default path), a rich error message guides users to start the server and documents the `--auto-spawn` option with its risks.

**Files changed:** `src/index.tsx`
- Added `--auto-spawn` flag parsing (line 43).
- Updated help text with new usage patterns and `--auto-spawn` warning.
- Rewrote server-lifecycle block (lines 94-138): now prefers attach-to-4096 over auto-spawn; distinct error messages for default vs. explicit `--attach`.

**Amendment — 2026-05-23, commit `12327ea` (Claude Code, Claude Sonnet 4.6):**
Converted the service from system-wide (root-owned) to a proper **user unit**, and made the
port configurable. opencode is single-user (SQLite session store) — a system-wide service was
the wrong abstraction.

- `scripts/opencode-server.service` — full rewrite as user unit: removed `User=florian`,
  `After=network.target`, `Environment=HOME=`, all hardcoded `/home/florian` paths; `%h`
  expansion throughout; `OPENCODE_PORT=4096` env var with optional `EnvironmentFile` override
  at `~/.config/opencode/opencode-server.env`; `WantedBy=default.target`; journal comments
  updated to `--user` flag.
- `scripts/install-opencode-service.sh` — rewritten without root: installs to
  `~/.config/systemd/user/`; `systemctl --user` throughout; errors if accidentally run as
  root; port-override hint and `loginctl enable-linger` hint.
- `src/index.tsx` — `systemctl start` → `systemctl --user start` in the rich error message.

**Logging decision — volatile (journald):** user journal is volatile by default on Debian
(stored in `/run/user/$UID/`, cleared on reboot). This is acceptable for a dev tool.
Query: `journalctl --user -u opencode-server [-f]`.

If persistent logs are needed later, options are:
1. **System-level** (requires root): set `Storage=persistent` in `/etc/systemd/journald.conf`
   and restart journald — all journals (system + user) become persistent in `/var/log/journal/`.
2. **File-based** (user-level, no root): change `StandardOutput=journal` to
   `StandardOutput=append:%h/.local/share/opencode/server.log` in the unit, then add a
   companion logrotate config + systemd user timer for daily rotation with `copytruncate`.

---

### 2026-05-22 — Stage 4.1b: systemd service for opencode headless mode

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `cbd48a08`, `00bb1efc`

**What shipped:**
Two files under `scripts/`:

- `scripts/opencode-server.service` — systemd unit that runs `opencode serve --port 4096 --print-logs --log-level INFO` as `User=florian`. `Type=simple` (non-forking). `Restart=on-failure` with `RestartSec=5s` and a burst cap (`StartLimitBurst=3` per 60 s) to avoid restart storms. Logs go to journald (`StandardOutput=journal`, `SyslogIdentifier=opencode-server`); query with `journalctl -u opencode-server -f`.

- `scripts/install-opencode-service.sh` — idempotent install script (run as root from repo root). Copies the unit to `/etc/systemd/system/`, reloads the daemon, and runs `systemctl enable --now`.

**Port:** 4096 (manual dev instances use 4097 / 4101).

**Log rotation:** handled by journald (configured via `/etc/systemd/journald.conf`; default keeps logs until disk use hits 10% or free space drops below 15%).

**Usage after install:**
```
sudo bash scripts/install-opencode-service.sh
journalctl -u opencode-server -f
```

---

### 2026-05-21 — Stage 4.1: Post-Version3 minor UX fixes

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `b92c706`, `419ac4e8`

**What shipped:**
`TmuxWindowRenderer` origin window renamed to opencode session label; side window names changed to `<label>--thinking` / `<label>--tools` (double-dash); `SubprocessStatus` component added — animated 2-char spinner + elapsed timer per active subprocess, shown above the input chrome.

Timer start/stop semantics: `thinking` timer starts on `block-start` for the thinking role, clears on its `block-end` (i.e. when the reasoning phase ends, before the text response begins — not at turn end). `tools` timer starts on the first `tool-call block-start`, clears on `tool-result block-end` (normal path — result delivery ends the sequence) or on `tool-call block-end` with `status="error"` (error path — no result follows). Both timers are also cleared on `session-idle` as a safety net. `procTimes` state in `app.tsx` tracks the start timestamps; zero-height when both are null.

---

### 2026-05-26 — SubprocessStatus: replace 2-char ASCII spinner with circleHalves

**Implemented by:** Claude Code (Claude Sonnet 4.6) — 2026-05-26--12-46
**Commit(s):** `b727424`

**What shipped:**
`SubprocessStatus` spinner replaced: `["--", "->", ">>", "->"]` at 500 ms/frame → `circleHalves` (`["◐", "◓", "◑", "◒"]`) at 50 ms/frame. Single character instead of two; standard spinner from sindresorhus/cli-spinners. No other changes.

---

## Stage 4 Plan

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

**Handoff to Stage 5:** UX foundation is complete. Stage 5 layers slash
commands on top — `/` input branches before reaching `promptAsync`.

---

### 2026-05-30--22-10 — v4.7 — toggle keybindings + ToggleStatusLine 3rd status bar

**Implemented by:** Claude Code (Claude Sonnet 4.6, via Actor subagent) — 2026-05-30--22-10
**Commit(s):** `43f3df1`, `0110138`

Add Ctrl-t / Ctrl-T keybindings for toggling the `tools` and `thinking` output gates, plus a 3rd status bar (`ToggleStatusLine`) that shows each toggle's current on/off state. Toggle defaults are loaded at startup from `~/.config/octmux/toggle-keybindings.json`. Ctrl-H (`key.backspace`) is also wired to fire `/help` as a live keybinding (no config or status bar entry).

**Architecture:**

- **`src/config.ts`** (new) — `ToggleBinding` / `TogglesConfig` types, `loadTogglesConfig()` reads `~/.config/octmux/toggle-keybindings.json` with graceful fallback to `{tools:true, thinking:true}` on any error, `getToggleDefaults()` returns a `Map<string,boolean>` for initialising the renderer.
- **`src/components/ToggleStatusLine.tsx`** (new) — iterates `bindings[]` from config in order; renders `^t /tools-output: on   ^T /thinking-output: on`; key notation + labels in default terminal colour; `on` = `#1dde00` bold, `off` = `#cc241d` bold (matches PermissionStatusLine palette).
- **`config/toggle-keybindings.json`** (new, in repo at `config/toggle-keybindings.json`) — canonical source; runtime location is `~/.config/octmux/toggle-keybindings.json`. Any commit touching this file must deploy it: `cp config/toggle-keybindings.json ~/.config/octmux/toggle-keybindings.json`. Ordered array of `{ key, gate, default }` entries where `gate` uses the slash-command form (`"tools-output"`, `"thinking-output"`). `rendererGateKey()` in `src/config.ts` strips the `-output` suffix at the renderer boundary so the internal `OUTPUT_KEYS` (`"tools"`, `"thinking"`) remain unchanged.
- **`src/keybindings.ts`** — `onCyclePermMode?` positional param replaced by a `callbacks` object (4 fields: `onCyclePermMode`, `onHelp`, `onToggleTools`, `onToggleThinking`). `key.backspace || key.delete` split into two branches: `key.backspace` → `onHelp` (Ctrl-H); `key.delete` → existing backspace/deleteForward logic. Added `key.ctrl && input === "t"` → `onToggleTools` and `key.ctrl && input === "T"` → `onToggleThinking` in the Emacs-ctrl group.
- **`src/components/PromptInput.tsx`** — 3 new optional props (`onHelp`, `onToggleTools`, `onToggleThinking`); passes all 4 callbacks as an object to `handleKey`.
- **`src/app.tsx`** — module-level `TOGGLES_CONFIG`; `gateStates` React state initialised from config defaults; renderer gates seeded from defaults in startup effect; `triggerHelp` / `toggleGate` callbacks; `gateStates` synced from renderer after manual `/tools-output` or `/thinking-output` commands; `ToggleStatusLine` rendered as the 3rd bottom status line.

---

### 2026-05-31--22-28 — v4.7 hotfix — Ctrl-t toggle aligned with slash-command path

**Implemented by:** Claude Code (Claude Haiku 4.5, via Actor subagent) — 2026-05-31--22-28
**Commit(s):** `392d771`

**What changed:**

Refactored `toggleGate` callback in `src/app.tsx` (lines 98–111) to eliminate a React anti-pattern that froze the UI mid-stream. The previous implementation called `renderer.setOutputEnabled()` inside a React `setState` updater, which is unsafe during streaming — React's Strict Mode may double-invoke the updater, and concurrent async event delivery races with the timing.

**The fix follows the slash-command path** established in Stage 4.5 (`parseBlockOutputCommand` → `setGateStates`):

1. **Step 1** — Mutate renderer first (outside React state updater): read current gate state, negate it, call `renderer.setOutputEnabled()` with the new value.
2. **Step 2** — Derive React state from renderer via pure read-back: `setGateStates` updater iterates all keys and reads back `renderer.isOutputEnabled()` for each, with zero side effects.

This ordering ensures the renderer is the authoritative source of truth; React state is always synchronized via read-back, never by closure; and the in-flight stream is unblocked by state updates.

**Rationale:**
- Pressing Ctrl-t during tool-call streaming in `--single` mode now behaves identically to `/tools-output off` — gate mutated first, state derived second, stream continues.
- Eliminates the event-loop block that froze the UI and prevented responsive input during streaming.
- Pattern now uniform across both the slash-command path and the keybinding path.

**Files modified:**
- `src/app.tsx` — `toggleGate` callback refactored.

---

### 2026-05-31--22-40 — v4.7 hotfix — Stage4.md timestamps corrected to local CEST

**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-05-31--22-40
**Commit(s):** `29138e4`

**What changed:**

Reviewer flagged that the previous v4.7-hotfix subsection (commit `392d771`) recorded its timestamps in UTC (`2026-05-31--20-28`) while every prior entry in `docs/Stage4.md` uses local CEST. Corrected three lines to keep the project convention consistent: the frontmatter `updated_at`, the subsection heading, and the `**Implemented by:**` line — all `20-28` → `22-28`.

**Rationale:**
- Consistency with all earlier Stage4 entries, which use local time.
- The project's CLAUDE.md global rule (timestamp format `YYYY-MM-DD--HH-MM` sourced from file mtime / local clock) implicitly assumes local time; no entry in any project doc to date is UTC.

**Files modified:**
- `docs/Stage4.md` — three timestamp strings; no body-text change to the v4.7 hotfix entry it documents.
