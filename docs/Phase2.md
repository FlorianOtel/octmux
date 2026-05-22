---
title: "octmux — Phase 2: Auto-spawn server + tmux guard"
created_at: 2026-05-19--15-37
created_by: Claude Code (Actor, Claude Haiku 4.5)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-05-22--21-46
context: >
  Phase 2 adds automatic server spawning with port rotation and a tmux guard
  that prevents octmux from running outside of tmux unless explicitly overridden.
  This document contains the complete implementation log for Phase 2.
---

# Phase pre-implementation checklist - Read this first

When starting a phase:

1. Read this doc top-to-bottom, paying attention to the most recent log
   entry — it carries forward notes from the previous phase that the spec
   below may not capture.
2. Implement only the deliverables and files listed for the current phase.
   Do not pull work forward from later phases.
3. Run the phase's manual verification steps. All must pass.

When finishing a phase:

1. Add a new entry at the top of "Implementation log" with today's
   `YYYY-MM-DD--HH-MM` timestamp.
2. Flip the phase's status in the parent plan to `✓ shipped — see log
   YYYY-MM-DD--HH-MM`.
3. Refresh `updated_by` and `updated_at` in the frontmatter.
4. Commit with `feat(octmux): Phase N — <short title>`.

---

## Implementation log (reverse chronological — newest at top)

### 2026-05-19--15-37 — Phase 2: Auto-spawn server + tmux guard

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `e8249f7d` (shared with Phase 1.5c+1.5d)

**What shipped:**
- src/server-lifecycle.ts (new): findFreePort (TCP bind probe, range [4096, 4106]),
  findOpencodeBin (~/.opencode/bin/opencode fallback), waitForHealth (200ms poll +
  10s deadline), spawnOpencodeServer (Bun.spawn + proc.unref + dispose handle).
- src/index.ts: --help, --version, --no-tmux-guard flags; tmux guard
  (process.env.TMUX check); auto-spawn vs --attach branch for baseUrl resolution;
  SIGTERM handler; serverHandle?.dispose() wired to rl.on("close") and SIGINT
  double-Ctrl-C exit path. Removed Phase 0 debug output (health: ok, sessions count).
- Ctrl-C behavior: single Ctrl-C during generation aborts (unchanged from Phase 1.5).
  Single Ctrl-C when idle now prints "(Press Ctrl-C again to exit)" — double Ctrl-C
  within 3s exits with dispose. Retroactively correct for attach mode (serverHandle
  is null → dispose() is a no-op).
- Phase 1.5 streaming/modal/abort behavior unchanged.

**Suggested next steps for Phase 3:** raw-mode input replaces readline.
  respondPermission/respondQuestion will need the raw-mode single-keypress path.
