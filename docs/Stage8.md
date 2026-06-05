---
title: "Stage 8 — Live cost display (OC SDK) + orchestra inflight badge"
created_at: 2026-05-29--08-27
created_by: Claude Code (Claude Haiku 4.5)
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-06-05--23-16
context: >
  octmux's status bar shows live `Σ$X.XX` cost (from OC SDK `AssistantMessage.cost`,
  summed over parent session + one-level children) and an orchestra inflight badge
  `♪ orchestra -> <title> -> <mode> [-> <subagent>] [!]` when an oconona `/brain` or
  `/duo` session is active. This file is the changelog + known-limitations + oconona
  feedback. The full consumer-side contract (cost path, badge mechanics, provider→
  consumer reads table, fragility analysis, recommended test matrix) lives in
  `docs/octmux--orchestra-implementation-details.md` and mirrors the structure of oconona's
  `oconona/docs/oconona--provider-contract-details.md` (provider spec). The two
  implementation-details docs must stay in sync.
---

## See also

- **`docs/octmux--orchestra-implementation-details.md`** — consumer-side contract: what octmux reads, how the watcher works, badge rendering rules, fragility/race analysis, recommended test matrix. Mirrors oconona's provider-side specification (see next bullet).
- **`oconona/docs/oconona--provider-contract-details.md`** — provider-side contract (authoritative for the sidecar layout, badge format spec, telemetry.json schema).
- **`oconona/docs/Stage7.md`** — oconona roadmap (v7.5 is the contract version this consumer reads).

---

## Implementation log

### 2026-06-05--13-48 — Stage 8.3 — Documentary alignment with oconona v8.2.0 (researcher tiers)
**Implemented by:** Actor (sohoai/qwen3-4b-q6) — 2026-06-05--13-48
**Commit(s):** `f12db50c197808ec69a8e7f920c9579e2f501707`

Aligned octmux documentation with the oconona v8.2.0 contract addition (new `researcher` / `researcher-deep` Phase 0 subagent tiers, new `researcher_dispatches` telemetry field). All v8.2.0 additions are ADDITIVE and forward-compatible at runtime — `info.agent` is an opaque `string` end-to-end in src/, so new tier names flow through unchanged; `researcher_dispatches` is a telemetry.json field octmux never reads. Three concrete doc changes: (a) back-propagated the prior `docs/Stage8--implementation-details.md` → `docs/octmux--orchestra-implementation-details.md` rename across three inbound references in `docs/Stage8.md` (lines 14, 21, 83); (b) updated `docs/octmux--orchestra-implementation-details.md` to enumerate `researcher`, `researcher-deep` in the `info.agent` and `subagents[]` examples (lines 116, 154), added `researcher_dispatches` to the explicit "does NOT read" list (line 192), and extended the test-matrix `/brain` lifecycle entry (line 379) to acknowledge Phase 0 dispatches; (c) updated frontmatter `updated_by` / `updated_at` and appended a v8.2.0 acknowledgement to the context block. Stage 8.1.5 lifecycle prose in this file also gained a one-clause Phase 0 Researcher acknowledgement. No `src/` changes, no `bun build`, no binary commit. Sole purpose is documentary alignment with the provider contract.

### 2026-06-05--23-05 — Stage 8.1.5.2 — Symmetric Task/session.created pairing + brain session.error defensive cleanup
**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-05--23-05
**Commit(s):** `f84a319`

**Bug**: Stage 8.1.5 introduced asymmetric pairing: `session.created` arrived and immediately paired with the oldest pending Task part. This worked for Anthropic-streamed brains (which emit `message.part.updated(pending)` BEFORE `session.created`), but failed silently for non-Anthropic providers like `sohoai/deepseek-v4-pro` where `session.created` arrives FIRST — the child would sit in `trackedChildSessions` but never be paired to a Task part, and rows would freeze at 120s inactivity instead of ending when the task completed. SQL forensics showed all 6 Task parts in a deepseek session reached `completed` in opencode.db, yet their paired subagent rows remained frozen — the silent miss.

**Fix**: Introduced symmetric pairing via two-way `tryPair()` helper (`src/events.ts` lines 90-115). New module-level `unpairedChildren: Set<string>` holds children arriving before any pending parts. Both `session.created` and `message.part.updated(pending)` now call `tryPair()`, which FIFO-drains both sets in lock-step, pairing oldest-pending-part with oldest-unpaired-child. The invariant is: a child either sits in `unpairedChildren` (waiting for a part) or in `taskToChild` (paired and active) — never falls through to a stale unpaired row.

**App-side defensive cleanup**: `src/app.tsx` error handler now calls `watcherRef.current?.notifyAllSubagentsEnded()` on any `session.error` event (line 558-568). This is a safe no-op when `badge.subagents` is empty, but catches the case where a brain session fails mid-pipeline (e.g. provider timeout during Phase 2 Researcher, or malformed response from a new provider tier) — orphaned rows are cleared and the user is prompted to run `/brain-abandon` for explicit cleanup.

**Test coverage** (`src/events.test.ts`): two new `describe` blocks added at lines 319–411:
- **§Task/session.created ordering: session.created BEFORE pending**: Test 1 verifies child arrives before pending part, then part completes → subagent-ended fires correctly. Test 2 verifies the same path with task transition to `error` instead.
- **§Parallel multi-task dispatch out-of-order**: Test 1 both children arrive before any parts → all 4 combinations queued → parts arrive → FIFO pairing verified → both complete correctly. Test 2 interleaved arrivals (child_1, part_1 immediate pair, child_2, part_2 immediate pair) verifies FIFO ordering is preserved even with interleaving. All 24 assertions green.

**Cross-reference**: This is a point-release of Stage 8.1.5 per `feedback-version-numbering` (anchor bug fixes against the implementing stage; do NOT inflate to a new top-level number). Stage 8.1.5 introduced the Task pairing logic; Stage 8.1.5.1 added diagnostic logging; this entry is Stage 8.1.5.2 (race fix).

### 2026-06-05--12-16 — Stage 8.2 — Subagent-activity coverage for child-session message.part.delta + message.part.updated
**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-05--12-16
**Commit(s):** `09a9204`

Extended subagent-activity event coverage to child-session `message.part.delta` and `message.part.updated` events. Previously, only parent-session activity and coarse `session.updated` events bumped the subagent spinner's activity timer, causing false-positive 120s freezes during reasoning-heavy workloads (e.g. long inference spans from minimax-m3). The fix routes delta and updated events arriving from `trackedChildSessions` directly to `subagent-activity` ReplEvent emissions, bypassing the parent-session logic paths.

**Implementation details:**
- `src/events.ts:166-186` (message.part.delta handler): replaced the single-line session filter with a three-branch gate: (a) parent session — falls through to existing `openParts` → `block-delta` logic (byte-equivalent); (b) tracked child session with non-empty delta — emits `{ kind: "subagent-activity", sessionID, ts }` and returns immediately without touching `openParts`; (c) everything else — drops.
- `src/events.ts:194-206` (message.part.updated handler): added identical three-branch gate: (a) parent session (`part.sessionID === sessionID`) — falls through to per-type sub-handlers; (b) tracked child session — emits `subagent-activity` and returns immediately; (c) everything else — drops. This covers tool-call state updates and any future part types; each message activity from a tracked child counts as a spinner bump.
- Code comments at both branches note that throttling is intentionally deferred per RESEARCH.md and that any non-empty activity bumps the spinner regardless of part type.
- `ACTIVITY_FREEZE_MS = 120_000` threshold remains unchanged. With proper event coverage, 120s of true SSE silence now correctly signals a wedge rather than false-positive during normal long inference.

**Design rationale:** Reasoning models emit `message.part.delta` at high frequency during inference. By routing these events to the spinner-activity timer instead of dropping them, the orchestru row correctly reflects genuine model activity rather than appearing frozen for 120+ seconds during legitimate thinking spans.

### 2026-06-05--00-53 — Stage 8.1.5 — Subagent rows: dispatch-time appearance + Task-tool lifecycle
**Implemented by:** Claude Code (Claude Opus 4.7 — 1M context) — 2026-06-05--00-53
**Commit(s):** `f54bb86` (src — detection + lifecycle + tests), this doc commit

Subagent rows now appear simultaneously with the brain's "dispatching planner / actor / reviewer" output line and end at the precise moment the parent's Task tool returns the subagent's final output. Operator-verified end-to-end on OC session `ses_16b325134ffe8IwQ5GWulksPvi` (planner → actor → reviewer dispatch sequence, preceded by one or more Phase 0 Researcher dispatches (oconona v8.2.0+; informational only); log evidence at `/tmp/octmux-debug.log`).

**Detection** — `src/events.ts` filters the OC global event stream (`client.global.event({})`, opened at `src/index.tsx:257`). When `event.type === "session.created"` and `info.parentID === harness sessionID`, the child sessionID is added to `trackedChildSessions: Set<string>` and a `subagent-detected` ReplEvent is emitted with `sessionID`, `agent` (from `info.agent`), and `model` (formatted as `${info.model.providerID}/${info.model.id}`). `info.agent` and `info.model` are populated by the locally-built OC daemon since the upstream Stage 8.1.3 fix (FlorianOtel/opencode@98a4907c9).

**Lifecycle end — protocol-precise** — the row drops on the brain's Task tool transitioning to `state.status === "completed"` or `"error"`, not on the child's `session.idle` (which OC fires on every turn pause within a subagent's life). Two module-level structures in `events.ts` implement the pairing:
- `openTaskPartIDs: Set<string>` — Task-tool partIDs first observed pending/running, awaiting pair. JS Sets iterate in insertion order, so the oldest entry is the FIFO head.
- `taskToChild: Map<string, string>` — paired Task-tool partID → child sessionID.

Flow: on `message.part.updated` with `part.type === "tool"` AND `toolPart.tool === "task"` (the daemon's registered name; verified at `~/Gin-AI/projects/opencode/packages/opencode/src/tool/task.ts:24`), the first observation in `pending` state adds the partID to `openTaskPartIDs`. The next `session.created` with matching parentID FIFO-pairs with the oldest entry, moving it to `taskToChild`. When that taskPart transitions to `completed`/`error`, a `subagent-ended` ReplEvent is emitted for the paired child and both structures are cleaned up. Tasks ending before a session.created (no child created) just clean up `openTaskPartIDs`. Activity-recency for the spinner-freeze threshold (Stage 8.1.4) is driven by `session.updated` events for tracked children → `subagent-activity` ReplEvent → `notifySubagentActivity(sessionID, ts)` in the watcher.

**Render-side invariants** — `src/orchestra-watch.ts` carries two structural invariants beyond the Stage 8.1.4 spinner/freeze/colour mechanics: (a) `scan()` preserves existing subagents across re-runs by reading `this.badge?.subagents ?? []` into the freshly-built `bestBadge` literals (both brain and duo branches) — so the 5-second poll and fs.watch fires no longer wipe rows that `notifySubagentStarted` just pushed; (b) every `notify*` method and the `_updateBadge` drain path replaces `this.badge` (or `newBadge`) with a shallow clone `{...this.badge}` before emitting `"changed"` — produces a new top-level reference each emit, defeating React's `Object.is` bailout in `setOrchestraBadge` (wired at `src/app.tsx:336` as `watcher.on("changed", setOrchestraBadge)`), so the re-render fires immediately on push/mutation rather than waiting for the next spinner tick.

**StatusLine rendering** — `src/components/StatusLine.tsx` renders each subagent row as `◐ planner [sohoai/minimax-m3]`: spinner glyph in `#1dde00` (rotating while activity-recent, freezing at `◐` after 120 s of inactivity); agent name in `#d3869b` (gruvbox purple); bracketed `provider/model` rendered with `dimColor`. Rows stack downward beneath the mode row, max 5 visible plus `+N more` overflow. Bracketed segment omitted if `info.model` is empty. Spinner glyph set / colour / freeze threshold / 250 ms tick mechanics carried over from Stage 8.1.4 unchanged.

**Dead-code purge** — `src/events.ts` no longer carries the SubtaskPart filter branch, `detectedSubtaskPartIDs`, or any `subtask` part-type handler. `src/orchestra-watch.ts` no longer carries the D-poll infrastructure (`_subagentPollers`, `_startSubagentPoll`, `_bumpSubagentActivity`, `_stopSubagentPoll`), `agentModelMap`, `loadAgentModels()`, the `sessionID?` notifier parameter, or per-subagent `partID` / `modelRaw` / `modelLabel` / `sessionID?` fields. Public API renamed: `notifySubtask*` → `notifySubagent*` with `sessionID` as the row identity key. `OrchestraBadge.subagents[]` element type: `{ sessionID, agent, model, description?, lastActivityAt }`.

**Diagnostics** — env-gated `console.error` shims at seven sites fire when `OCTMUX_DEBUG_SSE=1`: SSE wrapper-key one-shot dump + per-event payload type + harness sessionID (`app.tsx`); `filterEvent` event-type entry; `session.created` branch with parentID/agent/model/match outcome; `session.idle` with sessionID + tracking flags; `session.deleted` symmetric; Task tool pending + paired + completed/errored emissions; `notifySubagentStarted` entry with badge-presence and queue length; `_updateBadge` drain pending/subagents counts. Default off → zero behaviour change. Evidence-pass recipe: `OCTMUX_DEBUG_SSE=1 dist/octmux 2>/tmp/octmux-debug.log`, run `/brain "<task>"`, exit, grep for `session.created id=`, `session.created paired with`, `task tool completed`, plus the regression check `grep -c 'emitting subagent-ended (via session.idle)' /tmp/octmux-debug.log` (must be 0).

**Tests** — `src/events.test.ts` and `src/orchestra-watch.test.ts` pin the detection layer (session.created filter, Task-tool FIFO pairing, completed/error end emission, unpaired graceful handling) and the watcher (queue-and-drain, mutation+emit, new-reference invariant on all five emit sites). 58 assertions, all green. `package.json`: `"test": "bun test src/"`.

**Supersedes**: Stage 8.1.1 (SubtaskPart-based detection — never fired; OC daemon does not emit SubtaskPart for Task-tool dispatch by design, proven from `packages/opencode/src/tool/task.ts:148`, `session/session.ts:577`, `prompt.ts:1594`) and the Stage 8.1.4 queue-and-drain (solved a race that could only matter if SubtaskPart arrived — it doesn't). The Stage 8.1.4 spinner / `#1dde00` colour / 120 s freeze threshold / `notifyParentActivity` mechanics are preserved verbatim.

### 2026-06-04--18-40 — Stage 8.1.4 — Queue-and-drain + rotating spinner + #1dde00 colour fix
**Implemented by:** Claude Code (Claude Opus 4.7 — 1M context) via /brain — 2026-06-04--18-40
**Commit(s):** `eb3a777` (octmux src — queue-and-drain + spinner + colour); ref this doc backfill commit below

**Note:** superseded by Stage 8.1.5 — the SubtaskPart-based detection this entry's fixes were built on top of never functioned in practice (the OC daemon does not emit SubtaskPart for Task-tool dispatches by design); see the Stage 8.1.5 entry for the working `session.created`-based mechanism. The Stage 8.1.4 spinner, colour, freeze-threshold, and `notifyParentActivity` work IS preserved in 8.1.5.

Stage 8.1.4 fixes three coupled bugs in the v8.1.1 stacked-subagent-rows UX that prevented subagent rows from rendering at all during /brain runs. **Bug 1 (root cause)**: `notifySubtaskStarted` in `src/orchestra-watch.ts` returned early when `this.badge === null`, silently dropping all SubtaskPart event notifications when the directory-scan-driven badge construction lagged behind the first SSE event. Fix: queue-and-drain via `_pendingSubtaskQueue`, drained into `badge.subagents[]` in `_updateBadge` the moment a non-null badge materializes. Stage 8.2.1 `matchedSessionCount` invariant preserved (`scan()` body unchanged). **Bug 2**: active-dot colour changed from gruvbox `#b8bb26` to bright green `#1dde00` (matches the existing `ToggleStatusLine` / `PermissionStatusLine` palette). **Bug 3**: static `●/○` glyph pair replaced with rotating circle-quadrant spinner (`◐ ◓ ◑ ◒`, same family as the parent CC `◒ tools` / `◓ generating` indicators), keyed per row off `lastActivityAt` with a single binary 120-s freeze threshold. Parent (brain) row activity is bumped by a new `notifyParentActivity(ts)` watcher method (direct mutation + emit, bypasses `JSON.stringify` diff) called from `applyReplEvents` in `src/app.tsx` on every `block-start`/`block-delta` event with parent roles `text|thinking|tool-call|tool-result`. Subagent rows would be bumped by D-poll (5 s `client.session.messages` polling), but the OpenCode SDK's `SubtaskPart` carries no child session ID field (the existing `part.sessionID` is the parent session ID — verified against `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`), so subagent `sessionID` is passed as `undefined`, `_startSubagentPoll` silently no-ops, and subagent rows display rotating from dispatch then freeze at ~120 s until `notifySubtaskEnded` drops the row. Spinner frame advance is driven by an app-level 250 ms `useEffect` `setInterval` (one integer state); render cost is contained by React's same-reference bailout on `notifyParentActivity` and Ink's diff-based output. Frozen state uses the same `#1dde00` colour (no tint shift) — the freeze itself is the wedge signal. Full UX rule: row appears on `notifySubtaskStarted`, spinner rotates while `now - lastActivityAt <= 120000`, halts on `◐` otherwise, row drops on `notifySubtaskEnded` (`message.part.removed` OR `session.idle` force-flush) or pipeline cleanup. No new timeout-based row drop. Implementation per /brain plan at `~/.claude/plans/this-is-a-troubleshooting-peppy-tome.md`; Reviewer verdict PASS.

### 2026-06-03--23-28 — Stage 8.1.1 — SSE subagent detection + downward-stacked role rows + model labels
**Implemented by:** Actor (Claude Haiku 4.5 via /brain) — 2026-06-03--23-28
**Commit(s):** `7256de8`

**Note:** superseded by Stage 8.1.5 — the SubtaskPart-based detection described here was a misread of the OC protocol and never functioned in practice; see the Stage 8.1.5 entry for the working `session.created`-based mechanism. The downward-stack StatusLine layout and the OrchestraBadge widening to a `subagents[]` array are preserved.

Replaced invocations.log-based subagent detection (which never fires on OC) with live SSE SubtaskPart event detection via `message.part.updated` where `part.type === "subtask"`. Redesigned OrchestraBadge from single-field `subagent?` to widened type carrying parent model labels and an array of live subagents, each with agent role, description, and model info. Redesigned StatusLine rendering from single inline badge to downward-growing stack: main status row, optional mode row (●/○ based on subagent liveness with parent model label), per-subagent rows (max 5 visible with overflow counter), all in correct colors. Model labels (agent.name, agent.model → provider/modelId → friendly name) sourced from agent frontmatter YAML and opencode.json, read once at watcher startup. Supersedes Stage 8.1. Full implementation details at `docs/octmux--orchestra-implementation-details.md` §Subagent role detection.

### 2026-06-04--17-20 — Stage 8.1.3 — Upstream OpenCode fix + revert v8.1.2 sidecar
**Implemented by:** Claude Code (Claude Opus 4.7 — 1M context) — 2026-06-04--17-20
**Commit(s):** octmux docs only (this entry); ref oconona `3b4511c` (code revert) + `e9e1e19` (docs); ref opencode fork `FlorianOtel/opencode@98a4907c9`

Issue 4 (subagent attribution NULL) traced to upstream OpenCode commit `ddc30cd15` (`feat(core): add session metadata support (#23068)`, 2026-05-30 21:58 UTC): the refactor made `agent`/`model` explicit `Session.create()` inputs but `packages/opencode/src/tool/task.ts` never updated to pass them. Fix landed on fork `FlorianOtel/opencode@98a4907c9` (hoist `MessageV2.get()` + model derivation above `sessions.create()`; pass `agent: next.name` and `model` in `Session.Model`'s `{ id, providerID }` shape; regression Tests A/B/C in `test/tool/task.test.ts`). Locally-built daemon `0.0.0-dev-202606041432` populates `agent`/`model` natively on post-deploy Task-tool child sessions in `opencode.db` — verified on `ses_16cdc3cc3ffeerg5gJ9P03yZvl` immediately after the daemon restart. With OC-native attribution restored, the v8.1.2 oconona sidecar (`subagents.jsonl` writer in `commands/brain.md`, reader in `scripts/telemetry-summarize.py`) is reverted as no longer needed; `scripts/oc-db.py:378` defensive `or ""` default stays. Standalone PR handoff brief at `~/Gin-AI/tmp/opencode-fix-session-metadata.md`. Detailed §v8.1.3 in `docs/cost-telemetry-investigation.md`.

### 2026-06-04--10-09 — Stage 8.1.2 — Telemetry forensics + ctx-meter fix + sidecar attribution fallback
**Implemented by:** Claude Haiku 4.5 (Actor via /brain) — 2026-06-04--10-09
**Commit(s):** `c73e354` (octmux src); ref oconona `382dd4f` (code) + `5404b74` (docs)

Telemetry investigation of a /brain pipeline session uncovered four cost-telemetry anomalies and an OC daemon regression. Three issues were by design or rounding artifacts (tokens_input rounding, post-cleanup cost drift, context-meter snapshot timing); one exposed an OC daemon bug (NULL agent/model columns for child sessions created on 2026-06-03+). Issue 2 (ctx-meter showing 0% when latest assistant message has all-zero tokens during tool calls) was fixed via backwards-scan in `refreshTokenUsage()`: when `used === 0`, search earlier assistant messages for the first non-zero `used` value and use that frame's tokens instead. The OC daemon regression (Issue 4) required a sidecar fallback mitigation: oconona now instruments `commands/brain.md` to write `subagents.jsonl` (one JSON line per subagent invocation before Task dispatch), capturing `subagent_type` from the Task tool call. The telemetry summariser (`telemetry-summarize.py`) now reads this sidecar as fallback attribution when OC's agent/model columns are NULL, merging them chronologically by invocation index. One secondary change in oconona: removed misleading `agent: "brain"` default in `oc-db.py` (replaced with empty string to distinguish NULL from real "brain"). Full forensic findings, SQL evidence table (4 OC sessions with complete token/cost ground truth), and disposition analysis at `docs/cost-telemetry-investigation.md` §v8.1.2. **Superseded by Stage 8.1.3 (2026-06-04--17-20): the upstream daemon fix replaces the workaround; sidecar reverted.**

### 2026-06-03 — Stage 8.2.1 (commit `e28973e`)
**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-06-03--16-30
**Commit(s):** `e28973e`

`matchedSessionCount` now increments only when a live inflight marker (`.brain-inflight` or `.duo-inflight`) is found in the iteration, not on `.oc-session-id` match alone. Without this, the `#N` rewrite would mislabel a single live session as multi-concurrent whenever a prior completed run's session dir was still on disk with the same `.oc-session-id` (the parent OC session ID is shared across sequential orchestra runs within the same octmux session). Pre-existing latent bug from Stage 8.0; surfaced in Stage 8.2 review (Reviewer iter 2, flagged not-blocking).

### 2026-06-03 — Stage 8.2 (commit `8573af1`)
**Implemented by:** Actor (Claude Haiku 4.5) — 2026-06-03--16-16
**Commit(s):** `8573af1`

v7.5 contract refactor: `.oc-session-id` match key replaces `.project-dir`; `OrchestraWatcher` constructor takes `client` (not `projectDir`); OC HTTP API session resolution via `GET /session`; symmetric badge format `♪ orchestra -> <title> -> <mode> [-> <subagent>]`; `invocations.log` `subagent` field (canonical) with `stage` back-compat; per-session `telemetry.json` `parser_warnings` reader; `src/app.tsx` wires sessionID via `watcherRef` + `setOcSessionID()` setter; session_id filter applied to both start AND end events for cross-session isolation; `safeRealpath()` on directory comparison.

### 2026-05-29 — Stage 8.1 (commit `c30d30a`)
**Implemented by:** Actor (Claude Haiku 4.5) — 2026-05-29--11-01
**Commit(s):** `c30d30a`

Added active-subagent indicator reading `invocations.log`. (Superseded by Stage 8.2: separate yellow `▶ <stage>` rendering absorbed into inline `-> <subagent>` badge segment.)

### 2026-05-29 — Stage 8.0 (commit `bd561fc`)
**Implemented by:** Actor (Claude Haiku 4.5) — 2026-05-29--08-27
**Commit(s):** `bd561fc`

Initial live cost display (Σ$ from OC SDK `AssistantMessage.cost`) + orchestra inflight badge. (Discovery mechanism superseded by Stage 8.2.)

---

## Known limitations & future work

- **Per-tier cost breakdown:** Not in scope; current design sums all tiers uniformly.
- **Cost persistence:** Resets to 0 on octmux restart (by design; fresh session context).
- **SoHoAI flat-rate:** Displays `Σ$0.00` (correct; OC reports cost=0 for flat-rate sessions).

---

## Notes for oconona (v7.5 contract clarification)

The Stage 8.2.1 fix exposes an under-documented invariant of the v7.5 contract that oconona's spec (`oconona/docs/oconona--provider-contract-details.md`) should make explicit. **No oconona code change is required** — the contract is correct as designed; the gap is documentation.

### The invariant

`.oc-session-id` carries the **parent OC session ID**. That ID is constant for the lifetime of the OC session, so all orchestra session dirs created during the same octmux/OC session share the same `.oc-session-id` value. Sequential `/brain` or `/duo` runs in the same octmux session therefore produce multiple session dirs that ALL pass the `.oc-session-id` match key.

### Implication for harness implementations

The `.oc-session-id` match key alone is **not sufficient** to identify "live" session dirs — it identifies any dir created during this OC session, whether the orchestra run is in-flight or has completed. Harnesses MUST additionally filter by inflight marker presence (`.brain-inflight` / `.duo-inflight`) for live-segment discovery, and by `telemetry.json` presence (and absence of marker) for completed-segment discovery. The §11 harness checklist mentions this in passing (step 3 says "if .brain-inflight or .duo-inflight is present (and mtime < 24h), it's a live segment") but does not call out the multi-invocation-per-OC-session case explicitly. The current octmux Stage 8.2.1 bug originated from this gap.

### Suggested oconona-side action (documentation only)

Add an explicit subsection to `oconona/docs/oconona--provider-contract-details.md` §Sidecar match key — something along these lines:

> **Note: `.oc-session-id` is shared across orchestra runs within a single OC session.** The match key identifies any session dir created during the harness's current OC session, not specifically the live one. Concurrency counts and live-session detection MUST additionally filter on inflight marker presence; the `.oc-session-id` match alone will return all historic dirs from this OC session. To detect "currently active" sessions specifically, intersect: `.oc-session-id matches harness OC session ID` AND `inflight marker present` AND `marker mtime < 24h`.

### Optional (not required) oconona-side mitigation

If oconona ever wants to make `.oc-session-id` matching alone disambiguate live vs historic, options would be:
- **Aggressive completed-dir cleanup**: reduce the 30-day session-dir retention to a much shorter window for dirs that have `telemetry.json` (i.e., completed). Currently retention is uniform.
- **Per-invocation unique ID sidecar**: write a `.orchestra-run-id` UUID per `/brain`/`/duo` invocation alongside `.oc-session-id`. Adds contract surface; almost certainly overkill for the cost.

Neither is recommended — the documentation clarification is sufficient. The intersect-with-marker pattern is straightforward to implement on the harness side (as Stage 8.2.1 demonstrates).

