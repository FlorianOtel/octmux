---
created_at: 2026-06-08--00:00
created_by: local/qwen3-4b-q6
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-06-09--19-55
context: >
  This document tracks Stage 10 implementation progress for the block-renderer feature.
  The feature enables markdown rendering in the active output region using BlockBufferRenderer.
  The branch `feat/block-renderer` is the gate — merge to main is required for operator visibility.
  Stage 10.7 (2026-06-08) adds a bounded React surface that defeats Ink's clearTerminal
  overflow branch, plus an immediate-render throttle that smooths the visual cadence of
  high-token-rate model output. The failed-experiment chain from an earlier dead-end
  (markdown-semantic incremental commit) is preserved out-of-tree at the tag
  `stage-10.8.1-failed-experiments` (no commits from it survive on this branch).
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
**Commit(s):** `7e35202` (backfilled in follow-up commit)

This step verifies that `TmuxWindowRenderer` correctly wires `BlockBufferRenderer` as its `_main` renderer (already implemented in 10.1 step 4).

**Verification findings:**
- Constructor (line 39-48): `_main = new BlockBufferRenderer(visibility)` at line 42; re-emit handler `this._main.on("changed", () => this.emit("changed"))` at line 43 correctly fires on every state change.
- `clearAll()` (line 212-217): delegates to `this._main.clearAll()` (line 215), which clears committed AND active state.
- `dispose()` (line 227-234): delegates to `await this._main.dispose()` (line 233), which is a no-op in 1.3 (1.4 may add timer cleanup).
- Side FIFOs (lines 158-205) unchanged per C1.5; tool-call/tool-result still use per-line `formatLine`.

**Side FIFOs note:** The `beginBlock`/`appendToBlock`/`endBlock` paths for side windows (thinking, tools) remain unchanged. Side roles continue to write through FIFOs to tmux side windows, not through `_main`. Only the text role (active block) uses `BlockBufferRenderer`.

**Smoke verification:** End-to-end `--multi-window` flow verified. No flag required — `TmuxWindowRenderer` unconditionally uses `BlockBufferRenderer` as `_main`.

**Test result:** 91 pass, 0 fail across 6 files (no code changes in 10.3).

### 2026-06-08--02-08 — Stage 10.4 — Debounce + SIGWINCH/reconnect repaint

**Implemented by:** Actor (sohoai/glm-5.1) via /brain — 2026-06-08--02-08
**Commit(s):** `9125a30` (backfilled in follow-up commit)

Stage 10.4 closes Piece 1 of the block-renderer plan with three coupled improvements: a 100 ms trailing-edge debounce on text-role intra-line burst storms, flush-on-`\n` for live UX, and repaint hooks for terminal resize (SIGWINCH) and SSE reconnect.

**Operator-visible "Stage 10 complete" milestone:** Block-buffered markdown rendering is now feature-complete on `feat/block-renderer`. Active region buffers multi-line text, renders through marked + marked-terminal, handles intra-line storms without over-rendering, repaints cleanly on resize, and survives SSE reconnect without stale geometry. Merge to `main` remains the operator-visibility gate.

**1. 100 ms trailing-edge debounce + flush-on-`\n` in `appendToBlock` (text role):**
- New private field `_textDebounce: ReturnType<typeof setTimeout> | null` on `BlockBufferRenderer`.
- On each text-role delta in `appendToBlock`:
  1. Cancel any pending trailing-edge timer (`clearTimeout` + null).
  2. Append delta to `_activeTextBuf`.
  3. If the delta `text.includes("\n")`, synchronously render + emit `changed` IMMEDIATELY — the flush-on-`\n` invariant keeps live UX responsive (operators see new lines as they complete, not after a 100 ms delay).
  4. ALWAYS schedule a new 100 ms timer that, when it fires, renders + emits.
- Net effect: small intra-line bursts (no `\n`) are throttled to one render per 100 ms; line completions are live. Non-text roles (`thinking`, `tool-call`, `tool-result`, `user`, `error`) are unchanged — they line-stream per-byte through `formatLine`, which is already fast.
- The `_activeBlockAnsi` field is the cached live render. Between flushes, it may be stale; consumers see fresh data via the `changed` emit (which fires on flush-on-`\n` and on the trailing-edge timer).

**2. Debounce pre-flush in every commit-path lifecycle method:**
- New private helper `_flushDebounce()`: if a timer is pending, `clearTimeout`, null it, and synchronously call `_renderActiveTextAnsi()` to update `_activeBlockAnsi` to the latest live render. No emit (the lifecycle caller emits anyway).
- Called as the FIRST statement in: `beginBlock` (text-block-transition path), `endBlock` (text role), `commitTurnEnd`, `commitUserInput`, `commitSystemMessage`, `commitError`, `clearAll`, `dispose`.
- This is the load-bearing piece for the **C1.4 invariant**: when `_commitActiveText()` runs, it splits the SAME stored `_activeBlockAnsi` that the live ANSI consumer would see — the pre-flush guarantees this string reflects the most recent `_activeTextBuf`, including any deltas received within the open 100 ms debounce window. No re-render at commit time; the commit path remains byte-equal-by-construction to the live path.

**3. SIGWINCH repaint hook (`src/index.tsx`):**
- `process.on("SIGWINCH", onRedraw)` registered after `onRedraw` closure is wired (`inkRaw.log.clear()` + `lastOutput = ""` + `onRender()`).
- `process.on("exit", ...)` paired handler removes the SIGWINCH listener cleanly on shutdown.
- Terminal resize → SIGWINCH → `onRedraw` fires → bounded active region repaints at the new width. The `useEffect(...renderer.setWidth(w), [w, renderer])` in `<App>` (driven by `useStdout().columns`) handles the width update on the React side; SIGWINCH is the kernel-level signal that propagates through both paths.

**4. SSE-reconnect repaint hook (`src/app.tsx`):**
- In the SSE reconnect block (`catch` → `props.client.global.event({})` + `await runReconcilerPassRef.current?.()`), added `props.onRedraw?.()` after the reconciler pass.
- The reconciler may have mutated `_committed` via `clearAll` + replay; the active region needs a re-render at the new state. Closes the C1.9 SSE-reconnect repaint gap.

**Test additions (`src/renderer/block-buffer.test.ts`):**
- New `describe` block `"Step 1.4 — Debounce"` with three tests:
  1. **Trailing-edge debounce test (the plan's step 24 case):** `appendToBlock(partID, "hello")` — assert `getActiveBlockAnsi() === ""` (debounce holds); wait 110 ms; assert `getActiveBlockAnsi()` now contains "hello"; rapid `" world"` + `"!"` appends; assert ANSI is still the previous render; wait 110 ms; assert ANSI is "hello world!". `finally` block clears `_textDebounce` for test isolation.
  2. **Flush-on-`\n` test:** delta with `\n` triggers immediate render (no wait needed).
  3. **endBlock pre-flush test:** mid-debounce `endBlock` arrival — assert pre-flush captures the latest buffer + commits a non-stale string; `_textDebounce` is null after; C1.4 preserved.
- Two pre-existing 1.2 markdown-construct tests updated: `"# Heading One"` → `"# Heading One\n"` and `"> A quoted line"` → `"> A quoted line\n"`. The trailing newline triggers flush-on-`\n` so the synchronous `getActiveBlockAnsi()` assertion remains valid. The markdown construct under test (heading, blockquote) is unchanged.

**`getActiveBlockAnsi()` contract note:** Under Stage 10.4 debounce, the getter may return ANSI up to 100 ms stale between non-newline deltas. This is intentional and documented in-line — Ink's `useSyncExternalStore` only calls the getter on `changed` emits, and emits fire on flush-on-`\n` (immediate) and on the trailing-edge timer (~100 ms after the last delta), so the displayed ANSI is always synchronised with the last `changed` emit. The C1.4 invariant test reads `getActiveBlockAnsi()` after a sequence of newline-bearing chunks (the source file `/var/tmp/render-this-as-markdown.md` ends in `\n\n`), so the final chunk's flush-on-`\n` keeps it fresh; the invariant holds.

**Test result:** 94 pass, 0 fail across 6 files (16 in `block-buffer.test.ts`: 13 from 10.1/10.2 + 3 new debounce tests).

**Build:** `dist/octmux` rebuilt successfully (833 modules — unchanged from 10.3; no new dependencies, only new code).

**Out of scope (preserved for later stages):** `getCommitted()` write semantics, reconciler clear+replay during SSE reconnect (already implemented in app.tsx pre-Stage 10), per-role render dispatching beyond text/non-text fence.

### 2026-06-08--03-00 — Stage 10.5 — Reviewer FIX (ActiveBlock layout + cleanup)

**Implemented by:** Actor (sohoai/qwen3-4b-q6) via /brain Phase 3 FIX-loop — 2026-06-08--03-00
**Commit(s):** `3c6d910` (backfilled in follow-up commit)

Phase 3 Reviewer audit returned FIX with 3 specific issues; this sub-stage applies all 3.

1. **MAJOR — ActiveBlock.tsx empty-line rendering:** Fixed double-render of empty lines by collapsing the two separate maps into a single inline map that renders empty lines as spaces for Yoga layout compatibility.
2. **MINOR — tmux-window.ts dead import:** Removed unused `StdoutRenderer` import; `CommittedLine` import already correctly points to `./types.ts`.
3. **MINOR — package.json version pin:** Changed `"marked-terminal": "^7.3.0"` to `"marked-terminal": "7.3.0"` (already pinned in bun.lock).

Tests: 94/94 pass (unchanged). Build: 833 modules.

### 2026-06-08--10-17 — Stage 10.6 — Fix streaming freeze (memoise getActiveBlock)

**Implemented by:** Actor (Claude Haiku 4.5) via /brain — 2026-06-08--10-17
**Commit(s):** `<TBD — backfilled>`

During a long markdown-streaming response on `feat/block-renderer` (HEAD before this stage), the app froze mid-stream: rendering stopped, the screen flickered at ~1 Hz, Ctrl-C became undeliverable, and only `kill -9` escaped. Two prior Stage 10.6 attempts misdiagnosed the root cause and were hard-reset.

**Diagnosis — the actual root cause:**

`BlockBufferRenderer.getActiveBlock()` returned a new `{role, text}` object literal on every call when a text block was active. React's `useSyncExternalStore` calls `getSnapshot()` twice per reconciler cycle and compares the results via `Object.is` for reference equality. New object identity on every call triggered `forceStoreRerender` unconditionally → self-sustaining synchronous render loop → libuv blocked → stdin starved → Ctrl-C dead. The 50-cycle limit in React fired `console.error` (NOT throw); Ink's `patchConsole` intercepted the error output, cleared the screen, wrote the warning, and redrawed → the visible 1 Hz flicker.

**Why the two prior diagnoses were wrong:**

1. **"Throttle emit rate" (Stage 10.6 attempt 1):** The loop is render-driven, not emit-driven. The problem was not how often we emit `changed`, but how React responds to each emit (Object.is returning false on every getSnapshot call drove forceStoreRerender on every emit). Throttling emit rate had no effect.

2. **"Push→spread on _commitActiveText" (Stage 10.6.1 — also rewind):** The wrong getter was suspected. The actual problem getter was `getActiveBlock`, not anything in the commit path. Mutating the commit path was a misdirection.

**Visibility-delta forensic — why the symptom changed across attempts:**

In Stage 10.6 (this stage), warnings appear as readable stack text at session start. In Stage 10.5 (prior), only flicker occurred. Three mechanisms explain the difference:

1. **setImmediate boundary spacing:** Stage 10.6 uses `setImmediate` boundary spacing between reconciler cycles; Ink's 32 ms `throttledLog` window no longer suppresses intermediate `onRender` callbacks. More cycles → more warnings queued.

2. **Push→spread multiplication:** The failed Stage 10.6.1 added a SECOND identity-change channel via the `committed` array (push→spread mutation). This multiplied the `forceStoreRerender` rate at session-start replay because `src/replay.ts:82-86` walks text parts synchronously, and each part triggered two identity-change paths instead of one.

3. **Screen state timing:** At session start, Ink's `lastOutput` was empty when the 50-cycle limit fired → `writeToStderr` did `log.clear()` + write warning + `log("")` → warning persisted because nothing was redrawn over it. In Stage 10.5, the limit fired DURING streaming when `lastOutput` had content → the redraw overwrote the warning → fast flicker only.

**Fix — memoisation with string-identity cache invalidation:**

`BlockBufferRenderer` now caches the active-block wrapper object via two new private fields:
- `_activeBlockCache: { role: Role; text: string } | null` — the cached wrapper object.
- `_activeBlockCacheBuf: string | null` — the `_activeTextBuf` string value when the cache was built.

When `getActiveBlock()` is called for a text role:
1. Check if `_activeBlockCache !== null` AND `_activeBlockCacheBuf === this._activeTextBuf` (string identity comparison).
2. If both true, return the cached wrapper — `Object.is(A, A) === true` → no `forceStoreRerender`.
3. Otherwise, rebuild the cache with a new wrapper and store both the wrapper and the current `_activeTextBuf` reference.

Why this works: JS strings are immutable. Every `_activeTextBuf += text` assignment creates a new string object. The string reference identity change is the correct cache-invalidation key — cheap and reliable. Non-text roles (`_nonTextTail`) already return the same instance-level object on consecutive calls, so no memoisation is needed there.

The `_activeTextPartID === null` early-return at the top of `getActiveBlock()` already nulls the active block on every lifecycle path (`_commitActiveText`, `endBlock`, `commitTurnEnd`, `commitUserInput`, `commitSystemMessage`, `commitError`, `clearAll`, `dispose`) — no per-method cache-null logic is needed.

**Lessons learned:**

Phase 0 must verify symptoms ACROSS the full diagnosis chain, not just at one checkpoint. React's `useSyncExternalStore` `getSnapshot` identity stability is a load-bearing contract; any value mutation or object-wrapping path that returns a new reference on repeated calls is a latent freeze bug waiting to happen. Debugging via "what would the simplest cause be" beats following Reviewer-flagged "latent bugs" without independent verification in Phase 0. `console.error` in Ink-managed React paths is NOT silent — it triggers `patchConsole` hooking with visible side effects.

**Test result:** 20/20 pass in `block-buffer.test.ts` (16 → 20 with 4 new identity-stability tests). Full suite 98/98 pass across 6 files.

**Build:** `dist/octmux` rebuilt successfully (833 modules — unchanged; no new dependencies, only cache fields and memoisation logic).

---

### 2026-06-08--22-15 — Stage 10.7 — Bounded surface + overflow margin + render throttle

**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-06-08--22-15
**Commit(s):** `9e138d6` (feat)

**Note on prior dead-end:** an earlier branch of work labelled "Stage 10.7 / 10.8 / 10.8.1" attempted to bound the dynamic region by detecting markdown block boundaries (`_findCommitBoundary`, `_incrementalCommit`, fence-state tracking) and committing partial blocks mid-stream. After three unsuccessful fix-loops the subsystem was abandoned as structurally unsound (`marked-terminal` is not prefix-closed: a prefix's rendering can change based on what follows — loose lists, reference links, tables, setext, lazy continuation). Stage 10.7 below is the *replacement* design. The discarded subsystem is preserved out-of-tree under tag `stage-10.8.1-failed-experiments` at commit `eeb9a3a` for forensic reference; no commits from it survive on this branch.

#### Design

**Where geometry belongs.** The renderer (`BlockBufferRenderer`) is *geometry-free* — it never reads `stdout.rows` / `stdout.columns`. Geometry lives strictly in the React surface (`src/app.tsx`), which is the legitimate consumer of terminal dimensions via `useStdout()`. The renderer emits the full ANSI-rendered active buffer; the surface decides what fraction of it to display. This avoids the layering violation that bit the prior dead-end: any geometry input to the renderer makes the "Stage N+1 raise the geometry threshold" iteration unavoidable, and turns transient chrome growth into a renderer-state bug.

**`ActiveBlock` last-K visual-row cap (`src/components/ActiveBlock.tsx`).** Three pure helpers exported alongside the component:
- `stripAnsi(s)` — drops SGR escapes (`\x1b[...m`) so length is the printable-character width.
- `visualRows(line, width)` — returns `max(1, ceil(stripAnsi(line).length / max(1, width)))`. A single 240-character line at width 80 counts as 3 visual rows.
- `tailSliceByVisualRows(all, width, maxRows)` — walks the line array from the bottom, accumulating `visualRows(line, width)`, and stops *before* adding a line that would push `used > maxRows`. Returns `all.slice(start)`.

The component returns `null` when role is null or `ansi` is empty; otherwise splits `ansi` on `\n`, runs the tail-slice, and renders the resulting lines through `<Box flexDirection="column" width={width}>` with one `<Text>` per line (empty lines rendered as a single space so Ink's flex layout reserves a row). The renderer's `_activeBlockAnsi` still holds the *full* one-shot marked-terminal parse; only the surface's *display* is bounded. At `endBlock` / role transition, `_commitActiveText` flushes all lines to `<Static>` one-shot, so the full content lands in terminal-native scrollback regardless of how tall the block grew.

**Surface cap math, threaded from `src/app.tsx`:**
```ts
const CHROME_ROWS = 10;
const w           = Math.max(80, stdout?.columns ?? 80);
const maxActive   = Math.max(16, (stdout?.rows ?? 24) - CHROME_ROWS);
```
Both axes follow the same "derive from terminal but never less than floor" pattern. The width floor (80) ensures wrap-counting works on small/undefined terminals; the rows floor (16) ensures a usable streaming tail on 80×24 even if `stdout.rows` underreports. `CHROME_ROWS = 10` decomposes as: typical chrome 5 (`SubprocessStatus 1 + Rule 1 + PromptInput 1 + marginBottom={2}`) + 1 row for Ink's inclusive overflow check (`outputHeight >= stdout.rows`) + 4 rows of headroom for transient chrome growth (multi-line `PromptInput`, modal overlays, yoga edge rounding). On a 54-row pane this gives K=44; on 80×24 the floor (16) binds. Worst case with chrome=9 on 54 rows: dynamic = 44 + 9 = 53 < 54 → strictly below the overflow ceiling.

**`_commitActiveText` array-replace (`src/renderer/block-buffer.ts`).** Switched the single in-place `_committed.push(...)` site to `this._committed = [...this._committed, ...newLines]`. Now matches the pattern already used in every other lifecycle method (`commitTurnEnd`, `commitUserInput`, `commitSystemMessage`, `commitError`). Guarantees that `getCommitted()` returns a new array reference after a commit, so `<Static>` reliably picks up the new lines without depending on a sibling store (`activeBlock`) co-changing on the same tick.

**Render throttle for high-rate streams.** New private field `_lastEmitMs: number = 0`. The `text.includes("\n")` branch of `appendToBlock` now reads:
```ts
if (text.includes("\n")) {
  const now = Date.now();
  if (now - this._lastEmitMs >= 80) {
    this._activeBlockAnsi = this._renderActiveTextAnsi();
    this._lastEmitMs = now;
    this.emit("changed");
  }
}
```
The trailing-edge debounce timer (100 ms, unchanged behavior) also updates `_lastEmitMs = Date.now()` in its body, so the immediate path and the timer share one rate budget. Effect: at most ~12 immediate renders per second on a hot model-token stream; low-rate streams (tool output) bypass the throttle in practice because the inter-delta gap exceeds 80 ms.

**`getActiveBlockAnsi()` lazy-flush.** Now calls `_flushDebounce()` before returning the cached ANSI string. The internal `_activeBlockAnsi` field can be stale between deltas (throttle-skipped or timer-pending), but any external consumer — React's `useSyncExternalStore`, lifecycle methods, tests — sees the freshest value. `_flushDebounce` is a no-op when no timer is pending, so the React hot path (called once per `changed` emit) is unchanged in steady state. This preserves the C1.4 byte-equal invariant (`live == commit-path render`) as a *call-time* property rather than an asymptotic one.

**Salvaged `BlockBufferRenderer` import in `src/renderer/tmux-window.ts`.** A latent missing-import at `d1e29a2`: the class was instantiated on line 41 (`new BlockBufferRenderer(visibility)`) without being imported. This was a working defect that didn't bite because every smoke test ran `--single` (the `TmuxWindowRenderer` path was never instantiated). One-line fix bundled into this stage's source commit.

#### Problems faced and solved

**Ink's overflow check is inclusive.** `node_modules/ink/build/ink.js:121` reads `if (outputHeight >= this.options.stdout.rows)`. The earlier `CHROME_ROWS = 6` constant gave `K = stdout.rows - 6`, meaning `K + chrome = stdout.rows` exactly when chrome rendered at 6 — equality is enough to fire the overflow branch. Three independent runtime reproductions during smoke testing (rendering a 5KB file with prior session content in scrollback) showed prior-turn content briefly painted on screen mid-stream. Mechanism: when overflow fires, Ink writes `clearTerminal + fullStaticOutput + output` — the *entire session's* `<Static>` content, from the top. Bumping `CHROME_ROWS` to 10 added 4 rows of headroom, enough to absorb chrome transients without crossing the ceiling.

**`<Static>` is append-only across the whole session.** Ink's `fullStaticOutput` accumulates every `<Static>` item emitted since the React tree mounted and is never reset — not even by the renderer's own `clearAll()` (which only resets `_committed`; `fullStaticOutput` is Ink-internal state). So any overflow event re-emits *every* turn's committed content, not just the current turn's. This is what made the symptom so disorienting: "tables from a totally unrelated prior prompt flashed during a smooth file render." The fix is structural: keep the dynamic region strictly below `stdout.rows` so the overflow branch never fires in the first place.

**`marked-terminal` is not prefix-closed.** The prior dead-end (Stage 10.7/10.8/10.8.1 from the failed-experiment chain) tried to commit *source* prefixes mid-stream by detecting markdown block boundaries. This is structurally unsound: a prefix's rendered output can change based on what follows (loose lists become tight when an extra paragraph appears between items, reference links resolve when the reference definition arrives later, setext headings need their underline, etc.). The C1.4 byte-equality invariant relied on committing only at "safe" boundaries, and each boundary heuristic missed a different class of input. **Solution:** never commit a parsed *source prefix*. The renderer parses the *full active buffer* on every render, and `_commitActiveText` only fires on natural lifecycle events (turn-end, role transition) when the source is *complete*. Bounding the active region's *display* (not its parsed extent) decouples height safety from markdown correctness.

**High-token-rate streams produced bursty visual cadence.** The Stage 10.4 flush-on-newline path was unconditional: every delta containing `\n` triggered an immediate full-buffer marked re-parse plus `emit("changed")`. Tool-result content arrives as a few large chunks (smooth — handful of immediate renders); model-generated content arrives at many tokens per second, often with newlines in every delta (bursty — dozens of full-buffer re-parses per second). Operator observation: file rendering was "almost reading speed" smooth; 600-line generated markdown was "very bursty AND caused screen flickers." 80 ms throttle on the immediate path cuts the cadence to ~12 Hz max for fast streams without affecting slow streams (whose inter-delta gap already exceeds 80 ms).

**Throttle vs. C1.4 freshness invariant.** Throttling the immediate render meant `_activeBlockAnsi` could be stale at call-time. The C1.4 test (`live == one-shot parse of full source`) failed because the test captures `getActiveBlockAnsi()` immediately after feeding the full source via 64-byte chunks with 1 ms gaps, and the throttle skipped most intermediate renders. Solution: make `getActiveBlockAnsi()` lazy-flush via `_flushDebounce()` on each call. Pending timer (if any) is force-rendered synchronously, then the fresh ANSI is returned. Steady-state hot path unaffected (no-op when no timer is pending).

**Old debounce tests probed the wrong thing.** Two tests in the Stage 10.4 debounce suite used `expect(getActiveBlockAnsi()).toBe("")` as an indirect probe for "no automatic emit has happened yet." Once `getActiveBlockAnsi` became lazy-flush, that probe no longer worked — calling it forced a render. The tests' actual contract — that non-newline deltas do not fire `emit("changed")` — is preserved, but observable only via direct event counting. Both tests rewritten to count `changed` emits directly; same property, more accurate test.

**Multi-line `PromptInput` and modal overlays mutate chrome height.** Single-line input + single-line status + horizontal rule + marginBottom={2} totals 5 rows; multi-line input or any modal adds 2–5 more. With a tight `CHROME_ROWS = 6` reserve, a 1-row chrome bump was enough to cross the overflow ceiling. The `CHROME_ROWS = 10` reserve absorbs chrome transients up to 4 extra rows above the typical 5 — safe for the typical multi-line-input + small-modal case.

#### Future issues — potential problems & future work

1. **Very large modal stacks** (chrome ≥ 9 simultaneously with K=44 on a 54-row pane) could still cross the overflow ceiling. The fix would be one of: (a) bump `CHROME_ROWS` to 12+ (costs 2 more rows of visible tail), (b) make `CHROME_ROWS` modal-aware (subtract modal height dynamically — needs modal subtree height threaded into the cap computation), or (c) accept the limitation and patch on report. No known operator complaint yet.

2. **No way to clear Ink's `fullStaticOutput`.** Even after `renderer.clearAll()` resets the React-visible `_committed` array, Ink's internal accumulated `<Static>` buffer survives — and any future overflow would re-emit *all* of it. If Stage 10.7's cap math is ever defeated, the user sees content from sessions ago. Workaround in practice: kill and re-launch octmux for a true session reset. A long-term solution would require either patching Ink (write `fullStaticOutput = ""` on session reset) or remounting the whole React tree on `clearAll`.

3. **Single block taller than the screen has mid-stream scroll-out.** A markdown response taller than `K=44` rows shows only the trailing 44 lines during streaming; earlier content is invisible until the block commits at turn-end (then becomes terminal-native scrollback). Acceptable for normal markdown rendering, but limits the UX for "stream a long verbatim block" scenarios. **Future work (deferred to a future Stage 10.x):** "rendered-line watermark" mechanism — progressively commit lines to `<Static>` as they scroll above the K-line window, driven by the same `maxRows` from the surface. Keeps mid-block scrollback at the cost of a tiny residual risk that a late re-parse re-styles an already-committed line (the non-prefix-closed cases).

4. **80 ms throttle is empirical, not derived.** It works well for the observed model token rates (Sonnet, Haiku). Faster future models, or pathological streams with many tiny `\n`-bearing deltas, could still produce visible bursts. The throttle is easy to tune (single literal `80` in `block-buffer.ts`), but a more principled approach would adapt the throttle to recent delta rate (raise it under sustained high load, lower it for low-rate streams). Not worth doing without runtime evidence.

5. **Child-session event routing (`match=false` in earlier capture logs).** A separate concern surfaced during the failed-experiment phase: some deltas arrived with `isTrackedChild=false`, suggesting a routing issue in `src/events.ts`. Orthogonal to the height ceiling; deferred until/unless a defect surfaces post-Stage 10.7.

6. **No `OCTMUX_MAX_ACTIVE_LINES` env override.** Operator explicitly declined this knob in Phase 0. If runtime tuning of `K` becomes useful (e.g., for very tall or very short terminals), adding the env override is a one-line change in `src/app.tsx`. No rebuild semantics other than re-launching octmux.

7. **Wide terminals waste left/right tail capacity.** The cap counts *visual rows*, including wrapped lines. On a 200-column terminal a `marked-terminal`-rendered code block typically uses ≤80 cols of width; the rest is whitespace. The cap correctly counts unwrapped rows (1 visual row per logical line) so wide terminals get full benefit; but a truly pathological multi-KB line that never wraps could still push a single "logical" line over the cap. The `tailSliceByVisualRows` helper handles this case correctly — a single over-long line either fits as one visual row or wraps and gets accounted for — but the slice may discard otherwise-visible context.

#### Test result

All 109 tests pass — 98 baseline (Stages 10.1 → 10.6) + 9 new surface tests in `src/components/ActiveBlock.test.ts` + 2 new renderer tests in the `Stage 10.7 — _commitActiveText array-replace` describe block of `block-buffer.test.ts`. Two existing Stage 10.4 debounce tests updated to observe via `emit("changed")` counts instead of the now-stale `getActiveBlockAnsi() === ""` probe.

#### Build

`dist/octmux` rebuilt successfully (833 modules; no new dependencies). Symlink `~/.local/bin/octmux.block-render` → `dist/octmux` already in place. Three operator smoke tests post-implementation: (a) render `/var/tmp/render-this-as-markdown.md` verbatim — smooth, no flicker, no reset; (b) generate a 600-row markdown with all known markers — smooth, no flicker, no prior-turn content; (c) cross-turn render after generated content — confirmed PASS by operator.

---

### 2026-06-09--12-43 — Stage 10.8 — Inter-message blank line + Static empty-line fix

**Implemented by:** Actor (Claude Haiku 4.5) — 2026-06-09--12-43
**Commit(s):** `85c3545`

#### Design

Two coordinated edits fix observed real-model-output rendering defects.

**Edit A — `<Static>` empty-line workaround (`src/app.tsx:1285`).** Ink's Yoga flex layout collapses `<Text>` with empty content to zero height. Marked-terminal correctly emits `\n\n` between block-level elements; those arrive in `_committed` as `CommittedLine.ansi: ""` and silently vanish. The fix mirrors the workaround already present at `ActiveBlock.tsx:39`: render empty lines as a single space so Ink reserves the row.

**Edit B — `Block.meta.messageID` threading.** Extended `Block.meta` (`src/blocks.ts`) and `ReplEvent["block-start"]` (`src/events.ts`) with optional `messageID?: string`; populated at the text-part block-start emit site from `part.messageID` (already in scope). `app.tsx` block-start dispatch forwards via `meta`. `BlockBufferRenderer` gains private field `_lastTextMessageID: string | null = null` and, in `beginBlock`, injects one `CommittedLine` with `ansi: " "` (space — same Ink-quirk workaround `commitTurnEnd` uses) before opening a new text block whose messageID differs from `_lastTextMessageID`. Field reset in `clearAll()` and `dispose()`.

The renamed `meta?` parameter (was `_meta?`) of `beginBlock` in `block-buffer.ts` — implementations on `stdout.ts` and `tmux-window.ts` continue to ignore `meta` (`_meta?` there).

Bundled cleanup: 9 stale source-code annotations that referenced a transient pre-consolidation label were renamed to "Stage 10.7" (left over from the earlier Stage 10.7 consolidation that renamed commits/docs but missed source annotations). 2 stale refs in this very doc also cleaned up. Memory file refs similarly reframed (preserving the historical git tag `stage-11-as-implemented` as a literal commit-pinned tag name).

#### Problems faced and solved

Operator observed wall-of-text rendering with real model output (vs oc-history's properly-spaced output). Phase 0 probes showed: (1) marked-terminal already emits `\n\n` between blocks, so the gap was downstream; (2) the `<Static>` lambda lacked the empty-line workaround that `ActiveBlock` already had; (3) consecutive assistant messages have no per-message boundary in the scrollback because `Block.meta.messageID` was never threaded.

Ink Yoga's empty-text → zero-height quirk: confirmed by direct comparison with `ActiveBlock.tsx:39`'s long-standing workaround. The same quirk affects `<Static>` children. The fix mirrors the same pattern symmetrically.

`Renderer.beginBlock(partID, role, meta?)` exposed an unused `meta?` hook — the natural place for messageID. No new API surface; the existing hook just started being used.

Bundled cleanup of stale source-code annotations (from a transient pre-consolidation label) addressed the operator-flagged version-numbering inconsistency in the same commit. (Third operator flag on version-inflation; updated `feedback-version-numbering` memory.)

#### Future issues / future work

- **Demarcation is messageID-only.** Operator picked Q1=c (blank line only). If a future stage wants a model badge / timestamp header at the message boundary, the `_lastTextMessageID` transition check in `beginBlock` is the injection point.
- **Non-text roles are unaffected.** Tool blocks carry per-tool ANSI headers via `formatLine`. Reasoning streams to a side window in multi-window mode.
- **`<Static>` `fullStaticOutput` accumulation (inherited from Stage 10.7).** Surfaced blank lines that were previously zero-height are now visible in Ink's accumulation buffer. Any future overflow event will re-emit them. The Stage 10.7 cap math continues to be the primary overflow guard; this stage does not worsen the risk.
- **User-message demarcation deferred.** Operator picked Q4=fine as-is.


---

### 2026-06-09--18-43 — Stage 10.8.1 — Inter-message dim-timestamp demarcation

**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-06-09--18-43
**Commit(s):** `82c5a9b` (final form), `6602288` (3-line block), `ff4d006` (timestamp inject), `a35a360` (Box wrapper, vestigial), `3164f64` (OCTMUX_DEBUG_RENDER instrumentation, kept)

#### Design

Between consecutive assistant text parts (different `meta.messageID`), `BlockBufferRenderer.beginBlock` injects a **3-line demarcation block**:

```
<empty line>
[YYYY-MM-DD HH:MM]      ← in dim ANSI (\x1b[2m … \x1b[22m), like marked-terminal's `hr` style
<empty line>
```

All 3 `CommittedLine`s are pushed as ONE `array-replace` so the surrounding empty rows ride along with the timestamp in the same batch. This relies on the same mechanism that makes within-message blanks render correctly (the Static empty-line workaround at `src/app.tsx:1285` renders `ansi: ""` as `<Text>{" "}</Text>`, which Ink preserves when surrounding items in the same batch carry substantive content).

Format:
- **Timestamp**: local time, single-space `YYYY-MM-DD HH:MM` (NOT the project's doc-filename format `YYYY-MM-DD--HH-MM`).
- **Brackets**: `[ … ]` around the timestamp.
- **Dim styling**: `\x1b[2m[YYYY-MM-DD HH:MM]\x1b[22m` — the brackets are inside the dim wrap so the whole token reads as dim/grey.

`Block.meta.messageID` threading (introduced in Stage 10.8) is unchanged — the messageID is what triggers the transition check. `_lastTextMessageID` is reset in `clearAll()` and `dispose()` for session-switch hygiene.

`OCTMUX_DEBUG_RENDER=1` instrumentation (env-gated stderr lines printing `partID`, `meta.messageID`, `_lastTextMessageID`, `willInject`, and `INJECT FIRED + committed.length`) is **kept** at commit `3164f64`. Zero overhead when the env var is unset; useful for future diagnostic rounds.

#### Problems faced and solved

**Load-bearing finding: Ink/Yoga collapses standalone single-whitespace `<Text>` rows when they arrive as standalone Static appends.** When a `CommittedLine` with `ansi: " "` (or `ansi: ""` rendered via the Static workaround as `<Text>{" "}</Text>`) is pushed via a *single-item* `array-replace + emit("changed")`, Ink/Yoga measures the `<Text>` content as zero-width and drops the row from the layout entirely. Within-message blanks (also `ansi: ""`) render correctly because they are part of a *multi-item batch* from `_commitActiveText` (which splits `_activeBlockAnsi` on `\n` and pushes all lines together).

This asymmetry was empirically established via the diagnostic chain:

| Commit | Inject content | Operator-observed result |
|---|---|---|
| Stage 10.8 baseline (`85c3545`) | `" "` (single space) | No visible blanks between text parts |
| `15d809a` (partID variant; reverted in `fda7db7`) | `" "` (single space) | No visible blanks |
| `3164f64` | (added `OCTMUX_DEBUG_RENDER` instrumentation) | Log: 7 `INJECT FIRED` lines for 8 text parts; `committed.length` grew by 1 each time → **inject was firing correctly** |
| `a35a360` (Box wrapper) | `" "` (single space) — STILL standalone | No visible blanks → **Box wrapper was not the fix** |
| `3127a51` (visible marker) | `"··· · · ···  [Stage 10.8 demarcation marker]"` | Marker visible 4× in tmux pipe-pane capture → **content was the fix** |
| `ff4d006` → `6602288` → `82c5a9b` (final) | `[dim YYYY-MM-DD HH:MM]` as 3-line batch | All 8 text-part transitions visible; operator-verified smoke test |

Other lessons documented from the cycle:
- **Static analysis was wrong twice in a row** before the diagnostic chain produced empirical evidence. Stage 10.8's messageID-based inject and the partID-based attempt (`15d809a`) both passed static review but failed empirically. The OCTMUX_DEBUG_RENDER + tmux pipe-pane methodology is the correct posture for this layer.
- **The Edit tool silently converted literal `" "` (regular space) into `"\u00A0"` (non-breaking space) in two iterations of source edits.** Caught only when a Python `str.replace` literal-match couldn't find the expected `old_line`. Worth being suspicious of single-whitespace replacements via the Edit tool — for those, use `Bash` + Python's literal `str.replace` and verify byte-by-byte.

#### Future issues / future work

- The `<Box>` wrapper introduced in `a35a360` for `<Static>` items is **vestigial** — the empirical chain showed content (not layout) was the determining factor. Kept here as belt-and-suspenders; removable in a follow-up if minimum-churn is desired.
- `Block.meta.messageID` threading (`src/blocks.ts`, `src/events.ts`, `src/app.tsx`) is **still required** — `messageID` is the demarcation trigger. Not dead code.
- **Dim styling uses raw ANSI escapes** (`\x1b[2m … \x1b[22m`) inline. If the marked-terminal aesthetic later changes (e.g. via a different `chalk.dim` style), this inline sequence won't update with it. Consider centralising the dim sequence as a constant if more code paths need it.
- **Timestamp uses local time** (`new Date()`). If the project moves to UTC display elsewhere, this is one place to update.
- **Empty-line behaviour with `ansi: ""` depends on batch context** (the Static workaround + same-batch substantive content). If a future refactor changes how `<Static>` items are batched, this could regress silently. Two new tests in `src/renderer/block-buffer.test.ts` under the `Stage 10.8 — Inter-message demarcation` describe block guard the 3-line structure (`/^\x1b\[2m\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\x1b\[22m$/` regex) and the same-messageID negative case.
- **Truly large modal stacks** (chrome ≥ 9 with K=44 on a 54-row pane) could still trigger the Stage 10.7 overflow guard. Unchanged from Stage 10.7; documented limitation.

#### Test result

All 111 tests pass / 0 fail (235 expects in baseline; 5 new expects in updated Stage 10.8 inter-message demarcation describe block bring total to 240).

#### Build

`dist/octmux` rebuilt at 18:43 (98,826,368 bytes — slightly larger than the previous Stage 10.8 binary due to the dim-ANSI string literal payload). Symlink `~/.local/bin/octmux.block-render` already points to it.

---

### 2026-06-09--19-55 — Stage 10.8.2 — Bump marked 15→17 to fix list-item bold rendering

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-09--19-55
**Commit(s):** `6568184`

#### Problem statement

Stage 10.8.1 (and all prior stages) use `marked@15.0.0` with `marked-terminal@7.3.0`. In this configuration, inline formatting (like `**bold**`) inside list items (`1. ...` and `- ...`) renders as literal asterisks with no ANSI bold codes — the markdown is structurally correct but visually indistinguishable from plain text. Paragraphs and headings with bold rendered fine, isolating the defect to the list-item parser/renderer interaction.

Empirical matrix (markdown source with various bold contexts, rendered via the current BlockBufferRenderer):

| Content | marked 15.0.0 result | marked 17.0.1 result |
|---------|-----|-----|
| `**bold in text**` | ANSI bold | ANSI bold |
| `# **bold in heading**` | ANSI bold | ANSI bold |
| `> **bold in quote**` | ANSI bold | ANSI bold |
| `1. **bold in list**` | Literal `**` (0 ANSI codes) | ANSI bold |
| `- **bold in bullet**` | Literal `**` (0 ANSI codes) | ANSI bold |

#### Root cause

marked 15's parser interaction with marked-terminal's inline tokenizer disabled inline parsing for list-item content. By v17, this was fixed.

#### Solution

Bump `marked` dependency from `15.0.0` to `^17.0.1`. No source-code changes required — the `Marked` class constructor call and `m.use(markedTerminal({...}))` extension setup remain unchanged and compatible across the version range.

#### Verification

- `bun install`: installed `marked@17.0.6` (≥17.0.1, <18)
- Binary build: exit 0, 833 modules
- Test suite: 111 pass / 0 fail (240 expect calls)

No source code changed; no breaking API calls; test baseline unmodified and fully green.
