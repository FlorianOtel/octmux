---
title: "Stage 8 — Live cost display (OC SDK) + orchestra inflight badge"
created_at: 2026-05-29--08-27
created_by: Claude Code (Claude Haiku 4.5)
updated_by: Claude Code (Claude Opus 4.7 — split implementation details into Stage8--implementation-details.md)
updated_at: 2026-06-03--16-50
context: >
  octmux's status bar shows live `Σ$X.XX` cost (from OC SDK `AssistantMessage.cost`,
  summed over parent session + one-level children) and an orchestra inflight badge
  `♪ orchestra -> <title> -> <mode> [-> <subagent>] [!]` when an oconona `/brain` or
  `/duo` session is active. This file is the changelog + known-limitations + oconona
  feedback. The full consumer-side contract (cost path, badge mechanics, provider→
  consumer reads table, fragility analysis, recommended test matrix) lives in
  `docs/Stage8--implementation-details.md` and mirrors the structure of oconona's
  `docs/Stage7.5--implementation-details.md` (provider spec). The two
  implementation-details docs must stay in sync.
---

## See also

- **`docs/Stage8--implementation-details.md`** — consumer-side contract: what octmux reads, how the watcher works, badge rendering rules, fragility/race analysis, recommended test matrix. Mirrors oconona's `docs/Stage7.5--implementation-details.md` (provider spec).
- **`oconona/docs/Stage7.5--implementation-details.md`** — provider-side contract (authoritative for the sidecar layout, badge format spec, telemetry.json schema).
- **`oconona/docs/Stage7.md`** — oconona roadmap (v7.5 is the contract version this consumer reads).

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

