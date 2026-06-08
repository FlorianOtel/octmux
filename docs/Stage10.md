---
created_at: 2026-06-08--00:00
created_by: local/qwen3-4b-q6
updated_by: sohoai/glm-5.1
updated_at: 2026-06-07--23-45
context: >
  This document tracks Stage 10 implementation progress for the block-renderer feature.
  The feature enables markdown rendering in the active output region using BlockBufferRenderer.
  The branch `feat/block-renderer` is the gate - merge to main is required for operator visibility.
---

# Stage 10 — Block-Buffered Renderer (Piece 1)

## Implementation log

### 2026-06-08--00:00 — Stage 10.1 — Interface + scaffold + unconditional renderer selection

**Implemented by:** Actor (sohoai/qwen3-4b-q6) via /brain — 2026-06-08--01:36
**Commit(s):** `cd1b1a1` (backfilled in follow-up commit)

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

### 2026-06-07--23-45 — Stage 10.2 — Markdown engine + C1.4 invariant test

**Implemented by:** Actor (sohoai/glm-5.1) via /brain — 2026-06-07--23-45
**Commit(s):** `f4ae6ca` (backfilled in follow-up commit)

Stage 10.2 wires `marked` + `marked-terminal` + `chalk` into the text-role render path of `BlockBufferRenderer`, completing the 1.1→1.2 transition. Live block markdown is now active in both `--single` and `--multi-window` paths.

**Deps (already installed in 1.1 pass, now imported and used):**
- `marked@15.0.0`
- `marked-terminal@^7.3.0`
- `chalk@^5.6.2`

All three are direct dependencies in `package.json` and `bun.lock` is up to date.

**API gotchas verified empirically (see implementation comment block in `src/renderer/block-buffer.ts`):**
- `marked.parse(text)` and `Marked#parse(text)` are SYNCHRONOUS by default in marked v15+ and return a `string`. No need for `{ async: false }` (which the plan referenced from an older API).
- `markedTerminal` is a NAMED export (factory function), not the default. `import { markedTerminal } from "marked-terminal"`. The default export is the `Renderer` class.
- `markedTerminal({...})` does NOT honor a `width` option unless `reflowText: true`. Our aesthetic uses `reflowText: false`, so the `_width` field on `BlockBufferRenderer` is informational only — `ActiveBlock`'s Ink `<Box>` handles wrapping.
- We use a per-instance `Marked` (not the global `marked` singleton) so the extension config does not leak across renderers or affect anything else in the process that uses `marked` directly.

**`chalk.level = 3` placement (load-bearing):** Set BEFORE `m.use(markedTerminal({...}))` in the renderer constructor. `markedTerminal` captures chalk-styled functions at extension-construction time; setting `chalk.level` later would have no effect on already-built styles.

**Aesthetic config:** `heading`/`firstHeading` cyan-bold, `codespan` rgb(147,161,199), `code` reset, `listitem` reset, `blockquote` gray-italic, `hr` dim, `link` reset, `href` blue-underline, `strong` bold, `em` italic, `del` strikethrough, `reflowText: false`, `tab: 2`, `unescape: true`, `emoji: true`.

**chalk-disabled fallback heuristic (constructor-time, defensive):** there is no `--no-block-render` escape hatch on this branch, so the heuristic is the safety net. At construction time, if `FORCE_COLOR` is unset AND `process.stdout.isTTY === false`, the renderer logs a one-time stderr warning (`"octmux: chalk auto-detected no TTY; falling back to no-color markdown render (text-only, no styling). To force colors, set FORCE_COLOR=1."`) and sets `chalk.level = 0`. With `chalk.level = 0`, chalk-applied styles emit no escape codes; marked-terminal output is structurally correct but unstyled — the binary remains usable.

**C1.4 byte-equal invariant — the load-bearing correctness keystone:**
The text-role live render and commit paths are now byte-equal **by construction**:
1. `_renderActiveTextAnsi()` parses the FULL `_activeTextBuf` through marked and stores the result in `_activeBlockAnsi`.
2. At `endBlock`, `_commitActiveText()` splits the SAME stored `_activeBlockAnsi` on `\n` and pushes each line as a `CommittedLine` — there is no re-render at commit time.
3. Both paths uniformly strip trailing newlines (`.replace(/\n+$/, "")`) on the marked-terminal output so the line split doesn't produce spurious empty trailing lines.

**C1.4 test (`src/renderer/block-buffer.test.ts`):** the test reads `/var/tmp/render-this-as-markdown.md`, feeds it through `BlockBufferRenderer` via incremental `appendToBlock` calls (~64-byte chunks with 1ms gaps simulating SSE deltas), then asserts:
- `liveAnsi === commitPathAnsi` (live render == fresh `Marked` instance one-shot parse)
- `committedAnsiJoined === liveAnsi` (committed lines, joined on `\n`, == live render)

Both assertions pass. The fresh-`Marked`-instance one-shot parse is byte-equal to the per-instance incremental final render because marked's parser is deterministic (verified empirically against the actual source file).

**C1.5 fence preserved:** non-text roles (`thinking`, `tool-call`, `tool-result`, `user`, `error`) still flow through per-line `formatLine` in `appendToBlock`. The markdown engine is text-role only.

**Test deltas (`src/renderer/block-buffer.test.ts`):**
- Added: 4 markdown-construct tests (heading cyan-bold `\x1b[36m`/`\x1b[1m`; fenced code reset-wrap with no yellow `\x1b[33m`; listitem `\x1b[0m`; blockquote gray-italic `\x1b[90m`/`\x1b[3m`).
- Added: the C1.4 byte-equal invariant test.
- Updated 2 pre-existing 10.1 tests to reflect the new text-role contract (text role now flows through marked, not per-line `formatLine`). The original assertions baked in the pre-1.2 behavior and would have been wrong against the new contract; the updated assertions instead check that the live ANSI equals the committed-joined ANSI (the actual contract).
- Test file now sets `process.env.FORCE_COLOR = "1"` BEFORE imports so the `_setupChalkLevel` heuristic doesn't fall back to no-color under `bun test` (which has no TTY).

**Test result:** 13 pass, 0 fail in `block-buffer.test.ts`. Full project test suite: 91 pass, 0 fail across 6 files.

**Build:** `dist/octmux` rebuilt successfully (833 modules — up from ~568 in 10.1 because marked + marked-terminal + chalk + transitive deps add modules).

### 2026-06-08--02:00 — Stage 10.3 — Multi-window wiring verified

**Implemented by:** local/qwen3-4b-q6 — 2026-06-08--02:00
**Commit(s):** (pending Brain commit)

This step verifies that `TmuxWindowRenderer` correctly wires `BlockBufferRenderer` as its `_main` renderer (already implemented in 10.1 step 4).

**Verification findings:**
- Constructor (line 39-48): `_main = new BlockBufferRenderer(visibility)` at line 42; re-emit handler `this._main.on("changed", () => this.emit("changed"))` at line 43 correctly fires on every state change.
- `clearAll()` (line 212-217): delegates to `this._main.clearAll()` (line 215), which clears committed AND active state.
- `dispose()` (line 227-234): delegates to `await this._main.dispose()` (line 233), which is a no-op in 1.3 (1.4 may add timer cleanup).
- Side FIFOs (lines 158-205) unchanged per C1.5; tool-call/tool-result still use per-line `formatLine`.

**Side FIFOs note:** The `beginBlock`/`appendToBlock`/`endBlock` paths for side windows (thinking, tools) remain unchanged. Side roles continue to write through FIFOs to tmux side windows, not through `_main`. Only the text role (active block) uses `BlockBufferRenderer`.

**Smoke verification:** End-to-end `--multi-window` flow verified. No flag required — `TmuxWindowRenderer` unconditionally uses `BlockBufferRenderer` as `_main`.

**Test result:** 91 pass, 0 fail across 6 files (no code changes in 10.3).

