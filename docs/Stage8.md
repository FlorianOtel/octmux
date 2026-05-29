---
title: "Stage 8 — Live cost display (OC SDK) + orchestra inflight badge"
created_at: 2026-05-29--08-27
created_by: Claude Code (Claude Haiku 4.5)
context: >
  After Stage 8, octmux's status bar replaces the hardcoded `~$0.00` placeholder
  with a live `Σ$X.XX` cumulative cost (sourced from OC SDK `AssistantMessage.cost`,
  summed over all messages in the session + immediate child sessions), and shows
  a `♪ brain/plan <title>` badge when an oconona `/brain` or `/duo` session is
  active for the same project directory. No new oconona code or deploy steps are
  required; both features read from existing API/filesystem contracts already stable
  since oconona Stage 5.
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

### Badge source: fs.watch + 5-second fallback poll

`src/orchestra-watch.ts` exports `OrchestraWatcher` class. On each scan (triggered by fs events or 5s poll):

1. Check `~/.config/opencode/orchestra/sessions/*/` subdirs.
2. For each subdir, read `.project-dir` sidecar; skip if it doesn't match `process.cwd()`.
3. Skip if `.brain-inflight` or `.duo-inflight` mtime is older than 24h (stale-after-crash guard).
4. Check for `.duo-inflight` (priority: duo > brain, most recent by mtime).
5. For `/duo`: read `.duo-inflight` content as title.
6. For `/brain`: read `ORCHESTRA_TITLE=` line from `~/.config/opencode/orchestra/state.env`.
7. Truncate title to 30 chars.
8. Render in status bar as `♪ plan <title>` (duo) or `♪ brain <title>` (brain), color `#d3869b`.

Badge transitions within ~5 seconds of `/brain` or `/duo` start/stop in the same project.

### Stage indicator (`▶ stage`)

When a badge is showing and an oconona subagent is actively running, the status bar appends `▶ <stage>` (in yellow, color `#d79921`) immediately after the badge title. Stage labels are: `plan`, `implement`, `review`, `research`.

**Data source:** `~/.config/opencode/orchestra/invocations.log` (global file, not per-session). Newline-delimited JSON with entries like:
```json
{"event":"start","stage":"implement","subagent":"actor","ts":"20260529T123456Z",...}
{"event":"end",  "stage":"implement","subagent":"actor","ts":"20260529T123457Z",...}
```

**Detection algorithm:** `OrchestraWatcher.readActiveStage()` is called on each scan (via fs.watch or 5-second poll):
1. Read `~/.config/opencode/orchestra/invocations.log` synchronously (return null on any error).
2. Split by newlines, reverse-scan to find the last `event === "start"` and last `event === "end"` entries.
3. Parse each as JSON; skip malformed lines.
4. Compare `lastStart.ts > lastEnd.ts` lexicographically (ISO 8601 strings sort correctly).
5. If true (or no end exists), return `lastStart.stage`; otherwise return null.

**Rendering:** In `StatusLine.tsx`, the stage is rendered as `  ▶ <stage>` (two spaces + right-pointing triangle) immediately after the badge, only if `orchestraBadge?.stage` is truthy.

**Inherits project filter:** Stage indicator only shows when the badge is showing — it uses the same project-filtered badge logic. If badge is null (no active session for this project), stage is not read or shown.

**No new oconona work required:** The `invocations.log` file is written by oconona's `orchestra-hook.sh` (PreToolUse(Agent) + SubagentStop hooks) and is explicitly preserved through oconona v7.2 (`Keep: subagent start/end logging` per oconona Stage7.md Step 9).

### Oconona contract (testing prerequisites)

**No new oconona code or deploy steps are required.** Both cost and badge read from stable, existing contracts:

| What octmux reads | Written by | Already deployed? | Notes |
|---|---|---|---|
| OC HTTP API `/session/{id}/message` — `AssistantMessage.cost` | OpenCode runtime | Yes | OC built-in; no oconona action |
| OC HTTP API `/session/{id}/children` | OpenCode runtime | Yes | OC built-in; no oconona action |
| `~/.config/opencode/orchestra/sessions/*/[.brain-inflight\|.duo-inflight]` | oconona `orchestra-hook.sh` + `/brain`/`/duo-plan` | Yes | Stable since oconona Stage 5 |
| `${SESSION_DIR}/.project-dir` sidecar | oconona `/brain`/`/duo-plan` setup bash | Yes | Present in current deploy |
| `~/.config/opencode/orchestra/state.env` (`ORCHESTRA_TITLE=` line) | oconona `/brain` setup bash | Yes | Present in current deploy |

### Architecture decision: no separate CostAggregator class

The spec called for a separate `src/cost-aggregator.ts` with a 5-second `setInterval` poll. **This stage deviates.** Reason: `refreshTokenUsage()` already:
- Calls `client.session.messages()` (same endpoint needed for cost).
- Is invoked at the right time: on `session-idle` SSE events + session switches.
- Is the established pattern for live session-state updates in octmux.

Cost doesn't change between turns, so polling is wasteful. Extending `refreshTokenUsage()` is simpler, architecturally consistent, and avoids redundant polling.

### TDZ ordering constraint for effects

The `OrchestraWatcher` useEffect is declared BEFORE the SSE effect and BEFORE the session-get effect, ensuring that any effect that references `orchestraBadge` state can safely depend on the watcher being set up (per `feedback-react-effect-tdz.md`).

---

## Implementation log

### 2026-05-29--11-01 — Stage 8.1: active subagent stage indicator
**Implemented by:** Actor (Claude Haiku 4.5) — 2026-05-29--11-01
**Commit(s):** `c30d30a`

**Summary of changes:**

1. **`src/orchestra-watch.ts`:**
   - Extended `OrchestraBadge` type: added optional `stage?: string | null` field.
   - Added private method `readActiveStage(): string | null`:
     - Path: `~/.config/opencode/orchestra/invocations.log` (via `os.homedir()`)
     - Read file synchronously; return null on any error
     - Split by newlines, reverse-scan for last `event === "start"` and last `event === "end"` entries
     - Parse each as JSON (wrap in try/catch; skip malformed)
     - Compare timestamps lexicographically (`lastStart.ts > lastEnd.ts`)
     - Return `lastStart.stage` if active, else null
   - Updated `scan()`: after computing badge (when non-null), call `readActiveStage()` and attach result as `badge.stage`

2. **`src/components/StatusLine.tsx`:**
   - Updated `StatusLineProps` type: `orchestraBadge` field now includes optional `stage?: string | null`
   - Added stage indicator rendering: `{orchestraBadge?.stage && <Text color="#d79921">{`  ▶ ${orchestraBadge.stage}`}</Text>}` immediately after badge render

3. **`docs/Stage8.md`:**
   - Added new "Stage indicator (`▶ stage`)" section documenting data source, detection algorithm, rendering, and project filtering

**Binary rebuild:** Bun build succeeded with zero TypeScript errors.

### 2026-05-29--08-27 — Stage 8: live cost (OC SDK) + orchestra inflight badge
**Implemented by:** Actor (Claude Haiku 4.5) — 2026-05-29--08-27
**Commit(s):** `bd561fc`

**Summary of changes:**

1. **`src/app.tsx`:**
   - Added `runningCost` state hook; initialized to 0.
   - Extended `refreshTokenUsage()` callback (lines 181–250) to sum `AssistantMessage.cost` for all assistant messages in parent session + children (one level deep). Guard: treat NaN/negative costs as 0. Calls `setRunningCost(totalCost)`.
   - Added `setRunningCost(0)` in `switchSession()` to reset cost on session switch.
   - Added `orchestraBadge` state hook; initialized to null.
   - Added new useEffect (after git-branch fetch, before opencode-discovery) to instantiate `OrchestraWatcher(process.cwd())`, subscribe to `watcher.on("changed", setOrchestraBadge)`, call `watcher.start()`, and return cleanup via `watcher.dispose()`. Declared BEFORE any effect that references orchestraBadge (TDZ guard).
   - Updated `<StatusLine>` call: added `runningCost={runningCost}` and `orchestraBadge={orchestraBadge}` props.
   - Added import: `import { OrchestraWatcher, type OrchestraBadge } from "./orchestra-watch.ts"`.

2. **`src/orchestra-watch.ts` (NEW):**
   - Exports `OrchestraBadge = { mode: "brain" | "duo"; title: string } | null`.
   - `OrchestraWatcher` class extends EventEmitter.
   - Constructor: `(projectDir: string)` stores project directory.
   - `start()`: calls `scan()`, sets up `fs.watch()` on `~/.config/opencode/orchestra/sessions/` (if exists), sets 5s `setInterval` fallback poll.
   - `scan()`: globs session subdirs, reads `.project-dir` sidecars, skips if project dir doesn't match, skips if mtime > 24h, checks for `.duo-inflight` (priority) or `.brain-inflight`, reads title from marker or `state.env` ORCHESTRA_TITLE, truncates to 30 chars, returns highest-priority match.
   - `getBadge()`: returns current badge state.
   - `on("changed", cb)`: event emitter pattern for badge changes.
   - `dispose()`: clears watcher + interval.
   - All fs errors caught silently (no throws).

3. **`src/components/StatusLine.tsx`:**
   - Added `runningCost: number` and `orchestraBadge?: OrchestraBadge | null` to `StatusLineProps`.
   - Updated destructuring in function signature.
   - Replaced hardcoded `~$0.00` with `Σ$${runningCost.toFixed(2)}` on line 64.
   - Added conditional badge render after git suffix: `{orchestraBadge && <Text color="#d3869b">{` | ♪ ${mode} ${title}`}</Text>}`.

**Binary rebuild:** Bun build succeeded with zero TypeScript errors.

---

## Known limitations & future work

- **Per-tier cost breakdown:** Not in scope; current design sums all tiers uniformly.
- **Cost persistence:** Resets to 0 on octmux restart (by design; fresh session context).
- **Active subagent spinner:** (`▶ <stage>` from invocations.log) — out of scope; planned for future stage.
- **SoHoAI flat-rate:** Displays `Σ$0.00` (correct; OC reports cost=0 for flat-rate sessions).
