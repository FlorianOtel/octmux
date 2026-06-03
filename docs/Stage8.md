---
title: "Stage 8 — Live cost display (OC SDK) + orchestra inflight badge"
created_at: 2026-05-29--08-27
created_by: Claude Code (Claude Haiku 4.5)
updated_by: Claude Code (Claude Opus 4.7 — Stage 8.2.1 inflight-count fix)
updated_at: 2026-06-03--16-30
context: >
  After Stage 8, octmux's status bar replaces the hardcoded `~$0.00` placeholder
  with a live `Σ$X.XX` cumulative cost (sourced from OC SDK `AssistantMessage.cost`,
  summed over all messages in the session + immediate child sessions), and shows
  a `♪ orchestra -> <title> -> <mode>` badge when an oconona `/brain` or `/duo`
  session is active. Stage 8.2 implements the v7.5 oconona contract: `.oc-session-id`
  sidecar match key, OC HTTP API session resolution, symmetric badge format, per-session
  telemetry.json parser_warnings reader, canonical invocations.log subagent field,
  and session_id filter on both start AND end events for cross-session isolation.
  No new oconona deploy steps required beyond v7.5.
---

## Read first

### Cost source: OC SDK `AssistantMessage.cost` (not telemetry.json)

octmux reads cost directly from the OpenCode HTTP API: `GET /session/{id}/message` returns `AssistantMessage` objects with a `cost` field (float, null if cost not tracked). **No telemetry.json files are read.** Cost is summed event-driven in `refreshTokenUsage()` (lines 181–250 in `src/app.tsx`):

1. Fetch parent session messages via `client.session.messages()`.
2. Loop over all messages; for each `message.info.role === "assistant"`, add `message.info.cost` to total (guard: treat NaN/negative as 0).
3. Fetch child sessions via `client.session.children()`.
4. For each child, fetch its messages and sum costs (one level deep only).
5. Call `setRunningCost(totalCost)`.

**Timing:** Runs on every `session-idle` SSE event (i.e. after each model response completes) and on session switches (cost resets to 0). No polling loop. Displayed as `Σ$X.XX` in the status bar (replaces hardcoded `~$0.00`).

### Badge source: v7.5 contract — .oc-session-id match + OC HTTP API resolution

`src/orchestra-watch.ts` exports `OrchestraWatcher` class (extends EventEmitter). Discovery mechanism:

1. Glob `~/.config/opencode/orchestra/sessions/*/` for session subdirs.
2. For each subdir, read `.oc-session-id` sidecar (UUID, single line). Skip if missing or doesn't match harness's resolved OC session ID.
3. Harness OC session ID resolution: `client.session.list()`, filter `parentID === null && safeRealpath(s.directory) === safeRealpath(process.cwd())` (both sides realpathified), sort `time.updated` desc, take first; cached, re-resolved only on `setOcSessionID(id)` arg change.
4. Skip if inflight marker (`.brain-inflight` or `.duo-inflight`) mtime is older than 24h (stale-after-crash guard).
5. Check for `.duo-inflight` (priority: duo > brain); read marker content for title (duo).
6. For `/brain`: read global `ORCHESTRA_TITLE=` from `~/.config/opencode/orchestra/state.env`.
7. Read per-session `telemetry.json` at `${sessionDir}/telemetry.json` (NOT global); extract `parser_warnings: Array<{code, message}>` (guard: `Array.isArray(...) ? ... : []`).
8. Read `~/.config/opencode/orchestra/invocations.log` for active subagent: reverse-scan for last `start` event without matching later `end` event (filtered by `session_id` matching the matched session-dir basename); canonical field `subagent` (fallback `stage` for back-compat); both start AND end events must be filtered by `session_id` for cross-session isolation.
9. Render in status bar as `♪ orchestra -> <title> -> <mode>` with optional ` -> <subagent>` and optional ` !` (parser warnings), all in color `#d3869b` (no separate yellow indicator).

Badge transitions within ~5 seconds of `/brain` or `/duo` start/stop in the same project.

### Subagent indicator (inline `-> <subagent>`)

The active subagent is rendered inline as `-> <subagent>` in the symmetric badge format: `♪ orchestra -> <title> -> <mode> -> <subagent>`. Same color `#d3869b` throughout — no separate yellow indicator. Detection: reverse-scan `invocations.log` for last `start` event without matching later `end` event; compare `.ts` values lexicographically. Canonical field `subagent` (values: `planner`, `actor`, `actor-heavy`, `reviewer`); `stage` is deprecated back-compat fallback. BOTH start AND end events must be filtered by `session_id` matching the matched session-dir basename for cross-session isolation. Falls through when `session_id` field is absent (pre-v7.5 oconona).

### Oconona v7.5 contract — sidecar files, badge format, telemetry shape

| What octmux reads | Written by | Notes |
|---|---|---|
| OC HTTP API `/session/{id}/message` — `AssistantMessage.cost` | OpenCode runtime | Cost path |
| OC HTTP API `/session/{id}/children` | OpenCode runtime | Cost path |
| OC HTTP API `GET /session` (filter by directory + parentID==null) | OpenCode runtime | Harness session ID resolution |
| `~/.config/opencode/orchestra/sessions/*/.oc-session-id` | oconona setup (v7.5) | Match key |
| `~/.config/opencode/orchestra/sessions/*/[.brain-inflight\|.duo-inflight]` | oconona hooks | Active-session signal |
| `~/.config/opencode/orchestra/state.env` (`ORCHESTRA_TITLE=`) | oconona `/brain` setup | Brain title source |
| `~/.config/opencode/orchestra/invocations.log` (`subagent` field) | oconona hooks (v7.5) | Active subagent; `stage` is back-compat fallback |
| `~/.config/opencode/orchestra/sessions/*/telemetry.json` (`parser_warnings`) | oconona (v7.5) | Completed-segment diagnostics |

### Architecture decision: no separate CostAggregator class

The spec called for a separate `src/cost-aggregator.ts` with a 5-second `setInterval` poll. **This stage deviates.** Reason: `refreshTokenUsage()` already:
- Calls `client.session.messages()` (same endpoint needed for cost).
- Is invoked at the right time: on `session-idle` SSE events + session switches.
- Is the established pattern for live session-state updates in octmux.

Cost doesn't change between turns, so polling is wasteful. Extending `refreshTokenUsage()` is simpler, architecturally consistent, and avoids redundant polling.

### TDZ ordering constraint for effects

The `watcherRef` useEffect is declared BEFORE the SSE effect and BEFORE the session-get effect, ensuring that any effect that references `orchestraBadge` state can safely depend on the watcher being set up and `setOcSessionID()` being callable (per `feedback-react-effect-tdz.md`).

---

## Implementation log

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

The Stage 8.2.1 fix exposes an under-documented invariant of the v7.5 contract that oconona's spec (`oconona/docs/Stage7.5--implementation-details.md`) should make explicit. **No oconona code change is required** — the contract is correct as designed; the gap is documentation.

### The invariant

`.oc-session-id` carries the **parent OC session ID**. That ID is constant for the lifetime of the OC session, so all orchestra session dirs created during the same octmux/OC session share the same `.oc-session-id` value. Sequential `/brain` or `/duo` runs in the same octmux session therefore produce multiple session dirs that ALL pass the `.oc-session-id` match key.

### Implication for harness implementations

The `.oc-session-id` match key alone is **not sufficient** to identify "live" session dirs — it identifies any dir created during this OC session, whether the orchestra run is in-flight or has completed. Harnesses MUST additionally filter by inflight marker presence (`.brain-inflight` / `.duo-inflight`) for live-segment discovery, and by `telemetry.json` presence (and absence of marker) for completed-segment discovery. The §11 harness checklist mentions this in passing (step 3 says "if .brain-inflight or .duo-inflight is present (and mtime < 24h), it's a live segment") but does not call out the multi-invocation-per-OC-session case explicitly. The current octmux Stage 8.2.1 bug originated from this gap.

### Suggested oconona-side action (documentation only)

Add an explicit subsection to `oconona/docs/Stage7.5--implementation-details.md` §Sidecar match key — something along these lines:

> **Note: `.oc-session-id` is shared across orchestra runs within a single OC session.** The match key identifies any session dir created during the harness's current OC session, not specifically the live one. Concurrency counts and live-session detection MUST additionally filter on inflight marker presence; the `.oc-session-id` match alone will return all historic dirs from this OC session. To detect "currently active" sessions specifically, intersect: `.oc-session-id matches harness OC session ID` AND `inflight marker present` AND `marker mtime < 24h`.

### Optional (not required) oconona-side mitigation

If oconona ever wants to make `.oc-session-id` matching alone disambiguate live vs historic, options would be:
- **Aggressive completed-dir cleanup**: reduce the 30-day session-dir retention to a much shorter window for dirs that have `telemetry.json` (i.e., completed). Currently retention is uniform.
- **Per-invocation unique ID sidecar**: write a `.orchestra-run-id` UUID per `/brain`/`/duo` invocation alongside `.oc-session-id`. Adds contract surface; almost certainly overkill for the cost.

Neither is recommended — the documentation clarification is sufficient. The intersect-with-marker pattern is straightforward to implement on the harness side (as Stage 8.2.1 demonstrates).

