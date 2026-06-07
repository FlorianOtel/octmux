---
created_at: 2026-06-08--00:00
created_by: local/qwen3-4b-q6
updated_by: local/qwen3-4b-q6
updated_at: 2026-06-08--00:00
context: >
  This document tracks Stage 10 implementation progress for the block-renderer feature.
  The feature enables markdown rendering in the active output region using BlockBufferRenderer.
  The branch `feat/block-renderer` is the gate - merge to main is required for operator visibility.
---

# Stage 10 — Block-Buffered Renderer (Piece 1)

## Implementation log

### 2026-06-08--00:00 — Stage 10.1 — Interface + scaffold + unconditional renderer selection

**Implemented by:** Actor (sohoai/qwen3-4b-q6) via /brain — 2026-06-08--01:36
**Commit(s):** `b9cecbe`

This step implements the core interface and scaffolding for BlockBufferRenderer with unconditional renderer selection.

**Operator-visible behavior change at 1.1 commit:** The active region now buffers multi-line text until `endBlock` is called, rather than committing each line as it arrives. This means the active region displays the full multi-line text block (e.g., a heading, code block, or list) rather than just the last partial line. Visually, for simple text content this is mostly invisible since `formatLine` is applied per-line, but the structural change is load-bearing for the upcoming 1.2 markdown rendering.

**Intermediate-state risk during 1.1→1.2 transition:** The binary is running BlockBufferRenderer with per-line `formatLine` fallback in 1.1 (not `marked-terminal` yet). When 1.2 ships with `markedTerminal`, there will be no operator-visible change in the rendered output since the commit path uses the same stored ANSI as the live path. However, if the test environment has chalk auto-detect issues, the fallback to no-color rendering may occur.

**No flag exists; the branch is the gate:** There is no `--block-render` flag or any toggle. The `feat/block-renderer` branch itself is the gating mechanism. Operators on `main` are unaffected. Merge to `main` is required for the feature to become visible.

**Files changed:**
- `src/renderer/types.ts`: Added new interface methods (`getCommitted`, `getActiveBlock`, `getActiveBlockAnsi`, `setWidth`) and moved `CommittedLine` type here
- `src/renderer/stdout.ts`: Implemented new interface methods, removed deprecated `getTail()` method
- `src/renderer/block-buffer.ts`: New file with `BlockBufferRenderer` class that buffers text until `endBlock`
- `src/renderer/tmux-window.ts`: Changed `_main` type from `StdoutRenderer` to `Renderer`, constructor now creates `BlockBufferRenderer`
- `src/app.tsx`: Migrated `getTail()` subscription to `getActiveBlock()`, added `getActiveBlockAnsi()` subscription, added `setWidth` useEffect
- `src/components/ActiveBlock.tsx`: New component for rendering active block with proper empty-line handling
- `src/index.tsx`: Removed `StdoutRenderer` import, now unconditionally creates `BlockBufferRenderer` for `--single` mode and `TmuxWindowRenderer` (with `BlockBufferRenderer` as `_main`) for `--multi-window` mode
- `src/renderer/block-buffer.test.ts`: New test file with 12 passing tests
