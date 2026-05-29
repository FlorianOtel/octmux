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

### 2026-05-29--08-27 — Stage 8: live cost (OC SDK) + orchestra inflight badge
**Implemented by:** Actor (Claude Haiku 4.5) — 2026-05-29--08-27
**Commit(s):** `<hash>`   ← backfilled after commit

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
