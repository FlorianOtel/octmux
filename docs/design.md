---
title: "octmux — Design principles"
created_at: 2026-06-01--01-15
created_by: Claude Code (Claude Haiku 4.5, via Actor subagent)
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-06-05--23-30
context: >
  Cross-cutting design principles for octmux. Created during Stage 4.5.3
  hardening (commit 994952a) after the operator hit a wedged orchestra
  session caused by a silently dropped SSE event — a symptom of a deeper
  "single-shot SSE + no reconciler" pattern. This doc names the principle
  so future stages don't re-introduce variants of the same fragility.
  Updated 2026-06-01 to reflect the redesigned Stage 4.5.3 reconciler
  with four-layer guard (commit 8ee7b36) that eliminates unconditional
  polling during steady-state SSE.
---

# octmux — Design principles

## 1. OC daemon is the single source of truth

octmux is a view over OC state. The OC daemon's REST API is authoritative.
SSE is a fast push channel — but never a substitute for reconciliation.
For every UI state machine driven by an SSE event, there MUST be a polling
fallback that can recover from a missed event.

The four state machines currently in scope:
- session idle / generation-complete signal
- pending question modal (AskUserQuestion tool)
- pending permission modal (tool permissions)
- token-usage / cost counters

In steady-state (good SSE health), the polling reconciler does not run — it
arms only when SSE degradation is detected (>5s silence or reconnect in
progress). When armed, the reconciler guards its idle-detection logic with
three additional layers (recency check, active-stream inspection, REST
fallback) to ensure it does not fire `synthesizeSessionIdleEvents()` during
active text or reasoning streams.

See `src/app.tsx`'s `runReconcilerPassRef` for the implementation and
`docs/Stage4.md` §Stage 4.5.3 for the full four-layer guard design.

## 2. Renderer state mutations route through one path

All ReplEvent application — whether from live SSE or from the reconciler
— routes through the shared `applyReplEvents()` helper in `src/app.tsx`.
This guarantees `--multi-window` FIFO state is correctly drained
regardless of event source. There must be no bypass that mutates renderer
state directly.

## 3. Pure-gate contract (Stage 4.5.1 / 4.5.2 / 4.5.3 redesign)

`TmuxWindowRenderer.setOutputEnabled(key, on)` is a pure Map setter
plus, on `on=true`, a single non-blocking liveness-cache refresh kick.
It MUST NOT spawn windows, open or close FIFOs, kill windows, run any
synchronous tmux subprocess, or emit events.

Window/FIFO lifecycle is owned exclusively by `_ensureWindow`, invoked
exclusively from `beginBlock`.

The Stage 4.5.3 reconciler (commit `8ee7b36`) upholds this contract: no
reconciler call path touches `setOutputEnabled` or `_ensureWindow`. The
reconciler only synthesises ReplEvents routed through the shared
`applyReplEvents()` mutator and reads REST state. See `docs/Stage4.md`
§Stage 4.5.1, §Stage 4.5.2, and §Stage 4.5.3 (redesigned) for the full
contract chain.

## 4. Recovery must mirror live semantics exactly

Where the reconciler synthesises events that the live SSE handler also
processes, the reconciler MUST produce the same ReplEvent shapes and
route them through the same code path. Specifically: the reconciler's
permission-discovery branch on `permModeRef.current` mirrors
`src/app.tsx`'s `permission-asked` handler exactly (ask→modal,
allow→auto-`always`, deny→auto-`reject`). Recovery must never silently
change semantics.

## 5. Stage 8 — Orchestra integration: cost + subagent rows + activity tracking

**What Stage 8 is:** The orchestra-integration stage — live cost (`Σ$X.XX`) display from OC SDK, orchestra inflight badge (`♪ orchestra -> <title> -> <mode> [-> <subagent>] [!]`) when an oconona `/brain` or `/duo` session is active, and subagent-row rendering on the status line during pipelines.

**What Stage 8 does:**

1. **Cost summation** — reads `AssistantMessage.cost` from parent session and one-level children, sums them on every event, displays live in the status line. Driven by `message.created` and `message.part.updated` events (Stage 8.0).

2. **Subagent dispatch detection** — filters the global event stream for `session.created` events where `info.parentID === harness sessionID`. Each child is tracked in `trackedChildSessions` and emits a `subagent-detected` ReplEvent with `sessionID`, `agent` name, and formatted `provider/model` (Stage 8.1.5).

3. **Symmetric pairing** — Task-tool parts and child sessions are paired via a two-way `tryPair()` helper that drains `openTaskPartIDs` and `unpairedChildren` in FIFO order. This handles both Anthropic-streamed ordering (pending part BEFORE session.created) and non-Anthropic providers (session.created FIRST). The pairing invariant is: a child either sits in `unpairedChildren` (waiting for a part) or in `taskToChild` (paired and active) — never falls through to a stale unpaired row (Stage 8.1.5.2).

4. **Subagent-row rendering** — each paired subagent appears on the status line as `◐ <agent> [<provider/model>]`, with a rotating circle-quadrant spinner (`◐ ◓ ◑ ◒`) in `#1dde00`. Spinner rotates while `now - lastActivityAt <= 120000` ms, then freezes at `◐` to signal wedge (Stage 8.1.4). Rows stack downward below the mode row, max 5 visible plus `+N more` overflow (Stage 8.1.5).

5. **Activity tracking** — activity is bumped on parent-session `block-start`/`block-delta` (text, thinking, tool-call, tool-result roles) and child-session `message.part.delta`/`message.part.updated` events. The 120 s freeze threshold ensures rows correctly reflect genuine SSE activity vs. reconciler-synthesised idle (Stage 8.2).

6. **Lifecycle precision** — rows appear at dispatch time (session.created) and end when the Task-tool part transitions to `completed` or `error`, not when the child's session.idle fires (Stage 8.1.5). On pipeline error, an app-side session.error handler calls `notifyAllSubagentsEnded()` to defensively clear orphaned rows (Stage 8.1.5.2).

7. **Version progression** — Stage 8.0 (initial badge), 8.1.x (subagent rendering iterations), 8.2.x (subagent activity coverage), 8.3 (oconona researcher tiers alignment).

**Design invariant:** The subagent row's FIFO pairing and 120 s activity threshold are inherited from Principle 1 (OC daemon authoritative) — Stage 8 reads SSE for speed but reconciles via REST state machines (session/task completion checks) and syncs with activity events to distinguish genuine work from idle.
