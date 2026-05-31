---
title: "octmux — Design principles"
created_at: 2026-06-01--01-15
created_by: Claude Code (Claude Haiku 4.5, via Actor subagent)
context: >
  Cross-cutting design principles for octmux. Created during Stage 4.5.3
  hardening (commit 994952a) after the operator hit a wedged orchestra
  session caused by a silently dropped SSE event — a symptom of a deeper
  "single-shot SSE + no reconciler" pattern. This doc names the principle
  so future stages don't re-introduce variants of the same fragility.
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

See `src/app.tsx`'s `runReconcilerPassRef` for the implementation.

## 2. Renderer state mutations route through one path

All ReplEvent application — whether from live SSE or from the reconciler
— routes through the shared `applyReplEvents()` helper in `src/app.tsx`.
This guarantees `--multi-window` FIFO state is correctly drained
regardless of event source. There must be no bypass that mutates renderer
state directly.

## 3. Pure-gate contract (Stage 4.5.1 / 4.5.2)

`TmuxWindowRenderer.setOutputEnabled(key, on)` is a pure Map setter
plus, on `on=true`, a single non-blocking liveness-cache refresh kick.
It MUST NOT spawn windows, open or close FIFOs, kill windows, run any
synchronous tmux subprocess, or emit events.

Window/FIFO lifecycle is owned exclusively by `_ensureWindow`, invoked
exclusively from `beginBlock`.

The Stage 4.5.3 reconciler upholds this contract: no reconciler call
path touches `setOutputEnabled` or `_ensureWindow`. See
`docs/Stage4.md` §Stage 4.5.1, §Stage 4.5.2, §Stage 4.5.3.

## 4. Recovery must mirror live semantics exactly

Where the reconciler synthesises events that the live SSE handler also
processes, the reconciler MUST produce the same ReplEvent shapes and
route them through the same code path. Specifically: the reconciler's
permission-discovery branch on `permModeRef.current` mirrors
`src/app.tsx`'s `permission-asked` handler exactly (ask→modal,
allow→auto-`always`, deny→auto-`reject`). Recovery must never silently
change semantics.
