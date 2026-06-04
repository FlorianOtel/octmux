---
title: "Stage 8 — Live cost display (OC SDK) + orchestra inflight badge"
created_at: 2026-05-29--08-27
created_by: Claude Code (Claude Haiku 4.5)
updated_by: Claude Code (Claude Opus 4.7 — 1M context)
updated_at: 2026-06-04--17-20
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

### 2026-06-03--23-28 — Stage 8.1.1 — SSE subagent detection + downward-stacked role rows + model labels
**Implemented by:** Actor (Claude Haiku 4.5 via /brain) — 2026-06-03--23-28
**Commit(s):** `7256de8`

Replaced invocations.log-based subagent detection (which never fires on OC) with live SSE SubtaskPart event detection via `message.part.updated` where `part.type === "subtask"`. Redesigned OrchestraBadge from single-field `subagent?` to widened type carrying parent model labels and an array of live subagents, each with agent role, description, and model info. Redesigned StatusLine rendering from single inline badge to downward-growing stack: main status row, optional mode row (●/○ based on subagent liveness with parent model label), per-subagent rows (max 5 visible with overflow counter), all in correct colors. Model labels (agent.name, agent.model → provider/modelId → friendly name) sourced from agent frontmatter YAML and opencode.json, read once at watcher startup. Supersedes Stage 8.1. Full implementation details at `docs/Stage8--implementation-details.md` §Subagent role detection.

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

