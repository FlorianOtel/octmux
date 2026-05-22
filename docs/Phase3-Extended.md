---
title: "octmux — Phase 3 Extended: Ink-based rendering layer"
created_at: 2026-05-19--14-00
created_by: Claude (Opus 4.7, chat planning session)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-05-22--22-01
parent_plan: docs/Implementation-plan.md
context: >
  Phase 3 shipped a custom raw-mode input layer (LineEditor) plus an ANSI
  save/restore Renderer. The Renderer cannot achieve "input area anchored at
  the bottom of the screen with two horizontal rules and a status line below"
  because \x1b[s / \x1b[u anchor to the cursor position at showPrompt() time,
  not to the terminal's bottom edge. This is a structural limit of the chosen
  approach, not a polish gap. Phase 3 Extended replaces render.ts with an Ink
  (React for CLI) component tree and reduces LineEditor to a pure state
  container that Ink drives via useInput. Ink's flexbox layout naturally
  anchors a bottom area while a <Static> region above absorbs scrollback —
  the same architecture Claude Code itself uses (TypeScript + React + Ink +
  Yoga, publicly confirmed). All Phase 3 behavior (Emacs bindings, multi-line
  via Alt-Enter, history, bracketed paste, double-Esc clear) is preserved.
  This doc is structured to be implemented piece-wise across separate CC
  sessions; each sub-phase is independently shippable and verifies in
  isolation.
---

## Implementation log (reverse chronological — newest at top)

### 2026-05-20--19-00 — UX papercuts: cursor rendering, navigation, streaming flicker

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `376d2536`, `6f22cb05`

**What shipped:**

- **Cursor on wrapped lines fixed** (`src/components/PromptInput.tsx`): The cursor
  row was rendered as `<Box flexDirection="row">` containing three sibling `<Text>`
  children (before, cursor char, after). When `prefix + before` hit the terminal
  width, Yoga could not wrap the cursor character to the next terminal row inside
  the flex row → cursor disappeared. Fixed by replacing the `<Box>` wrapper with a
  single parent `<Text>` containing a nested `<Text inverse>` for the cursor char.
  Ink 5 supports nested `<Text>` with per-section styling and treats the content as
  one text flow — Yoga wraps the full line correctly regardless of length.

- **Navigation garbling on line 2+ fixed** (`src/components/PromptInput.tsx`): The
  same `<Box>` vs `<Text>` element-type flip was the root cause. Non-cursor rows were
  `<Text key={i}>` but the cursor row was `<Box key={i}>`. When the cursor moved to
  another row, React saw the same key with a different type → unmount + remount → Ink
  partial-update diffing produced corrupted terminal output. With the nested-`<Text>`
  fix both cases are always `<Text>` at the same key; React diffs in-place, no
  garbling.

- **Streaming flicker reduced** (`src/app.tsx`): `setStreamBuf` was called on every
  incoming SSE text-delta event, causing a full Ink screen repaint per chunk (~20-50
  repaints/sec → visible flicker). Added a 50 ms debounce timer (`flushTimerRef`):
  the ref accumulates text as before; the state update is batched at most once per
  50 ms (~20 repaints/sec → smooth). The timer is flushed immediately on
  `session-idle` and `error` events (so the final text always commits), and cancelled
  in the `useEffect` cleanup.

**Future work noted:** A typed `StreamItem` union (`text | thinking | tool-use |
tool-result`) with a `<StreamingView>` component will replace the raw `streamBuf`
string for the per-kind styling and ON/OFF toggles needed when thinking blocks and
tool calls are enabled. The 50 ms debounce is compatible — same pattern with an array
push instead of string concat.

---

### 2026-05-20--17-40 — Phase 3E.6: Cleanup + doc updates

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `7059f5c4` (shared with 3E.4+3E.5 session)

**What shipped:**
- `src/index.ts.phase2.bak` deleted (leftover safety copy from 3E.1).
- `README.md` rewritten: Architecture section explains the Ink Static/dynamic layout model and why bottom-anchor is automatic; Key bindings table documents all Emacs and navigation bindings; tmux configuration subsection covers `mouse on`, `extended-keys on`, `terminal-features extkeys`, and clarifies that text selection still works (alternate scroll mode does not intercept clicks).
- `docs/Implementation-plan.md` updated: locked decision #3 rewritten to Ink language; Phase 3 Extended inserted as a new Phase plan entry between Phase 3 and Phase 4; Phase 3 status changed to "superseded"; consolidated log entry prepended; frontmatter refreshed.
- This doc: 3E.6 status → ✓ shipped; log entry prepended; frontmatter refreshed.

**Bug fixes included in this session (not 3E.6-spec but landed here):**
- `stdin.ref is not a function` crash on startup: the `Transform`-stream-as-stdin approach was dropped entirely. Mouse tracking now uses `DECSET 1007` (alternate scroll mode) instead of `?1000h` (button-event mode). Wheel events arrive as arrow keys to Ink's normal input path; no Transform stream or TTY-proxy needed. Text selection restored.
- Two blank lines between turns not rendering: `measureText("")` returns `{width:0, height:0}` so `<Text>{""}</Text>` was a zero-height Yoga node. Fixed to `<Text>{" "}</Text>`.

**What changed in this doc:** 3E.6 status → ✓ shipped; all sub-phases now ✓; Phase 3 Extended is complete.

---

### 2026-05-20--17-47 — Phase 3E.4 + 3E.5: Modals, mouse scroll, Ctrl-C recall, UX anchoring

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `7059f5c4` (shared with 3E.6 session)

**What shipped:**

- **Terminal clear + bottom anchor** (`src/index.tsx`): On startup, clears the screen and positions the cursor so the input area anchors at the bottom. Uses `\x1b[2J\x1b[H` + `rows - 7` newlines to pre-fill space above the dynamic area.
- **4-line status area** (`src/app.tsx`): `marginBottom={3}` on the bottom Box makes StatusLine(1) + 3 blank lines = 4 lines reserved for status. Phase 4 will fill the 3 blank lines with model/tokens/cost/orchestra badge.
- **Turn spacing** (`src/app.tsx`): Each scrollback entry is followed by 2 blank lines, separating operator input from LLM output visually.
- **PermissionModal** (`src/components/PermissionModal.tsx`): Inline y/a/n prompt replaces the auto-approve placeholder in app.tsx. `y`=once, `a`=always, `n`=reject.
- **QuestionModal** (`src/components/QuestionModal.tsx`): Numbered-options prompt for `question.asked` events. Accepts digit keys, advances through multi-question flows, POSTs answers to `/question/{reqID}/reply`.
- **Mouse wheel scroll** (`src/hooks/useMouseScroll.ts`, `src/index.tsx`, `src/app.tsx`): `attachMouseStream` intercepts SGR mouse sequences on stdin, fires wheel callbacks, passes cleaned bytes to Ink. Wheel-up = `editor.histPrev()`, wheel-down = `editor.histNext()`. SGR mode enabled on start, disabled on exit.
- **Ctrl-C semantics** (`src/app.tsx`): Three cases: (1) generating → `session.abort()` + `editor.loadText(lastSubmitted)`; (2) idle non-empty buffer → `editor.clearBuffer()`; (3) idle empty buffer → double-press exit guard (preserved from 3E.3).
- **`baseUrl` prop** (`src/app.tsx`, `src/index.tsx`): Added to AppProps so QuestionModal can POST answers without reimporting lifecycle state.
- **`onWheelRegister` prop** (`src/app.tsx`, `src/index.tsx`): Callback for App to register its wheel handler with the index.tsx dispatcher.

**What changed in this doc:** log entry prepended; 3E.4 and 3E.5 status → ✓ shipped; frontmatter updated_by and updated_at refreshed.

---

### 2026-05-20--16-36 — Feature: history draft preservation in LineEditor

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `ddc065f0` (shared with 3E.3 session)

**What shipped:**
- `src/editor.ts`: Added `_draft: string | null` field to `LineEditor`. When the
  user presses Up (histPrev) for the first time, the current unsaved buffer is saved
  to `_draft`. When they navigate back to "present" (histNext past the newest history
  entry), `_draft` is restored instead of clearing to empty. `_draft` is cleared on
  submit (`enterOnLastRow`) and on double-Esc (`clearBuffer`).

**Why:** Without this, any text typed but not submitted was silently lost whenever
  the user scrolled through history and returned. Expected behaviour: the draft
  survives the round-trip.

**How it works:**
- `histPrev()`: on first call (histIdx === -1), `this._draft = this.getText()` before
  overwriting the buffer.
- `histNext()` return-to-present path: restores `const draft = this._draft ?? ""`
  instead of `this.lines = [""]`.
- `enterOnLastRow()` and `clearBuffer()`: both set `this._draft = null`.

**What changed in this doc:** log entry prepended; frontmatter updated_by and
  updated_at refreshed.

---

### 2026-05-20--16-21 — Phase 3E.3: <App> shell + Static scrollback

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `ddc065f0` (shared with history-draft session)

**What shipped:**
- `src/app.tsx` (new): `<App>` component with `<Static>` scrollback, session label
  prop, onExit prop, StatusLine in layout. All SSE wiring moved from index.tsx.
  Uses module-level `nextId` counter to track scrollback entry IDs. Accepts
  client, sessionID, sessionLabel, eventStream, and onExit as props.
- `src/components/StatusLine.tsx` (new): `[idle]` placeholder stub.
- `src/index.tsx`: slimmed to ~80 lines; App component moved to app.tsx; passes
  client, sessionID (first 8 chars as sessionLabel), eventStream, and onExit as props.
  Preserves all server lifecycle logic (arg parsing, port scan, spawn, health check,
  SIGTERM handler). Removed App definition, HistoryEntry type, SSE loop, useInput
  handlers, handleSubmit callback, and all React imports except render.

**What changed in this doc:** Phase 3E.3 status → ✓ shipped; log entry prepended;
  frontmatter updated_by and updated_at refreshed.

**Suggested next steps for 3E.4:** PermissionModal.tsx and QuestionModal.tsx
  components to replace the auto-approve placeholder in app.tsx; QuestionModal
  for question.asked events. Add streaming buffer state and mode tracking to
  support [generating…] indicators and session-idle text flushing.

---

### 2026-05-20--10-45 — Phase 3E.2 fixes: Keybinding fixes, keybindings.ts, LLM wiring, UX polish

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `d39ed8ed`

**What shipped:**

**Keybinding bug fixes — three Ink 5 quirks discovered and resolved:**

The Phase 3E.2 dispatch table in this doc (and the initial `PromptInput.tsx`
implementation) had three bugs rooted in non-obvious Ink 5 behaviour. All three
were diagnosed by reading `node_modules/ink/build/parse-keypress.js` and
`use-input.js` directly. Full details in `docs/Troubleshooting.md` entry
2026-05-20--10-45.

1. **Backspace → `key.delete`, not `key.backspace`**: Modern terminals send
   `\x7f` for Backspace; Ink maps it to `key.delete`. Fix: check
   `key.backspace || key.delete`. The original check `if (key.backspace)` never
   fired on any modern terminal.

2. **Alt-Enter → `key.return=false, key.meta=false, input='\r'`**: Ink strips
   the `\x1b` prefix from `\x1b\r`, leaving a bare CR with no flags. Fix:
   `else if (input === '\r' || input === '\n')` placed after the `key.return`
   branch. The original check `key.return && key.meta` never fired.

3. **Ctrl-X → `(key.ctrl=true, input="x")`**: Ink converts control bytes to
   their letter name. Fix: `key.ctrl && input === "a"` etc. The original
   `input === "\x01"` checks never matched.

**`src/keybindings.ts` (new file):**
All key dispatch was extracted from `PromptInput.tsx` into a standalone
`src/keybindings.ts` module exporting `handleKey(input, key, editor, lastEscTime)`.
The file has three header sections documenting each Ink 5 quirk with byte-level
detail and source references, plus a full annotated binding table. `PromptInput.tsx`
is now a thin wrapper that calls `handleKey` in its `useInput` handler.

**`src/index.tsx` — full LLM wiring (phases 3E.3 + 3E.4 implemented inline):**
Rather than building `src/app.tsx` + `<Static>` scrollback as a separate phase,
the full opencode integration was wired directly in `src/index.tsx`:
- Top-level arg parsing: `--help`, `--version`, `--attach <port>`,
  `--no-tmux-guard`, tmux guard.
- Server lifecycle: `findFreePort` + `spawnOpencodeServer` (auto-spawn mode) or
  `isOpencodeHealthy` health check (attach mode). `SIGTERM` handler disposes
  the server process.
- Module-level `await`: `client.session.create({})`, `client.global.event({})`.
- SSE loop: `for await` over `eventStream.stream` in a `useEffect`. Dispatches
  `text-delta`, `generating`, `session-idle`, `error`, and `permission-asked`
  (auto-approved as "once" — placeholder for a future PermissionModal).
- Streaming display: `streamBufRef` (a `useRef`) accumulates text-delta chunks
  without per-chunk re-renders; `setStreamBuf` (state) triggers display update.
  On `session-idle`, text is committed to `history` as an `"assistant"` entry.
- `handleSubmit`: calls `client.session.promptAsync` and adds the user text to
  `history` immediately (no laggy wait for first SSE event).
- Double-press Ctrl-C: first press shows a 500 ms "Press Ctrl-C again to exit"
  warning; second press disposes server and exits. `render()` called with
  `exitOnCtrlC: false`.

**`src/components/Rule.tsx` — right-align support:**
Added `align?: "left" | "right"` prop (default "left"). Right-aligned title:
4 trailing dashes, fill on the left, spaces around the title text. The top rule
in the harness uses `align="right"`.

**`src/index.tsx` — UX polish:**
- Typed `HistoryEntry`: `{ role: "user" | "assistant" | "error"; text: string }`.
- User history entries rendered with `<Text inverse>` (flipped fg/bg). Error
  entries rendered red.
- `[generating…]` placeholder shown while `isGenerating && !streamBuf`.
- Bottom `<Box>` uses `marginBottom={4}` to keep the prompt 4 lines above the
  terminal edge.

**Note on 3E.2 dispatch table below:** The table under "Phase 3E.2 spec"
lists Ctrl bindings as `input === "\x01"` etc. — those checks are wrong for
Ink 5 (QUIRK 3 above). The authoritative binding table is in `src/keybindings.ts`.

**What changed in this doc:** log entry prepended; frontmatter updated.

**Next steps:** The harness is feature-complete for basic LLM interaction.
Phase 3E.3 (`src/app.tsx` with `<Static>`) is no longer blocking — it can
be added later as a refactor if scrollback overflow becomes an issue. Phase
3E.5 (mouse wheel scroll + Ctrl-C-during-generation recall) and 3E.6
(cleanup + parent-plan updates) remain on the roadmap.

---

### 2026-05-20--00-34 — Phase 3E.2: LineEditor state machine + PromptInput component

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `a7560509`, `b23965e4`

**What shipped:**
- `src/editor.ts` (new): pure LineEditor EventEmitter state machine ported from
  `1f81dae:src/input.ts` on DECSTBM-dead-end branch. I/O stripped: no start()/stop(),
  no escape-sequence parser, no modal helpers. All buffer ops made public. New methods:
  moveUpRow(), moveDownRow(), loadText(), getText(), isAtTopRow(), isAtBottomRow(),
  enterOnLastRow(). Events kept: "changed", "submit".
- `src/components/PromptInput.tsx` (new): Ink component rendering multi-line buffer
  with cursor. useInput dispatcher covers full Emacs binding table from 3E.2 spec.
  Double-Esc (within 500ms) clears buffer. Paste arrives as single input string via
  Ink 5.x (no manual bracketed-paste parsing needed).
- `src/components/Rule.tsx` (new): horizontal rule with optional embedded title.
- `src/index.tsx`: updated to 3E.2 harness (history list + Rule + PromptInput + Rule).
  Both bun run dev and bun run compile verified.

**What changed in this doc:** Phase 3E.2 status → ✓ shipped; log entry prepended.

**Suggested next steps for 3E.3:** Build src/app.tsx (<App> with <Static> scrollback
  above, Rule + PromptInput + Rule + StatusLine stub below). src/index.tsx becomes real
  entry with Phase 2 arg parsing; session label is "local-harness" until 3E.4.

---

### 2026-05-20--00-10 — Phase 3E.1: Bootstrap Ink + React under Bun

**Implemented by:** Claude Code (Actor, Claude Haiku 4.5)
**Commit(s):** `6c52cdd3`, `02f09ce3`, `9d43e9c1`

**What shipped:**
- `package.json`: added `ink@^5.0.0`, `react@^18.3.1` as deps; `@types/react@^18.3.0` as devDep; also added `react-devtools-core@^7.0.1` as optional dep (required for Ink 5.x compile support).
- `tsconfig.json`: added `"jsx": "react-jsx"`, `"jsxImportSource": "react"` to compilerOptions.
- `src/index.ts.phase2.bak`: copy of the Phase 2 readline REPL (safety net for in-progress session).
- `src/index.tsx`: replaced Phase 2 REPL with 20-line Ink hello-world demo — bordered single-line box "octmux — Ink hello", auto-exits after 2 s. Both `bun run dev` and `dist/octmux` binary verified working (exit code 0).
- Build scripts updated: `dev`, `build`, `compile` now reference `src/index.tsx` instead of `src/index.ts`.

**What changed in this doc:** Phase 3E.1 status flipped to ✓ shipped; Implementation log section added; frontmatter updated with editor/timestamp.

**Suggested next steps for 3E.2:** `src/input.ts` does not exist (Phase 3 was never committed). 3E.2 must create `src/editor.ts` from scratch as a pure LineEditor state machine. All LineEditor buffer ops (insert, backspace, Emacs bindings, history, kill ring) must be written new. Then build `src/components/PromptInput.tsx` on top. The Phase-3-Extended.md spec for 3E.2 is accurate; just substitute "create from scratch" for "rename from src/input.ts".

---

# octmux — Phase 3 Extended: Ink migration

## Why this phase exists

Phase 3 shipped with this Renderer architecture (src/render.ts:25-50):

```
showPrompt():     write \x1b[s   (save cursor at current row)
_repaint():       write \x1b[u + \x1b[J + redraw input
clearInputArea(): write \x1b[u + \x1b[J        (during streaming)
```

The cursor's saved position depends on where the terminal cursor was when
showPrompt() last ran — which is wherever the last assistant output ended.
For a true bottom-anchored input area, the saved position would need to be
`(rows - input_height - status_height, 1)`, and any output that arrives
above must scroll the input region downward without disturbing it. The
save/restore approach cannot do this; you'd need either DECSTBM scrolling
regions (\x1b[1;Nr) or the alternate screen buffer plus manual scrollback
management.

Either of those is a feasible 100–150 line addition. But two factors push
the right answer to a library:

1. **Phase 4+ region composition.** Status line, /model picker, /agents
   picker, permission modal, question modal, orchestra badge — each adds a
   new dynamic region competing for screen real estate, each needs to
   re-anchor cleanly on SIGWINCH. Manual region management compounds the
   fragility already visible in respondPermission / respondQuestion in
   index.ts:181-231.
2. **On-distribution stack for the model.** Claude Code itself is built on
   TypeScript + React + Ink + Yoga. Future LLM-assisted work on octmux is
   meaningfully cheaper on the same substrate.

Off-the-shelf survey result (see chat transcript referenced in commit
message): upstream Ink is the only production-grade option. Alternatives
considered and rejected:

- **claude-code-kit / @claude-code-kit/ui** — surface-closest match
  (`<REPL>` + `<PromptInput>`), but six weeks old, ten stars, one
  maintainer, ships its own React reconciler instead of upstream Ink.
  Future-proof risk too high. Borrow design ideas; do not depend on it.
- **ink-multiline-input** — bare cursor navigation only, no Emacs ops, no
  history. The existing LineEditor is already richer.
- **neo-blessed / blessed** — alt-screen TUI library, overweight for a
  single-pane REPL.

## Locked decisions (updates to parent plan)

The parent plan's locked decision #3 reads:

> **3. Input layer:** custom raw-mode stdin handler. Emacs bindings,
> multi-line, bracketed paste, Esc-interrupt, double-Esc clear. No readline,
> no Ink.

Replace with:

> **3. Input layer:** Ink (React for CLI) for region composition and
> resize/repaint. LineEditor state machine preserved from Phase 3 as a pure
> buffer/history container; Ink's useInput hook replaces the raw-stdin
> escape-sequence parser. Bottom-anchor via Ink's natural render order
> (Static-above-dynamic). No readline.

All other locked decisions stand unchanged.

## Architecture at a glance (post-Phase-3E)

```
src/
  index.ts             entry: args, lifecycle, render(<App/>)
  server-lifecycle.ts  (unchanged)
  events.ts            (unchanged — already returns ReplEvent records)
  editor.ts            (was input.ts) — pure LineEditor state machine
  app.tsx              <App>: top-level component, owns scrollback + mode
  components/
    PromptInput.tsx    multi-line buffer view + useInput dispatcher
    Rule.tsx           horizontal rule with optional title (top / bottom)
    StatusLine.tsx     placeholder, fleshed out in Phase 4
    PermissionModal.tsx  inline y/a/n prompt (lifted from index.ts)
    QuestionModal.tsx    numbered-options prompt (lifted from index.ts)
  hooks/
    useMouseScroll.ts  SGR mouse mode + wheel → up/down dispatch
```

One source file per concern. .tsx for React components, .ts for plain logic.

## Sub-phase execution order

Each sub-phase is independently shippable and verifies standalone. A fresh
CC session reading this doc plus the repo at the prior phase's commit
should be able to complete the next phase without external context.

- **3E.1** — Build setup: Ink + React under Bun; verify dev + compile paths.
- **3E.2** — LineEditor refactor + `<PromptInput>` component.
- **3E.3** — `<App>` shell with anchored layout (no opencode wiring yet).
- **3E.4** — SSE integration: full Phase 1.5/3 parity under Ink.
- **3E.5** — Mouse wheel scroll + Ctrl-C-during-generation recall.
- **3E.6** — Cleanup: delete render.ts, README, parent-plan updates.

---

### Phase 3E.1 — Bootstrap Ink + React under Bun (½ day)

**Status:** ✓ shipped — see log 2026-05-20--00-10

**Goal:** prove Ink works under Bun for both `bun run dev` and
`bun build --compile`, before touching any existing code.

**Deliverable:** a 30-line hello-world Ink app at `src/index.ts` that
renders `octmux — Ink hello` inside a single-line bordered Box for 2
seconds, then exits 0. Both `bun run dev` and the compiled binary behave
identically.

**Files to create / modify:**

- `package.json`:
  - Add dependencies: `"ink": "^5.0.0"`, `"react": "^18.3.1"`.
  - Add devDependency: `"@types/react": "^18.3.0"`.
  - Keep `@opencode-ai/sdk` and `@types/bun` untouched.
- `tsconfig.json`:
  - Add `"jsx": "react-jsx"`, `"jsxImportSource": "react"`.
  - Confirm `"target": "ES2022"`, `"module": "ESNext"`,
    `"moduleResolution": "bundler"`, `"strict": true`.
- `src/index.ts`:
  - Stash current contents under `src/index.ts.phase3.bak` (git history
    keeps it; the .bak is just a safety belt for the in-progress session).
  - Replace with a minimal Ink demo:
    ```tsx
    import { render, Box, Text } from "ink";
    import { useEffect } from "react";

    function App({ onExit }: { onExit: () => void }) {
      useEffect(() => {
        const t = setTimeout(onExit, 2000);
        return () => clearTimeout(t);
      }, [onExit]);
      return (
        <Box borderStyle="single" paddingX={1}>
          <Text>octmux — Ink hello</Text>
        </Box>
      );
    }

    const { unmount, waitUntilExit } = render(<App onExit={() => unmount()} />);
    await waitUntilExit();
    ```

**Key Bun + Ink notes:**

- Bun's TypeScript loader supports JSX natively when `tsconfig.json` has
  `"jsx": "react-jsx"`. No Babel.
- Ink 5.x ships Yoga as WASM bundled into the package; `bun build --compile`
  inlines it. Expect binary size to grow by ~5–8 MB.
- `bun build --compile` requires `--target bun-linux-x64` (already set in
  the existing `compile` script).

**Manual verification:**

1. `bun install` — confirm `ink`, `react`, `@types/react` resolve; no peer
   warnings.
2. `bun run dev` — single-line bordered "octmux — Ink hello" appears,
   disappears cleanly after 2 s, process exits 0, terminal modes restored.
3. `bun run compile` produces `dist/octmux`. Run it — same behavior.
4. Run twice in succession: no residual ANSI artifacts, no broken cursor.

**Out of scope:** any LineEditor or opencode wiring. Pure infra check.

**Handoff to 3E.2:** Ink works under Bun including compile. The existing
`src/input.ts` and `src/render.ts` are untouched on disk. The opencode SDK
client, server lifecycle, SSE dispatcher, and event filtering are all still
intact — they're just not currently being called from `src/index.ts`.

---

### Phase 3E.2 — LineEditor as state container + `<PromptInput>` (1 day)

**Status:** ✓ shipped — see logs: 2026-05-20--00-34 , 2026-05-20--10-45

**Goal:** strip all I/O from LineEditor; build a `<PromptInput>` Ink
component that renders the buffer and dispatches Ink key events to
LineEditor methods. The two are tightly coupled — same phase.

**Deliverable:** a small Ink harness app where you can type into a
bordered multi-line input area, use all the Phase 3 Emacs bindings,
Alt-Enter for newlines, history with Up/Down at row boundaries, and
Enter to submit (submitted text echoes to stdout above the input).

**Files to create / modify:**

- Rename `src/input.ts` → `src/editor.ts`. Modify the `LineEditor` class:
  - **Delete:** `start()`, `stop()`, the stdin listener, the entire escape
    state machine (`_startEscape`, `_processEscape`, `escState`, `csiBuf`,
    `escTimer`), the `keyResolve`/`lineResolve` modal helpers, the
    `readKey`/`readLine` methods, and the `pasteMode` field.
  - **Keep:** `lines`, `row`, `col`, `killRing`, `history`, `histIdx`.
  - **Keep all buffer ops** as public methods (rename them from `_xxx` to
    public `xxx`):
    - `insert(s: string)`, `backspace()`, `deleteForward()`,
      `insertNewline()`, `enterOnLastRow()` (replaces `_enter`'s submit
      logic — emits "submit" and clears).
    - `moveLineStart()`, `moveLineEnd()`, `moveBackward()`,
      `moveForward()`, `moveUpRow()`, `moveDownRow()` (the row-only
      variants — new).
    - `wordBackward()`, `wordForward()`, `killToEnd()`, `killToStart()`,
      `killWordBackward()`, `killWordForward()`, `yank()`.
    - `histPrev()`, `histNext()`, `clearBuffer()`.
  - **Add new methods:**
    - `loadText(text: string)`: replaces buffer contents, cursor at end.
      Used by 3E.5 for Ctrl-C recall.
    - `getText()`: returns `this.lines.join("\n")`.
    - `isAtTopRow()`: `this.row === 0`.
    - `isAtBottomRow()`: `this.row === this.lines.length - 1`.
  - **Events to keep:** `"changed"` (used by React to force re-render),
    `"submit"` (carrying the joined text). Remove `"interrupt"`, `"eof"`,
    `"clear-screen"` — those are now handled by Ink's useInput in the
    component layer.

- `src/components/PromptInput.tsx` (new):
  - Props:
    ```ts
    type Props = {
      editor: LineEditor;
      disabled?: boolean;
      onSubmit: (text: string) => void;
    };
    ```
  - Use `useReducer` to force re-render on `editor.on("changed", ...)`.
  - Use `useInput(handler, { isActive: !disabled })` to receive keys.
  - Render:
    - First line gets `> ` prefix (cyan or default — match Claude Code
      style).
    - Subsequent lines render with no prefix (just indented to align with
      first-line content).
    - Cursor is rendered as inverse-styled character at `(row, col)` —
      split the line into `before + cursorChar + after`, wrap `cursorChar`
      in `<Text inverse>`. If `col === line.length`, use a space as the
      cursor char.
  - Wire `editor.on("submit", onSubmit)` in `useEffect`.

- `src/components/Rule.tsx` (new):
  - Props: `{ title?: string; width: number }`.
  - Renders a single line of `─` characters with the title embedded:
    `── title ──────────────────...`. Width comes from `useStdout().stdout.columns`.

- Temporary harness `src/index.ts`:
  - Replace the 3E.1 hello with:
    ```tsx
    import { render, Box, Text } from "ink";
    import { useState } from "react";
    import { LineEditor } from "./editor.ts";
    import { PromptInput } from "./components/PromptInput.tsx";
    import { Rule } from "./components/Rule.tsx";

    function App() {
      const [editor] = useState(() => new LineEditor());
      const [history, setHistory] = useState<string[]>([]);
      const { stdout } = useStdout();   // import { useStdout } from "ink";
      const w = stdout.columns ?? 80;

      return (
        <>
          {history.map((h, i) => <Text key={i}>{h}</Text>)}
          <Box flexDirection="column">
            <Rule title="harness" width={w} />
            <PromptInput
              editor={editor}
              onSubmit={(text) => {
                setHistory(prev => [...prev, "> " + text]);
              }}
            />
            <Rule width={w} />
          </Box>
        </>
      );
    }

    render(<App />);
    ```

**Ink useInput → LineEditor dispatch table:**

This is the heart of 3E.2. Inside `PromptInput`'s `useInput((input, key) => {...})`:

| Ink key event | LineEditor call |
|---|---|
| `key.return && !key.meta` | if row is last: `editor.enterOnLastRow()` else `editor.moveDownRow()` |
| `key.return && key.meta` (Alt-Enter) | `editor.insertNewline()` |
| `key.backspace` | `editor.backspace()` |
| `key.delete` | `editor.deleteForward()` |
| `key.leftArrow && key.ctrl` | `editor.wordBackward()` |
| `key.rightArrow && key.ctrl` | `editor.wordForward()` |
| `key.leftArrow` | `editor.moveBackward()` |
| `key.rightArrow` | `editor.moveForward()` |
| `key.upArrow` | if `editor.isAtTopRow()`: `editor.histPrev()` else `editor.moveUpRow()` |
| `key.downArrow` | if `editor.isAtBottomRow()`: `editor.histNext()` else `editor.moveDownRow()` |
| `input === "\x01"` (Ctrl-A) | `editor.moveLineStart()` |
| `input === "\x05"` (Ctrl-E) | `editor.moveLineEnd()` |
| `input === "\x0b"` (Ctrl-K) | `editor.killToEnd()` |
| `input === "\x15"` (Ctrl-U) | `editor.killToStart()` |
| `input === "\x17"` (Ctrl-W) | `editor.killWordBackward()` |
| `input === "\x19"` (Ctrl-Y) | `editor.yank()` |
| `input === "\x02"` (Ctrl-B) | `editor.moveBackward()` |
| `input === "\x06"` (Ctrl-F) | `editor.moveForward()` |
| `input === "\x10"` (Ctrl-P) | `editor.histPrev()` |
| `input === "\x0e"` (Ctrl-N) | `editor.histNext()` |
| `key.meta && input === "b"` | `editor.wordBackward()` |
| `key.meta && input === "f"` | `editor.wordForward()` |
| `key.meta && input === "d"` | `editor.killWordForward()` |
| `key.escape` (single, debounced) | (no-op in 3E.2; reserved for Phase 4 abort) |
| `key.escape` twice within 500 ms | `editor.clearBuffer()` |
| `input >= " "` and not a special key | `editor.insert(input)` |

Note: Ink reports Alt-prefixed keys as `key.meta === true`. Pasted blocks
arrive as a single `input` string in Ink 5.x — no manual bracketed-paste
parser needed in the component (Ink handles `\x1b[200~...\x1b[201~`
internally and passes the cleaned payload).

**Manual verification:**

1. Type `hello world` — chars appear; cursor visible at end.
2. Ctrl-A jumps cursor to start; Ctrl-E to end. Alt-B/Alt-F by word.
3. Alt-Enter creates a second line; cursor on it. Up arrow returns to row
   0. Down arrow returns to row 1. Up arrow when on row 0 with empty
   history is a no-op; with history, recalls last submission.
4. Type a 3-line buffer, hit Enter on the last line — submitted text
   appears above (as `> ...`), buffer clears.
5. Recall via Up arrow — full multi-line block reappears, cursor at the
   end of the last line.
6. Paste a 30-line clipboard block — arrives as one logical input, cursor
   at end of paste.
7. Ctrl-W deletes word backward; Ctrl-U kills to line start; Ctrl-K kills
   to line end; Ctrl-Y yanks the last kill.
8. Double-Esc within 500 ms clears the buffer.
9. Resize the terminal — the Rule width updates on the next keystroke (or
   immediately if you've wired SIGWINCH to a re-render; Ink does this by
   default via the `useStdout` hook).

**Out of scope:** opencode SDK, SSE, modals, mouse, Ctrl-C semantics,
status line. The harness exists only to verify the input layer in
isolation.

**Handoff to 3E.3:** `editor.ts` is now a pure state machine. `PromptInput`
and `Rule` work standalone. `src/index.ts` is a throwaway harness — the
next phase replaces it with the real `<App>` shell. The opencode SDK
client, server lifecycle, SSE, and event filtering are still intact on
disk but uncalled.

---

### Phase 3E.3 — `<App>` shell with anchored layout (½ day)

**Status:** ✓ shipped — see log 2026-05-20--16-21

**Goal:** stand up the production `<App>` component with the final layout
geometry — `<Static>` scrollback above, top rule with session label, input
area, bottom rule, status-line placeholder — but driven purely by local
state. No opencode wiring yet. This phase exists to lock the layout before
adding the dynamic complexity of streaming.

**Deliverable:** an Ink app where typing into the input echoes the message
into a persistent scrollback region above. The bottom four lines of the
terminal are always: top rule, input (1+ lines), bottom rule, status-line
placeholder. As scrollback grows past terminal height, older entries
scroll out of view through the terminal's native scrollback.

**Files to create / modify:**

- `src/app.tsx` (new):
  ```tsx
  import { Box, Static, Text, useStdout } from "ink";
  import { useState, useEffect } from "react";
  import { LineEditor } from "./editor.ts";
  import { PromptInput } from "./components/PromptInput.tsx";
  import { Rule } from "./components/Rule.tsx";
  import { StatusLine } from "./components/StatusLine.tsx";

  type ScrollbackEntry = {
    id: number;
    role: "user" | "assistant" | "system";
    text: string;
  };

  export function App({ sessionLabel }: { sessionLabel: string }) {
    const [editor] = useState(() => new LineEditor());
    const [scrollback, setScrollback] = useState<ScrollbackEntry[]>([]);
    const { stdout } = useStdout();
    const cols = stdout.columns ?? 80;

    const handleSubmit = (text: string) => {
      setScrollback(prev => [
        ...prev,
        { id: Date.now(), role: "user", text }
      ]);
    };

    return (
      <>
        <Static items={scrollback}>
          {(item) => (
            <Text key={item.id}>
              {item.role === "user" ? "> " : ""}{item.text}
            </Text>
          )}
        </Static>
        <Box flexDirection="column">
          <Rule title={sessionLabel} width={cols} />
          <PromptInput editor={editor} onSubmit={handleSubmit} />
          <Rule width={cols} />
          <StatusLine />
        </Box>
      </>
    );
  }
  ```

- `src/components/StatusLine.tsx` (new):
  ```tsx
  import { Text } from "ink";

  // Phase 4 will fill this in with model / tokens / cost / orchestra badge.
  export function StatusLine() {
    return <Text dimColor>[idle]</Text>;
  }
  ```

- `src/index.ts`:
  - Strip the 3E.2 harness.
  - Restore the Phase 2 argument parsing (--help, --version, --attach,
    --no-tmux-guard, tmux guard).
  - DO NOT yet restore the opencode client construction or SSE loop —
    those return in 3E.4.
  - Resolve a session label string: `"local-harness"` if no server is
    running, otherwise something derived from args (final answer wires up
    in 3E.4 once we have a sessionID).
  - Final shape:
    ```ts
    const { unmount, waitUntilExit } = render(
      <App sessionLabel="local-harness" />
    );
    await waitUntilExit();
    ```

**Anchoring mechanics (read once, internalize):**

Ink renders the component tree to stdout each frame. `<Static>` items are
written exactly once each (when first added), in the order added, above
everything dynamic. The non-Static portion of the tree is the "dynamic
area" — Ink clears and re-renders it on every state update, starting from
the cursor position immediately below the last Static commit.

Net effect: the dynamic area (top rule + input + bottom rule + status) is
always the bottommost rendered content. Scrollback accumulates above it.
When the dynamic area's total rendered height exceeds terminal rows, the
top of the visible region scrolls upward via the terminal's natural
scrolling. There is no explicit height calculation needed.

This is why we don't set `height={rows}` on the root Box. Setting it would
fight with `<Static>`'s incremental commit model.

**Manual verification:**

1. Launch — terminal shows top rule with `── local-harness ──...`, an
   input area with `> `, a bottom rule, and `[idle]` on the line below.
2. Type a message, press Enter — message appears as `> message` above the
   top rule. Input clears. Bottom region stays put.
3. Submit 20 messages quickly — scrollback grows; oldest messages scroll
   out the top of the terminal naturally; input remains at the bottom.
4. Resize terminal narrower — rules adjust width on next keystroke or
   re-render. Existing scrollback lines wrap (that's the terminal's job;
   Ink doesn't re-flow Static).
5. Resize terminal taller — input stays anchored visually at the bottom;
   blank space appears above the scrollback's last entry.
6. Ctrl-C (with no handler yet) — Ink's default useApp exit fires;
   terminal restored cleanly.

**Out of scope:** opencode SDK, SSE, streaming, modals, mouse, Ctrl-C
recall semantics. Scrollback is local-state-only and dies on exit.

**Handoff to 3E.4:** layout geometry is final and proven. The next phase
wires `<App>` to the opencode client + SSE — submissions go through
session.promptAsync, streaming text-delta events accumulate into a
"currently streaming" buffer rendered between Static and the bottom block,
and on session-idle that buffer flushes into Static as an assistant entry.

---

### Phase 3E.4 — SSE integration: full Phase 1.5/3 parity under Ink (1–1½ days)

**Status:** ✓ shipped — see log 2026-05-20--17-47

**Goal:** wire the opencode client and SSE event stream into `<App>` so
the existing Phase 1.5/3 behavior is fully restored under Ink:
text-delta streaming, [generating…] / [retrying…] indicators,
session-idle turn-completion, permission and question modals, Ctrl-C
double-press exit guard, Ctrl-D EOF.

**Deliverable:** functional parity with the Phase 3 build. From the
user's perspective, octmux behaves the same as before — typing a prompt
streams a response — except the input area is now bordered, anchored at
the bottom, and the existing modal flows render as proper Ink components
instead of inline stdout writes.

**Files to create / modify:**

- `src/app.tsx`:
  - Add state for streaming buffer, mode, and modal queue:
    ```ts
    const [streaming, setStreaming] = useState<string>("");
    const [mode, setMode] = useState<"idle" | "generating" | "retrying">("idle");
    const [permission, setPermission] = useState<{
      permID: string; title: string;
    } | null>(null);
    const [question, setQuestion] = useState<{
      reqID: string;
      questions: Array<{
        question: string;
        options: Array<{ label: string; description: string }>;
        multiple?: boolean;
      }>;
    } | null>(null);
    ```
  - Add props for the opencode client and sessionID:
    ```ts
    type AppProps = {
      client: ReturnType<typeof createOpencodeClient>;
      sessionID: string;
      sessionLabel: string;
      eventStream: AsyncIterable<{ payload: unknown }>;
      onExit: () => void;
    };
    ```
  - In a useEffect, iterate the SSE stream (same logic as the old
    `sseLoop` in index.ts:131-167) and dispatch each event to setState:
    - `text-delta` → `setStreaming(prev => prev + ev.text)`.
    - `generating` → `setMode("generating")`.
    - `session-status` retry → `setMode("retrying")`.
    - `session-idle` → flush: append `{role: "assistant", text: streaming}`
      to scrollback, `setStreaming("")`, `setMode("idle")`.
    - `error` → append `{role: "system", text: "[error] " + ev.message}`
      to scrollback.
    - `permission-asked` → `setPermission({permID, title})`.
    - `question-asked` → `setQuestion({reqID, questions})`.
    - `part-removed` → no-op (filterEvent has already invalidated).
  - On `PromptInput`'s onSubmit, call `client.session.promptAsync(...)`
    (same body shape as index.ts:288-291).
  - Render `streaming` between Static and the bottom block:
    ```tsx
    <Static items={scrollback}>...</Static>
    {streaming && <Text>{streaming}</Text>}
    {permission && <PermissionModal {...permission} onAnswer={...} />}
    {question && <QuestionModal {...question} onAnswer={...} />}
    <Box flexDirection="column">
      <Rule title={sessionLabel} width={cols} />
      <PromptInput
        editor={editor}
        disabled={mode !== "idle" || !!permission || !!question}
        onSubmit={handleSubmit}
      />
      <Rule width={cols} />
      <StatusLine mode={mode} />
    </Box>
    ```

- `src/components/PermissionModal.tsx` (new):
  - Props: `{ permID: string; title: string; onAnswer: (a: "once"|"always"|"reject") => void }`.
  - Renders:
    ```tsx
    <Box flexDirection="column">
      <Text>? Allow: {title}</Text>
      <Text dimColor>  y=once  a=always  n=reject</Text>
    </Box>
    ```
  - Uses `useInput((input) => { ... })` to capture a single key:
    - `y` → `onAnswer("once")`.
    - `a` → `onAnswer("always")`.
    - `n` → `onAnswer("reject")`.
  - In `<App>`, `onAnswer` calls `client.postSessionIdPermissionsPermissionId(...)`
    (same as index.ts:190-193) and then `setPermission(null)`.

- `src/components/QuestionModal.tsx` (new):
  - Props: same shape as the data from the question-asked event, plus
    `onAnswer: (answers: string[][]) => void`.
  - For each question, render the question text + numbered options.
  - Captures input one question at a time via useInput, accumulating
    digits until Enter. Multiple-choice questions accept comma-separated
    numbers (matches the Phase 3 behavior in index.ts:204-220).
  - On completion: `onAnswer(answers)`. `<App>` POSTs to
    `${baseUrl}/question/${reqID}/reply` (same as index.ts:223-227)
    then `setQuestion(null)`.

- `src/index.ts`:
  - Restore all the Phase 2 lifecycle code: arg parsing, server spawn,
    health probe, session.create, client.global.event.
  - Construct `eventStream` via `await client.global.event({})`.
  - Build a Ctrl-C / Ctrl-D handler at the index.ts level using
    `process.on("SIGINT")` and the existing double-Ctrl-C guard logic
    — wired through `app.onExit`. Reason: Ctrl-C semantics during
    streaming require state (mode === "streaming") that's cleaner to read
    from inside `<App>`; defer the Ctrl-C interrupt-during-stream logic
    to 3E.5 where Ctrl-C recall lives. For now: Ctrl-C inside `<App>`
    calls `useApp().exit()` directly (default behavior).
  - Final shape:
    ```ts
    const { unmount, waitUntilExit } = render(
      <App
        client={client}
        sessionID={sessionID}
        sessionLabel={sessionID.slice(0, 8)}
        eventStream={eventStream.stream}
        onExit={async () => {
          await serverHandle?.dispose();
          unmount();
        }}
      />
    );
    await waitUntilExit();
    ```

**Why the disabled prop on PromptInput:**

Phase 3 used `renderer.clearInputArea()` to suppress repaints during
streaming and modal flows. In Ink the input simply shouldn't accept keys
while a modal is up or generation is in flight — `disabled={true}` makes
`useInput`'s `isActive: false` skip the key handler, and the underlying
buffer is preserved unchanged. This means we no longer need
clearInputArea/restoreInputArea/showPrompt — the equivalent is just
disabling the input.

**Manual verification:**

1. Type `tell me a haiku about tmux` → Enter → input clears, prompt
   appears in scrollback as `> tell me a haiku about tmux`, then
   streaming text appears below it as it arrives, then on session-idle
   the streamed text moves into Static as an assistant entry.
2. While streaming, the input area is visibly dim or shows a "thinking"
   state; keys typed into it are ignored.
3. Trigger a tool that requires permission (e.g. a write operation) →
   PermissionModal renders between Static and the bottom block →
   pressing `y` dismisses it and proceeds.
4. Trigger a `question.asked` event (model asks user to disambiguate) →
   QuestionModal renders the numbered options → typing a number + Enter
   answers it.
5. After three turns, scrollback has six entries (3 user, 3 assistant),
   all readable above the input.
6. Ctrl-D on an empty buffer exits cleanly with server disposal; no
   orphan opencode process.

**Out of scope:** mouse scroll, Ctrl-C-during-generation recall (3E.5),
status line content (Phase 4).

**Handoff to 3E.5:** behavioral parity with Phase 3 is achieved under
Ink. `src/render.ts` is now unreferenced but not yet deleted.
`src/input.ts` was renamed in 3E.2. The next phase adds the two UX
features the user explicitly requested that were never in Phase 3:
mouse-wheel scroll mapping to up/down history nav, and
Ctrl-C-during-generation recall of the last submission.

---

### Phase 3E.5 — Mouse-wheel scroll + Ctrl-C recall (½ day)

**Status:** ✓ shipped — see log 2026-05-20--17-47

**Goal:** add the two new UX features that motivated Phase 3 Extended in
the first place — mouse wheel acts like Up/Down arrow keys (history nav),
and Ctrl-C during generation aborts the stream and restores the last
submitted text into the input buffer for editing.

**Deliverable:** wheel-up while idle recalls the previous submission;
wheel-down forward-navigates history toward the empty buffer. Ctrl-C
during streaming aborts the in-flight prompt and re-populates the input
with the most recently submitted text, cursor at end.

**Files to create / modify:**

- `src/hooks/useMouseScroll.ts` (new):
  - On mount: write SGR mouse mode enable to stdout:
    `process.stdout.write("\x1b[?1006h\x1b[?1000h")`.
  - On unmount: write disable: `process.stdout.write("\x1b[?1000l\x1b[?1006l")`.
  - Mouse events arrive on stdin as `\x1b[<BTN;COL;ROW M` (press) or `m`
    (release). Wheel up = `BTN === 64`, wheel down = `BTN === 65`.
  - **Important:** Ink also reads stdin. To avoid double-handling, this
    hook should NOT add a parallel `process.stdin.on("data", ...)`
    listener. Instead, install a transform: intercept stdin via a
    `Transform` stream before Ink reads it, strip mouse sequences,
    forward the cleaned bytes to Ink, and emit wheel events to a
    listener.
  - **Simpler alternative (recommended for first cut):** Ink 5 exposes a
    `stdin` prop on render. Pass a wrapped stream that pre-parses mouse
    bytes. Reference implementation skeleton:
    ```ts
    import { Transform } from "node:stream";
    import { useEffect } from "react";

    type WheelHandler = (dir: "up" | "down") => void;

    const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

    export function attachMouseStream(
      source: NodeJS.ReadStream,
      onWheel: WheelHandler,
    ): Transform {
      const t = new Transform({
        transform(chunk, _enc, cb) {
          const s = chunk.toString("utf8");
          let cleaned = "";
          let lastIdx = 0;
          for (const m of s.matchAll(MOUSE_RE)) {
            cleaned += s.slice(lastIdx, m.index);
            const btn = parseInt(m[1], 10);
            if (m[4] === "M") {
              if (btn === 64) onWheel("up");
              else if (btn === 65) onWheel("down");
            }
            lastIdx = m.index + m[0].length;
          }
          cleaned += s.slice(lastIdx);
          cb(null, cleaned);
        },
      });
      source.pipe(t);
      return t;
    }
    ```
  - Use it from `src/index.ts`:
    ```ts
    const wheelHandlers: Array<(dir: "up" | "down") => void> = [];
    const mouseStream = attachMouseStream(process.stdin, (dir) => {
      for (const h of wheelHandlers) h(dir);
    });
    process.stdout.write("\x1b[?1006h\x1b[?1000h");
    process.on("exit", () => {
      try { process.stdout.write("\x1b[?1000l\x1b[?1006l"); } catch {}
    });

    render(<App onWheel={...} ... />, { stdin: mouseStream });
    ```
  - In `<App>`, on wheel up: `editor.histPrev()`. On wheel down:
    `editor.histNext()`.

- `src/app.tsx`:
  - Add `lastSubmitted` state:
    ```ts
    const [lastSubmitted, setLastSubmitted] = useState<string>("");
    ```
  - In `handleSubmit`: before submitting, `setLastSubmitted(text)`.
  - In the SSE useEffect, on `session-idle` after a normal completion
    (not after an abort): `setLastSubmitted("")`.
  - Add an interrupt handler. Two flavors:
    - **Ctrl-C while idle (mode === "idle"):** existing double-Ctrl-C
      exit guard (preserve Phase 2 logic in index.ts:253-271).
    - **Ctrl-C while streaming (mode === "generating" || "retrying"):**
      ```ts
      await client.session.abort({ path: { id: sessionID } });
      editor.loadText(lastSubmitted);  // restore for editing
      // mode flips back to "idle" via the session-idle event that
      // follows the abort.
      ```
  - Wire via a top-level `useInput` in `<App>` (separate from
    PromptInput's, since PromptInput is disabled during streaming):
    ```ts
    useInput((input, key) => {
      if (key.ctrl && input === "c") handleInterrupt();
    }, { isActive: true });
    ```

**Mouse scroll behavior details:**

- Wheel events fire one per detent. There's no acceleration; one wheel
  notch = one history step. If the user wants to scroll faster, they
  hold the key (or wheel) — `histPrev/histNext` debounce isn't needed.
- Wheel scroll while focus is in a multi-line buffer at a non-boundary
  row: same as up/down arrow — moves within the buffer. The "smart
  arrow" logic in `PromptInput`'s useInput already covers this; the
  wheel handler should call the same dispatcher path, not call
  `histPrev` unconditionally. Refactor: extract the up/down dispatcher
  into a method on `PromptInput`'s ref or expose it via context. Pragmatic
  shortcut for v1: wheel only does history (call `editor.histPrev/Next`
  directly) — most users wheel-scroll only at row boundaries anyway.
  Note this limitation in the README.
- tmux caveat: tmux intercepts mouse events when `mouse on` is set,
  unless the pane is in mouse-passthrough mode. Document the tmux
  config requirement: `set -g mouse on` plus the application must be in
  the foreground. Mouse scroll won't work in tmux copy-mode (that's
  expected and correct).

**Ctrl-C semantics summary (post-3E.5):**

| State | Ctrl-C action |
|---|---|
| idle, empty buffer | first press: print "Press Ctrl-C again to exit"; second press within 3 s: exit |
| idle, non-empty buffer | `editor.clearBuffer()` (do NOT exit; do NOT prompt for exit) |
| generating / retrying | `session.abort()` + `editor.loadText(lastSubmitted)`; mode flips to idle on the next session-idle event |
| modal up (permission / question) | dismiss modal, return to idle (no submission canceled because no submission is in flight) |

The "idle, non-empty buffer" behavior is a small addition over Phase 3 to
match Claude Code's actual semantics. Without it, Ctrl-C with a typed
draft would prompt for exit, which is surprising.

**Manual verification:**

1. Submit three different prompts, wait for each to complete.
2. Wheel up — first wheel-up restores the most recent submission to the
   buffer. Continuing wheel-ups walk backwards through history.
3. Wheel down past the present — buffer clears to empty.
4. Type a long prompt; submit. While the assistant is streaming, press
   Ctrl-C → streaming stops, `[aborted]` is printed in scrollback (or
   marked as system entry), the input now contains your last submission,
   cursor at end. Edit it and re-submit.
5. Test with tmux: `set -g mouse on` in `~/.tmux.conf`, restart tmux,
   run octmux, confirm wheel events reach octmux.
6. Test without tmux mouse mode: confirm graceful degradation (wheel
   does nothing inside octmux; tmux pane scrolls naturally).
7. Type a draft, press Ctrl-C (idle, non-empty) — buffer clears, no exit
   prompt. Press Ctrl-C again immediately — exit prompt appears
   ("Press Ctrl-C again to exit").

**Out of scope:** status line content (Phase 4), slash commands
(Phase 5).

**Handoff to 3E.6:** all behavioral goals for Phase 3 Extended are met.
The final sub-phase is cleanup: delete unused files, update README and
the parent implementation plan.

---

### Phase 3E.6 — Cleanup + parent-plan update (½ day)

**Status:** ✓ shipped — see log 2026-05-20--17-40

**Goal:** remove dead code, document the new architecture, flip
status in the parent implementation plan, prepare a clean baseline for
Phase 4.

**Files to delete:**

- `src/render.ts` — superseded by Ink. No longer imported anywhere.
- `src/index.ts.phase3.bak` if it was created in 3E.1.

**Files to modify:**

- `src/index.ts` — final pass:
  - Strip any remaining ANSI escape writes that don't belong (the only
    legitimate raw stdout writes are the SGR mouse mode enable/disable
    from 3E.5).
  - Confirm the file is ~80 lines: arg parsing, server lifecycle,
    SDK client + session, SSE stream construction, mouse stream wrap,
    render(<App />). Nothing more.

- `README.md`:
  - Add a section "Architecture" with a one-paragraph note on the Ink
    layout model and why bottom-anchor is automatic.
  - Add a "tmux configuration" subsection:
    ```
    For full UX, add to ~/.tmux.conf:
      set -g mouse on
      set -g extended-keys on
      set -ga terminal-features ",*:extkeys"
    ```
  - Mention the key bindings table from the Phase 3E.2 dispatcher.

- `docs/Implementation-plan.md` (parent plan):
  - Update locked decision #3 to the Ink language from this doc's
    "Locked decisions" section.
  - Insert a "Phase 3 Extended" entry in the Phase plan between
    Phase 3 and Phase 4, with status `✓ shipped — see log <date>` and a
    link reference to this doc.
  - Prepend a log entry at the top of the Implementation log:
    ```
    ### YYYY-MM-DD--HH-MM — Phase 3 Extended: Ink rendering layer
    **Implemented by:** <agent name (model)>
    **What shipped:** <bullet list of 3E.1 through 3E.6 deliverables>
    **What changed in this doc:** locked decision #3 updated; Phase 3
      Extended inserted into Phase plan; render.ts deleted; input.ts
      renamed to editor.ts.
    **Suggested next steps for Phase 4:** StatusLine content (model,
      tokens, cost, orchestra badge) — components/StatusLine.tsx is
      already plumbed and just needs prop wiring + a state store
      (state.ts as per parent plan).
    ```
  - Refresh `updated_by` and `updated_at` in frontmatter.

- `docs/Phase-3-Extended.md` (this doc): leave in place as historical
  contract. Future phases reference it for the input-layer architecture.

**Verification:**

1. `bun run dev` — full UX walk-through: type, submit, stream, modal,
   abort, recall, exit. Everything from 3E.4 + 3E.5 still works.
2. `bun run compile` produces `dist/octmux`. Run it in a fresh tmux
   session. Same behavior.
3. `grep -r "render.ts\|src/input.ts" src/` returns nothing.
4. `wc -l src/*.ts src/**/*.tsx` — total project size should be
   roughly comparable to or smaller than Phase 3 (gains from deleting
   render.ts and the escape parser largely offset by component
   scaffolding).
5. `git log --oneline` shows one commit per sub-phase (3E.1 through
   3E.6).

**Handoff to Phase 4:** Ink architecture is in place; StatusLine
component exists as a stub; state.ts (per parent plan) doesn't exist yet
— Phase 4 creates it and feeds it into StatusLine.

## Risks / unknowns to resolve during 3E.1

1. **Bun + Ink + WASM Yoga in --compile mode.** Ink 5.x ships Yoga as
   WASM. `bun build --compile` should inline it, but verify before
   building out 3E.2. If compile fails, the fallback is to ship as
   `bun run dist/octmux.js` instead of a single binary.
2. **Ink 5 vs Ink 4 useInput.** Ink 5 reports paste as a single `input`
   string with `key.paste === true`. Ink 4 does not. Pin to Ink 5.x.
3. **Bracketed paste under tmux.** Same tmux config caveat as Phase 3
   (`extended-keys on`, `terminal-features ",*:extkeys"`). Ink handles
   the protocol once tmux delivers the sequences.
4. **Mouse mode + Ink stdin coexistence.** The `attachMouseStream`
   pattern in 3E.5 routes mouse bytes around Ink. Verify with a test
   that wheel events fire while idle and while a modal is up.
5. **SIGWINCH redraw with `<Static>`.** Static items don't re-render on
   resize. The dynamic area below does. If terminal narrows after a
   long line is committed, that line will be wrapped by the terminal,
   not Ink — acceptable for v1.

## Reused patterns (do not re-derive)

- LineEditor buffer operations: existing implementation in `src/input.ts`
  (Phase 3) — port wholesale into `src/editor.ts`, just delete the I/O
  wrappers.
- SSE event filtering: `src/events.ts` is unchanged and returns
  `ReplEvent` records of 8 kinds. Phase 3E.4 dispatches on these.
- Server lifecycle + tmux guard: `src/server-lifecycle.ts` is unchanged
  and called from `src/index.ts`.
- SGR mouse mode escape sequences: `\x1b[?1000h` enables button/wheel
  reporting; `\x1b[?1006h` switches to SGR-format (which produces
  parseable decimals instead of byte-encoded coords). Both must be
  disabled on exit.

## Phase implementation checklist (per sub-phase)

Mirror the parent plan's checklist:

When starting a sub-phase:

1. Read this doc top-to-bottom, focusing on the current sub-phase's spec
   AND the prior sub-phase's "Handoff" note (it carries forward state
   not visible in the spec below).
2. Implement only the deliverables and files listed for the current
   sub-phase. Do not pull work forward.
3. Run the manual verification steps. All must pass before commit.

When finishing a sub-phase:

1. Prepend a log entry at the top of the "Implementation log" with:
   - **Implemented by:** `<agent name (model)> — YYYY-MM-DD--HH-MM`
   - **Commit(s):** `hash1`, `hash2` — all hashes comma-separated on one line
2. Commit with `feat(octmux): Phase 3E.<n> — <short title>`.
3. If shipping multiple sub-phases in one session: complete one before
   starting the next; do NOT interleave.
4. Only after 3E.6: prepend a single consolidated log entry to the
   parent plan's Implementation log and flip the parent's locked
   decision #3.
