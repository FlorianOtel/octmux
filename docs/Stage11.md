---
title: "Stage 11 — Block-Renderer Robustness (Piece 2)"
created_at: 2026-06-11--13-09
created_by: Claude Code (Claude Haiku 4.5)
context: >
  Implementation log for the Stage 11 Brain series (block-renderer robustness); companion to
  docs/Stage11-Block-Renderer-Improvements.md. Sessions cover A.1 (debug hygiene), A.2 (geometry
  liveness hook), A.3 (airtight cap), and A.4 (single-line blanking).
---

# Stage 11 — Block-Renderer Robustness (Piece 2)

## Implementation log

### 2026-06-11--13-09 — A.1: consolidate OCTMUX_DEBUG_RENDER writes behind _dbg() helper

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--13-09
**Commit(s):** _pending — backfill after commit_

Extracted three inline env-gated stderr writes in `src/renderer/block-buffer.ts:beginBlock` into one private `_dbg(msg)` helper (lines 197–201). All debug instrumentation in the class now routes through this single env-check, reducing hot-path noise. Trace lines preserved; WP-C capability retained. `process.env.OCTMUX_DEBUG_RENDER` check consolidated to one location inside `_dbg`; three `this._dbg(...)` callsites remain in `beginBlock` (lines 224, 244, 248) with message strings unchanged.

### 2026-06-11--13-09 — A.2: useTerminalSize() hook for live terminal geometry

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--13-09
**Commit(s):** _pending — backfill after commit_

Added `useTerminalSize()` hook in `src/app.tsx` (lines 227–240) that subscribes to `stdout` resize events and lifts terminal dimensions into React state. Replaced inline `stdout?.rows` / `stdout?.columns` reads with state-derived `rows` and `columns` at lines 320, 332–333. Terminal resize now forces a re-render; `maxActiveRows` and `w` recompute on every resize event in all states (streaming, paused, idle). The re-render is cheap — dynamic region only; `<Static>` history not re-emitted. `setWidth` effect fires on resize for free (staged-width updates). Resize-during-pause flash eliminated; A.3 (chrome measurement) can proceed.
