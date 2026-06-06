---
title: "Stage 8 — octmux consumer-side contract: cost path, badge mechanics, fragility analysis"
created_at: 2026-06-03--16-50
created_by: Claude Code (Claude Opus 4.7 1M context)
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-06-05--23-30
context: >
  Consumer-side implementation reference for the cost display + orchestra badge in octmux.
   Mirrors the structure of oconona's docs/oconona--provider-contract-details.md (the provider
  spec): the two docs describe the same provider↔consumer contract from opposite ends.
  Self-contained for a future octmux refactor that needs to revise the OrchestraWatcher
  or rendering paths against changes in oconona's v7.5+ contract. Includes a dedicated
  fragility/race analysis covering interrupted sessions, double-counting, session tracking
  consistency, and other edge cases discovered during Stage 8.0–8.2.1 development.
  Companion to docs/Stage8.md (which retains the changelog + cross-pointer).
  Updated 2026-06-05 to acknowledge oconona v8.2.0 additions (researcher / researcher-deep tiers, researcher_dispatches telemetry field). All v8.2.0 additions are ADDITIVE and require no octmux source change; this doc records the documentary alignment.
---

# Stage 8 — octmux consumer-side contract: cost path, badge mechanics, fragility analysis

## Status and scope

This document is the **authoritative consumer-side reference** for octmux's integration with the oconona orchestra. It is the symmetric counterpart to `oconona/docs/oconona--provider-contract-details.md` (the provider spec): same contract, opposite end. Where oconona documents what it *writes*, this doc documents what octmux *reads*, *renders*, and *infers*. The contract surface is identical; the two docs must stay in sync.

The cost display (`Σ$`) and orchestra badge (now `♪ orchestra full/light - <title>`; pre-v8.1.5: `♪ orchestra -> …`; v8.1.6: title embedded in inflight file content, rendered passthrough as `♪ ${orchestraBadge.title}`) shipped in stages 8.0, 8.1, 8.2, and 8.2.1. See `docs/Stage8.md` for the implementation changelog.

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
4. Determine badge text from marker filename (v8.1.6: both read from inflight file content):
   - `.duo-inflight` → title from marker content (first 48 chars). Example: `orchestra light - <title>`.
   - `.brain-inflight` → title from marker content (first 48 chars). Example: `orchestra full - <title>`. Fallback if file is empty: `orchestra full - brain`.
   - `state.env` (`ORCHESTRA_TITLE=`) is **no longer read** (deprecated v8.1.6; was brain-only).
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

## Subagent role detection (`session.created` filter + Task-tool lifecycle)

### What octmux reads

Live subagent detection operates on the OpenCode **global event stream** (`client.global.event({})`, opened once at `src/index.tsx:257`), filtering `session.created` events whose payload `info.parentID` matches the harness OC session ID. The child Session payload carries:
- `info.id: string` — child OC session ID; the lifecycle key used throughout octmux.
- `info.parentID: string` — harness session ID; equality with `sessionID` is the filter predicate.
- `info.agent: string` — dispatched subagent role (e.g. `planner`, `actor`, `actor-heavy`, `reviewer`, `researcher`, `researcher-deep`).
- `info.model: { providerID: string; id: string; variant?: string }` — resolved model; rendered as `${providerID}/${id}`.

`info.agent` and `info.model` are populated by the locally-built OC daemon since the upstream Stage 8.1.3 fix (FlorianOtel/opencode@98a4907c9). The published SDK `Session` type lags behind these additions; octmux accesses them through a typed `as unknown as { ... }` cast at the `session.created` branch.

### Detection mechanism

1. **`session.created` (row appears).** `src/events.ts:filterEvent` matches `event.type === "session.created"` AND `info.parentID === sessionID` AND `!trackedChildSessions.has(info.id)`. Adds `info.id` to module-level `trackedChildSessions: Set<string>`. Emits `{ kind: "subagent-detected", sessionID: info.id, agent: info.agent ?? "", model: "${providerID}/${id}" | "" }`. The watcher's `notifySubagentStarted(sessionID, agent, model, description?)` pushes a fresh `{sessionID, agent, model, description?, lastActivityAt: Date.now()}` into `this.badge.subagents[]`.

2. **Task-tool tracking (lifecycle end signal).** The row's protocol-precise end signal is the brain's Task tool transitioning to `state.status === "completed"` or `"error"` — NOT the child's `session.idle` (which OC fires on every turn pause within a subagent's life). Three module-level structures in `events.ts` implement the pairing:
   - `openTaskPartIDs: Set<string>` — Task-tool partIDs first observed in `pending`/`running` state, awaiting pair. JS `Set`s iterate in insertion order.
   - `unpairedChildren: Set<string>` — child session IDs that arrived via `session.created` before any pending Task part (could not be paired at detection time). JS `Set`s maintain insertion order for FIFO pairing.
   - `taskToChild: Map<string, string>` — paired Task-tool partID → child sessionID.
   - `tryPair(): void` — helper function that FIFO-drains both `unpairedChildren` and `openTaskPartIDs` in lock-step, pairing oldest-pending-part with oldest-unpaired-child. Called from both `session.created` (when a child arrives) and `message.part.updated(pending)` (when a part arrives). Ensures symmetric pairing regardless of event order.

   Flow inside the existing `message.part.updated` `part.type === "tool"` branch (gated by `toolPart.tool === "task"` — the daemon's registered tool name, verified at `~/Gin-AI/projects/opencode/packages/opencode/src/tool/task.ts:24`):
   - State first seen as `pending`: `openTaskPartIDs.add(toolPart.id)`, then call `tryPair()` to pair with any waiting unpairedChildren.
   - On `session.created` for a child of the harness: add `info.id` to `unpairedChildren`, then call `tryPair()` to pair with any waiting openTaskPartIDs. The pairing is symmetric: whichever event arrives second (`pending` or `session.created`), `tryPair()` will match them if both conditions are met.
   - State transitions to `completed` (or `error`): if `taskToChild.has(toolPart.id)`, the paired `childID` is removed from `trackedChildSessions`, the entry is deleted from `taskToChild`, and `{ kind: "subagent-ended", sessionID: childID }` is appended to the tool-result/error event array. A task that ends before a `session.created` pairs with it (no child created) just cleans up `openTaskPartIDs`.

3. **Per-row activity (spinner-vs-frozen).** A `session.updated` event for a tracked child ID emits `{ kind: "subagent-activity", sessionID, ts: Date.now() }`. The watcher's `notifySubagentActivity(sessionID, ts)` bumps the matching row's `lastActivityAt` (see §Activity indicator).

4. **Child `session.idle` is NOT an end signal.** OC fires `session.idle` on every turn pause within a subagent's life. The tracked-child branch in the `session.idle` handler returns `null` deliberately — row removal is owned by the Task-tool tracking above. The Stage 8.1.4 spinner-freeze threshold (120 s of inactivity) provides the inactivity-recent visual cue meanwhile.

5. **`session.deleted` is a fallback end signal.** Rarely fires under normal /brain flow but serves as a safety net for explicit session deletion: tracked-child match emits `subagent-ended` and cleans `trackedChildSessions` + `taskToChild`.

6. **Watcher notification routing.** `src/app.tsx` routes ReplEvents: `subagent-detected → notifySubagentStarted`; `subagent-ended → notifySubagentEnded`; `subagent-activity → notifySubagentActivity`.

### Render-side invariants in `orchestra-watch.ts`

**`scan()` preserves existing subagents across re-runs.** The `bestBadge` literals in both brain and duo branches build with `subagents: this.badge?.subagents ?? []` rather than `[]`. `scan()` runs every 5 s (fallback poll) and on every `fs.watch` fire (oconona writing/touching files in the orchestra-sessions directory). Without preservation, `_updateBadge`'s `JSON.stringify` diff would see the fresh-empty-array vs the previously-mutated one, replace `this.badge` with the empty version, and silently destroy any subagent rows that `notifySubagentStarted` had just pushed.

**Every emit produces a new top-level reference.** Five `notify*` methods and the `_updateBadge` drain path execute `this.badge = {...this.badge}` (or `newBadge = {...newBadge}`) immediately before `this.emit("changed", ...)`. The wiring at `src/app.tsx:336` is `watcher.on("changed", setOrchestraBadge)`; React's `setOrchestraBadge` does `Object.is(newValue, currentState)` and bails out of re-rendering when they match. In-place mutation of `badge.subagents` does not change the badge's top-level reference, so without the shallow clone the push/filter/lastActivityAt-bump becomes visible only at the next unrelated re-render (the 250 ms `spinnerFrame` tick). The clone makes each emit immediately observable to React. The `subagents` array reference is shared between the clone and the previous badge (the mutation has already been applied), so `StatusLine` reads the latest state.

**Queue-and-drain for race safety.** When a `session.created` event arrives before the directory-scan-driven badge construction has produced a non-null badge, `notifySubagentStarted` buffers the call in `_pendingSubagentQueue: Array<{sessionID, agent, model, description?}>` and returns. The next non-null `_updateBadge(newBadge)` drains the queue into `newBadge.subagents[]` (deduping by `sessionID`) before emitting `"changed"`. Stage 8.2.1 `matchedSessionCount` invariant unchanged.

### Subagent row payload

Each entry in `OrchestraBadge.subagents[]`:
- `sessionID: string` — child OC session ID (identity, lifecycle, activity key)
- `agent: string` — dispatched role name (`planner`, `actor`, `actor-heavy`, `reviewer`, `researcher`, `researcher-deep`)
- `model: string` — `${providerID}/${id}` (empty string when the daemon omitted `info.model`)
- `description?: string` — reserved; currently always undefined (`session.created` carries no description)
- `lastActivityAt: number` — ms timestamp; bumped by `notifySubagentActivity`

### Parent (harness) row model label

`OrchestraBadge.parentModelRaw` / `parentModelLabel` are populated from `harnessOcSessionModel`, resolved by `resolveHarnessSessionID()` via the OC HTTP API (`GET /session`). The friendly-name lookup uses `~/.config/opencode/opencode.json` `provider.<P>.models.<M>.name`; format is `[provider/friendly]` (brackets included). `modelFriendlyMap` is loaded once in `OrchestraWatcher.start()`.

Subagent rows do not consult the friendly-name map: the `info.model` from `session.created` is rendered as-is in `[${providerID}/${id}]` form on screen (e.g. `[sohoai/minimax-m3]`).

### Diagnostic logging

Env-gated `console.error` shims fire when `OCTMUX_DEBUG_SSE=1`:
- `src/app.tsx` SSE for-await loop: one-shot wrapper-key dump + per-event `payload type=… directory=… harness=…`.
- `src/events.ts`: `filterEvent type=…` entry; `session.created id=… parentID=… agent=… model=… harness=… match=…`; `session.created child added to unpairedChildren childID=… openTaskPartIDsSize=…`; `tryPair paired taskPartID=… childID=…`; `session.idle sessionID=… isTrackedChild=… isHarnessParent=…`; `session.deleted sessionID=… isTrackedChild=…`; `task tool pending partID=…`; `task tool completed/errored, ending subagent partID=… childID=…`.
- `src/orchestra-watch.ts`: `notifySubagentStarted sessionID=… agent=… model=… badgePresent=… queueLen=…`; `_updateBadge drain pendingLen=… badgeSubagentsBefore=…` / `…drain done badgeSubagentsAfter=…`.

Default off → zero behaviour change. Evidence-pass recipe: `OCTMUX_DEBUG_SSE=1 dist/octmux 2>/tmp/octmux-debug.log`, run `/brain "<task>"`, exit, grep for the lifecycle markers. Regression check: `grep -c 'emitting subagent-ended (via session.idle)' /tmp/octmux-debug.log` must be 0.

### File:line reference

- `src/index.tsx:257` — `client.global.event({})` opens the global event stream; `eventStream.stream` is passed to `<App>`.
- `src/events.ts` — `trackedChildSessions`, `openTaskPartIDs`, `taskToChild`, `unpairedChildren` module state; `tryPair()` helper (lines 90-115) implements symmetric Task-tool/session.created pairing; `session.created`/`session.deleted`/`session.updated`/`session.idle` branches; `message.part.updated` tool branch with Task-tool tracking; `resetEventState()` clears all four structures.
- `src/orchestra-watch.ts` — `notifySubagentStarted`/`Ended`/`AllEnded`/`Activity` + `notifyParentActivity` public API with the new-reference emit invariant; `scan()` with `subagents` preservation in both brain and duo branches; `_pendingSubagentQueue` + drain in `_updateBadge`; `loadModelFriendlyNames()` + `formatModelLabel()` for the parent row.
- `src/app.tsx` — `subagent-detected` / `subagent-ended` / `subagent-activity` / `session-idle` event handlers; watcher mount useEffect at line 333 (declared before SSE useEffect at line 684 for non-null `watcherRef.current` on first event); `watcher.on("changed", setOrchestraBadge)` at line 336.
- `src/components/StatusLine.tsx` — subagent row render with `<spinner glyph> <agent> [<model>]`, model in `dimColor`.

---

## Per-session `telemetry.json` reader

### What octmux reads

`${sessionDir}/telemetry.json` (per-session, NOT a global file). The schema is owned by oconona (see `oconona/docs/oconona--provider-contract-details.md` §telemetry.json shape post-v7.5). octmux reads ONLY:

- `parser_warnings: Array<{code: string; message: string}>` — surfaced as a ` !` indicator after the badge.

octmux does NOT read `parent_delta`, `parent_total`, `parent_snapshot_*`, `started_at_oc_ms`, `ended_at_oc_ms`, `subagents`, `totals`, `cost_usd_estimate`, `researcher_dispatches`, or any other v7.5+ field for live state. Those fields exist for reporting and forensics (oconona's `session-report.py` consumes them).

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

Inline segment in the main status line: `♪ orchestra light - <title>` (duo) or `♪ orchestra full - <title>` (brain) plus ` !` suffix if `parser_warnings.length > 0`. The mode prefix is embedded in the stored title value; StatusLine renders passthrough as `♪ ${orchestraBadge.title}` without additional wrapper prefix; no separate mode or subagent rows are rendered.

### Idle state

When `orchestraBadge === null`, no badge renders.

### Activity indicator

Each subagent row, and the mode row for the parent (harness) session, displays a glyph that rotates or freezes based on recent activity. The signal is binary: rotation when activity has been observed within the last 120 seconds, otherwise a halted frame that serves as a wedge indicator.

**Glyph set:** `SPINNER_GLYPHS = ['◐', '◓', '◑', '◒']` (circle-quadrant family, matching the parent CC role indicators `◒ tools` / `◓ generating`). The active frame is selected by an app-level `spinnerFrame` integer state incremented every 250 ms by a `useEffect`-scoped `setInterval`.

**Colour:** `ACTIVE_GREEN = '#1dde00'`, uniform for both rotating and frozen states.

**Parent (harness) row:** `lastActivityAt` is bumped by `OrchestraWatcher.notifyParentActivity(ts)`, called from `applyReplEvents` in `src/app.tsx` whenever an SSE `block-start` or `block-delta` event arrives with parent role `text`, `thinking`, `tool-call`, or `tool-result`. The update is a direct mutation on `this.badge.lastActivityAt` plus an emit; React's same-reference bailout suppresses a re-render storm under the parent's chunked streaming.

**Subagent rows:** `lastActivityAt` is bumped by `OrchestraWatcher.notifySubagentActivity(sessionID, ts)`, called from `applyReplEvents` when a `subagent-activity` ReplEvent arrives. That event is emitted by `filterEvent` on every global-stream `session.updated` whose `info.id` is in `trackedChildSessions`. After the in-place mutation the watcher replaces `this.badge` with a shallow clone so the emit produces a new top-level reference and React re-renders.

**Freeze threshold:** `ACTIVITY_FREEZE_MS = 120_000`. Render condition: `now - lastActivityAt <= ACTIVITY_FREEZE_MS` selects the rotating glyph; otherwise the frame is held at `SPINNER_GLYPHS[0] = '◐'`.

**Row lifecycle:** A row appears on `notifySubagentStarted` (or on queue drain inside `_updateBadge` when the badge transitions from null to non-null with pending notifications). The spinner rotates while activity is recent and freezes at `◐` thereafter. The row drops on `notifySubagentEnded`, triggered by the brain's Task tool transitioning to `state.status === "completed"` or `"error"` (the paired-task signal in `events.ts`; see §Subagent role detection / Detection mechanism) or, as a fallback safety net, by `session.deleted` for the tracked child sessionID. `session.idle` for a tracked child is NOT a row-end signal (OC fires it on every turn pause within a subagent's task).

### File:line reference

`src/components/StatusLine.tsx:80–150` — downward-stack layout with mode row, subagent rows, overflow counter, glyph rendering and spinner advance.

---

## What octmux reads (provider→consumer table)

Symmetric to oconona §What each consumer reads — this is the consumer-side view of the same contract surface.

| What | Path | Written by | Used for |
|---|---|---|---|
| `AssistantMessage.cost` | OC HTTP `GET /session/{id}/message` | OpenCode runtime | Σ$ cost |
| Child sessions | OC HTTP `GET /session/{id}/children` | OpenCode runtime | Σ$ cost (one level) |
| Session list | OC HTTP `GET /session` (filtered by directory + parentID==null) | OpenCode runtime | Harness OC session ID resolution |
| `.oc-session-id` | `~/.config/opencode/orchestra/sessions/*/` | oconona setup (v7.5) | Match key — filters which session dirs belong to this OC session |
| `.brain-inflight` / `.duo-inflight` | `~/.config/opencode/orchestra/sessions/*/` | oconona setup + cleanup | Active-session signal — primary discovery, mode source, badge title (v8.1.5+: content = full badge text), 24h stale guard |
| `session.created` global events | OC global event stream (`client.global.event({})`) | OpenCode runtime (`packages/opencode/src/session/session.ts:577`) | Live subagent detection — filtered by `info.parentID === harness sessionID`; `info.agent` + `info.model` supply the row label |
| `session.updated` / `session.deleted` global events | OC global event stream | OpenCode runtime | Per-row activity (drives spinner) and end-of-row signal |
| `opencode.json` model names | `~/.config/opencode/opencode.json` | oconona setup | Provider/modelId → friendly name mapping (parent harness row only) |
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
| C6 | ~~`ORCHESTRA_TITLE=` in `state.env` is global~~ | ~~Resolved in v8.1.6~~: both `/brain` and `/duo` now embed the badge title in their per-session inflight file content. `state.env` is no longer used for badge title sourcing; the global-clobber risk is eliminated. | — | resolved |

### 4. Other fragility

| # | Scenario | Behaviour | Mitigation | Severity |
|---|---|---|---|---|
| D1 | OC daemon down at octmux startup | `client.session.list()` throws → `harnessOcSessionID` stays null → badge never appears. Silent | octmux already fails on daemon-down in other paths (SSE, session.create); not a new failure mode. Could add an explicit operator-visible warning | low |
| D2 | **Spec contradiction in oconona** about telemetry vs marker write order: `oconona--provider-contract-details.md` invariant 6 says "marker removed BEFORE telemetry-summarize.sh invoked". The actual `/brain` cleanup script (orchestra-cleanup.sh) runs summarizer first (Step 4), then removes marker (Step 6) — i.e. telemetry before marker, the opposite order | If the docs are inconsistent, future implementations might pick the wrong order. The provider-doc-prescribed order would create a brief no-marker-no-telemetry window. octmux is robust either way (no-marker = no badge, no-telemetry = no warning indicator) | **G1 — Documented below:** provider doc §Write-order invariant 6 contradicts implementation. Provider doc should be updated to match cleanup.sh ordering. | med |
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
2. **Clean `/brain` lifecycle**: start → (optional Phase 0 researcher / researcher-deep dispatches; oconona v8.2.0+) → planner → actor → reviewer → cleanup. Badge transitions through all roles.
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

- **Provider spec:** `oconona/docs/oconona--provider-contract-details.md` — the symmetric counterpart written from the provider's side. The two documents must stay in sync.
- **oconona roadmap:** `oconona/docs/Stage7.md` (v7.5 is the contract version this consumer reads).
- **octmux changelog:** `docs/Stage8.md` — implementation log + known limitations + feedback to oconona.
- **Auto-memory:** `feedback-orchestra-v75-contract.md` (in user's auto-memory) — quick reference for the v7.5 contract.
- **Related code:** `src/orchestra-watch.ts`, `src/components/StatusLine.tsx`, `src/app.tsx` (watcherRef + useEffects).
- **Related feedback memories:** `feedback-react-effect-tdz.md` (TDZ ordering), `feedback-oc-directory-header.md` (`x-opencode-directory` header).
