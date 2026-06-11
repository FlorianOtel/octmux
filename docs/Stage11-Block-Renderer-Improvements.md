---
title: "octmux block-renderer — Brain series handover (live document)"
branch: "main"
head_at_handover: "85b2414 (feat/block-renderer merged to main)"
created: 2026-06-08
revised: 2026-06-11 (rev 3 — corrected paths/line offsets, retired C-4, marked shape-stable note, Part 0 re-verified @85b2414, A.1+A.2 shipped)
updated_by: "Claude Code (Claude Haiku 4.5)"
updated_at: 2026-06-11--13-09
maintained_as: "LIVE DOCUMENT — update the Status Tracker and per-WP status as the series progresses"
authored_by: "External analysis session (Claude), grounded in the feat/block-renderer tree + Ink 5.2.1 / marked-terminal 7.3.0 source"
how_to_use: >
  This is a live document for a series of Brain orchestra sessions. Part 0 is shared
  load-bearing context that EVERY work package depends on — paste it into every session.
  WP-A, WP-B, WP-C are independently dispatchable: each is self-contained enough to lift
  into its own Brain session together with Part 0. Confidence is tagged inline:
  [VERIFIED] = checked against source this session; [HIGH-CONF] = strong hypothesis with a
  named confirming test not yet run; [DECIDE] = operator decision required. Do not let a
  Brain session silently upgrade a [HIGH-CONF] to fact without running the test.
---

# octmux block-renderer — Brain series handover (live document)

## Status tracker (update as you go)

| WP | Topic | Priority | Status | Gating unknown |
|----|-------|----------|--------|----------------|
| A.0 | Flash cause — already attributed in-tree; conservative-cap as regression check | DONE-ish | ☐ confirm | none material — see 0.5 |
| A.1 | Hygiene: debug instrumentation cleanup | high (quick) | ✓ shipped | — |
| A.2 | **Geometry liveness: `useTerminalSize` resize hook** (keystone; prereq for A.3 + WP-B) | **highest** | ✓ shipped | — |
| A.3 | Airtight cap: measure chrome, strict headroom (the chrome-budget half of the flash fix) | highest | ☐ | depends on A.2 |
| A.4 | Pathological single-line blanking | medium | ☐ | — |
| B | Real terminal size + table wrapping | high (UX) | ☐ | needs A.2 ✓ (shipped) |
| C | Open investigations | ongoing | ☐ | several |

> **Re-sequencing note (rev 2):** the "flash / overflow" fix is now TWO items — **A.2** (the
> resize hook, which fixes the resize-during-pause flash) and **A.3** (measure the chrome,
> which fixes the chrome-budget boundary flash). A.2 is also a prerequisite for WP-B's
> "re-fit tables on resize". Do A.1 → A.2 → A.3 in order; A.3's `measureElement` is only
> *live* if A.2 is in place.

---

## Part 0 — Load-bearing shared context (paste into every session)

These are the facts that took ~8 data points and 6 failed fixes to establish on this
branch. A Brain session that re-derives them wastes the budget; a session that
contradicts them is wrong. Treat as ground truth unless a [HIGH-CONF] test overturns it.

> **Verified at HEAD `85b2414` (2026-06-11):** all [VERIFIED] tags below hold against the live
> tree on `main`. block-buffer lives at `src/renderer/block-buffer.ts`; the §0.4 line references
> are current as of this HEAD. A.1 (debug hygiene) and A.2 (geometry-liveness hook) are shipped.

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

### 0.4 Verified file/line map (at HEAD `85b2414`)

| Thing | Location |
|-------|----------|
| Cap math | `src/app.tsx:328` `CHROME_ROWS = 10`; `:333` `maxActiveRows = max(16, rows - CHROME_ROWS)` |
| Width into renderer | `src/app.tsx:332` `w = max(80, columns ?? 80)`; `:336–338` `useEffect(() => renderer.setWidth(w), [w, renderer])` |
| `<Static>` + Box-per-item workaround | `src/app.tsx:1441–1458` (Box wrapper at :1455) |
| `<ActiveBlock ... maxRows={maxActiveRows}>` | `src/app.tsx:1459` |
| Chrome composition (dynamic, below ActiveBlock) | `src/app.tsx:1493–1520` (single `<Box flexDirection="column" marginBottom={2}>` with SubprocessStatus, pendingQueue?, Rule(sessionLabel), PromptInput, Rule, StatusLine, PermissionStatusLine, ToggleStatusLine) |
| ctrlcPending (dynamic, above chrome box) | `src/app.tsx:1460` |
| `useTerminalSize()` hook | `src/app.tsx:227–240` (subscribes to stdout resize, returns live size state) |
| Cap slice helpers | `src/components/ActiveBlock.tsx` `stripAnsi`, `visualRows`, `tailSliceByVisualRows` |
| One-shot render | `src/renderer/block-buffer.ts` `_renderActiveTextAnsi` |
| Commit (array-replace) | `src/renderer/block-buffer.ts` `_commitActiveText` |
| Width field + setter | `src/renderer/block-buffer.ts:108` `_width = 80`; `:586` `setWidth(width)` |
| marked instance builder | `src/renderer/block-buffer.ts` `_makeMarkedInstance()` (free function; no `this`) |
| Debug instrumentation | `src/renderer/block-buffer.ts:197–201` private `_dbg(msg)` helper (single `OCTMUX_DEBUG_RENDER` check); called at :224, :244, :248 |
| Ink resize wiring | `ink/build/ink.js:77` `stdout.on('resize', resized)`; `:83` `resized = () => { calculateLayout(); onRender(); }` |
| marked-terminal tables | `marked-terminal@7.3.0/index.js:237` → `cli-table3@0.6.5`; `reflowText` only at `:127,207` (paragraph/text/hr, **not** tables) |

### 0.5 Empirical anchors already gathered (do not re-run unless testing a change)

- `/var/tmp/render-this-as-markdown.md` renders one-shot to **73 logical lines** (~75
  visual rows at width 190) vs a ~48-row threshold on a 54-row pane → deterministic
  overflow at commit `a887d63`/`d1e29a2` (which has no cap). This is why the cap exists.
- On the 54-row pane, `maxActiveRows = 54 − 10 = 44`. A full active block (44) + chrome at
  its 10-row budget = **54 == rows → overflow boundary** (Ink uses `>=`). Baseline chrome
  is ~7, leaving ~3 rows of slack.
- `tailSliceByVisualRows([...,<line taller than maxRows>], …)` returns `[]` — a single
  over-tall line blanks the active region and suppresses smaller lines above it.
- **The flash is already attributed in-tree** [VERIFIED]: the comment at `app.tsx:296-303`
  states `CHROME_ROWS` was bumped 6→10 *"after three independent reproductions of
  fullStaticOutput re-emission ('prior-turn content flashed on screen')."* So the flash =
  the 0.1 overflow branch is **confirmed**, and `10` is a **partial** mitigation: it does
  not close the `>=` boundary (44+10=54), does not count modals, and does not cover stale
  geometry on resize-during-pause (0.6). A.2 + A.3 are the complete fix.

### 0.6 Geometry is refreshed on React re-render, NOT on terminal resize [VERIFIED] — the keystone

This is the fact that motivates WP-A.2 and gates WP-B's resize behavior.

- `maxActiveRows` and `w` are computed in the `App` component **body**; `setWidth(w)` runs
  in `useEffect([w])`. All three refresh only when `App` **re-executes** — i.e. on a React
  re-render. Re-renders come from the `useSyncExternalStore("changed")` subscription (every
  delta/commit, ~12 Hz throttled while streaming) and from other state (input, modal, focus).
- **A terminal resize does not re-run React.** Ink subscribes to `stdout` `'resize'` only
  inside the instance (`ink.js:77`); `resized()` = `calculateLayout()` (re-flow Yoga at the
  live terminal width) + `onRender()` (re-*serialize* the existing fiber tree via
  `render(rootNode)` — **no `reconciler.updateContainer`**). `use-stdout.js` does not
  subscribe to resize, and Ink 5 ships no dimensions hook. So values read from
  `stdout.columns/rows` in a component body stay **stale** until the next re-render from
  some other cause.
- **Two re-emit costs — do not conflate:**
  - A React re-render redraws only the **dynamic region**; `<Static>` is index-tracked
    (0.2), so unchanged `committed` ⇒ empty static output that frame. A resize-triggered
    re-render does **not** re-render the >100-turn history. Cost ≈ one streaming delta.
  - The **overflow branch** (0.1) is the only path that re-emits `fullStaticOutput`. That,
    not re-rendering, is the history flash.
- **Net behavior today:** while deltas flow, a resize self-corrects within ~one throttle
  tick (the next delta re-renders and re-caps). During a **pause** — between PartIDs, while
  a tool call runs, while Opus "thinks", or idle between turns — a resize is invisible to
  React: geometry is frozen, and a resize-*smaller* leaves `maxActiveRows` stale-large and
  the `ActiveBlock` `<Box width={w}>` wider than the terminal, which can push the dynamic
  region over `rows` and **stick in the overflow branch (flash) until the next delta**.
  Brain sessions spend most of their resize-prone time in exactly these pauses. WP-A.2 fixes
  this by forcing a (cheap, dynamic-region-only) re-render on resize.

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

**Status:** confirmed as the 0.1 overflow branch — the in-tree comment at `app.tsx:296-303`
documents three independent reproductions of `fullStaticOutput` re-emission, and `<Static>`
re-render is ruled out [VERIFIED] (`retagBlock`/`commitCompactionDivider` are append-only;
Static is index-tracked, 0.2). Two distinct triggers feed it: (a) the chrome-budget boundary
(`44+10=54`, A.3), and (b) stale geometry on resize-during-pause (0.6, A.2).

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

**Why (0.6):** geometry only refreshes on React re-render; a bare resize re-flows Yoga but
does not re-run React, so `maxActiveRows`/`w`/`setWidth` go stale during any pause. In
brain-session pauses (between PartIDs, tool calls, Opus thinking, idle) a resize-smaller can
trigger the overflow flash and stick until the next delta. This hook makes the resize force a
re-render so geometry is live in **all** states. The re-render is cheap — dynamic region
only; `<Static>` history is **not** re-emitted (0.2).

**Fix:** subscribe to `stdout` resize and lift size into React state; derive `maxActiveRows`
and `w` from that state, not from inline `stdout.rows/columns`.

```tsx
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ rows: stdout.rows, columns: stdout.columns });
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}
// in App:
const { rows, columns } = useTerminalSize();
const w = Math.max(80, columns ?? 80);               // (the 80-floor: see WP-B B.0 for the table budget)
// maxActiveRows now recomputes on resize; setWidth effect ([w]) now fires on resize.
```

**Properties:** resize → `setSize` → re-render → cap + width recompute, `setWidth` runs,
tail re-slices — in any state. Prerequisite for A.3 (its `measureElement` only re-runs on a
re-render) and for WP-B (table re-fit on resize). Coalesced by the OS/terminal into a few
events per drag; each is a dynamic-region-only redraw.

**Blast radius:** `app.tsx` only (one hook; swap inline reads for state). No renderer change.
Watch: ensure no other code still reads `stdout.rows/columns` inline (would stay stale).
**Done:** resizing *during a pause* (e.g. mid tool-call in a brain turn) immediately re-caps
the tail and re-fits the chrome; resize-smaller during a pause no longer flashes; suite green.

### A.3 — Airtight cap: measure the chrome, don't budget it [VERIFIED gap; the chrome-budget half of the flash fix] (highest, after A.2)

**Problem [VERIFIED]:** `maxActiveRows = max(16, rows − 10)` uses a *fixed* `CHROME_ROWS=10`
against a *dynamic* chrome, ignores modal height, and the Ink boundary is `>=` not `>`. On a
54-row pane: full active block (44) + chrome at budget (10) = 54 = rows → overflow. The
`max(16,…)` floor also guarantees overflow on panes shorter than ~27 rows.

**Fix — measure the actual non-ActiveBlock dynamic height and subtract it (+1):** the dynamic
region is `<Static>` (excluded), then `ActiveBlock`, then everything else (ctrlcPending +
modals + chrome box) contiguously after it. Wrap that remainder in one measured container and
cap `ActiveBlock` to what's left.

```tsx
import { measureElement } from "ink";
const restRef = useRef(null);
const [restRows, setRestRows] = useState(12); // conservative initial fallback
useLayoutEffect(() => {
  if (restRef.current) {
    const { height } = measureElement(restRef.current);
    if (height > 0) setRestRows(height);
  }
});
const maxActiveRows = Math.max(1, rows - restRows - 1); // rows from useTerminalSize (A.2); strict headroom
// ...
{activeBlock && <ActiveBlock ... maxRows={maxActiveRows} />}
<Box ref={restRef} flexDirection="column">
  {ctrlcPending && <Text>…</Text>}
  {/* modals */}
  <Box flexDirection="column" marginBottom={2}>{/* existing chrome */}</Box>
</Box>
```

**Properties:** exact, not budgeted — adapts to a growing prompt, the queue line, the Ctrl-C
hint, a wrapped StatusLine, **and** any mounted modal. Strict `−1` closes the `>=` boundary.
`measureElement` populates after layout (one-frame lag on sudden chrome growth) — the
conservative `restRows` fallback covers the first frame; A.2 ensures resize triggers the
re-render that re-measures. Drop/rework the `max(16,…)` floor in favour of
`Math.max(1, rows − restRows − 1)`.

**Alternative (KISS, no async measure) [DECIDE]:** compute `restRows` from known state —
`1 + (queue?1:0) + 1 + editorLineCount + 1 + statusRows + 2 + (ctrlc?1:0) + modalRows`.
Synchronous, no lag, but hand-maintained. Recommend `measureElement`; offer the computed sum
as fallback if the modal subtree makes measuring fiddly.

**Blast radius:** `app.tsx` render tree (wrap remainder in a measured Box) + `maxActiveRows`
derivation. No renderer change. Verify the extra Box adds no row. **Done:** A.0's flash gone
at production margins; a 6-line paste in the prompt while a tall block streams does not
overflow; suite green; test asserts `maxActiveRows = rows − measuredRest − 1` for sample
chrome heights.

### A.4 — Pathological single-line blanking [VERIFIED bug, low frequency]

**Problem [VERIFIED]:** `tailSliceByVisualRows` returns `[]` when the bottom line's visual
rows exceed `maxRows`, and suppresses smaller lines above it. A long unwrapped line (tool
JSON, base64, long URL/path) blanks the live view until a newline arrives.

**Fix (local to the slice):** if the slice would be empty, include the last line and
hard-truncate it to `maxRows * width` visible chars (mark truncation). Full content still
commits to `<Static>` intact. Generalize: never return empty when `all.length > 0`.

**Blast radius:** `ActiveBlock.tsx` pure helper only; covered by `ActiveBlock.test.ts`.
**Done:** a line of length `> maxRows*width` renders a truncated tail (not blank); tests for
the single-huge-line and `[a,b,c,<huge>]` cases.

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

### B.0 — Size source: you already have it; `stty` is a red herring for the interactive path [VERIFIED]

In a TTY, `process.stdout.columns/rows` **is** the live terminal size, updated on `SIGWINCH`;
Ink surfaces it via `useStdout()`. Do **not** shell out to `stty size` for the interactive
renderer — same number, fork/exec cost, and a race. `stty size`/`tput cols` is only a fallback
when `process.stdout.isTTY === false` (piped/non-interactive), where there is no interactive
render anyway. **But note (0.6):** the value is only *consumed* on a React re-render; for the
size to reach the table override on a resize-during-pause, **WP-A.2 (the resize hook) must be
in place**. The other real defect is `w = Math.max(80, stdout?.columns ?? 80)` (`app.tsx:304`):
the 80-col floor means on a sub-80-col pane the renderer believes it has 80 columns and tables
(and prose) overflow regardless. For the table budget, use the **real** `columns`, not the
floored `w`.

### B.1 — The table fix: override marked's `table(token)` [VERIFIED mechanism]

`reflowText` does **not** touch tables (only paragraph/text/hr — `marked-terminal/index.js:127,207`),
and there is no config knob: `cli-table3` *can* wrap (`colWidths` + `wordWrap:true` →
`cell.js:76-89`), but `colWidths` must match each table's column count, and `tableOptions` is
one static object that can't know per-table counts. So the fix is an **override**, the same
idiom as the bold-in-list `text(token)` override:

- Override marked's `table(token)` (marked v15 token-based — **verify the token shape first,
  C-4**). Render each cell's inline tokens via `this.parser.parseInline(cell.tokens)`.
- Compute per-column widths to fit the current terminal width (B.3). Build a `cli-table3`
  `Table` with those `colWidths` + `wordWrap:true`, `wrapOnWordBoundary:false`. Add
  `cli-table3` as a **direct** dependency (currently transitive).
- Return the string in the form marked-terminal's pipeline expects (match its `section(...)`
  spacing / surrounding newlines — verify against output).

### B.2 — Live width: threading + resize re-fit [VERIFIED plumbing, two gaps + the hook]

The one-shot re-parse (0.3) means the override re-fits on every render for free **if it reads
the current width at parse time**. Plumbing present: `setWidth` (`block-buffer.ts:578`), called
from `app.tsx:309` (`useEffect([w])`). To make the **active table re-fit on a resize, including
during a pause**, all three of these must hold:

1. **WP-A.2 hook** — so a resize re-renders React, recomputes `w`, and runs the `setWidth`
   effect at all (without it, resize-during-pause never calls `setWidth`).
2. `_makeMarkedInstance()` is a free function with no `this`. Pass it `getWidth: () => number`
   (closing over `_width`) so the override reads **live** width, not a construction-time const.
3. `setWidth` currently only sets the field. Have it also **re-render the active block and
   `emit("changed")`** when a text block is active — otherwise the new width is stored but the
   active table's ANSI is not re-parsed until the next delta. (Gaps 2+3 re-fit the table
   *content*; the hook in #1 is what triggers the whole chain on a paused resize.)

### B.3 — Column-width algorithm

- Natural width per column = max **visible** cell width (strip ANSI; see caveat). Budget ≈
  `realColumns − (3 · numCols + 1)` (cli-table3 border + 2-padding per column — calibrate
  empirically as the `text` override was). If `sum(natural) ≤ budget`, use natural. Else: floor
  each column (~8 chars, or natural if smaller), distribute remaining budget proportionally to
  natural width; `wordWrap:true` wraps cells to those `colWidths`. ~40–50 lines.

### B.4 — Caveats to decide on [DECIDE]

- **Visible width, not `.length`:** cells carry ANSI and `emoji:true` is on; strip ANSI (reuse
  `stripAnsi`) and ideally handle double-width emoji/CJK (`string-width` dep, or accept minor
  misalignment).
- **Streaming churn:** later rows with wider cells re-balance columns between frames; the table
  "jumps" while streaming, settles on completion. 80 ms throttle limits it. Grow-only column
  widths (needs per-table state) — defer.
- **Committed tables don't reflow on resize:** `<Static>` is write-once, so only the *active*
  table re-fits; scrollback tables stay at commit-time width (as `less`/tmux do). Re-fitting
  history would need retained block source + re-parse on resize — out of scope.

**Blast radius:** `block-buffer.ts` (`_makeMarkedInstance` signature, `setWidth` re-render, new
`table` override), one new direct dep (`cli-table3`, maybe `string-width`), the `app.tsx:304`
floor for the budget. **Depends on WP-A.2.** No change to the cap or commit paths. **Done:** a
wide-cell table renders fully inside the width with wrapped cells, no box-drawing wrap; resizing
narrower re-wraps the *active* table within one frame **even during a pause**; suite green; a
fixture renders a wide-cell table at widths 60/120/190 asserting max line width ≤ terminal width.

---

## WP-C — Open investigations / hypotheses to test

| # | Hypothesis / unknown | Confidence | Cheap test | Gates |
|---|----------------------|-----------|-----------|-------|
| C-1 | The screen flash IS the Ink overflow branch (0.1/0.2). | **VERIFIED** (in-tree comment, 0.5) | A.0 conservative-cap regression check. | A.2/A.3 framing |
| C-2 | The child session in the SSE log (`match=false`, `isTrackedChild=false`, ~88/142 deltas) routes content in/out of the renderer unexpectedly. | UNKNOWN | Re-run a multi-step turn with `OCTMUX_DEBUG_SSE`; diff what reaches `appendToBlock` vs what the model emitted. | possible 2nd content/flash cause |
| C-3 | Box-per-Static-item adds measurable layout cost at >150-turn scrollback. | LOW | Time a render at ~200 committed lines vs without the wrapper (keep wrapper regardless). | A.5 note only |
| C-4 | marked v15 `table(token)` shape: `token.header[i].{text,tokens,align}`, `token.rows[r][c].{text,tokens}`. | **VERIFIED / SHAPE-STABLE** | v15→v18 token shape marked `.header[i].{text,tokens,align}`, `.rows[r][c].{text,tokens}`; table override returns `string`. | B.1 may proceed without further shape investigation. |
| C-5 | O(N²) re-parse shows CPU on a huge single text block. | LOW | Stream ~50 KB single text part; sample CPU; if flat, close. | A.5 note only |
| C-6 | Resize re-runs React. | **VERIFIED FALSE** (0.6) — resize re-flows Yoga + re-serializes, no `updateContainer`; `setWidth` is not called on a paused resize and does not re-parse the active block. | none — folded into 0.6; addressed by A.2 + B.2 gaps 2/3. | closed |
| C-7 | The cap's `visualRows` count matches Yoga's actual `outputHeight` (wide chars/tabs not underestimated). | MED | With A.3's `measureElement` in place, log measured ActiveBlock height vs `maxRows`; should track. | A.3 robustness |
| C-8 | `Math.max(80, columns)` floor causes overflow/garble on sub-80-col panes independent of tables. | MED | Run in a 70-col pane; observe prose + cap. | B.0 / A.3 floor decision |

**Standing instrumentation spec:** extend the debug hook to log, per text delta,
`[partID, deltaLen, activeBufLen, renderedLines, maxRows, committed.length]` behind one env
flag, plus a `tmux capture-pane -p -S -200` helper. This is the runtime evidence that has been
missing; prefer it over static reasoning for any "still happening" report.

---

## Appendix — sequencing recommendation

1. **A.0** (regression probe ready) + **A.1** (hygiene) — cheap; A.1 de-noises before the rest.
2. **A.2** (resize hook) — the keystone; makes geometry live in all states and unblocks A.3 + WP-B.
3. **A.3** (measureElement cap) — airtight `outputHeight < rows`; resolves the chrome-budget flash, the floor, and modal counting. Run C-7 alongside.
4. **A.4** (single-line blank) — small; ship with/after A.3.
5. **WP-B** — after **A.2** is in (shipped). Independent of the cap; can run in a separate session, but its resize-during-pause re-fit depends on A.2.
6. **WP-C** items as gates/closeouts throughout.

**Series-done:** the dynamic-region invariant (0.1) provably holds at all sizes **and in all
states (streaming, paused, idle, resized)** — no flash, no overflow, on any pane; wide-cell
tables render within the real terminal width and the active table re-fits on resize including
during pauses; and the [HIGH-CONF] tags are retired by their named tests.
