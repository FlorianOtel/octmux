---
title: "octmux block-renderer — Brain series handover (CLOSED SERIES RECORD)"
branch: "main"
head_at_handover: "6326949 (series closed at Stage 11.3)"
created: 2026-06-08
revised: 2026-06-11 (rev 8 — known-risk-factors quick-reference added at top; rev 7 — Stage 11.2 shipped (9bafdce); Stage 11.3 closeout (C-7 fix, per-delta instrumentation, doc closure); rev 6 — B shipped; rev 5 — A.3+A.4 shipped; rev 4 — implementation log lives in this doc; rev 3 corrected paths/line offsets, retired C-4, marked shape-stable note, Part 0 re-verified @85b2414, A.1+A.2 shipped)
updated_by: "Claude Code (Claude Fable 5)"
updated_at: 2026-06-11--20-25
maintained_as: "CLOSED SERIES RECORD — Stage 11 complete; see § Series closeout for the operator-testing watch list"
authored_by: "External analysis session (Claude), grounded in the feat/block-renderer tree + Ink 5.2.1 / marked-terminal 7.3.0 source"
how_to_use: >
  This document is a CLOSED SERIES RECORD capturing the Stage 11 block-renderer work
  (Stages 11.0–11.3). Part 0 is the definitive architectural ground truth for the
  dynamic-region invariant and the render design — preserved for any future renderer work.
  The per-work-package sections (WP-A, WP-B, WP-C) are historical: all items listed have shipped.
  The § Series closeout section at the end is the operator-facing reference: it lists the
  watch list (open items for future work), the per-stage one-liners with commits, and the
  debug instrumentation calibration how-to. See that section first when investigating
  renderer behavior in the field.
---

# octmux block-renderer — Brain series handover (CLOSED SERIES RECORD)

## Known risk factors — how they may manifest

Quick-reference for operator testing: each open risk, what you would actually SEE if it bites,
and how to capture evidence. Full detail (triggers, capture commands, future-work pointers) in
§ Series closeout at the end of this document.

| Risk | How it may manifest | Likelihood / severity | Capture |
|------|---------------------|----------------------|---------|
| **C-8 — 80-col layout floor** (prose/Rules; tables are exempt since 11.2) | On a pane narrower than 80 columns: `Rule` separator lines run past the right edge and wrap; prose wraps at column 80 instead of the pane width, producing ragged spill-over lines. Tables are NOT affected (they budget against the real width). | Likely on sub-80 panes; cosmetic-to-disruptive | note pane width + `tmux capture-pane -p -S -200` |
| **C-2 — child-session SSE routing** | During multi-agent turns (e.g. a /brain dispatching subagents): model output missing from the transcript, or fragments appearing twice, or content interleaved out of order. | Unknown (never reproduced under instrumentation); high severity if real | `OCTMUX_DEBUG_SSE=1 OCTMUX_DEBUG_RENDER=1`, keep stderr; `tmux capture-pane -p -S -200` |
| **tmux SIGWINCH lag** | Immediately after a pane split (esp. with `pane-border-status` on): the layout briefly renders at the pre-split geometry — content too wide/tall for one frame — then corrects on the next resize event or delta. | Occasional; transient by design | none needed unless it does NOT self-correct |
| **C-3 — scrollback layout cost** | In very long sessions (>150 turns): keystroke echo and re-renders feel sluggish (one Yoga node per scrollback line). | Low; performance-only | note turn count + subjective lag |
| **C-5 — O(N²) re-parse** | While a single very large text block (≈50 KB+) is streaming: CPU pegs and the live tail stutters; recovers when the block commits. | Low; bounded by the 80 ms throttle | `top` during the stream |
| **Expected behaviors (not bugs)** | (a) Tables already in scrollback keep the width they were committed at after a resize (like `less`/tmux); (b) a streaming table's columns re-balance ("jump") between frames, settling on completion; (c) literal `:emoji_shortcodes:` inside table cells stay literal (unicode emoji render fine); (d) wrapped table-cell continuation lines can lose 256/true-color tint (cosmetic). | By design / accepted | revisit triggers in § Series closeout |

If a flash of past-turn content recurs (full screens of old output between frames), that is the
Part 0 §0.1 overflow branch — capture `OCTMUX_DEBUG_RENDER=1` stderr (the per-delta trace shows
`lines=` vs the cap) plus `tmux capture-pane`, and check it against the closed items C-1/C-7
before assuming a new cause.

## Status tracker

| WP | Topic | Priority | Status | Gating unknown |
|----|-------|----------|--------|----------------|
| A.0 | Flash cause — already attributed in-tree; conservative-cap as regression check | DONE-ish | ✓ closed (subsumed by A.2+A.3; regression check retired) | — |
| A.1 | Hygiene: debug instrumentation cleanup | high (quick) | ✓ shipped | — |
| A.2 | **Geometry liveness: `useTerminalSize` resize hook** (keystone; prereq for A.3 + WP-B) | **highest** | ✓ shipped | — |
| A.3 | Airtight cap: measure chrome, strict headroom (the chrome-budget half of the flash fix) | highest | ✓ shipped | — |
| A.4 | Pathological single-line blanking | medium | ✓ shipped | — |
| B | Real terminal size + table wrapping | high (UX) | ✓ shipped | — |
| C | Open investigations | ongoing | ✓ closed (see § Series closeout — open items moved to watch list) | — |

> **Re-sequencing note (rev 2, historical):** the "flash / overflow" fix was split into TWO items — **A.2** (the resize hook, which fixes the resize-during-pause flash) and **A.3** (measure the chrome, which fixes the chrome-budget boundary flash); A.2 was also the prerequisite for WP-B's "re-fit tables on resize". Shipped in order A.1 → A.2 → A.3 (Stages 11.0–11.1).

---

## Part 0 — Load-bearing shared context

These are the facts that took ~8 data points and 6 failed fixes to establish on this
branch. A Brain session that re-derives them wastes the budget; a session that
contradicts them is wrong. Treat as ground truth unless a [HIGH-CONF] test overturns it.

> **Verified at HEAD 6326949 (2026-06-11):** A.1–A.4 and WP-B shipped (Stages 11.0–11.2);
> §0.4 line references current as of this HEAD. block-buffer lives at `src/renderer/block-buffer.ts`.
> All [VERIFIED] tags below hold against the live tree on `main` at this commit.

### 0.1 The master fact — Ink's dynamic-region height ceiling [VERIFIED]

Ink 5.2.1 renders the tree as two streams (`ink/build/renderer.js`): the **dynamic**
output is built with `renderNodeToOutput(node, output, { skipStaticElements: true })` —
it *excludes* `<Static>`. The dynamic region in octmux is `ActiveBlock` + `ctrlcPending` +
any mounted modal + the bottom chrome `<Box>` (SubprocessStatus, Rules, PromptInput,
StatusLine, `marginBottom={2}`). Its height is `outputHeight`.

In `ink/build/ink.js:121`:

```js
if (outputHeight >= this.options.stdout.rows) {
    this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
    this.lastOutput = output;
    return;
}
```

When the **dynamic region alone** meets/exceeds `stdout.rows`, Ink abandons the
incremental path and, **every frame until it drops back under**, clears the screen
(`\x1b[2J\x1b[H`) and re-emits the *entire* accumulated static history plus the dynamic
output. **The single invariant that must hold at all times is: `outputHeight < stdout.rows`.**
It is a pure line-count (visual-row) invariant; it has nothing to do with markdown structure.

### 0.2 The `<Static>` asymmetry and `fullStaticOutput` [VERIFIED]

- `<Static>` content is written once and scrolls in the terminal's native scrollback. It
  is **never counted toward `outputHeight`** and has **no height limit**. It is also
  **index-tracked**: on each render Ink emits only items *beyond* the count it has already
  written, so when `committed` is unchanged the static output for that frame is empty.
  (This is why the renderer commits completed content to `<Static>` and keeps only a
  bounded live tail in the dynamic region — and why an ordinary re-render is cheap.)
- Ink keeps the entire session's static output in a single string `fullStaticOutput` that
  **only grows** (reset solely on unmount; `clearAll()` / `/compact` do not shrink it).
  On the happy path this copy is never read. It is read **only** by the overflow branch in
  0.1, which re-emits all of it. **This is the only path that re-renders history** — an
  ordinary React re-render does not. Consequence: an overflow frame costs O(session
  length); at >150 turns it visibly scrolls the whole history through the viewport. That is
  the "old-turn flash" (WP-A).

### 0.3 The current octmux render design (post-reset) [VERIFIED]

The branch was reset onto `d1e29a2` (the memoised-`getActiveBlock` freeze fix) and the
fragile incremental-commit-by-markdown-semantics subsystem was discarded. The current
design:

- **One-shot re-parse:** `_renderActiveTextAnsi()` parses the *entire* active text buffer
  through marked + marked-terminal on every flush (`block-buffer.ts`). No incremental/
  piecewise parse, no markdown-boundary heuristic. This is the key enabler downstream: any
  width/size change is picked up for free on the next re-parse, with zero incremental state.
- **Bounded live tail (the cap):** `ActiveBlock` displays only the last `maxRows` visual
  rows of the rendered active block (`tailSliceByVisualRows`, bottom-up, wrapped-row aware).
  `maxRows` is computed in `app.tsx` from terminal rows.
- **One-shot commit:** at block-end / role transition / turn-end, the full rendered block
  is split on `\n` and array-replaced into `_committed` (→ `<Static>`). `getCommitted()`
  returns a new array reference on every commit (no in-place push).
- **Freeze fix:** `getActiveBlock()` returns a memoised wrapper keyed on `_activeTextBuf`
  identity; do not regress this (prevents a `useSyncExternalStore` Object.is storm).
- **Throttle + debounce:** immediate render on `\n` if ≥80 ms since last emit; a 100 ms
  trailing-edge timer is the safety net; every lifecycle commit pre-flushes via
  `_flushDebounce()` (which re-renders). No final-render gap.

### 0.4 Verified file/line map (at HEAD 6326949)

| Thing | Location |
|-------|----------|
| Cap math (measured) | `src/app.tsx:324` `const restRef = useRef<any>(null)`; `:326` `useLayoutEffect` (no deps) measuring restRef; `:335` `const maxActiveRows = Math.max(1, rows - restRows - 1)` |
| Width into renderer | `src/app.tsx:332` `const w = Math.max(80, columns ?? 80)` (LAYOUT-only — the floor is never passed to the renderer); `:338-340` `useEffect(() => renderer.setWidth(columns ?? 80), [columns, renderer])` — real `columns` to the renderer; effect fires on resize via the A.2 hook. |
| `<Static>` + Box-per-item workaround | `src/app.tsx:1441–1458` (Box wrapper at :1455) |
| Measured chrome wrapper | `src/app.tsx:1462-1523` `<Box ref={restRef} flexDirection="column">` wraps ctrlcPending through chrome box; `:1463` ctrlcPending inside wrapper |
| `<ActiveBlock ... maxRows={maxActiveRows}>` | `src/app.tsx:1461` |
| Chrome composition (dynamic, below restRef wrapper) | `src/app.tsx:1496–1523` (nested `<Box flexDirection="column" marginBottom={2}>` with SubprocessStatus, pendingQueue?, Rule(sessionLabel), PromptInput, Rule, StatusLine, PermissionStatusLine, ToggleStatusLine) |
| `useTerminalSize()` hook | `src/app.tsx:227–240` (subscribes to stdout resize, returns live size state) |
| Cap slice helpers | `src/components/ActiveBlock.tsx` `stripAnsi`, `visualRows`, `tailSliceByVisualRows` |
| One-shot render | `src/renderer/block-buffer.ts:200` `private _renderActiveTextAnsi()` |
| Commit (array-replace) | `src/renderer/block-buffer.ts:519` `private _commitActiveText()` |
| Width field | `src/renderer/block-buffer.ts:136` `private _width = 80` |
| setWidth with re-render | `src/renderer/block-buffer.ts:624` `setWidth(width)`: no-op if unchanged; re-renders + emits if active text block |
| marked instance builder | `src/renderer/block-buffer.ts:53` `function _makeMarkedInstance(getWidth: () => number)` (free function; closure over `_width`); includes table override |
| Per-delta trace | `src/renderer/block-buffer.ts:306-313` inside appendToBlock TEXT branch; fires only when OCTMUX_DEBUG_RENDER=1 (direct env guard) |
| Debug instrumentation | `src/renderer/block-buffer.ts:225–228` private `_dbg(msg)` helper (single `OCTMUX_DEBUG_RENDER` check); called at :252, :272, :276 |
| getActiveBlock | `src/renderer/block-buffer.ts:574` memoised wrapper keyed on `_activeTextBuf` identity (cache fields ~:166–179) |
| Table column-width algorithm | `src/renderer/table-layout.ts` `naturalWidths`, `computeColWidths`, `wrapCell` |
| marked-terminal reflection | `marked-terminal@7.3.0/index.js:237` → `cli-table3@0.6.5`; `reflowText` applied at `:127,207` (paragraph/text/hr — **never** to tables) |
| Ink resize wiring | `ink/build/ink.js:77` `stdout.on('resize', resized)`; `:83` `resized = () => { calculateLayout(); onRender(); }` |

### 0.5 Empirical anchors already gathered (do not re-run unless testing a change)

- `/var/tmp/render-this-as-markdown.md` renders one-shot to **73 logical lines** (~75
  visual rows at width 190) vs a ~48-row threshold on a 54-row pane → deterministic
  overflow at commit `a887d63`/`d1e29a2` (which has no cap). This is why the cap exists.
- **The flash is already attributed in-tree** [VERIFIED]: in-tree git history recorded three
  independent reproductions of fullStaticOutput re-emission during development — this is
  confirmed as the 0.1 overflow branch. The empirical fix: `CHROME_ROWS` was bumped 6→10;
  this is a **partial** mitigation — it does not close the `>=` boundary, does not count
  modals, and does not cover stale geometry on resize-during-pause (0.6). Stage 11.2
  shipped A.2 + A.3, the complete fix (measured chrome cap + live geometry).
- On a 54-row pane with the old fixed budget: `maxActiveRows = 54 − 10 = 44`. Full active
  block (44) + chrome budget (10) = 54 == rows → overflow boundary (Ink uses `>=`). New
  measured approach (A.3): `maxActiveRows = Math.max(1, rows - restRows - 1)` adapts to
  the real chrome height; closed-border strict headroom eliminates the boundary case.

### 0.6 Geometry is refreshed on React re-render (via the A.2 hook, in all states) [VERIFIED]

**Background (pre-11.0 behavior):** Ink's terminal resize does not re-run React. Ink
subscribes to `stdout` `'resize'` in the instance (`ink.js:77`); `resized()` =
`calculateLayout()` (re-flow Yoga at the live terminal width) + `onRender()` (re-*serialize*
the fiber via `render(rootNode)` — **no `reconciler.updateContainer`**). Without a React
hook subscribing to resize, values read from `stdout.columns/rows` in component bodies stay
stale until the next re-render from a delta. The overhead of re-parsing and re-rendering was
acceptable when geometry was only needed during streaming; but during pauses (between
PartIDs, tool calls, idle) a resize-smaller would not trigger a React re-render, leaving
`maxActiveRows` stale-large, and pushing the dynamic region over the Ink overflow boundary.

**Current (post-11.0):** The `useTerminalSize()` hook (A.2, Stage 11.0) subscribes to
`stdout` resize and lifts terminal dimensions into React state. On any resize, `setSize`
updates state, forcing a React re-render that recomputes `maxActiveRows` and `w`, and runs
the `setWidth(columns ?? 80)` effect. Geometry is **live in all states** (streaming, paused, idle).
Re-renders triggered by resize are cheap — dynamic region only; `<Static>` history is
never re-emitted (0.2). The cap is exact, not budgeted (A.3), so it closes the Ink
overflow boundary in all cases. This is the keystone fact that gates WP-B's resize re-fit.

### 0.7 Confidence legend

`[VERIFIED]` checked against source this session · `[HIGH-CONF]` strong hypothesis, named
test not yet run · `[DECIDE]` operator decision required.

---

## WP-A — Render robustness (hygiene → geometry liveness → airtight cap → edge bugs)

**Goal:** make the dynamic-region invariant (0.1) provably hold at all times and in all
states (streaming, paused, idle, resized), which eliminates both the residual overflow and
the long-session "screen flash". Order: hygiene first (clears the hot path), then the two
halves of the flash fix (A.2 resize liveness, A.3 chrome measurement), then the edge bug.

### A.0 — Flash cause: confirmed in-tree; keep one regression check [VERIFIED]

**Symptom:** in long sessions (>150 turns), the renderer flashes full screens of *old-turn*
content between frames, excludes the prompt area, subsides unpredictably, correlates with
bursty output and with resizing.

**Status:** confirmed as the 0.1 overflow branch — in-tree git history (since removed by
A.3) recorded three independent reproductions of `fullStaticOutput` re-emission during
development, and `<Static>` re-render is ruled out [VERIFIED] (`retagBlock`/
`commitCompactionDivider` are append-only; Static is index-tracked, 0.2). Two distinct
triggers: (a) the fixed chrome-budget boundary (addressed by A.3's measured cap), and
(b) stale geometry on resize-during-pause (addressed by A.2's resize hook).

**Regression check (keep, do not treat as discovery):** with the conservative cap below,
the flash should be gone; re-narrowing the margin should bring it back — a quick before/after
when validating A.2+A.3.

```ts
// app.tsx — temporary regression probe
const maxActiveRows = Math.max(16, (rows) - 24);   // vs production - 10
```

### A.1 — Hygiene: debug instrumentation cleanup [VERIFIED, low risk] (do first)

`block-buffer.ts beginBlock` carries `OCTMUX_DEBUG_RENDER`-gated `process.stderr.write`
calls and the `[octmux-render] → INJECT FIRED` line. Env-gated (harmless at runtime) but
noisy; the inject is confirmed working.

- Extract all `OCTMUX_DEBUG_RENDER` writes into one private `_dbg(msg)` helper, or remove
  outright. Keep one structured opt-in trace available for WP-C (see C instrumentation spec)
  — de-noise the hot path, don't delete the capability.

**Blast radius:** none (gated debug only). **Done:** `beginBlock` reads cleanly; behavior
unchanged with the env var unset; suite green.

### A.2 — Geometry liveness: `useTerminalSize` resize hook [VERIFIED gap; keystone] (highest)

**Shipped in Stage 11.0 (commit `fd3e3a6`).**

The `useTerminalSize()` hook subscribes to `stdout` resize and lifts size into React state.
`maxActiveRows` and `w` derive from that state (Stage 11.0, `app.tsx:227–240`); a terminal
resize forces a React re-render, recomputing geometry in **all** states (streaming, paused,
idle). The re-render is cheap — dynamic region only; `<Static>` history is **not**
re-emitted (0.2). This makes the resize force a re-render so geometry is live in all states,
preventing the resize-during-pause overflow flash.

**Properties:** resize → `setSize` → re-render → cap + width recompute, `setWidth` runs,
tail re-slices — in any state. Prerequisite for A.3 (its `measureElement` re-runs on
re-render) and for WP-B (table re-fit on resize). Coalesced by the OS/terminal into a few
events per drag; each is a dynamic-region-only redraw.

**Blast radius:** `app.tsx` only (one hook; swapped inline reads for state). No renderer
change. Verified: resizing during a pause immediately re-caps the tail and re-fits the
chrome; resize-smaller during a pause no longer flashes; suite green.

### A.3 — Airtight cap: measure the chrome, don't budget it [VERIFIED gap; the chrome-budget half of the flash fix] (highest, after A.2)

**Shipped in Stage 11.1 (commit `293f0c5`).**

The measured-chrome cap replaces the fixed `CHROME_ROWS = 10` budget. Stage 11.1 wrapped
the non-ActiveBlock dynamic region (ctrlcPending through chrome box, `app.tsx:1462–1523`)
in `<Box ref={restRef}>` with a no-deps `useLayoutEffect` measuring it (`:326–330`). The
cap formula is now `maxActiveRows = Math.max(1, rows - restRows - 1)` — exact measurement
instead of budgeting. This adapts to a growing prompt, the queue line, the Ctrl-C hint,
a wrapped StatusLine, **and** any mounted modal. The strict `−1` closes the `>=` boundary.

**Properties:** exact, not budgeted — `measureElement` populates after layout (one-frame lag
on sudden chrome growth, covered by the conservative `restRows` fallback). A.2 ensures resize
triggers the re-render that re-measures. The `max(16,…)` floor is gone in favour of
`Math.max(1, rows − restRows − 1)`.

**Alternative considered:** compute `restRows` from known state (queue, editor line count,
status rows, ctrlc, modal rows) — synchronous, no lag, but hand-maintained. **Rejected in
favour of `measureElement`** — the measured approach adapts automatically to future chrome
changes without re-visiting the formula.

**Blast radius:** `app.tsx` render tree + `maxActiveRows` derivation. No renderer change.
Verified: A.0's flash gone at production margins; a 6-line paste in the prompt while a tall
block streams does not overflow; suite green.

### A.4 — Pathological single-line blanking [VERIFIED bug, low frequency]

**Shipped in Stage 11.1 (commit `293f0c5`).**

The `tailSliceByVisualRows` helper (ActiveBlock.tsx) now guards against blanking: if the
slice would be empty and the input is non-empty, return a single truncated line — the plain
text of the last line (ANSI stripped), capped to `Math.max(1, maxRows * Math.max(1, width) - 1)`
visible characters, marked with "…" at the end. Full styled content still commits to
`<Static>` intact. A pathological single over-tall line no longer blanks the live view; it
renders truncated, and operators see that output is being clipped (the "…" marker).

**Verified:** a line of length `> maxRows*width` renders a truncated tail (not blank); tests
cover the single-huge-line and `[a,b,c,<huge>]` cases at multiple maxRows settings.

### A.5 — Documented, NOT actioned now (record so a session doesn't "discover" them)

- **Demarcation/timestamp (10.8.1) + Box-per-Static-item (`app.tsx:1409`):** the per-message
  dim timestamp is product scope-creep that took a revert to stabilize, but the `<Box>`-per-
  item wrapper is **load-bearing** (Ink collapses standalone `" "` Static appends). Keep both;
  do not "simplify" the Box wrapper away. Minor cost: one Yoga node per scrollback line. See
  C-3 if very large scrollback shows layout cost.
- **O(N) re-parse per render → O(N²) per stream:** `_renderActiveTextAnsi` re-parses the full
  buffer each flush. Bounded by the 80 ms throttle; a non-issue for normal responses. See C-5.

---

## WP-B — Real terminal size & table wrapping

**Goal:** real model output puts long content in table cells; marked-terminal sizes columns
to content with no width bound, so tables overflow and the box-drawing wraps into unreadable
garbage. Make tables fit the *actual* terminal width, re-fitting the active table live —
**including during pauses, which requires WP-A.2**.

### B.0 — Size source: you already have it; the real issue is the floor [VERIFIED]

In a TTY, `process.stdout.columns/rows` **is** the live terminal size. Ink surfaces it via
`useStdout()`. Do **not** shell out to `stty size` — same number, fork/exec cost, and a race.
`stty size` is only a fallback when `process.stdout.isTTY === false`, where there is no
interactive render anyway. **The real defect:** the renderer uses `w = Math.max(80, columns)`
(layout-only constant, `app.tsx:332`). The 80-col floor means on a sub-80-col pane the
renderer believes it has 80 columns and tables (and prose) overflow regardless. **For the
table budget and wrap-width override, use the real `columns`, not the floored `w`.** The
table override reads `getWidth()`, which returns the real terminal width; this is correct.
With A.2 (the resize hook) in place, `columns` is live in all states, so table re-fit on
resize-during-pause works (the whole chain fires).

### B.1 — The table fix: custom marked override with content-preserving wrapping [VERIFIED, shipped Stage 11.2]

The table override (marked `table(token)` in `_makeMarkedInstance`, block-buffer.ts:53+)
renders each cell's tokens via `parser.parseInline(cell.tokens)`, computes per-column widths
to fit the current terminal width (`getWidth()`, a closure over `_width`), then pre-wraps
each cell with `wrapAnsi(parsed, colWidths[i]−2, {hard:true, trim:false})` and hands it to
cli-table3 with `wordWrap:false`. This ensures the table box fits the terminal and no content
is truncated — long tokens wrap across multiple rows within the budget.

**Design:** the width-discipline invariant — every pre-wrapped line ≤ `colWidths[i]−2` — is
the single load-bearing condition. `wrapAnsi` with `{hard:true}` maintains it. cli-table3
with `wordWrap:false` respects this invariant and never re-wraps or truncates (it would
truncate lines of `content+1`; pre-wrapping keeps us under that threshold). This is more
robust than the earlier `wrapOnWordBoundary:false` approach (which wraps on raw `.length`
and splits ANSI escapes — unsafe). The override returns the string in the form marked-terminal
expects (matching `section(...)` spacing / surrounding newlines).

### B.2 — Live width: threading + resize re-fit [VERIFIED plumbing, shipped Stage 11.2]

The one-shot re-parse (0.3) means the override re-fits on every render if it reads the live
width at parse time. Stage 11.2 shipped all three pieces:

1. **WP-A.2 hook in place** — a resize re-renders React, recomputes `w`, and runs the
   `setWidth` effect in all states (streaming, paused, idle). Without it, resize-during-pause
   never calls `setWidth`.
2. `_makeMarkedInstance(getWidth: () => number)` (free function, line 53) closes over
   `_width` so the override reads **live** width, not a construction-time const.
3. `setWidth` now re-renders the active block + emits on change when a text block is active
   (lines 624–632) — the active table's ANSI is re-parsed immediately on width change, not
   deferred until the next delta. All three pieces firing together: resize → A.2 re-render
   → `setWidth` effect runs → active table re-parsed with new width.

### B.3 — Column-width algorithm [shipped Stage 11.2]

The algorithm (src/renderer/table-layout.ts: `naturalWidths`, `computeColWidths`, `wrapCell`)
computes per-column widths to fit the real terminal width:

- `naturalWidths`: per-column = max **visible** cell width (strip ANSI, use `string-width`
  for emoji/CJK). Budget ≈ `realColumns − (3 · numCols + 1)` (cli-table3 border + padding).
- `computeColWidths`: if `sum(natural) ≤ budget`, use natural. Else: floor each column
  (~8 chars, or natural if smaller), distribute remaining budget proportionally to natural
  width.
- `wrapCell`: wrap each cell to its assigned `colWidth` using `wrapAnsi(..., colWidth−2,
  {hard:true, trim:false})` — maintains the width-discipline invariant for cli-table3.

### B.4 — Decisions & deferrals — see § Decisions & deferrals (11.2)

### Decisions & deferrals (11.2)

- **A2 adopted — content-preserving tables.** Cells are pre-wrapped with `wrapAnsi(parsed, colWidths[i]−2, {hard:true, trim:false})` and handed to cli-table3 with `wordWrap:false`, so the box never exceeds the terminal width and **no content is truncated** (long tokens wrap across rows). Runtime-probe-confirmed robust. The width-discipline invariant — every pre-wrapped line ≤ `colWidths[i]−2` — is the single load-bearing condition (cli-table3 truncates lines of `content+1`); `wrapAnsi {hard:true}` maintains it. NB: the earlier B.1 `wrapOnWordBoundary:false` guidance was wrong — that path is ANSI-unsafe (it wraps on raw `.length` and splits SGR escapes); we do not use cli-table3's internal wrap at all.
- **Caveat — emoji shortcodes in cells.** marked-terminal's built-in table applies its `transform` (unescape + `:shortcode:`→emoji) to body cells; the override renders cells via `parseInline`, which does not run that transform. Unicode emoji and CJK render fine (string-width/wrap-ansi handle them); only literal `:rocket:`-style shortcodes inside a table cell won't convert. Accepted.
- **B1 deferred — committed tables keep commit-time width.** `<Static>` is write-once, so only the *active* table re-fits on resize; tables already scrolled into history stay at the width they were committed at (as `less`/tmux do). Reflowing history would need retained block source + re-parse on every resize — out of scope. **Revisit trigger:** operators consistently report scrollback tables are unreadable after resizing a session smaller than it started.
- **C1 deferred — streaming column "jump" accepted.** While a table streams in, later rows with wider cells re-balance the columns between frames (the 80 ms throttle limits the frequency); the table settles on completion. Grow-only column widths would need per-table persistent state, which the stateless full-buffer re-parse design specifically avoids. **Revisit trigger:** operators report the mid-stream column jump is disruptive in practice.

---

## WP-C — Open investigations / hypotheses tested and dispositioned

| # | Item | Status | Disposition |
|---|------|--------|-------------|
| C-1 | Screen flash IS the Ink overflow branch (0.1/0.2). | ✓ closed | **VERIFIED** (in-tree history, 0.5); addressed by A.2+A.3. |
| C-2 | Child session SSE routes content unexpectedly. | WATCH | `match=false` untracked children still occur; investigate with `OCTMUX_DEBUG_SSE=1` + `OCTMUX_DEBUG_RENDER=1` + capture-pane if content missing/duplicates in multi-agent turns. |
| C-3 | Box-per-Static layout cost at >150 turns. | WATCH | Keep instrumentation active; profile only if >150-turn sessions show layout stalls (currently A.5 note). |
| C-4 | marked v15→v18 token shape stable. | ✓ closed | **VERIFIED / SHAPE-STABLE** (v15→v18 `.header[i].{text,tokens,align}`, `.rows[r][c].{text,tokens}`); B.1 shipped. |
| C-5 | O(N²) re-parse CPU on huge blocks. | WATCH | Stream ~50 KB single text; profile only if CPU pegging observed in field (currently A.5 note). |
| C-6 | Resize re-runs React. | ✓ closed | **VERIFIED FALSE** (0.6 pre-A.2 behavior); A.2's hook fixed it. Folded into A.2/B.2. |
| C-7 | `visualRows` matches Yoga `outputHeight` (wide chars not underestimated). | ✓ closed (Stage 11.3) | **FIXED** — Stage 11.3 adds string-width to `visualRows` (ActiveBlock.tsx), so wide chars/emoji counted at real width. Matches Yoga's Ink output. |
| C-8 | Floor 80 causes overflow/garble on sub-80-col panes. | WATCH | Prose and cap overflowed pre-A.3 on 70-col pane; MED priority if operators report; trigger revisit if widespread. |

**Instrumentation — IMPLEMENTED (Stage 11.3):** the per-delta trace in block-buffer.ts:306–313
(when `OCTMUX_DEBUG_RENDER=1`) logs `[octmux-render] delta part=<id> len=<bytes> buf=<activeTextBufLen>
lines=<renderedLines> committed=<committedCount>`. Fields:
- `part` — PartID (text delta scope).
- `len` — bytes in this delta.
- `buf` — total active text buffer length after append.
- `lines` — current rendered-output line count (lags ≤1 throttle tick).
- `committed` — scrollback line array length (total committed lines).

To capture this alongside maxRows and pane geometry:
```bash
OCTMUX_DEBUG_RENDER=1 dist/octmux 2> /tmp/octmux-delta-trace.log
# In tmux, in parallel:
tmux capture-pane -p -S -200 > /tmp/octmux-cap.txt
```
Use the trace + pane dump to diagnose C-2 (SSE content), C-3 (layout), C-5 (CPU), C-8 (floor)
as they arise. Revisit triggers listed per item.

---

## Series closeout (Stage 11.3) — open items, future work, operator-testing watch list

### Per-stage summary

The Stage 11 block-renderer series is closed. All items shipped:

- **Stage 11.0** (commit `fd3e3a6`): A.1 (debug hygiene), A.2 (useTerminalSize hook).
- **Stage 11.1** (commit `293f0c5`): A.3 (measured chrome cap), A.4 (pathological single-line truncation).
- **Stage 11.2** (commit `9bafdce`): WP-B (table wrapping — measured `table(token)` override, live width threading, content-preserving pre-wrap + cli-table3 wordWrap:false).
- **Stage 11.3** (_pending — backfill after commit_): C-7 fix (string-width in visualRows), per-delta instrumentation (OCTMUX_DEBUG_RENDER=1), marked-comment update, doc closure.

### Watch list (field triggers + capture procedures)

**tmux SIGWINCH lag.** Trigger: stale geometry immediately after pane splits with pane-border-status. Behavior: transient; self-corrects on next resize event/delta. Expected and not a bug.

**C-2: Content missing or duplicated during multi-agent turns.** Hypothesis: child sessions
in the SSE stream may have untracked ancestry or mismatched ID resolution. Trigger: operator
reports content appearing out of order, duplicated across turns, or missing in middle of a
multi-step brain turn. **Capture:**
```bash
OCTMUX_DEBUG_SSE=1 OCTMUX_DEBUG_RENDER=1 dist/octmux 2> /tmp/octmux-debug.log
# Reproduce the multi-agent turn, then: tmux capture-pane -p -S -200 > /tmp/octmux-cap.txt
# Post the debug.log and cap.txt for analysis.
```

**C-3: Sluggish redraw at >150 turns.** Hypothesis: Box-per-Static layout overhead or O(N)
re-parse cost. Trigger: operator reports laggy interaction, stall on keypress. **Capture:**
Use the instrumentation above; watch for `lines=` values growing unboundedly or `committed`
>> pane height. If profiling: disable Box wrapper in app.tsx:1455 + time a 200-turn render.

**C-5: CPU pegging on huge single block.** Hypothesis: O(N²) re-parse per delta × throttle.
Trigger: operator streams ~50 KB in one text part, CPU spikes. **Capture:** Same
instrumentation; watch for repeated high `len=` + re-parse overhead in the trace log.

**C-8: Garbled prose or cap overflow on sub-80-col panes.** Hypothesis: the `w = max(80,
columns)` floor was a pre-A.3 workaround; A.3's measured cap should close it, but prose
still may wrap unexpectedly. Trigger: run in a 70-col pane, observe box-drawing or wrapped
words clipping content. **Capture:** tmux capture-pane shows the garble; trace log shows
active block height vs maxRows divergence.

#### Expected behaviors (not bugs)

**B1 committed tables keep commit-time width.** Like `less`/tmux, tables in scrollback stay at the width they were committed at. Only the active table re-fits on resize. **Revisit trigger:** operators consistently report scrollback tables become unreadable after session resize.

**C1 streaming column "jump".** While a table streams, later rows with wider cells re-balance columns between frames (80 ms throttle limits frequency). The table settles on completion. **Revisit trigger:** operators report the mid-stream column jump is disruptive in practice.

**emoji `:shortcodes:` in table cells don't convert.** The table override renders cells via `parseInline` (which does not run marked-terminal's `:shortcode:`→emoji transform). Unicode emoji and CJK render fine; only literal `:rocket:`-style shortcodes inside a table cell won't convert. Accepted.

**256/true-color tint loss on wrapped table-cell continuation lines.** Cosmetic; rare. Wide characters or ANSI sequences on the wrap boundary may not preserve color state across wrapped lines in table cells.

### Future work (revisit triggers)

**B1 deferred — scrollback table reflow.** `<Static>` is write-once; only the active table
re-fits on resize. Tables in scrollback stay at commit-time width (like `less`/tmux). To
reflow history: need to retain block markdown source + re-parse on resize — out of scope for
the current design. **Revisit if:** operators consistently complain that scrollback tables
become unreadable after session resize.

**C1 deferred — streaming column "jump".** While a table streams, later rows with wider
cells re-balance columns between frames (80 ms throttle limits frequency). Grow-only column
widths would need per-table persistent state, which the full-buffer re-parse design avoids.
**Revisit if:** operators report the mid-stream column jump is disruptive in practice.

**C-8 floor rework.** The 80-col floor (`w = max(80, columns)`) is a layout constant
(Yoga/TTY sizing). On sub-80-col panes, a.3's measured cap should still work, but prose
may still wrap unexpectedly. Deferred decision: is this a rendering issue (floor too high)
or a constraint (Yoga nodes need minimum width)? **Revisit if:** sub-80-col pane issues
surface in field testing.

### Debug instrumentation how-to (operator calibration reference)

Run the renderer with `OCTMUX_DEBUG_RENDER=1` to enable per-delta trace logging:

```bash
OCTMUX_DEBUG_RENDER=1 dist/octmux 2> /tmp/octmux-delta-trace.log
```

**Delta-trace fields** (logged to stderr, format `[octmux-render] delta part=… len=… buf=… lines=… committed=…`):
- `part` — PartID (identifies which text delta, e.g., `prt_abc123def`).
- `len` — bytes in this delta (size of the incoming text chunk).
- `buf` — cumulative active text buffer length after append (grows during streaming, resets on commit).
- `lines` — number of lines in the current rendered ANSI output (reflects active block visual rows; lags ≤1 throttle tick).
- `committed` — length of the scrollback line array (total committed lines; grows as blocks end).

In parallel with the renderer, capture the tmux pane:

```bash
tmux capture-pane -p -S -200 > /tmp/octmux-cap.txt
```

The pane capture shows the last 200 lines of rendered output at that moment. Cross-reference
with the delta trace to correlate input deltas with visual output, confirm `lines=` values
match the actual pane content, and diagnose watch-list issues (C-2, C-3, C-5, C-8) when they
occur.

---

## Implementation log

Per-session record of what shipped. Each entry carries the two mandatory metadata lines
(`Implemented by` / `Commit(s)`) per the project's build-discipline rule.

### 2026-06-11--13-09 — A.1: consolidate OCTMUX_DEBUG_RENDER writes behind `_dbg()` helper

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--13-09
**Commit(s):** `fd3e3a6`

Three inline env-gated `process.stderr.write` calls in `src/renderer/block-buffer.ts:beginBlock`
route through one private `_dbg(msg)` helper (lines 197–201), so the `OCTMUX_DEBUG_RENDER` check
lives in a single place and the hot path is de-noised. The three `this._dbg(...)` callsites in
`beginBlock` (lines 224, 244, 248) keep their original message strings. WP-C's structured-trace
capability is retained.

### 2026-06-11--13-09 — A.2: `useTerminalSize()` hook for live terminal geometry

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--13-09
**Commit(s):** `fd3e3a6`

`src/app.tsx` carries a `useTerminalSize()` hook (lines 227–240) that subscribes to `stdout`
resize events and lifts terminal dimensions into React state. `w` and `maxActiveRows` derive
from that state (lines 320, 332–333), so a terminal resize forces a re-render and the geometry
recomputes in all states (streaming, paused, idle) — not only while deltas flow. The re-render
is cheap: the dynamic region only; `<Static>` history is not re-emitted. The `setWidth` effect
fires on resize for free. This removes the resize-during-pause flash. `CHROME_ROWS` and the cap
formula are unchanged — A.2 makes the geometry live; A.3 (measured chrome) makes the cap airtight.

### 2026-06-11--13-42 — A.3+A.4: measured chrome cap + single-line truncation

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--13-42
**Commit(s):** `293f0c5`

**A.3 — measured chrome cap:** `src/app.tsx` adds `restRef` + `restRows` state (lines 321–328),
a no-deps `useLayoutEffect` measuring the non-ActiveBlock dynamic region (ctrlcPending through
chrome box closing tag, lines 1461–1523). The cap formula becomes `maxActiveRows = Math.max(1,
rows - restRows - 1)` — exact measurement replacing the fixed `CHROME_ROWS = 10` budget. The
`CHROME_ROWS` const is removed. The measured region wraps L1460-1520 inside `<Box ref={restRef}
flexDirection="column">` immediately after the `ActiveBlock` line and closing after the chrome
box. Imports: `measureElement` added to ink import (line 1), `useLayoutEffect` to react import
(line 2). This closes the overflow boundary on any pane size, counts modal height automatically,
and adapts to transient chrome growth (multi-line PromptInput, wrapped StatusLine).

**A.4 — single-line truncation:** `src/components/ActiveBlock.tsx` `tailSliceByVisualRows`
(lines 18–28) now guards against blanking: if `start >= all.length` (slice would be empty) and
`all.length > 0`, return a single truncated line — the plain text of the last line (ANSI
stripped), capped to `Math.max(1, maxRows * Math.max(1, width) - 1)` visible characters, marked
with "…" at the end. This ensures a pathological single over-tall line never blanks the live
view; full styled content still commits to `<Static>` intact. Test: `src/components/ActiveBlock.test.ts`
flips L56 assertion (was empty, now truncates), adds two `[a,b,c,huge]` cases (maxRows=1 and
maxRows=2) confirming truncation behavior and bounds.

### 2026-06-11--15-41 — B: table wrapping (A2 content-preserving, live-width, resize-refit)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--15-41
**Commit(s):** `9bafdce`

New `src/renderer/table-layout.ts` (pure: `naturalWidths`, `computeColWidths`, `wrapCell`). A custom marked `table(token)` override in `_makeMarkedInstance` (block-buffer.ts): renders cells via `parser.parseInline`, computes per-column widths against the live terminal width (`getWidth()` closure over `_width`), pre-wraps each cell with `wrapAnsi(…, colWidths[i]−2, {hard:true, trim:false})`, and builds a cli-table3 table with `wordWrap:false` so the box fits the terminal and content wraps without truncation. `setWidth` now re-renders the active text block + emits on change (active table re-fits on resize, incl. during pauses). `app.tsx` feeds the real terminal `columns` to the renderer (B.0). cli-table3/string-width/wrap-ansi promoted to direct deps. Unit tests (table-layout) + a real-renderer integration test asserting a 100-char token wraps within width 60 with full content preserved (no `…`). See "Decisions & deferrals (11.2)" for A2/B1/C1 and the width-discipline invariant.

### 2026-06-11--19-42 — C: series closeout — C-7 string-width fix, per-delta instrumentation, doc closure

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-06-11--19-42
**Commit(s):** `_pending — backfill after commit_`

**C-7 string-width fix:** `src/components/ActiveBlock.tsx` `visualRows` (line 12) now uses
`stringWidth(line)` instead of `plain.length` so wide characters (emoji, CJK) are counted
at real width (2 columns each), matching Yoga's and Ink's rendering. The `tailSliceByVisualRows`
pathological branch (lines 18–28) also uses `stringWidth` in its column-budget walk to
compute visible-char truncation accurately. New tests: CJK 10 chars @ width 10 → 2 rows;
5 emoji @ width 10 → 1 row; truncation boundary tests. Existing ASCII tests unchanged.

**Per-delta instrumentation:** block-buffer.ts:306–313 adds a direct `if (process.env.OCTMUX_DEBUG_RENDER === "1")`
guard around per-delta trace logging (part ID, len, buf, lines, committed). The guard
is at the call site so the log string is not allocated when the flag is off (hot-path safe).

**Marked comment fix:** block-buffer.ts line 16 updated: "verified against marked@17
(token shape stable v15→v18) + marked-terminal@7.3.0".

**Doc closure:** Stage11-Block-Renderer-Improvements.md now a CLOSED SERIES RECORD (frontmatter
updated; head_at_handover = 6326949; maintained_as = "CLOSED SERIES RECORD" + watch-list
reference). Part 0 re-verified @6326949; §0.4 rebuilt from live code (0.4 table comprehensive).
§0.5 re-framed (flash attribution to git history, not deleted comment). §0.6 rewritten as
present-state (A.2 hook in place, geometry live). WP-A/B/C updated with shipped stamps and
dispositions. New § "Series closeout" documents per-stage summary, watch list (C-2/C-3/C-5/C-8
with capture procedures), future work (B1/C1/C-8 deferred), and debug how-to.
