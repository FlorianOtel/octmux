---
title: "octmux — Phase 3-UX: Block-typed renderer + tmux multi-pane"
created_at: 2026-05-20--19-30
created_by: Claude (Opus 4.7, chat planning session)
updated_at: 2026-05-21--11-45
updated_by: Claude Code (Claude Haiku 4.5)
parent_plan: docs/Phase3-Extended.md
context: >
  Phase 3 Extended shipped Ink-based rendering with a single growing
  `streamBuf` state in the dynamic region. The 50 ms debounce in app.tsx
  reduces repaint frequency but does not address the structural problem:
  once `streamBuf` plus the bottom chrome (rule + input + rule + status +
  marginBottom) exceeds terminal rows, Ink's reconciler falls back to a
  full clear-and-redraw of the dynamic region on every flush → visible
  flicker on every long response. Phase 3 UX moves streamed content out
  of Ink's dynamic region entirely (Option 4), then introduces a typed
  Renderer interface (Option 2) so a future tmux multi-pane backend
  (Option 3) is a swap rather than a rewrite. The path is 4 → 2 → 3.
  A core architectural principle threads through every sub-phase: Ink's
  responsibility is bounded to a single pane's interactive chrome
  (input area, status line, modals); tmux is the pane manager and
  framing engine (borders, titles, splits, resize, focus); opentmux is
  the future cross-pane coherence layer. Ink does not draw multi-pane
  layouts and does not draw pane borders — those belong to tmux. This
  separation is what makes the role → FIFO → pane-title contract in
  3U.5 a clean integration seam for opentmux. Each sub-phase is
  independently shippable and verifies in isolation. Same execution
  model as Phase 3 Extended: a fresh CC session reading this doc plus
  the repo at the prior phase's commit should be able to complete the
  next phase without external context.
---

## Implementation log (reverse chronological — newest at top)

### 2026-05-21 — Phase 3U.3

**Implemented by:** Claude Code (Claude Haiku 4.5)

**What shipped:**
- `src/renderer/visibility.ts` (new): `Visibility` EventEmitter class with per-role
  on/off state + hidden counts; `parseShowCommand()` parser for `/show [role] [on|off]`
- `src/app.tsx`: `Visibility` singleton; `handleBlockDelta` gated on `vis.isVisible`;
  `block-end` skips `flushTail` for hidden roles; `handleSubmit` intercepts `/show`
  commands, pushes reply to committed without calling LLM; `vis` passed to StatusLine
- `src/components/StatusLine.tsx`: accepts `vis: Visibility`; uses `useSyncExternalStore`
  to subscribe; renders `[idle]  hidden: T·N ⚙·M` badge when roles are suppressed

**What changed in this doc:** Phase 3U.3 status ☐ → ✓

**Suggested next steps:** Phase 3U.4 — extract Renderer interface (Option 2 seam).

---

### 2026-05-21 — Phase 3U.2

**Implemented by:** Claude Code (Claude Haiku 4.5)

**What shipped:**
- `src/app.tsx`: replaced `streamBuf`/debounce/`history` model with `<Static>`-backed
  line-granularity rendering. `committed: CommittedLine[]` accumulates pre-formatted ANSI
  lines; `tail` holds the single in-progress partial line in the dynamic region.
  `handleBlockDelta` splits incoming text at newlines and commits completed lines;
  `flushTail` commits any partial line on `block-end` or `session-idle`. The `text-delta`
  branch and 50ms debounce are removed. User input and errors use `formatLine` and go
  directly to `committed`. Dynamic region is now ≤ ~9 lines regardless of response length
  — flicker is structurally impossible.

**What changed in this doc:** Phase 3U.2 status ☐ → ✓

**Suggested next steps:** Phase 3U.3 — per-role visibility toggles (`/show thinking off`).

---

### 2026-05-21 — Phase 3U.1

**Implemented by:** Claude Code (Claude Haiku 4.5)

**What shipped:**
- `src/blocks.ts` (new): `Role` type, `Block` type, inline ANSI constants, `formatLine()`, `formatBlock()`
- `src/events.ts`: extended `ReplEvent` union with `block-start`/`block-delta`/`block-end`; added `openParts` Map for part tracking; extended `message.part.updated` to handle `"reasoning"` and `"tool"` part types; `message.part.delta` emits `block-delta` for all tracked roles (plus `text-delta` compat alias for text parts); `session-idle` closes open blocks; `filterEvent` return type widened to `ReplEvent | ReplEvent[] | null`
- `src/app.tsx`: SSE loop updated to handle array return from `filterEvent` — mechanical change only, no rendering difference
- `.gitignore`: added `*.smoke.ts`

**What changed in this doc:** Phase 3U.1 status ☐ → ✓

**Suggested next steps:** Phase 3U.2 — Direct-to-terminal streaming: replace `streamBuf` with `<Static>`-backed line-granularity commits driven by the new block events; kill the flicker.

---

# octmux — Phase 3 UX: Block-typed renderer + tmux multi-pane

## Why this phase exists

Phase 3 Extended ships a working Ink REPL but with one structural UX
defect and two missing capabilities that block Phase 4+ ambitions:

1. **Streaming flicker on long responses.** `src/app.tsx` holds
   `streamBuf` as React state. Every text-delta chunk (debounced at
   50 ms) calls `setStreamBuf`, which triggers Ink to re-render the
   dynamic region: `streaming text + [generating…] + ctrlcPending +
   permission/question modal + Rule + PromptInput + Rule + StatusLine
   + marginBottom`. While that whole block fits below the static
   cursor, Ink diffs in place. The moment its total rendered height
   exceeds `process.stdout.rows`, Ink switches to clear-and-redraw of
   the entire dynamic region per flush. The debounce sets the *rate*
   of the full repaint, not the *fact* of it.

2. **No per-stream-kind differentiation.** Today everything that comes
   out of `text-delta` lands in the same `streamBuf`. Thinking blocks
   (`reasoning` part type) and tool calls (`tool` part type) are not
   yet surfaced through `src/events.ts`. Phase 4 wants both:
   colour-coded inline rendering, and the ability to turn each off.

3. **No structural seam for a future tmux multi-pane layout.** The
   ambition is to spawn dedicated tmux panes for subagents and route
   each kind of stream (thinking / tools / main response) to its own
   pane — the opentmux UI pattern. Today the rendering decision is
   hard-coded inside `<App>`. There is no Renderer abstraction that a
   tmux-pane backend could implement.

The 4 → 2 → 3 path addresses all three:

- **Option 4 first (3U.2):** stream content goes through `<Static>` at
  line granularity rather than into a growing dynamic-region state.
  The dynamic region shrinks to "chrome + at most one in-progress
  line" — well below any terminal height. ANSI escapes embedded in the
  written strings drive role colouring; the terminal handles all
  wrapping and scrollback. This gives native terminal semantics
  (`tmux capture-pane` works, copy-paste works, line wrap matches
  terminal width) without giving up live streaming.
- **Option 2 next (3U.4):** extract a `Renderer` interface. The
  Option 4 mechanics become `StdoutRenderer`. Same behaviour, cleaner
  seam, ready for swap.
- **Option 3 last (3U.5):** add `TmuxPaneRenderer` that splits the
  window via `tmux split-window` and feeds each role's blocks to its
  own pane through FIFOs. Toggle at startup or via a slash command.

## Why option 4 over option 1 (the path not taken)

Both options eliminate flicker. The difference is the texture of the
result:

- Option 1 (stay in Ink) keeps Static items as Ink JSX nodes;
  per-role styling uses `<Text color="...">`; layout is Ink's
  flexbox. Ink wraps content using Yoga.
- Option 4 (this plan) keeps Static items as `<Text>{rawAnsiString}</Text>`;
  per-role styling is ANSI escapes embedded in the string; layout is
  the terminal's. Ink only handles the bottom chrome.

The two reasons option 4 wins for octmux specifically:

1. **The glide path to option 3.** With option 4, going to multi-pane
   means changing where the formatted ANSI string is written —
   `process.stdout.write` to `fifoWriter.write`. Same string, different
   sink. Option 1 would require first unwinding the Ink-managed
   styling for streamed content to reach the same place.
2. **Native terminal semantics for the content the user cares about.**
   Long responses, code blocks, ANSI from tool output — all of these
   behave best when the terminal sees them as raw bytes, not as Ink
   nodes Yoga is trying to lay out.

Option 1's strengths (Ink layout primitives, single React mental
model) are valuable for the *chrome*, which is small, fixed-height,
and benefits from Ink's modal / box / border features. Phase 3-UX
keeps Ink there. Streamed content is what moves out — and once it
moves out, the multi-pane layout that 3U.5 builds on top can
delegate framing to tmux, where it belongs. See the "Division of
responsibilities" section below for the full Ink/tmux/opentmux
boundary statement that governs every sub-phase.

## Locked decisions (updates to parent plan)

The parent plan's locked decision #3 (post-Phase-3E) reads:

> **3. Input layer:** Ink (React for CLI) for region composition and
> resize/repaint. LineEditor state machine preserved from Phase 3 as a
> pure buffer/history container; Ink's useInput hook replaces the
> raw-stdin escape-sequence parser. Bottom-anchor via Ink's natural
> render order (Static-above-dynamic). No readline.

Augment with a new locked decision #4:

> **4. Output layer + pane scope.** Output is a typed block model
> (`text` / `thinking` / `tool-call` / `tool-result` / `user` /
> `error`) with a `Renderer` interface. **Ink's responsibility is
> strictly bounded to a single pane's interactive chrome** — the
> input editor, rules, status line, and modals that need React-style
> reactive layout. Ink does not own multi-pane layout. Ink does not
> draw inter-pane framing. The default `StdoutRenderer` writes
> ANSI-formatted lines via `<Static>` at line granularity inside
> Ink's pane; the terminal handles all layout for streamed content.
> **tmux is the pane manager and framing engine** — pane creation,
> geometry, borders, titles, focus highlights, resize, layout
> presets, and detach/reattach are all tmux's responsibility, never
> octmux's and never Ink's. The `TmuxPaneRenderer` routes per-role
> blocks to dedicated tmux panes via FIFOs and asks tmux (via
> `select-pane -T`) to label each pane; everything visual about the
> panes themselves is controlled by tmux options that the user (or
> opentmux) sets. **opentmux is the future cross-pane coherence
> layer** — consistent border styles, focus rules, layout presets,
> navigation keybindings — built on top of the role → FIFO →
> pane-title contract that 3U.5 establishes. octmux's job ends at
> "I produce these roles into these named sinks with these titles";
> opentmux's job is to make a set of such panes feel like one
> interface.

All other locked decisions stand unchanged.

## Division of responsibilities: Ink vs tmux vs opentmux

A single principle drives the whole 4 → 2 → 3 path:

> **Framing belongs to the layout engine, not to the renderer.**

Three layers cooperate; each has a strictly bounded scope. Crossing
a boundary is a design smell that compounds into fragility (the
exact failure mode Phase 3 Extended already had to escape from).

**Layer 1 — Ink (per-pane interactive chrome only).** Inside the
single pane where octmux's REPL runs, Ink handles what it's
genuinely good at: a reactive input editor with Emacs bindings, a
status line that updates from external stores, modal flows
(permission / question prompts), and the bottom-anchor layout that
keeps the input pinned while scrollback grows above it. Ink's
`<Static>` is used to commit finalised lines of streamed content as
ANSI byte strings; the terminal — not Ink — handles wrap and
scroll for that content. Ink does not know other panes exist, does
not draw pane borders, does not manage pane focus, does not
participate in resize across panes. If a feature is about "where
panes live and what they look like as a system," Ink is the wrong
layer for it.

**Layer 2 — tmux (pane manager and framing engine).** Everything
about panes — creation via `split-window`, geometry, borders,
titles per pane, focus highlight on the active pane, resize via
the user's keybindings, detach/reattach across sessions, kill-pane
on exit — is tmux's job. tmux is strictly more capable here than
anything octmux could roll, because tmux is the layout engine the
user is already running. octmux's interaction with tmux is
deliberately small: `split-window` to create panes, `select-pane
-T <role>` to label them, `kill-pane` on shutdown. The *visual
properties* of those panes — border characters, title bar format,
active vs inactive border colours, status-line integration — are
configured through tmux options in the user's `~/.tmux.conf` (or
overridden by opentmux), not through any code in octmux. This is
the boundary that makes pane styling tuneable per environment
without recompiling octmux.

**Layer 3 — opentmux (future cross-pane coherence).** opentmux is
the downstream layer that turns "a set of tmux panes with assigned
roles" into a unified-feeling interface — consistent border
styles, focus rules, layout presets ("thinking on right, tools
below," "subagents in a grid"), navigation keybindings that match
across pane types, status-bar integration that aggregates state
from all panes. opentmux does not yet ship in octmux, but the 4 →
2 → 3 architecture is designed so that opentmux can integrate at
either end of octmux's contract: take over pane spawning entirely
(octmux just opens FIFOs and announces role names; opentmux
creates panes with its own geometry and styling), or take over
pane consumption (octmux still spawns `tail -F` processes;
opentmux re-skins the panes from outside). Either integration mode
relies on the same contract.

**The contract that ties the three layers together** is what 3U.5
implements:

| Octmux emits             | Sink                                | Title set via              |
|--------------------------|-------------------------------------|----------------------------|
| `text`, `user`, `error`  | Ink's pane (origin pane, scrollback)| n/a (the chrome pane)      |
| `thinking`               | `${tmpdir}/octmux-${pid}-thinking.fifo` | `select-pane -T thinking`  |
| `tool-call`              | `${tmpdir}/octmux-${pid}-tool-call.fifo` | `select-pane -T tool-call` |
| `tool-result`            | `${tmpdir}/octmux-${pid}-tool-result.fifo` | `select-pane -T tool-result` |
| (future) `subagent:<id>` | `${tmpdir}/octmux-${pid}-subagent-<id>.fifo` | `select-pane -T subagent:<id>` |

Anything that wants to consume octmux's output — a default
`tail -F` per side pane, or opentmux's pane-renderer — reads from
the FIFOs. Anything that wants to control how the panes *look*
configures tmux. octmux itself stays out of both concerns.

**What this rules out (deliberately).**

- octmux drawing borders around streamed content using Ink. The
  borders, if any, are drawn by tmux around the pane that holds
  the content. Ink box-borders are reserved for modals
  (`PermissionModal`, `QuestionModal`) which live inside the
  chrome pane and need React-style reactive composition.
- octmux choosing pane border characters, colours, or title
  formats. All of those are tmux options (`pane-border-status`,
  `pane-border-format`, `pane-active-border-style`,
  `pane-border-style`) the user or opentmux owns.
- octmux managing focus or implementing pane-navigation
  keybindings. tmux owns the user's `prefix h/j/k/l` (or whatever
  the user has bound); octmux does not intercept them.
- octmux trying to render multi-pane layouts inside a single
  terminal viewport. The instinct to do this in Ink is the wrong
  instinct: tmux already exists, is already running, and does it
  better.

**What octmux DOES own programmatically inside this contract:**

- Choosing which `Role` exists and which gets its own pane (the
  `SIDE_ROLES` array in `tmux-pane.ts`).
- Creating the FIFO for each role and spawning the pane with
  `split-window` (with a default geometry; opentmux may override).
- Setting the pane title via `select-pane -T <role>` so tmux's
  `pane-border-format` can render it.
- Cleaning up FIFOs and panes on shutdown.
- The per-role ANSI prefix glyph in `formatLine` (`│`, `⚙`, `↳`) —
  this is intra-content framing, written to the pane's byte stream,
  visible regardless of whether tmux draws a border around the
  pane. It does not depend on tmux configuration.

That last item is worth dwelling on: there are *two* kinds of
framing in play, and they are independent.

1. **Pane-level framing** — borders, titles, focus highlights
   *around* a pane. Drawn by tmux. Configured by tmux options.
   Survives resize and detach/reattach because tmux owns it.
2. **Intra-pane framing** — left-rail glyphs, role colour, visual
   separators *inside* a pane's content stream. Drawn by octmux's
   ANSI formatter. Embedded in the byte stream itself. Survives
   tmux capture-pane and copy-paste because it's just text.

The two compose cleanly. A tmux border labelled "thinking" wraps a
pane whose internal lines all start with `│ ` in dim grey. The
user sees both layers simultaneously: tmux's structural framing,
octmux's semantic prefixing. Neither layer is doing the other's
job.

## Architecture at a glance (post-Phase-3U)

```
src/
  index.tsx              entry: args, lifecycle, renderer selection, render(<App/>)
  server-lifecycle.ts    (unchanged)
  events.ts              extended: emits block events, not just text-delta
  blocks.ts              (new) typed Block model + formatBlock() (ANSI strings)
  editor.ts              (unchanged)
  app.tsx                <App>: chrome only; streams go through renderer
  keybindings.ts         (unchanged)
  renderer/
    types.ts             (new) Renderer interface + Block types re-export
    stdout.ts            (new) StdoutRenderer: <Static>-backed ANSI writer
    tmux-pane.ts         (new) TmuxPaneRenderer: per-role panes via FIFOs
    fifo.ts              (new) FIFO lifecycle helpers (mkfifo, open, cleanup)
    visibility.ts        (new) per-role on/off state + slash-command parser
  components/
    PromptInput.tsx      (unchanged)
    Rule.tsx             (unchanged)
    StatusLine.tsx       (will gain visibility-indicator badges in 3U.3)
    PermissionModal.tsx  (unchanged)
    QuestionModal.tsx    (unchanged)
  hooks/
    useMouseScroll.ts    (unchanged)
```

One source file per concern, same layout convention as Phase 3 Extended.
`.tsx` for React components, `.ts` for plain logic.

## Sub-phase execution order

Each sub-phase is independently shippable and verifies standalone.

- **3U.1** — Block-typed event surface + ANSI formatter (no rendering change).
- **3U.2** — Direct-to-terminal streaming: kill the flicker (Option 4).
- **3U.3** — Per-role visibility toggles (`/show thinking off` etc).
- **3U.4** — Extract `Renderer` interface (Option 2 seam).
- **3U.5** — `TmuxPaneRenderer`: multi-pane layout via FIFOs (Option 3).
- **3U.6** — Cleanup + parent-plan update.

---

### Phase 3U.1 — Block-typed event surface + formatter (½ day)

**Status:** ✓ complete

**Goal:** introduce a typed `Block` model and an ANSI formatter that
turns a block into a coloured, prefixed string. Extend `src/events.ts`
so block-level events for thinking and tool parts reach `<App>`. No
rendering change yet — this phase only restructures the event stream
and adds a pure formatter. Existing behaviour preserved bit-for-bit.

**Deliverable:** `src/events.ts` emits new `ReplEvent` kinds:
`block-start`, `block-delta`, `block-end` for each of `text`,
`thinking`, `tool-call`, `tool-result`. The existing `text-delta`
kind is preserved as an alias for `block-delta` on a text block (so
`<App>` keeps compiling unchanged for now). A new `src/blocks.ts`
exports a `Block` type and a `formatBlock(block, mode)` function
returning an ANSI string ready to write to stdout. A standalone
smoke test (a one-off `bun run src/blocks.smoke.ts` not committed)
prints sample blocks of each kind to stdout and visually confirms
the colour scheme.

**Files to create / modify:**

- `src/blocks.ts` (new):
  ```ts
  export type Role = "user" | "text" | "thinking" | "tool-call" | "tool-result" | "error";

  export type Block = {
    id: string;          // partID from opencode, or synthetic for user/error
    role: Role;
    text: string;        // accumulated text for the block; mutable during streaming
    meta?: {
      toolName?: string;     // for tool-call / tool-result
      toolStatus?: "running" | "ok" | "error";
    };
  };

  // ANSI sequences (kept inline rather than importing chalk; one less dep).
  const ANSI = {
    reset:    "\x1b[0m",
    dim:      "\x1b[2m",
    bold:     "\x1b[1m",
    cyan:     "\x1b[36m",
    yellow:   "\x1b[33m",
    magenta:  "\x1b[35m",
    red:      "\x1b[31m",
    gray:     "\x1b[90m",
    invert:   "\x1b[7m",
  };

  // Convert one line of a block to its ANSI-formatted form.
  // Caller is responsible for line-splitting; this function never sees \n.
  export function formatLine(role: Role, line: string, isFirstLine: boolean): string {
    switch (role) {
      case "user":         return ANSI.invert + "> " + line + ANSI.reset;
      case "text":         return line;
      case "thinking":     return ANSI.gray + (isFirstLine ? "│ " : "│ ") + line + ANSI.reset;
      case "tool-call":    return ANSI.cyan + (isFirstLine ? "⚙ " : "  ") + line + ANSI.reset;
      case "tool-result":  return ANSI.dim  + (isFirstLine ? "  ↳ " : "    ") + line + ANSI.reset;
      case "error":        return ANSI.red  + "[error] " + line + ANSI.reset;
    }
  }

  // Convenience for finalised blocks (committed at once, not streamed).
  export function formatBlock(block: Block): string {
    const lines = block.text.split("\n");
    return lines.map((l, i) => formatLine(block.role, l, i === 0)).join("\n");
  }
  ```

- `src/events.ts` (modify):
  - Extend the `ReplEvent` union with the new kinds. Keep `text-delta`
    as an alias for backward compatibility with the current
    `app.tsx` — the existing dispatch in `<App>` keeps working until
    3U.2 rewrites it.
    ```ts
    export type ReplEvent =
      | { kind: "text-delta"; text: string }                              // existing — alias for block-delta on a text block
      | { kind: "block-start"; partID: string; role: Role; toolName?: string }
      | { kind: "block-delta"; partID: string; role: Role; text: string }
      | { kind: "block-end"; partID: string; role: Role; status?: "ok" | "error" }
      | { kind: "session-idle" }
      | { kind: "error"; message: string }
      | { kind: "generating" }
      | { kind: "session-status"; status: "idle" | "busy" | "retry" }
      | { kind: "part-removed"; partId: string }
      | { kind: "permission-asked"; ... }                                 // unchanged
      | { kind: "question-asked"; ... };                                  // unchanged
    ```
  - In `filterEvent`, broaden the `message.part.delta` branch to emit
    block events for **any** non-user part type. The exact opencode
    part types must be confirmed by the implementer — the v2 SDK
    exposes them via `event.properties.field` and the parent part's
    `type`. Expected mapping (verify before committing):
    | opencode `part.type` | `field` of delta | emit Role          |
    |---|---|---|
    | `text`               | `text`           | `"text"`           |
    | `reasoning`          | `text`           | `"thinking"`       |
    | `tool`               | `input` / `args` | `"tool-call"`      |
    | `tool`               | `output` / `result` | `"tool-result"` |
  - First time a `partID` is seen → emit `block-start`. Subsequent
    deltas → emit `block-delta`. When `message.part.updated` arrives
    with a terminal state (e.g. tool status changes to `completed`)
    or when the part is implicitly closed by a new part starting,
    emit `block-end`. Track open partIDs in a `Map<string, Role>`.
  - **Keep emitting `text-delta`** alongside the new events for text
    blocks specifically. This is the compat shim; 3U.2 removes the
    `text-delta` branch from `<App>` and at that point we can drop
    `text-delta` from the union (do this in 3U.6).

- `src/blocks.smoke.ts` (new, **not committed** — `.gitignore` covers
  it via `*.smoke.ts` if you want):
  ```ts
  import { formatBlock } from "./blocks.ts";
  for (const role of ["user","text","thinking","tool-call","tool-result","error"] as const) {
    process.stdout.write(formatBlock({ id: "x", role, text: `sample ${role} content\nsecond line` }) + "\n\n");
  }
  ```

**Critical implementation note — opencode part-type discovery:**

The v2 SDK does not currently expose a stable enum for part types in
its TypeScript surface. The implementer must:

1. Add temporary `console.error(JSON.stringify(event.properties))` to
   `events.ts` for `message.part.delta` and `message.part.updated`.
2. Trigger each kind: a normal text response, a response with thinking
   enabled (model = `claude-opus-4-7-thinking` or similar — check
   current opencode config), and a response that invokes a tool
   (e.g. ask the agent to read a file).
3. Record the observed `part.type` and `field` values in a table
   inside `events.ts` as a comment block above `filterEvent`.
4. Remove the diagnostic logging before commit.

If `reasoning` is not the actual type name, the table above is wrong;
the implementer's discovery is authoritative.

**Manual verification:**

1. `bun run dev` — no regression. Text streaming behaves exactly as
   before (the compat `text-delta` alias keeps `app.tsx` working).
2. Submit a prompt that triggers a tool call. Inspect logs to confirm
   `block-start`, multiple `block-delta`, and `block-end` events fire
   for the tool part. They are not yet rendered.
3. Submit a prompt with thinking enabled. Same — thinking part events
   fire but render path is unchanged.
4. Run the smoke test: each role's sample line appears in its colour.
5. `grep "console.error" src/events.ts` returns nothing (diagnostic
   logging removed).

**Out of scope:** any change to `app.tsx` rendering, any UI for
thinking/tool blocks, the renderer interface (3U.4), visibility
toggles (3U.3), tmux integration (3U.5).

**Handoff to 3U.2:** the event stream now carries block-level
information for every part type. `<App>` still consumes only the
compat `text-delta`. The next phase replaces the dynamic-region
`streamBuf` rendering with `<Static>`-backed line commits driven by
the new block events.

---

### Phase 3U.2 — Direct-to-terminal streaming: kill the flicker (1–1½ days)

**Status:** ✓ complete

**Goal:** rewrite the streaming render path in `app.tsx` so the
dynamic region holds only the bottom chrome plus at most one
in-progress line. Finalised lines are committed to `<Static>`. The
content rendered by Static items is a single `<Text>{ansiString}</Text>`
where `ansiString` contains the role prefix and colour escapes — the
terminal handles wrapping, layout, and scrollback. After this phase,
flicker is gone on responses of any length.

**Deliverable:** typing a prompt that produces a 3000-token streamed
response with interleaved thinking and tool calls shows: (a) the
bottom chrome stays anchored and never flickers, (b) committed lines
appear above the chrome with correct per-role colours, (c) the
in-progress trailing line updates live as chunks arrive, (d)
`tmux capture-pane -p` captures all streamed content as plain
ANSI-bearing text, (e) `Ctrl-Shift-`-selecting text in the terminal
copies cleanly without Ink artefacts.

**Files to create / modify:**

- `src/app.tsx` (major refactor):
  - **Remove:** `streamBuf` state, `streamBufRef`, `flushTimerRef`,
    the 50 ms debounce — all gone. The compat `text-delta` branch in
    the SSE loop also goes; 3U.1 already emits the block events that
    replace it.
  - **Remove:** the inline `{streamBuf && <Text>{streamBuf}</Text>}`
    render between Static and the bottom Box.
  - **Add:** new state for line-granularity rendering:
    ```ts
    type CommittedLine = {
      id: number;          // monotonic for Static key
      role: Role;
      ansi: string;        // pre-formatted, ready to write
    };

    const [committed, setCommitted] = useState<CommittedLine[]>([]);
    const [tail, setTail] = useState<{ role: Role; text: string } | null>(null);
    const tailBufRef = useRef<string>("");
    const activeBlockRef = useRef<{ partID: string; role: Role } | null>(null);
    ```
  - **Add:** the central dispatcher. On every block-delta:
    ```ts
    function handleBlockDelta(ev: { partID: string; role: Role; text: string }) {
      // Switching blocks? Flush the prior tail.
      if (activeBlockRef.current && activeBlockRef.current.partID !== ev.partID) {
        flushTail();
      }
      activeBlockRef.current = { partID: ev.partID, role: ev.role };
      tailBufRef.current += ev.text;

      // Split off any complete lines and commit them.
      let buf = tailBufRef.current;
      let nl = buf.indexOf("\n");
      const newCommits: CommittedLine[] = [];
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        newCommits.push({
          id: nextId++,
          role: ev.role,
          ansi: formatLine(ev.role, line, /* isFirstLine doesn't matter past line 0 */ false),
        });
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      tailBufRef.current = buf;

      if (newCommits.length > 0) setCommitted(prev => [...prev, ...newCommits]);
      setTail(buf ? { role: ev.role, text: buf } : null);
    }

    function flushTail() {
      if (tailBufRef.current) {
        const role = activeBlockRef.current!.role;
        setCommitted(prev => [...prev, {
          id: nextId++,
          role,
          ansi: formatLine(role, tailBufRef.current, false),
        }]);
        tailBufRef.current = "";
      }
      setTail(null);
      activeBlockRef.current = null;
    }
    ```
  - On `block-end`: `flushTail()`.
  - On `session-idle`: `flushTail()`, plus a separator blank line
    pushed to `committed` for visual breathing room.
  - On `error`: emit a single committed line via `formatLine("error", ...)`.
  - Keep `permission-asked` and `question-asked` handling unchanged.
  - **Add:** when a user message is submitted (`handleSubmit`), push
    a user line directly to `committed` instead of the current
    `history` array. The `history` state goes away; everything is in
    `committed` now.

  - **Render block becomes:**
    ```tsx
    return (
      <>
        <Static items={committed}>
          {(item) => <Text key={item.id}>{item.ansi}</Text>}
        </Static>
        {tail && <Text>{formatLine(tail.role, tail.text, false)}</Text>}
        {isGenerating && !tail && <Text dimColor>[generating…]</Text>}
        {ctrlcPending && <Text color="yellow">Press Ctrl-C again to exit</Text>}
        {permission && <PermissionModal title={permission.title} onAnswer={handlePermission} />}
        {question && <QuestionModal questions={question.questions} onAnswer={handleQuestion} />}
        <Box flexDirection="column" marginBottom={3}>
          <Rule title={props.sessionLabel} width={w} align="right" />
          <PromptInput editor={editor} disabled={isGenerating || !!permission || !!question} onSubmit={handleSubmit} />
          <Rule width={w} />
          <StatusLine />
        </Box>
      </>
    );
    ```

**Why this kills the flicker (in one paragraph, for the implementer):**

Ink's reconciler diffs the dynamic region in place when its rendered
height fits below the last Static commit. With the rewrite, the
dynamic region is `tail (≤ 1 line) + [generating] (≤ 1 line) +
Rule(1) + PromptInput(1+) + Rule(1) + StatusLine(1) + marginBottom(3)`
— at most ~9 lines, regardless of how long the response is. This
sits well below any reasonable terminal height. Ink never falls into
clear-and-redraw mode. Every newly-completed line goes through
`<Static>`, which appends-and-commits exactly once per item — no
re-render of prior content.

**Why ANSI escapes in the Static-rendered string, not `<Text color>`:**

Ink's `<Text color="cyan">` wraps content in styled spans that Yoga
lays out. For a single line of plain text that's fine, but: (a) it
makes per-line content less portable to the `TmuxPaneRenderer` in
3U.5 (we want the exact same byte stream going to a FIFO), (b) it
means future tool output that already contains ANSI (e.g. compiler
errors) gets double-styled. Passing pre-formatted strings through
`<Text>` keeps Ink's role to "emit these bytes; the terminal does
the rest" — exactly the Option 4 invariant.

**Subtle issue — Static item key stability:**

Ink's `<Static>` uses the `key` to decide whether an item was
already committed. The monotonic `nextId` counter satisfies this:
old items keep their keys, new items get new ones. Do not reuse
keys. Do not derive keys from content (lines repeat).

**Subtle issue — user message echo:**

Today `app.tsx` shows the user's prompt by pushing it to `history`
with `<Text inverse>`. The new model: format the user input as a
`user` block via `formatLine("user", text, true)` and push to
`committed`. The inverse styling is in the ANSI string now.

**Subtle issue — partial-line ANSI:**

When the tail line is being rendered in the dynamic region, it
already has its role prefix and colour ANSI. If the chunk that
arrives mid-line contains its own ANSI (e.g. tool output that's
already coloured), the colours will compose oddly. Acceptable for
v1 — document as a known limitation. A future patch could strip
nested SGR sequences from incoming chunks.

**Manual verification:**

1. `bun run dev` — submit a one-word prompt. Response streams in;
   chrome does not flicker; final response appears in scrollback.
2. Submit "write a 300-line poem about tmux". Watch the whole response
   stream past. Chrome must remain perfectly still. Use a screen
   recorder if you can't trust your eyes — frame-by-frame should
   show the bottom rule pixels stable.
3. Submit a prompt that triggers thinking (if opencode supports it
   in your config). Thinking lines appear in dim gray with `│ ` prefix.
4. Submit a prompt that invokes a tool. Tool call lines appear cyan
   with `⚙ ` prefix; tool result lines appear dim with `↳ ` prefix.
5. `tmux capture-pane -pS -1000` after a long response — output
   contains all streamed lines as plain text with their ANSI escapes
   intact.
6. Select a multi-line range of streamed text with mouse — paste
   into another window — content is clean (no Ink box-drawing artefacts).
7. Resize the terminal narrower during a response — already-committed
   lines wrap via the terminal's reflow (acceptable; not perfect but
   matches every terminal app's behaviour).
8. Permission modal and question modal both still render correctly
   between Static and chrome.
9. Ctrl-C during streaming still aborts and restores `lastSubmitted`.

**Out of scope:** visibility toggles (3U.3), renderer abstraction
(3U.4), tmux pane integration (3U.5).

**Handoff to 3U.3:** flicker is gone. Every kind of streamed
content lands as colour-coded lines in scrollback. The next phase
adds per-role on/off toggles so a user can collapse thinking and
tool calls when they're noise.

---

### Phase 3U.3 — Per-role visibility toggles (½ day)

**Status:** ✓ complete

**Goal:** let the user hide thinking and/or tool-call blocks via
slash commands. When hidden, the role's content does not commit to
scrollback; instead, a one-line summary indicator appears
("⚙ 3 tool calls hidden") that updates as blocks of that role
arrive. Toggles persist for the session.

**Deliverable:** typing `/show thinking off` and pressing Enter
suppresses subsequent thinking lines. `/show thinking on` re-enables
them (already-suppressed lines stay hidden — toggling does not
back-fill scrollback). Same for `tools`. `/show` with no args prints
current state. `StatusLine` gains small badges showing which roles
are hidden (`T·` for thinking, `⚙·` for tools).

**Files to create / modify:**

- `src/renderer/visibility.ts` (new):
  ```ts
  import { EventEmitter } from "node:events";
  import type { Role } from "../blocks.ts";

  export class Visibility extends EventEmitter {
    private state: Record<Role, boolean> = {
      user: true, text: true, thinking: true,
      "tool-call": true, "tool-result": true, error: true,
    };
    private counts: Record<Role, number> = {
      user: 0, text: 0, thinking: 0,
      "tool-call": 0, "tool-result": 0, error: 0,
    };

    isVisible(r: Role): boolean { return this.state[r]; }
    set(r: Role, on: boolean): void {
      if (this.state[r] === on) return;
      this.state[r] = on;
      if (on) this.counts[r] = 0;
      this.emit("changed");
    }
    increment(r: Role): void {
      this.counts[r]++;
      this.emit("changed");
    }
    hiddenSummary(): Array<{ role: Role; count: number }> {
      const out = [];
      for (const r of Object.keys(this.state) as Role[]) {
        if (!this.state[r] && this.counts[r] > 0) out.push({ role: r, count: this.counts[r] });
      }
      return out;
    }
  }

  // Slash command parser. Returns true if input was a recognised /show command.
  export function parseShowCommand(input: string, vis: Visibility): { handled: boolean; reply?: string } {
    const m = input.trim().match(/^\/show(?:\s+(\S+))?(?:\s+(on|off))?$/);
    if (!m) return { handled: false };
    const [, what, action] = m;
    if (!what) {
      const rolesOff = (["thinking","tool-call","tool-result"] as Role[]).filter(r => !vis.isVisible(r));
      return { handled: true, reply: rolesOff.length === 0 ? "all visible" : `hidden: ${rolesOff.join(", ")}` };
    }
    const role: Role | null =
      what === "thinking" ? "thinking" :
      what === "tools" ? "tool-call" :          // shorthand toggles both call+result
      what === "tool-call" ? "tool-call" :
      what === "tool-result" ? "tool-result" :
      null;
    if (!role || !action) return { handled: false };
    vis.set(role, action === "on");
    if (what === "tools") vis.set("tool-result", action === "on");
    return { handled: true, reply: `${what} ${action}` };
  }
  ```

- `src/app.tsx` (modify):
  - Construct a `Visibility` singleton: `const [vis] = useState(() => new Visibility())`.
  - Subscribe to `vis.on("changed", forceRerender)` so `StatusLine`
    badges update live.
  - In `handleSubmit`: before calling `client.session.promptAsync`,
    parse the input with `parseShowCommand(text, vis)`. If
    `handled === true`, do not submit to the LLM; push a synthetic
    system block to `committed` carrying the reply, return early.
  - In `handleBlockDelta`: before any commit / tail update, check
    `vis.isVisible(ev.role)`. If false, `vis.increment(ev.role)` and
    return without rendering anything. The block-end event also
    returns early for hidden roles.
  - Pass `vis` to `StatusLine`.

- `src/components/StatusLine.tsx` (modify):
  ```tsx
  import { Text } from "ink";
  import type { Visibility } from "../renderer/visibility.ts";
  import { useSyncExternalStore } from "react";

  export function StatusLine({ vis }: { vis: Visibility }) {
    const summary = useSyncExternalStore(
      (cb) => { vis.on("changed", cb); return () => vis.off("changed", cb); },
      () => vis.hiddenSummary(),
    );
    if (summary.length === 0) return <Text dimColor>[idle]</Text>;
    const parts = summary.map(s => {
      const icon = s.role === "thinking" ? "T" : s.role === "tool-call" ? "⚙" : "·";
      return `${icon}·${s.count}`;
    });
    return <Text dimColor>[idle]  hidden: {parts.join(" ")}</Text>;
  }
  ```

**UX detail — what hidden blocks look like in scrollback:**

By design, hidden blocks emit nothing to scrollback. The user sees:
text response → text response → text response, uninterrupted by
thinking/tool noise. The single source of "something was hidden" is
the StatusLine summary. This is deliberate: inline summaries
("[3 tool calls hidden]") would themselves be noise, defeating the
purpose. If the user wants to inspect what happened, they toggle the
role back on for the next turn.

The hidden counts reset on toggle-on; that way the StatusLine
reflects "what's currently being suppressed" rather than lifetime
counts. The session-total view is a Phase 4 concern.

**Manual verification:**

1. Submit `/show` (no args) → reply "all visible" appears as a
   system line. StatusLine reads `[idle]`.
2. Submit `/show thinking off` → reply "thinking off". Submit a
   prompt that triggers thinking → no thinking lines in scrollback;
   StatusLine shows `[idle]  hidden: T·N` where N is the count.
3. Submit `/show thinking on` → reply "thinking on". StatusLine
   returns to `[idle]`. The next prompt's thinking is visible again.
   Already-elided thinking is not back-filled (expected).
4. Submit `/show tools off` → tool calls AND tool results both
   suppressed. Submit a prompt invoking a tool → no tool lines;
   StatusLine shows `[idle]  hidden: ⚙·N`.
5. Submit `/show whatever off` → no parser match → input is treated
   as a normal prompt (the LLM gets it). Document this as the
   fallback behaviour.

**Out of scope:** renderer abstraction (3U.4), tmux integration (3U.5),
persisting toggles across sessions (Phase 4), keybinding shortcuts
(future polish).

**Handoff to 3U.4:** the rendering is correct and configurable. The
next phase extracts the rendering machinery into a `Renderer`
interface so a future tmux-pane backend can be a swap.

---

### Phase 3U.4 — Extract Renderer interface (Option 2 seam) (½ day)

**Status:** ☐ pending

**Goal:** pull the "format a block; commit to Static; manage tail
buffer" logic out of `app.tsx` and behind a `Renderer` interface.
The current behaviour becomes a `StdoutRenderer` implementation. No
functional change; this phase only restructures the code so 3U.5
can implement a second backend without touching `<App>`.

**Deliverable:** `<App>` calls `renderer.beginBlock()`, `renderer.appendToBlock()`,
`renderer.endBlock()`, `renderer.commitUserInput()`, `renderer.commitError()`.
The `StdoutRenderer` implements these by managing the Static-items
state and exposing a `useScrollback()` hook that `<App>` consumes
for rendering. All Phase 3U.3 behaviour preserved bit-for-bit.

**Files to create / modify:**

- `src/renderer/types.ts` (new):
  ```ts
  import type { Block, Role } from "../blocks.ts";
  import type { Visibility } from "./visibility.ts";

  export interface Renderer {
    // Streaming primitives — called from <App>'s SSE dispatch.
    beginBlock(partID: string, role: Role, meta?: Block["meta"]): void;
    appendToBlock(partID: string, text: string): void;
    endBlock(partID: string, status?: "ok" | "error"): void;

    // One-shot primitives — called for non-streamed entries.
    commitUserInput(text: string): void;
    commitSystemMessage(text: string): void;       // for /show replies etc.
    commitError(message: string): void;

    // Lifecycle.
    dispose(): Promise<void>;

    // Backend identifies itself for the StatusLine / debug.
    readonly kind: "stdout" | "tmux-pane";

    // Visibility (shared by all backends).
    readonly visibility: Visibility;
  }
  ```

- `src/renderer/stdout.ts` (new):
  ```ts
  import { EventEmitter } from "node:events";
  import type { Renderer } from "./types.ts";
  import type { Block, Role } from "../blocks.ts";
  import { formatLine } from "../blocks.ts";
  import { Visibility } from "./visibility.ts";

  export type CommittedLine = { id: number; role: Role; ansi: string };

  export class StdoutRenderer extends EventEmitter implements Renderer {
    readonly kind = "stdout" as const;
    readonly visibility: Visibility;

    private committed: CommittedLine[] = [];
    private tail: { role: Role; text: string; partID: string } | null = null;
    private nextId = 0;

    constructor(visibility: Visibility) {
      super();
      this.visibility = visibility;
    }

    beginBlock(partID: string, role: Role) {
      if (!this.visibility.isVisible(role)) return;
      this.flushTailIfDifferent(partID);
    }

    appendToBlock(partID: string, text: string) {
      // Recover role from any prior tail OR from a stored open-blocks map.
      // For brevity here, expect callers to call beginBlock first; track open blocks in an internal Map.
      const open = this.openBlocks.get(partID);
      if (!open) return;
      if (!this.visibility.isVisible(open.role)) {
        this.visibility.increment(open.role);
        return;
      }
      // ... line-split-and-commit as in 3U.2's handleBlockDelta ...
      this.emit("changed");
    }

    endBlock(partID: string) {
      this.flushTailIfDifferent(null);
      this.openBlocks.delete(partID);
    }

    commitUserInput(text: string) { /* push formatted user line */ this.emit("changed"); }
    commitSystemMessage(text: string) { /* push formatted system line */ this.emit("changed"); }
    commitError(message: string) { /* push formatted error line */ this.emit("changed"); }
    async dispose() { /* no-op for stdout */ }

    // For <App> to render.
    getCommitted(): CommittedLine[] { return this.committed; }
    getTail(): { role: Role; text: string } | null { return this.tail; }

    private openBlocks = new Map<string, { role: Role }>();
    private flushTailIfDifferent(newPartID: string | null) { /* impl */ }
  }
  ```

- `src/app.tsx` (refactor):
  - Accept `renderer: Renderer` as a prop.
  - Replace `committed` / `tail` / `tailBufRef` / `activeBlockRef`
    state with reads from `renderer.getCommitted()` and
    `renderer.getTail()`, gated by a `useSyncExternalStore` subscribed
    to `renderer.on("changed", ...)`.
  - SSE dispatch becomes a thin translation layer:
    ```ts
    if (ev.kind === "block-start")  renderer.beginBlock(ev.partID, ev.role, { toolName: ev.toolName });
    if (ev.kind === "block-delta")  renderer.appendToBlock(ev.partID, ev.text);
    if (ev.kind === "block-end")    renderer.endBlock(ev.partID, ev.status);
    if (ev.kind === "error")        renderer.commitError(ev.message);
    // session-idle / generating / etc unchanged
    ```
  - `handleSubmit` calls `renderer.commitUserInput(text)` instead of
    pushing to a local `history` array.
  - The slash-command path calls `renderer.commitSystemMessage(reply)`.

- `src/index.tsx` (modify):
  - Construct the renderer at startup: `const renderer = new StdoutRenderer(new Visibility());`
  - Pass it as a prop: `<App renderer={renderer} ... />`.
  - On exit: `await renderer.dispose()`.

**Why a class with EventEmitter instead of a hook:**

Renderers must be swappable at construction time (3U.5 picks one
based on a CLI flag). A class is the simplest shape that
(a) carries state outside React, (b) survives hot-reload during
development, (c) admits a cleanly different implementation in 3U.5
without exporting different hook signatures.

**Manual verification:**

1. All of 3U.2 and 3U.3's manual verification steps pass unchanged.
2. `grep -r "committed\|tail\|activeBlockRef" src/app.tsx` returns
   nothing — the state is fully migrated to the renderer.
3. `wc -l src/app.tsx` is meaningfully smaller than before 3U.4
   (target: under 150 lines).
4. `<App>` compiles with `renderer: Renderer` typed as the interface,
   not the concrete `StdoutRenderer` — confirming the seam.

**Out of scope:** any new functionality. This phase is purely a
refactor.

**Handoff to 3U.5:** the seam is in place. The next phase implements
a second `Renderer` — `TmuxPaneRenderer` — that routes per-role
blocks to dedicated tmux panes via FIFOs. `<App>` is untouched in
3U.5; only `index.tsx`'s startup picks which renderer to construct.

---

### Phase 3U.5 — TmuxPaneRenderer: multi-pane layout via FIFOs (1½–2 days)

**Status:** ☐ pending

**Goal:** add a second `Renderer` implementation that spawns dedicated
tmux panes for non-text roles (thinking, tool-call, tool-result) and
feeds each pane its role's blocks via named pipes. The main pane
keeps the chrome and the text response stream. The user opts in via
`--multi-pane` at startup; a future slash command can flip it at
runtime.

**Deliverable:** running `octmux --multi-pane` inside tmux opens
three panes via `tmux split-window`: main (chrome + text), thinking,
tools. Each non-main pane is a `tail -F /tmp/octmux-<pid>-<role>.fifo`
process. Submitting a prompt that triggers thinking and tool calls
fills the side panes concurrently with content. Quitting octmux
closes the side panes and removes the FIFOs.

**Files to create / modify:**

- `src/renderer/fifo.ts` (new):
  ```ts
  import { mkfifoSync } from "node:fs";        // not in stdlib; see note
  import * as fs from "node:fs";
  import * as os from "node:os";
  import * as path from "node:path";

  // Bun does not expose mkfifo natively. Use child_process to call /usr/bin/mkfifo,
  // which is available on every Linux distro octmux supports.
  import { execFileSync } from "node:child_process";

  export type FifoHandle = {
    path: string;
    writer: fs.WriteStream;
    close: () => Promise<void>;
  };

  export function makeFifo(role: string, pid: number): FifoHandle {
    const p = path.join(os.tmpdir(), `octmux-${pid}-${role}.fifo`);
    try { fs.unlinkSync(p); } catch {}
    execFileSync("mkfifo", [p]);
    // Open with O_RDWR to avoid blocking until a reader attaches.
    // (Opening write-only on a FIFO with no reader hangs the process.)
    const fd = fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const writer = fs.createWriteStream("", { fd, autoClose: false });
    return {
      path: p,
      writer,
      close: async () => {
        await new Promise<void>((res) => writer.end(() => res()));
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(p); } catch {}
      },
    };
  }
  ```

- `src/renderer/tmux-pane.ts` (new):
  ```ts
  import { execFileSync } from "node:child_process";
  import type { Renderer } from "./types.ts";
  import type { Role } from "../blocks.ts";
  import { formatLine } from "../blocks.ts";
  import { makeFifo, type FifoHandle } from "./fifo.ts";
  import { StdoutRenderer } from "./stdout.ts";
  import { Visibility } from "./visibility.ts";

  // Panes for non-text roles. Text + user + error stay in the main pane (delegated to a StdoutRenderer).
  const SIDE_ROLES: Role[] = ["thinking", "tool-call", "tool-result"];

  export class TmuxPaneRenderer implements Renderer {
    readonly kind = "tmux-pane" as const;
    readonly visibility: Visibility;
    private main: StdoutRenderer;
    private fifos = new Map<Role, FifoHandle>();
    private paneIds = new Map<Role, string>();   // tmux pane IDs (%N format)

    constructor(visibility: Visibility) {
      this.visibility = visibility;
      this.main = new StdoutRenderer(visibility);
    }

    async setup() {
      for (const role of SIDE_ROLES) {
        const fifo = makeFifo(role, process.pid);
        this.fifos.set(role, fifo);
        // Spawn a side pane that tails the fifo. -P prints the new pane ID; -F formats it.
        const id = execFileSync("tmux", [
          "split-window", "-h", "-P", "-F", "#{pane_id}",
          `tail -F ${fifo.path}`,
        ]).toString().trim();
        this.paneIds.set(role, id);
        // Label the pane for visual differentiation.
        execFileSync("tmux", ["select-pane", "-t", id, "-T", role]);
      }
      // Return focus to the originating pane (the one octmux is running in).
      // tmux remembers it via display-message; the simplest approach is to track
      // the originating pane ID before any splits and select it last.
      // Implementer to fill in — see "tmux pane id discovery" below.
    }

    beginBlock(partID: string, role: Role, meta?: any) {
      if (this.isSideRole(role)) return;          // FIFOs are append-only; no per-block setup needed
      this.main.beginBlock(partID, role, meta);
    }

    appendToBlock(partID: string, text: string) {
      const role = this.roleForPart(partID);     // small open-blocks map; same pattern as StdoutRenderer
      if (!role) return;
      if (!this.visibility.isVisible(role)) { this.visibility.increment(role); return; }
      if (this.isSideRole(role)) {
        // Format and write straight to the role's fifo. The tail process renders it.
        this.fifos.get(role)!.writer.write(formatLine(role, text, false));
      } else {
        this.main.appendToBlock(partID, text);
      }
    }

    endBlock(partID: string, status?: "ok" | "error") {
      const role = this.roleForPart(partID);
      if (role && this.isSideRole(role)) {
        this.fifos.get(role)!.writer.write("\n");  // separator
      } else {
        this.main.endBlock(partID, status);
      }
    }

    commitUserInput(t: string)      { this.main.commitUserInput(t); }
    commitSystemMessage(t: string)  { this.main.commitSystemMessage(t); }
    commitError(m: string)          { this.main.commitError(m); }

    async dispose() {
      for (const [role, fifo] of this.fifos) {
        try { execFileSync("tmux", ["kill-pane", "-t", this.paneIds.get(role)!]); } catch {}
        await fifo.close();
      }
      await this.main.dispose();
    }

    private isSideRole(r: Role) { return SIDE_ROLES.includes(r); }
    private roleForPart(_pid: string): Role | null { /* track via Map<partID, Role> populated in beginBlock */ return null; }
  }
  ```

**Implementation note — block-separator blank lines must NOT go to side-pane FIFOs.**

`StdoutRenderer` (via `app.tsx`'s `handleBlockDelta` and `session-idle` handlers) emits
2-blank-line separators between every block transition and at the end of each turn. These
separators exist to give visual breathing room in the single main-pane view.

When `TmuxPaneRenderer` routes a block to a side pane via a FIFO, it must **not** write
those blank separators. Each side pane contains only its own role's content — adding
surrounding whitespace would produce leading/trailing blank lines inside the pane that
the user did not generate. The pane already has visual framing from tmux's border; it
does not need intra-content padding.

Concrete rule for `TmuxPaneRenderer.appendToBlock` and `endBlock`:

- Write only `formatLine(role, text, false)` to the FIFO — the raw formatted content.
- Do **not** write blank separator lines before or after the block.
- The `endBlock` separator in the skeleton above (`writer.write("\n")`) is acceptable as
  a single trailing newline to terminate the last content line cleanly. It is not the
  2-blank-line turn separator from `StdoutRenderer` and should not be changed to match it.

The `StdoutRenderer.endBlock()` and the `session-idle` path in `app.tsx` add the 2-blank
spacing for the main pane. That logic lives inside `StdoutRenderer` and is invisible to
`TmuxPaneRenderer`. No cross-renderer coordination is needed; the separation of concerns
already enforces the right behaviour.

- `src/index.tsx` (modify):
  - Add `--multi-pane` to the argv check at the top.
  - Renderer selection:
    ```ts
    const visibility = new Visibility();
    const renderer: Renderer = args.includes("--multi-pane")
      ? new TmuxPaneRenderer(visibility)
      : new StdoutRenderer(visibility);
    if (renderer.kind === "tmux-pane") await (renderer as TmuxPaneRenderer).setup();
    ```
  - Pass to `<App renderer={renderer} ... />`.
  - On exit (Ctrl-C double-press or SIGTERM): `await renderer.dispose()`.

**tmux pane id discovery (read once):**

To clean up cleanly and to know which pane "owns" the chrome, octmux
needs to record its originating pane ID before any splits. tmux
exposes this via the `$TMUX_PANE` environment variable when octmux
starts. Capture it in `index.tsx`:
```ts
const originPaneId = process.env.TMUX_PANE;
```
After all splits, `tmux select-pane -t $originPaneId` returns focus.

**Layout choice (single source of truth):**

The simplest layout that matches the opentmux demo is:
- Main pane (octmux's origin): chrome + main text response.
- Right split: thinking pane.
- Right split of right split: tool-call pane.
- Below tool-call: tool-result pane.

tmux's `split-window -h` splits horizontally (creates a right pane);
`split-window -v` splits vertically. Order matters: split right
first, then split the right pane vertically. This keeps the main
pane wide and stacks the side panes on the right. The implementer
may prefer a different geometry; document the chosen one in the
README's tmux section.

**Pane framing via tmux (this is the heart of 3U.5):**

Per the Division of responsibilities section above, octmux's job
ends at "spawn the pane and label it." Everything visual about the
panes — borders, title-bar position, focus highlights, inactive
appearance — is configured by tmux options, not octmux code. This
subsection makes the boundary concrete by listing every dial and
who owns it.

**What octmux MUST do programmatically (inside `TmuxPaneRenderer.setup()`):**

1. Capture the origin pane ID before any splits:
   ```ts
   const originPaneId = process.env.TMUX_PANE;
   if (!originPaneId) throw new Error("octmux --multi-pane requires running inside tmux");
   ```
2. For each side role, create a FIFO and spawn a pane that tails
   it. The `-P -F "#{pane_id}"` flags make tmux print the new
   pane's ID so octmux can address it later for kill-pane:
   ```ts
   const id = execFileSync("tmux", [
     "split-window", "-h",          // or "-v" depending on geometry
     "-P", "-F", "#{pane_id}",
     `tail -F ${fifo.path}`,
   ]).toString().trim();
   ```
3. **Set the pane title** so tmux's `pane-border-format` can render
   it. This is the single visible call octmux makes to influence
   pane appearance:
   ```ts
   execFileSync("tmux", ["select-pane", "-t", id, "-T", role]);
   ```
4. After all panes are spawned, return focus to the origin pane:
   ```ts
   execFileSync("tmux", ["select-pane", "-t", originPaneId]);
   ```

That is the entire scope of what octmux does to "frame" panes:
spawn, label, return focus. No border characters, no colours, no
title formats. octmux does not write to tmux options; it does not
issue `set-option` or `set-window-option` commands.

**What `~/.tmux.conf` SHOULD set (user-tunable, not octmux's concern):**

Out of the box, tmux does not show per-pane title bars. For the
multi-pane UX to look like the opentmux demo, the user needs three
options enabled. Document this in `README.md` (handled in 3U.6) as
**recommended user configuration** — not as an octmux requirement,
because the multi-pane mode degrades gracefully without it
(borderless panes that still receive content via FIFOs).

Recommended snippet for `~/.tmux.conf`:

```tmux
# Per-pane title bar at the top of each pane.
set -g pane-border-status top

# Title bar format. Pane title is set by octmux via select-pane -T.
# Colours optional; this matches the opentmux aesthetic.
set -g pane-border-format " #[fg=cyan,bold]#{pane_title}#[default] "

# Distinguish active vs inactive panes visually.
set -g pane-active-border-style "fg=cyan"
set -g pane-border-style "fg=brightblack"

# Optional: thicker borders if your terminal supports them.
set -g pane-border-lines heavy
```

octmux's README should explain that without `pane-border-status
top`, the multi-pane mode still works — content streams into
unbordered panes — but the visual differentiation that motivated
3U.5 in the first place will be missing. The user is one config
line away from the full experience; octmux does not own that line.

**What opentmux WILL own (future integration):**

opentmux is the layer that turns the recommended snippet above
into a coherent, opinionated theme that applies consistently
across all octmux-spawned panes. Specifically, opentmux is
expected to:

1. Ship its own `pane-border-format` that may include status
   indicators beyond `pane_title` (e.g. block count, last-update
   timestamp, role-specific glyphs).
2. Apply different border styles per role (e.g. thinking panes
   get dim grey borders to match their muted content; tool panes
   get cyan to match the call-line glyph).
3. Define layout presets (`opentmux preset thinking-right`,
   `opentmux preset subagent-grid`) that the user invokes once
   and that re-arrange existing octmux panes accordingly.
4. Bind navigation keys that respect role semantics (e.g.
   `prefix t` always jumps to the thinking pane regardless of its
   geometric position).

None of those concerns are in 3U.5's scope. 3U.5 establishes the
contract — role names, FIFOs, pane titles — that opentmux will
build on. The contract is sufficient for opentmux to do all four
of the above without octmux changing.

**Verifying the boundary is clean (during 3U.5):**

A simple test confirms octmux is not leaking pane-styling concerns:

```bash
grep -E "pane-(border|active)|set-option|set-window-option" src/renderer/
```

This should return zero lines after 3U.5 is complete. If it
returns anything, that's octmux drawing pane framing — wrong layer.
The only tmux commands octmux issues are `split-window`,
`select-pane`, `kill-pane`, `list-panes`, and reads of
`$TMUX_PANE`. None of those touch styling.

**Edge cases to handle explicitly:**

1. **Octmux is not running inside tmux.** `$TMUX_PANE` is undefined.
   `--multi-pane` should error early with a clear message: "octmux
   --multi-pane requires running inside tmux."
2. **`mkfifo` is not on PATH.** Fail with a clear error pointing at
   the OS-package install command for `coreutils` (which provides
   mkfifo on Linux; macOS ships it as well).
3. **A side pane is killed manually by the user.** Detect via
   `tmux list-panes -F "#{pane_id}"` periodically? Simpler: catch
   the `EPIPE` on FIFO write and degrade gracefully — that role's
   content is silently dropped, optionally with a one-time
   StatusLine warning. Do not crash.
4. **Octmux crashes.** FIFOs in `/tmp` persist until reboot. Acceptable
   for v1; document the cleanup command (`rm /tmp/octmux-*.fifo`).
   Future polish: register an `unhandledException` handler that
   calls `renderer.dispose()`.

**Why FIFOs and not sockets:**

A FIFO is a 3-line setup with one filesystem-visible artefact and
no auth, no framing, no protocol — exactly what's needed for
"append-only text from one writer to one reader." Sockets would
add work for no benefit at this scale. If we ever want
bidirectional communication (e.g. a side pane sends keystrokes
back), revisit.

**Manual verification:**

1. Outside tmux: `octmux --multi-pane` exits with a clear error.
   `octmux` (no flag) still works as before.
2. Inside tmux: `octmux --multi-pane` opens three side panes.
   Submit a prompt that triggers thinking and a tool call. Thinking
   text streams to one side pane; tool call to another; tool result
   to the third. Main pane gets only the text response. Chrome
   stays anchored, no flicker.
3. Quit octmux (Ctrl-C double-press). Side panes disappear. FIFOs
   removed from `/tmp`.
4. Manually kill a side pane mid-stream (`tmux kill-pane -t %N`).
   Octmux continues. New content for that role is silently dropped.
   No crash.
5. Toggle `/show thinking off` — the thinking pane stops receiving
   new content. StatusLine shows the hidden count. Toggling back
   on resumes.
6. Resize the tmux window. Layout adjusts (tmux handles it). Main
   pane chrome stays correctly anchored at its bottom.
7. Detach and reattach the tmux session. State preserved.

**Out of scope:** runtime layout changes (slash command to switch
between single-pane and multi-pane mid-session — Phase 4), subagent
panes (each spawned subagent gets its own pane via the same
contract — Phase 5), pane geometry presets, status-bar integration,
**and anything that styles the panes themselves** — pane borders,
title-bar formats, active/inactive border colours, focus
highlights, border characters. Those are tmux options the user
sets in `~/.tmux.conf` (or that opentmux applies as a coherent
theme); octmux does not issue any `set-option` or
`set-window-option` commands. The only tmux commands octmux uses
are `split-window`, `select-pane -T`, `select-pane -t`,
`kill-pane`, and `list-panes` — none of which touch styling.

**Handoff to 3U.6:** all UX goals are met. Cleanup and parent-plan
update remain.

---

### Phase 3U.6 — Cleanup + parent-plan update (½ day)

**Status:** ☐ pending

**Goal:** delete the `text-delta` compatibility alias, document the
new architecture, flip status in the parent implementation plan,
prepare a clean baseline for Phase 4.

**Files to delete:**

- Any `*.smoke.ts` files from 3U.1 if not already deleted.

**Files to modify:**

- `src/events.ts`:
  - Remove the `text-delta` kind from the `ReplEvent` union (it has
    no consumers after 3U.4).
  - Remove the dual-emit in the `message.part.delta` branch — emit
    only `block-delta` now.
- `src/app.tsx`: any leftover `if (ev.kind === "text-delta")` branch
  goes away.
- `README.md`:
  - Add an "Output architecture" section: typed Block model,
    Renderer interface, two backends (stdout / tmux-pane).
  - Document the `/show` slash commands and the `--multi-pane` flag.
  - Document the tmux pane geometry chosen in 3U.5.
  - Document the FIFO cleanup command for crash recovery.
  - **Add a "Pane framing and the Ink/tmux boundary" subsection**
    that summarises the Division of responsibilities section from
    this doc. Key points the README must convey: Ink owns the
    chrome pane only; tmux owns all multi-pane layout and pane
    framing; the user's `~/.tmux.conf` configures pane appearance
    (with the recommended snippet from 3U.5 reproduced verbatim);
    octmux issues no `set-option` commands. State explicitly that
    `--multi-pane` works without the tmux.conf snippet (panes are
    just unbordered) so the reader understands the snippet is a
    polish step, not a prerequisite.
  - **Add an "Integration with opentmux" subsection** that
    documents the contract 3U.5 establishes — the role → FIFO →
    pane-title mapping — and identifies it as the seam opentmux
    is expected to consume. Spell out the two integration modes
    (opentmux owns spawning, or opentmux owns consumption) so a
    future opentmux contributor reading the README knows where
    the seam is and which side they're building. List the exact
    FIFO path template (`${tmpdir}/octmux-${pid}-${role}.fifo`)
    and the set of role names octmux emits, since those are the
    public surface of the contract. **State explicitly that
    opentmux integration is not part of Phase 3-UX and is not
    the immediately-following work** — point the reader at the
    "Sequencing toward opentmux integration" section of this
    doc for the gating criteria, the full contract surface, the
    contract assumptions, and the concrete sequencing
    recommendation (Phase 3-UX → Phase 4 → soak → Phase 5 →
    opentmux). The README's job is to surface the contract to
    casual readers; this doc's job is to govern when and how it
    gets consumed.
- `docs/Implementation-plan.md`:
  - Add locked decision #4 from this doc's "Locked decisions"
    section.
  - Insert a "Phase 3 UX" entry in the Phase plan between
    Phase 3 Extended and Phase 4, with status `✓ shipped — see log
    <date>` and a link reference to this doc.
  - Prepend a single consolidated log entry summarising 3U.1–3U.6.
  - Refresh `updated_by` and `updated_at` in frontmatter.
- `docs/Phase3-UX.md` (this doc): leave in place as historical
  contract.

**Verification:**

1. `bun run dev` and `bun run dev -- --multi-pane` both produce the
   correct UX walk-through end-to-end.
2. `bun run compile` produces a working `dist/octmux`. Both modes
   work from the compiled binary.
3. `grep -r "text-delta" src/` returns nothing.
4. `wc -l src/*.ts src/**/*.ts src/**/*.tsx` — total project size
   should be modestly larger than Phase 3 Extended (the renderer/
   directory adds ~400 lines; visibility and slash-command parsing
   add ~100; the simpler `app.tsx` saves ~80).
5. `git log --oneline` shows one commit per sub-phase (3U.1–3U.6).

**Handoff to Phase 4:** The Renderer interface is the seam for any
future output-related work. StatusLine has its first piece of real
content (the hidden-roles summary); Phase 4 fills in the rest
(model, tokens, cost, orchestra badge) via the same
`useSyncExternalStore` pattern.

---

## Sequencing toward opentmux integration

This section is the authoritative answer to "when does opentmux
integration happen?" — added in response to a clarification
question during the planning session. Read it before assuming any
specific timing.

### When opentmux integration is NOT

**Not during Phase 3-UX.** Every sub-phase in 3-UX has explicit
"Out of scope" clauses; opentmux integration is out of scope for
all of them. The phase's job is to land the contract (role names,
FIFO paths, pane titles, the `Renderer` interface), not its first
downstream consumer. If opentmux integration code lived inside
3U.5, three things would go wrong: (1) verification becomes
coupled — 3-UX cannot be signed off without also signing off
opentmux; (2) the contract gets shaped by opentmux's current
quirks instead of by what is structurally clean; (3) the
boundary-cleanliness check in 3U.5 (`grep -E
"pane-(border|active)|set-option" src/renderer/` returning zero
lines) loses its meaning because there is now legitimate styling
code somewhere in octmux. 3-UX ships a default `tail -F` consumer
per side pane and stops there.

**Not immediately after Phase 3-UX either.** Phase 4 (StatusLine
content + the state.ts store, per the parent plan) is the
natural follow-on. Phase 4 builds directly on the renderer
abstraction and visibility system that 3-UX establishes, is
independent of opentmux, and gives the contract a settling period
in real use before a second consumer is built on top of it.
Contracts are easier to amend before they have two consumers
than after.

### Gating criteria (all three must hold)

Opentmux integration becomes the right next move only when all of
the following are true. Until then, the work is solving a problem
that does not yet exist.

1. **The contract has been used in anger.** Phase 3-UX's
   `--multi-pane` mode has run through real sessions for long
   enough to surface edge cases — at least two to three weeks of
   daily use. Either the role set, FIFO shape, and pane-title
   convention have been confirmed correct, or small refinements
   have been made and re-soaked. The contract is not amended
   while opentmux is being integrated; amendments and integration
   are separate work.

2. **Subagent panes exist or are imminent.** The subagent role
   (`subagent:<id>` in the contract table) is where opentmux's
   layout-preset work actually pays off. Three side panes
   (thinking, tool-call, tool-result) can be arranged by hand in
   tmux without much pain; twelve panes from a fanned-out
   subagent run is where presets like `subagent-grid` earn their
   keep. If subagents are not on the immediate horizon, opentmux
   integration solves a problem you do not yet have.

3. **opentmux itself is mature enough to integrate with.** Same
   risk evaluation Phase 3 Extended applied to claude-code-kit
   and explicitly rejected as a dependency: maintainer count,
   release cadence, API stability, total stars/forks. If
   opentmux remains single-maintainer and pre-1.0, the right move
   is to vendor its key ideas (layout presets, border
   conventions) into octmux's README as user-facing tmux config —
   not to take a code dependency. Revisit each time the project
   ships a meaningful release.

### Contract surface (what opentmux consumes)

Phase 3-UX makes the following primitives available for opentmux
(or any other downstream consumer) to build on. These are the
public surface; nothing else in octmux is intended for external
consumption.

| Primitive                | Provided by              | Stability         |
|--------------------------|--------------------------|-------------------|
| Role enum                | `src/blocks.ts` `Role`   | versioned; closed for v1 — see below |
| FIFO path template       | `src/renderer/fifo.ts`   | stable: `${tmpdir}/octmux-${pid}-${role}.fifo` |
| Pane title per role      | `select-pane -T <role>`  | stable: role string verbatim |
| `Renderer` interface     | `src/renderer/types.ts`  | stable across Phase 4; extensible after |
| `Visibility` system      | `src/renderer/visibility.ts` | stable; opentmux may read but should not write |
| Per-role ANSI formatter  | `formatLine` in `blocks.ts` | stable; pure function |
| tmux command set         | `split-window`, `select-pane`, `kill-pane`, `list-panes` | stable |

The role enum is "closed for v1" — meaning octmux v1 will only
emit the roles listed in `src/blocks.ts`. Future versions may
add roles (notably `subagent:<id>` once subagent support lands).
opentmux should match roles by string prefix where appropriate
(`subagent:` for the subagent family) and degrade gracefully on
unknown roles (default styling, no special pane treatment).

The FIFO path template is the most public part of the contract.
Once shipped, the template `${tmpdir}/octmux-${pid}-${role}.fifo`
must not change without a major version bump, because external
consumers will hard-code or pattern-match against it.

### Contract assumptions (what consumers can rely on)

These are the invariants opentmux can assume hold for any
octmux process speaking the v1 contract. They are guarantees, not
implementation details:

1. **tmux is the layout engine.** octmux does not draw multi-pane
   layouts in any other way. There is no "embedded multi-pane
   mode" inside Ink, no alternate compositor.
2. **octmux runs in exactly one origin pane.** That pane is
   identified by `$TMUX_PANE` at startup and holds the chrome
   (input, status line, modals) plus the main text-response
   scrollback.
3. **Side panes are append-only text consumers.** FIFOs are
   write-only from octmux's perspective; there is no return
   channel. If opentmux wants to send commands back to octmux,
   that is a future contract extension, not part of v1.
4. **FIFOs carry ANSI-formatted UTF-8 text.** No binary content,
   no out-of-band framing. The same byte stream is what would
   reach the terminal in single-pane mode for that role.
5. **octmux issues no tmux styling commands.** `set-option`,
   `set-window-option`, `set-environment` — none are called by
   octmux. The pane appearance is whatever tmux configuration is
   active at the time octmux starts, unmodified.
6. **Pane lifecycle is owned by octmux.** octmux creates side
   panes during `TmuxPaneRenderer.setup()` and kills them on
   `dispose()`. opentmux may reparent or rearrange those panes
   freely, but should not assume octmux will recreate a pane
   that has been killed externally — the EPIPE handling in 3U.5
   silently drops content for killed panes.
7. **Process and pid identity is stable.** The `$pid` in the FIFO
   path is the octmux process pid; opentmux can rely on
   `/proc/$pid` existing for the lifetime of the FIFOs on Linux.

### Two integration modes (re-stated as a sequencing concern)

Once gating criteria are met, opentmux can integrate at either
end of the contract:

**Mode A — opentmux owns pane spawning.** octmux's
`TmuxPaneRenderer` is configured (via an env var or CLI flag) to
skip `split-window` and `select-pane -T` calls and instead just
create FIFOs and announce them on stdout in a machine-readable
form (e.g. one line per role: `OCTMUX_FIFO thinking
/tmp/octmux-1234-thinking.fifo`). opentmux reads that
announcement, creates panes with its own geometry and styling,
and spawns its own consumer processes pointed at the FIFOs.
Cleanest separation; requires the smallest change in octmux.

**Mode B — opentmux owns pane consumption.** octmux behaves
exactly as Phase 3-UX ships — creates panes via `split-window`,
spawns `tail -F` per pane, labels panes via `select-pane -T`.
opentmux runs externally, watches tmux's pane list, identifies
octmux-spawned panes by their title prefix or by a sentinel
window option, and re-skins them from outside (changes border
style per pane, applies a coherent theme, binds navigation
keys). Zero change in octmux; opentmux does everything from
outside. Slightly more work for opentmux, but the integration
seam is purely observational.

Recommendation: start with Mode B for the prototype. It proves
the contract is sufficient without requiring any octmux changes,
which is the strongest validation possible. Move to Mode A only
if Mode B hits a wall that a small contract extension would
solve cleanly.

### Concrete sequencing recommendation

```
Phase 3-UX (this doc)         → ship the contract + default tail consumer
   ↓
Phase 4 (parent plan)         → StatusLine content + state.ts store
   ↓
[soak period: 2–3 weeks of daily use]
   ↓
Phase 5 (subagent panes)      → adds subagent:<id> roles; same contract
   ↓
[re-evaluate gating criteria for opentmux]
   ↓
opentmux integration          → Mode B prototype first, then Mode A if needed
```

Phase 5 and opentmux integration are not strictly ordered against
each other — subagent panes use the same contract 3-UX
establishes, so they could happen with or without opentmux.
Putting subagents first means opentmux has more panes to make
coherent when it does land, which is when the polish payoff is
largest.

---

## Risks / unknowns to resolve during 3U.1

1. **Exact opencode part-type names for thinking and tools.** The
   v2 SDK does not expose a stable enum. 3U.1's first task is the
   diagnostic-logging exercise described in the "Critical
   implementation note" — confirm `reasoning` vs `thinking` vs
   another spelling, confirm the `field` value carrying tool args
   vs tool output. If the names differ from this doc's assumptions,
   correct the mapping table in `src/events.ts` and proceed; the
   rest of the plan is unaffected.
2. **ANSI colour rendering inside tmux.** SGR sequences are passed
   through faithfully by tmux on every terminal-features setting
   octmux already requires. Verify on your shell during 3U.2's
   verification step 1. If colours don't render, the cause is
   almost certainly an outer terminal that doesn't claim
   `xterm-256color` or equivalent.
3. **mkfifo availability on macOS.** mkfifo ships with macOS by
   default. Verify if Phase 4 ever targets macOS distribution; for
   now Linux is the only target.
4. **Tail process buffering on side panes.** `tail -F` on a FIFO
   may buffer output in 4 KB blocks before flushing. If thinking
   text appears in bursts rather than streaming smoothly, the fix
   is `stdbuf -oL tail -F …` (line-buffered) on Linux or replacing
   `tail -F` with a tiny `cat` loop. 3U.5 verification step 2 is
   where you'd notice.
5. **`<Static>` key collisions on session reset.** If a future
   feature (Phase 5+) clears scrollback mid-session, the monotonic
   `nextId` keeps incrementing — no collision. If it ever resets,
   Static won't recommit old items. Document the invariant in
   `src/renderer/stdout.ts`.
6. **Static re-rendering on resize.** Already documented in the
   Phase 3 Extended risks section — Ink does not re-flow Static
   items on SIGWINCH; the terminal does. Same behaviour applies to
   3U.2's per-line commits.

## Reused patterns (do not re-derive)

- LineEditor + PromptInput + Rule + StatusLine + PermissionModal +
  QuestionModal — Phase 3 Extended is the source of truth. None of
  these are touched in Phase 3-UX except StatusLine (which gains
  the hidden-roles badge in 3U.3 via a small props extension).
- SSE event filtering: `src/events.ts` is the only place opencode
  event shapes live. All renderer code consumes `ReplEvent`
  records, not raw SDK events.
- Server lifecycle + tmux guard: `src/server-lifecycle.ts` and the
  `--no-tmux-guard` flag in `src/index.tsx` are unchanged. The new
  `--multi-pane` flag does not replace `--no-tmux-guard`; it has a
  stricter requirement (`$TMUX_PANE` must be set).
- SGR mouse + alternate scroll mode: `\x1b[?1007h` enable in
  `src/index.tsx` is unchanged. tmux pane spawning does not
  interfere with mouse handling in the main pane.

## Phase implementation checklist (per sub-phase)

Mirror the parent plan's checklist:

When starting a sub-phase:

1. Read this doc top-to-bottom, focusing on the current sub-phase's
   spec AND the prior sub-phase's "Handoff" note (it carries forward
   state not visible in the spec below).
2. Implement only the deliverables and files listed for the current
   sub-phase. Do not pull work forward (especially: do not extract
   the Renderer interface during 3U.2; do not add multi-pane during
   3U.4).
3. Run the manual verification steps. All must pass before commit.

When finishing a sub-phase:

1. Commit with `feat(octmux): Phase 3U.<n> — <short title>`.
2. If shipping multiple sub-phases in one session: complete one
   before starting the next; do NOT interleave.
3. Prepend a log entry at the top of this doc's "Implementation log"
   section using the same format as Phase 3 Extended's entries.
4. Only after 3U.6: prepend a single consolidated log entry to the
   parent plan's Implementation log and flip the parent's locked
   decision #4 to "shipped".
