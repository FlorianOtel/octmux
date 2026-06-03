---
title: "Stage 8 — octmux consumer-side contract: cost path, badge mechanics, fragility analysis"
created_at: 2026-06-03--16-50
created_by: Claude Code (Claude Opus 4.7 1M context)
updated_by: Claude Code (Claude Haiku 4.5 — Actor via /brain)
updated_at: 2026-06-03--23-28
context: >
  Consumer-side implementation reference for the cost display + orchestra badge in octmux.
  Mirrors the structure of oconona's docs/Stage7.5--implementation-details.md (the provider
  spec): the two docs describe the same provider↔consumer contract from opposite ends.
  Self-contained for a future octmux refactor that needs to revise the OrchestraWatcher
  or rendering paths against changes in oconona's v7.5+ contract. Includes a dedicated
  fragility/race analysis covering interrupted sessions, double-counting, session tracking
  consistency, and other edge cases discovered during Stage 8.0–8.2.1 development.
  Companion to docs/Stage8.md (which retains the changelog + cross-pointer).
---

# Stage 8 — octmux consumer-side contract: cost path, badge mechanics, fragility analysis

## Status and scope

This document is the **authoritative consumer-side reference** for octmux's integration with the oconona orchestra. It is the symmetric counterpart to `oconona/docs/Stage7.5--implementation-details.md` (the provider spec): same contract, opposite end. Where oconona documents what it *writes*, this doc documents what octmux *reads*, *renders*, and *infers*. The contract surface is identical; the two docs must stay in sync.

The cost display (`Σ$`) and orchestra badge (`♪ orchestra -> …`) shipped in stages 8.0, 8.1, 8.2, and 8.2.1. See `docs/Stage8.md` for the implementation changelog.

The following are **out of scope** for this document:
- `/brain` / `/duo` skill internals — owned by oconona.
- OC daemon behaviour (HTTP API, SQLite schema) — upstream OpenCode.
- Cost attribution mechanics, hybrid attribution, segment-delta computation — owned by oconona's telemetry-summarize.py.

---

## Cost source — `refreshTokenUsage()`

### What octmux reads

| Endpoint | Purpose |
|---|---|
| `client.session.messages({ path: { id } })` | Sum `info.cost` for every `info.role === "assistant"` message in the parent session |
| `client.session.children({ path: { id } })` | Enumerate immediate child sessions (one level deep) |
| For each child: `client.session.messages({ path: { id: child.id } })` | Sum child assistant costs |
| `getContextWindow(client, providerID, modelID)` | Per-message context-window lookup for the bar fill |

**No `telemetry.json` files are read for cost.** The live SSE path is the authoritative source for the in-status-bar `Σ$X.XX`. `telemetry.json` is read only for completed-segment diagnostics (parser warnings).

### When it fires

- On every `session-idle` SSE event (after each model response completes).
- On every `message.part.updated` SSE event for `text|reasoning` parts (Stage 4.5.7: per-message refresh).
- On session switch (cost resets to 0 first, then refreshes).
- On manual operator resync (Stage 4.5.3 reconciler).

### File:line reference

`src/app.tsx:411–482` — `refreshTokenUsage(sid)` callback.

### Properties

- **Cumulative within OC session.** Does not reset between `/brain` / `/duo` invocations in the same octmux session. Resets on octmux restart (fresh process) and on session switch.
- **One level deep.** Subagents of subagents (grandchildren) are not counted. Multi-level orchestrations under-report.
- **NaN/negative guard.** `cost && !isNaN(cost) && cost >= 0` — defensive against malformed values from OC.
- **Silent on failure.** Network errors / missing endpoint → cost stays at last known value.

---

## Badge source — `OrchestraWatcher` (`.oc-session-id` match + OC HTTP API resolution)

### Discovery recipe (matches oconona §Sidecar match key recipe)

1. Resolve harness OC session ID via `client.session.list()`:
   - Filter `parentID === null && safeRealpath(s.directory) === safeRealpath(process.cwd())`.
   - Sort by `time.updated` descending; take first.
   - Cache the result; re-resolve only when `setOcSessionID(id)` is called with a different ID.
2. Glob `~/.config/opencode/orchestra/sessions/*/` for session subdirs.
3. For each subdir:
   - Read `.oc-session-id` sidecar (UUID, single line). Skip if missing/empty or doesn't match the resolved harness session ID.
   - 24h mtime stale guard on the inflight marker file (not the directory).
4. Determine mode from marker filename:
   - `.duo-inflight` → mode `duo`, title from marker content (first 30 chars).
   - `.brain-inflight` → mode `brain`, title from global `ORCHESTRA_TITLE=` in `~/.config/opencode/orchestra/state.env`.
5. Read per-session `telemetry.json` at `${sessionDir}/telemetry.json`:
   - Extract `parser_warnings: Array<{code, message}>`. Guard: `Array.isArray(...) ? ... : []`.
   - Present only for completed segments; absent during live session.
6. Among matched dirs, pick the one with the most recent inflight marker mtime. Priority: `duo > brain`.
7. Count only **inflight-bearing matched dirs** toward `matchedSessionCount` (Stage 8.2.1 fix). If `>1`, render `#N` instead of title (multi-concurrent case).

### Polling and event sources

- `fs.watch(sessionsDir, { recursive: false })` — primary event source.
- `setInterval(scan, 5000)` — fallback for missed events (NFS attribute cache lag, OS-specific watch quirks).
- `setOcSessionID(id)` — explicit re-scan trigger on session ID change.

### Two-phase async resolution

`scan()` is called from `fs.watch` callbacks (sync context) and from the 5s `setInterval`. `resolveHarnessSessionID()` is async (HTTP). The watcher resolves this via two-phase:

1. **Sync return path:** if `harnessOcSessionID` is cached, scan proceeds synchronously and emits a badge update.
2. **Background path:** if `harnessOcSessionID === null && lastSessionIDInput !== null`, scan emits a null badge and returns. The async resolve scheduled by `setOcSessionID()` will populate the cache and trigger a re-scan when it completes.

This prevents `fs.watch` callbacks from blocking on an HTTP roundtrip while preserving the eventual badge appearance.

### File:line reference

`src/orchestra-watch.ts:16–326` — `OrchestraWatcher` class.

---

## Subagent role detection (SSE SubtaskPart)

### What octmux reads

Live subagent detection operates via OpenCode SSE `message.part.updated` events for `part.type === "subtask"`. The SubtaskPart carries these fields:
- `id: string` — unique part ID
- `sessionID: string` — OC session ID of the subagent session
- `agent: string` — subagent role (planner, actor, actor-heavy, reviewer)
- `description?: string` — optional description
- `messageID: string`, `prompt: string` — other fields not used by octmux

### Detection mechanism

1. **Event stream:** `src/events.ts:filterEvent` processes `message.part.updated` events; if `part.type === "subtask"` and `part.sessionID === sessionID` (matches current harness OC session), emit `{ kind: "subagent-detected", partID, agent, description }`.
2. **State tracking:** `detectedSubtaskPartIDs: Set<string>` in `src/events.ts` tracks active partIDs. Deduplicates repeated updates for the same part (only first detection emits event).
3. **Lifecycle end:** On `message.part.removed` for a subtask part, emit `{ kind: "subagent-ended", partID }` and remove from set. On `session.idle`, flush all remaining detected parts via `subagent-ended` events.
4. **Watcher notification:** `src/app.tsx` applies these events to `OrchestraWatcher` via `notifySubtaskStarted(partID, agent, description)`, `notifySubtaskEnded(partID)`, and `notifyAllSubtasksEnded()`.

### Model labels

Agent names (planner, actor, etc.) are resolved to friendly model labels via:
1. **Agent frontmatter lookup** (`~/.config/opencode/agents/*.md`): extract `name:` and `model:` YAML fields (e.g., `model: sohoai/qwen3-coder-next`).
2. **opencode.json mapping** (`~/.config/opencode/opencode.json`): `provider.<P>.models.<M>.name` structure maps provider/modelID to a friendly name (e.g., "Qwen3 Coder Next").
3. **Fallback:** if friendly name missing, use the model ID tail (after last `/`).
4. **Label format:** `[provider/friendly_name]` (brackets and provider prefix always shown; fallback `[provider/modelID]`).

Both maps are loaded once in `OrchestraWatcher.start()` and remain constant for the watcher lifetime. Stale during live orchestration if oconona updates agents; octmux restart needed to refresh.

### OrchestraBadge shape

The badge carries:
- `parentModelRaw?: string` — parent harness model as `provider/modelId`
- `parentModelLabel?: string` — formatted parent label
- `subagents: Array<{ partID, agent, description?, modelRaw?, modelLabel? }>` — current live subagents (max 5 shown; overflow indicated by `+N more` row)

### File:line reference

- `src/events.ts` — SubtaskPart event filtering and `detectedSubtaskPartIDs` state
- `src/orchestra-watch.ts:105–127` — `notifySubtaskStarted()`, `notifySubtaskEnded()`, `notifyAllSubtasksEnded()` public API; `loadAgentModels()`, `loadModelFriendlyNames()`, `formatModelLabel()` private helpers
- `src/app.tsx:505–530` — wiring (subagent-detected, subagent-ended, session-idle branches)

---

## Per-session `telemetry.json` reader

### What octmux reads

`${sessionDir}/telemetry.json` (per-session, NOT a global file). The schema is owned by oconona (see `oconona/docs/Stage7.5--implementation-details.md` §telemetry.json shape post-v7.5). octmux reads ONLY:

- `parser_warnings: Array<{code: string; message: string}>` — surfaced as a ` !` indicator after the badge.

octmux does NOT read `parent_delta`, `parent_total`, `parent_snapshot_*`, `started_at_oc_ms`, `ended_at_oc_ms`, `subagents`, `totals`, `cost_usd_estimate`, or any other v7.5 field for live state. Those fields exist for reporting and forensics (oconona's `session-report.py` consumes them).

### When read

Inside the per-session scan loop, before the marker checks — so each matched directory's telemetry is read on every scan tick. Read is synchronous, ungrded for size (telemetry.json is small, < 4 KB typically).

### Guards

- `fs.existsSync` before read (live segments have no telemetry.json yet).
- `JSON.parse` in try/catch; malformed → skipped.
- `Array.isArray(data.parser_warnings)` before assignment (pre-v7.5 telemetry.json files lacked this field).

### File:line reference

`src/orchestra-watch.ts:237–249` — telemetry read block inside `scan()`.

---

## Badge rendering spec

The badge renders as a downward-growing stack of rows (flex column) when an orchestra session is active.

### Main status row (always present)

Inline segment in the main status line: `♪ orchestra -> <title>` plus ` !` suffix if `parser_warnings.length > 0`. The mode and subagent status are no longer inline; they appear as separate rows below (see next sections).

### Mode row (only when `orchestraBadge !== null`)

Rendered below main status row via IIFE:
- **Waiting** (subagents detected): `○ {mode} {parentModelLabel}` (● circle is dim/grey)
- **Idle** (no subagents): `● {mode} {parentModelLabel}` (● circle is bright green)

Color: purple `#d3869b` for text; `#b8bb26` (bright green) for `●` when idle, dim when waiting.

### Subagent rows

For each detected subagent (max 5 rows shown):
- `● {agent} {modelLabel} {description_truncated}`

Color: purple `#d3869b` for text; bright green `#b8bb26` for `●`.

If `subagents.length > 5`, add overflow row:
- `+{N} more` in dim purple

### Idle state

When `orchestraBadge === null`, no mode/subagent/overflow rows render. Layout functionally identical to pre-Stage-8.1.1 (only main status row visible).

### File:line reference

`src/components/StatusLine.tsx:80–150` — downward-stack layout with mode row, subagent rows, overflow counter.

---

## What octmux reads (provider→consumer table)

Symmetric to oconona §What each consumer reads — this is the consumer-side view of the same contract surface.

| What | Path | Written by | Used for |
|---|---|---|---|
| `AssistantMessage.cost` | OC HTTP `GET /session/{id}/message` | OpenCode runtime | Σ$ cost |
| Child sessions | OC HTTP `GET /session/{id}/children` | OpenCode runtime | Σ$ cost (one level) |
| Session list | OC HTTP `GET /session` (filtered by directory + parentID==null) | OpenCode runtime | Harness OC session ID resolution |
| `.oc-session-id` | `~/.config/opencode/orchestra/sessions/*/` | oconona setup (v7.5) | Match key — filters which session dirs belong to this OC session |
| `.brain-inflight` / `.duo-inflight` | `~/.config/opencode/orchestra/sessions/*/` | oconona setup + cleanup | Active-session signal — primary discovery, mode source, 24h stale guard |
| `state.env` `ORCHESTRA_TITLE=` | `~/.config/opencode/orchestra/state.env` | oconona `/brain` setup | Brain title source (global; NOT per-session) |
| `SubtaskPart` SSE events | OC HTTP SSE `/message` | OpenCode (oconona creates subtask parts) | Live subagent detection (part.type === "subtask") |
| Agent frontmatter | `~/.config/opencode/agents/*.md` | oconona setup | Subagent role → model mapping (name + model YAML fields) |
| `opencode.json` model names | `~/.config/opencode/opencode.json` | oconona setup | Provider/modelId → friendly name mapping |
| `telemetry.json` `parser_warnings` | `${sessionDir}/telemetry.json` | oconona telemetry-summarize.py (v7.5) | Completed-segment diagnostics — surfaces ` !` indicator |

---

## App.tsx wiring pattern

### Refs and effects

```tsx
// Declared at line 91, alongside other refs (before any useEffect that uses it)
const watcherRef = useRef<InstanceType<typeof OrchestraWatcher> | null>(null);

// Watcher mount — empty deps; singleton; client is module-level stable
useEffect(() => {
  const watcher = new OrchestraWatcher(props.client);
  watcherRef.current = watcher;
  watcher.on("changed", setOrchestraBadge);
  watcher.start();
  watcher.setOcSessionID(sessionID);  // seed initial ID
  return () => {
    watcher.dispose();
    watcherRef.current = null;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// Re-resolve when session ID changes
useEffect(() => {
  watcherRef.current?.setOcSessionID(sessionID);
}, [sessionID]);
```

### TDZ ordering constraint

The `watcherRef` and watcher useEffect MUST be declared **before** any useEffect that references `orchestraBadge` state. `useRef` initializes synchronously so the ref is not subject to TDZ on its own, but reads of `orchestraBadge` in later effects would trip TDZ if mounted in the wrong order. See `feedback-react-effect-tdz.md` for the historical bug pattern.

### `safeRealpath()` helper

```typescript
private safeRealpath(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return dir; }
}
```

Applied to both sides of the `directory === process.cwd()` comparison during OC session resolution. Required because OC may store symlink paths or realpaths depending on how the session was created. Bun's `process.cwd()` always returns realpath (getcwd syscall).

---

## Architecture decisions

### No separate `CostAggregator` class

The original Stage 8 spec called for a `src/cost-aggregator.ts` with a 5s `setInterval` poll. Stage 8.0 deviates: cost is summed inside `refreshTokenUsage()` (which already runs on the right SSE events). No polling for cost — only the watcher polls (5s fallback for missed fs events).

### No reading of `telemetry.json` for live cost

The v7.5 contract is explicit: telemetry.json is written at cleanup, not tick-time. During a live session it doesn't exist or reflects the previous run. octmux uses SSE for live cost; telemetry.json is read only for completed-segment `parser_warnings`.

### Symmetry with standalone-OC behaviour

oconona's `status-line/orchestra-block.sh` reads live cost from OC SQLite (different access path, same underlying data). octmux reads via the SDK / HTTP API. Both report the same `cost` field from the same `session` table; the values agree.

---

## Known fragility and race conditions

The matrix below enumerates the failure modes discovered during Stage 8.0–8.2.1 development and analysis. Severity: **high** = visible operator impact + no current mitigation; **med** = visible impact but has a mitigation; **low** = cosmetic or edge-case.

### 1. Stale inflight markers (interrupted sessions)

| # | Scenario | Behaviour | Mitigation | Severity |
|---|---|---|---|---|
| A1 | Operator Ctrl-C during `/brain`; cleanup block runs cleanly | Marker removed; telemetry.json written; badge clears within 5s | Cleanup is part of `/brain` skill; reliable | low |
| A2 | oconona process killed mid-pipeline (SIGKILL, OOM, daemon crash) | Marker stays on disk | (a) Stop-hook orphan finalizer on next OC Stop event writes `.outcome=abandoned`, runs summarise, removes marker. (b) octmux's 24h mtime guard hides badge after 24h. (c) oconona's 30-day reaper deletes the dir eventually | med |
| A3 | octmux closed while `/brain` is live | Marker stays live in oconona; new octmux launch re-scans + shows badge correctly | None needed — design works | low |
| A4 | OC daemon killed mid-`/brain` | Marker stays. SSE drops on octmux side. Pipeline can't run cleanup. Recovery requires daemon back + Stop event to fire orphan-finalizer | Daemon restart kicks Stop-hook on first turn; octmux's 24h guard hides badge meanwhile | med |
| A5 | OC daemon restart, octmux survives | SSE reconnects (reconciler). `harnessOcSessionID` cached from pre-restart is now stale; new OC sessions don't match. Badge disappears (correct outcome). On next sessionID change, `setOcSessionID()` re-resolves | Implicit via session change detection. Edge: if octmux reattaches to a session with the same UUID (unusual), no re-resolve fires | low |
| A6 | System reboot during `/brain` | Marker on disk from pre-reboot oconona instance. 24h guard handles mtime > 24h. Below 24h: Stop-hook orphan-finalizer cleans on first Stop of new OC session | Recovery path exists | med |
| A7 | `/brain` legitimately runs > 24h | Marker mtime hits 24h threshold; octmux hides badge; operator may think pipeline ended | None. Stage 8.0 baked in the 24h cap. Real-world `/brain` runs are << 24h; not a practical concern | low |

### 2. Double-counting / undercounting

| # | Scenario | Behaviour | Mitigation | Severity |
|---|---|---|---|---|
| B1 | Multi-level orchestrations (subagent dispatches a subagent) | `client.session.children()` returns only one level deep; grandchildren costs undercounted in `Σ$` | None. Documented limitation. Acceptable for current `/brain` topology (Planner → Actor → Reviewer; no nesting) | med |
| B2 | Σ$ accumulates across multiple orchestra runs in the same octmux session | By design — operator sees session-lifetime total; resets on session switch or octmux restart | Not a bug | n/a |
| B3 | `matchedSessionCount` includes completed dirs (pre Stage 8.2.1) → badge mislabeled as `#N` after first `/brain` completes | **FIXED in Stage 8.2.1** (commit `e28973e`): count gated on `dirHasInflight` | Shipped | resolved |
| B4 | parser_warnings only attached to the *picked* `bestBadge` dir; warnings from other matched (non-picked) completed dirs are dropped | Operator sees ` !` only if the most-recent live dir's telemetry has warnings | Acceptable — operator's attention should be on the live session | low |
| B5 | Cost numerator mismatch: octmux Σ$ = live SSE cumulative-within-OC-session; oconona telemetry.json = per-segment delta written at cleanup | Different denominators. Operator may confuse the two. Documented in Cost source above | Documentation only | low |
| B6 | OC's `cost` field reports cost=0 for SoHoAI flat-rate sessions | Σ$ shows $0.00, which is correct per oconona's "trust OC's cost unconditionally" invariant | Documented as expected behaviour | n/a |

### 3. Session tracking consistency

| # | Scenario | Behaviour | Mitigation | Severity |
|---|---|---|---|---|
| C1 | SSE drops mid-session | `refreshTokenUsage` doesn't fire; Σ$ stays at last value; badge polling continues via 5s interval | Stage 4.5.3 reconciler reconnects + re-fetches on resume | low |
| C2 | NFS attribute cache lag (`fs.watch` misses events) | Badge update delayed up to 5s | 5s `setInterval` is the safety net | low |
| C3 | Bun `process.cwd()` realpath vs oconona's bash `$PWD` (logical) divergence under symlinks | OC HTTP API `directory` filter may not match | `safeRealpath()` applied to both sides of the comparison; oconona also uses `realpath` in setup curl. Stage 4.5.5 directory-header fix addressed the related class of bugs | low (now) |
| C5 | `setOcSessionID()` cache: same input → no re-resolve. If OC session was destroyed + recreated with the same UUID (unusual), cache is stale | Edge case unlikely in practice; OC session IDs are time-encoded UUIDs | None; would require manual `dispose()` + reinstantiate | low |
| C6 | `ORCHESTRA_TITLE=` in `state.env` is global. Two concurrent `/brain` sessions in different projects on the same host would clobber the title | Operator sees the most-recently-set title for either project. Octmux's `.oc-session-id` filter prevents the wrong dir from being shown, but the title field on the right dir may be wrong | None on octmux side. Oconona could move ORCHESTRA_TITLE to per-session (currently global). Practical risk: low — most operators run one orchestra at a time | low |

### 4. Other fragility

| # | Scenario | Behaviour | Mitigation | Severity |
|---|---|---|---|---|
| D1 | OC daemon down at octmux startup | `client.session.list()` throws → `harnessOcSessionID` stays null → badge never appears. Silent | octmux already fails on daemon-down in other paths (SSE, session.create); not a new failure mode. Could add an explicit operator-visible warning | low |
| D2 | **Spec contradiction in oconona** about telemetry vs marker write order: `Stage7.md` invariant 4 says "telemetry.json written BEFORE marker removed"; `Stage7.5--implementation-details.md` invariant 6 says "marker removed BEFORE telemetry-summarize.sh invoked". The actual /brain skill follows Stage7.md ordering (telemetry first, marker after) | If the docs are inconsistent, future implementations might pick the wrong order. The Stage7.5 ordering would create a brief no-marker-no-telemetry window. octmux is robust either way (no-marker = no badge, no-telemetry = no warning indicator) | **Needs clarification on oconona side**: pick one invariant and align both docs. See `Notes for oconona` in `docs/Stage8.md` for the next round of feedback | med |
| D3 | Oconona's `telemetry-summarize.py` crashes after writing `.outcome` but before writing `telemetry.json` | Dir has `.outcome` + no telemetry + no (or stale) marker. Stop-hook orphan finalizer's "candidate condition" (per oconona Stage7.md §Cleanup machinery) catches this on next OC Stop event | Stop-hook orphan finalizer is the safety net | low |
| D4 | Many accumulated session dirs (30-day retention × multiple/day) | Each 5s scan does fs.existsSync + fs.statSync + fs.readFileSync per dir matching `.oc-session-id`. 100+ syscalls per 5s in extreme cases | Not a perf killer at 5s cadence. Operator can manually `rm -rf` old dirs if motivated, or reduce `housekeeping.session_retention_days` in `~/.config/opencode/orchestra/oconona-config.yaml` | low |
| D5 | `OrchestraWatcher.dispose()` doesn't cancel in-flight `resolveHarnessSessionID()` promise | If the component unmounts mid-resolve, the `.then()` callback fires on a disposed watcher. `scan()` no-ops (no listeners). Technically a memory leak (closure retains client + the watcher itself until promise resolves) but bounded by the HTTP call timeout | Use AbortController if this ever becomes a real concern | low |
| D6 | Σ$ flash on session switch | `setRunningCost(0)` fires first; then async `refreshTokenUsage` populates the real value. Brief `$0.00` → `$X.XX` transition | Cosmetic only | low |
| D7 | `client.session.list()` returns sessions sorted by `time.updated`. Two sessions tied to the millisecond | Stable JS sort; tie-break is insertion order. Practically deterministic per response; edge case if multiple sessions edit simultaneously | None needed | low |
| D8 | `OrchestraWatcher` constructor + `start()` is called once. If the OC `client` instance is somehow swapped out, the watcher holds the old reference forever | `props.client` is constructed once in `src/index.tsx` and never reassigned; watcher useEffect has `[]` deps. Stable by design | n/a | n/a |
| D9 | `parser_warnings` `!` indicator persists across sessions if the last completed segment had warnings, even after a new clean segment | The badge only shows during a live session anyway; once the new live session finishes cleanly, its telemetry overwrites the warning state | Self-clearing on next clean segment | low |
| D10 | Octmux's `Σ$` shows total within OC session; the operator may have switched between sessions and the Σ$ shows the *current* session's cumulative cost only | `setRunningCost(0)` on session switch is intentional. Operator who wants cross-session totals should use oconona's `session-report.py` | Documented in `docs/Stage8.md` Known limitations | low |

### Recommended testing matrix

When validating Stage 8 changes (refactors, OC version bumps, oconona contract changes), exercise at minimum:

1. **Clean `/duo` lifecycle**: start → subagent dispatch → cleanup. Badge appears + transitions + disappears.
2. **Clean `/brain` lifecycle**: start → planner → actor → reviewer → cleanup. Badge transitions through all roles.
3. **`/brain-abandon` mid-pipeline**: badge clears within 5s; no stale marker.
4. **Two sequential `/brain` runs in one octmux session**: title is correct on each (not `#2`). This is the Stage 8.2.1 regression test.
5. **OC daemon kill mid-`/brain`**: SSE drops; badge stays for ≤24h or until next Stop event clears it.
6. **Σ$ continuity**: cost updates on every assistant response; matches OC SQLite (`SELECT cost FROM session WHERE id=…`) within OC's float precision.
7. **Symlinked invocation**: launch octmux from `~/Gin-AI/projects/octmux` (symlink) while OC stores `/mnt/nfs/Florian/Gin-AI/projects/octmux` (realpath); badge still appears.
8. **Parser warning surface**: induce a `parser_warnings`-emitting telemetry (e.g., delete `.parent-snapshot-start` mid-session); `!` appears on next scan after cleanup.
9. **Stop octmux + restart while `/brain` is live**: badge re-appears within 5s of restart.

The matrix above is also the foundation for any future E2E test recipe. Items 1–4 are mandatory regression tests; 5–9 are diagnostic / robustness checks.

---

## Cross-references

- **Provider spec:** `oconona/docs/Stage7.5--implementation-details.md` — the symmetric counterpart written from the provider's side. The two documents must stay in sync.
- **oconona roadmap:** `oconona/docs/Stage7.md` (v7.5 is the contract version this consumer reads).
- **octmux changelog:** `docs/Stage8.md` — implementation log + known limitations + feedback to oconona.
- **Auto-memory:** `feedback-orchestra-v75-contract.md` (in user's auto-memory) — quick reference for the v7.5 contract.
- **Related code:** `src/orchestra-watch.ts`, `src/components/StatusLine.tsx`, `src/app.tsx` (watcherRef + useEffects).
- **Related feedback memories:** `feedback-react-effect-tdz.md` (TDZ ordering), `feedback-oc-directory-header.md` (`x-opencode-directory` header).
