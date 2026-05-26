---
title: "octmux — Implementation Plan"
created_at: 2026-05-18--21-58
created_by: Claude Code (Claude Sonnet 4.6 1M)
updated_by: Claude Code (Claude Haiku 4.5)
updated_at: 2026-05-26--21-15
context: >
  octmux is a text-only barebones REPL UI for OpenCode that mimics the Claude
  Code CLI feel: text REPL, one bottom status line, Emacs-style line edits,
  multi-line via Alt-Enter, Esc / double-Esc semantics. Runs inside tmux (one
  octmux REPL per tmux window, independent sessions). Built on TypeScript +
  Bun using the official @opencode-ai/sdk. Sub-agent visualization is
  delegated to opentmux (existing OpenCode server-side plugin that auto-spawns
  tmux panes on session.created events). Orchestration is delegated to
  opencode-orchestra (slash-command framework: /brain, /duo-plan, /duo-act,
  etc.) which octmux invokes by forwarding unknown slash commands to the
  server. This document holds both the forward phase plan and a reverse-
  chronological implementation log; phases get logged at the top as they ship.
---

# octmux — Implementation Plan

## Context

octmux is a focused TUI client over OpenCode's HTTP API. It is NOT a tmux
manager, NOT a sub-agent orchestrator, NOT a plugin host. It lives in the
main pane of a tmux window and lets opentmux split sub-agent panes off to
the right (see `~/Gin-AI/projects/opentmux/assets/demo.png` for the target
layout). Orchestra slash commands (`/brain`, `/duo-*`) are forwarded to the
server's command endpoint — octmux does not implement orchestration logic
itself.

## Locked decisions

1. **Stack:** TypeScript on Bun. Use `@opencode-ai/sdk` (installed at
   `~/.config/opencode/node_modules/@opencode-ai/sdk`, v1.15.4). Ship via
   `bun build --compile` as a single executable.
2. **Server lifecycle:** three modes (inverted in Version 4.1c — default is now attach, not spawn).
   - Default — attach to port 4096 (the systemd service `scripts/opencode-server.service`).
     Rich error on connection failure guides user to start the service.
   - `--attach <port>` — connect to an existing server on the given port.
   - `--auto-spawn` — spawn `opencode serve --port <free>` per tmux window
     (port range `[4096, 4106]`). Explicit opt-in only; risk: SQLite locking +
     MCP/LSP bloat from concurrent instances.
3. **Input layer:** Ink (React for CLI) for region composition and resize/repaint.
   `LineEditor` state machine (`src/editor.ts`) preserved as a pure buffer/history
   container; Ink's `useInput` hook drives it. Bottom-anchor via Ink's
   Static-above-dynamic layout. All Emacs bindings, multi-line, bracketed paste,
   history, double-Esc clear preserved. No readline.
4. **Output layer + window scope.** Output is a typed block model (`text` / `thinking`
   / `tool-call` / `tool-result` / `user` / `error`) with a `Renderer` interface.
   **Ink's responsibility is strictly bounded to the single origin window's interactive
   chrome** — input editor, rules, status line, and modals. Ink does not own
   multi-window layout. The default `StdoutRenderer` writes ANSI-formatted
   lines via `<Static>` at line granularity; the terminal handles layout for streamed
   content. **tmux is the window manager and framing engine** — window creation,
   geometry, titles, focus, resize, detach/reattach. octmux issues no `set-option`
   or `set-window-option` commands except for `automatic-rename off` (needed to
   prevent tmux renaming `new-window` constructs to the running command).
   `TmuxWindowRenderer` (`--multi-window`, recommended default for SSH/TTY) is the
   tmux multiplex backend, routing `tool-call` and `tool-result` to a shared `"tools"`
   sink in a side window. **opentmux is the future cross-window coherence layer** —
   built on the role → log-file → tmux-window contract that Version 3-UX establishes.
   _(Note: `TmuxPaneRenderer` / `--multi-pane` were removed in Version 4 — see
   `docs/multi-window--vs--multi-pane.md` for rationale.)_
5. **Slash commands:** full set with interactive UX.
   - Local with custom UX: `/exit`, `/clear`, `/help`, `/model`, `/agents`, `/show`.
   - All other `/foo` forwarded to `POST /session/{id}/command` (orchestra
     commands and any future server-registered command get it for free).
6. **tmux:** required (env `TMUX`). Soft override `--no-tmux-guard`.

## Architecture at a glance

```
src/
  index.tsx              entry: args, lifecycle, renderer selection, render(<App/>)
  server-lifecycle.ts    port scan, spawn `opencode serve`, health probe, dispose
  events.ts              SSE dispatcher: filter by sessionID, emit block events
  blocks.ts              typed Block model + formatLine() ANSI formatter
  app.tsx                <App>: chrome + Static scrollback, thin renderer translation
  editor.ts              LineEditor: pure state machine, Emacs keymap, history
  keybindings.ts         all Ink 5 key dispatch
  renderer/
    types.ts             Renderer interface
    stdout.ts            StdoutRenderer: Static-backed, default backend
    visibility.ts        per-role on/off toggles + /show slash-command parser
    fifo.ts              log-file IPC (regular append-mode temp files, not FIFOs)
    tmux-window.ts       TmuxWindowRenderer: --multi-window, lazy side windows
  commands.ts            local slash-command parsers (parseExitCommand, parseRenameCommand, parseModelCommand, parseShowCommand)
  components/
    PromptInput.tsx      Ink input wrapper
    Rule.tsx             horizontal rule with optional title
    StatusLine.tsx       [idle] + hidden-role badges
    PermissionModal.tsx  y/a/n inline permission prompt
    QuestionModal.tsx    numbered-options question modal
    ModelPickerModal.tsx interactive model picker (arrow-key navigation, Enter/Esc/1-9 shortcuts)
```

One source file per concern. Grow organically; do not pre-explode.

## Document conventions

- The **Version plan** below is the design reference and execution order. When
  a version ships, mark its status `✓ shipped — see log <date>` in the plan but
  do not delete or rewrite the version spec; it's the historical contract.
- **Implementation logs** have been separated into individual version documents
  for clarity. See the references below.
- After every save: update `updated_by` and `updated_at` in the frontmatter
  per global doc rules (timestamp = `date +"%Y-%m-%d--%H-%M"`).

## Implementation logs (by version)

Detailed implementation logs for each version have been moved to dedicated documents.
**If a Version doc conflicts with this file, the Version doc is authoritative.**

- **Version 0:** embedded in this file (inline log, no separate doc)
- **Version 1, Version 1.5:** `docs/Version1.md` ← authoritative
- **Version 2:** `docs/Version2.md` ← authoritative
- **Version 3 (original, superseded):** plan spec only; no implementation log (never shipped as-is)
- **Version 3 Extended (3E.1–3E.6) + Version 3 UX (3U.1–3U.8):** `docs/Version3.md` ← authoritative (combined log)
- **Version 4:** `docs/Version4.md` ← authoritative

---

## Version plan (forward execution order)

### Version 0 — Skeleton + SDK smoke test (½ day)

**Status:** ✓ shipped — see log 2026-05-18--22-16

**Goal:** confirm Bun + the SDK + a running opencode server can talk. No UI.

**Deliverable:** `bun run src/index.ts --attach 4096` connects, prints
`health: ok` and the session count, exits 0.

**Files to create:**
- `package.json` (`type: module`, dep `@opencode-ai/sdk` via `"file:..."`,
  devDep `@types/bun`, scripts `dev`/`build`/`compile`)
- `tsconfig.json` (`target: ES2022`, `module: ESNext`,
  `moduleResolution: bundler`, `types: ["bun"]`, `strict: true`)
- `.gitignore` (`node_modules/`, `dist/`, `*.log`)
- `src/index.ts` (parse `--attach`, `createOpencodeClient`,
  `client.session.list({})`, print, exit)

**Key SDK calls / reused patterns:**
- `createOpencodeClient({ baseUrl })` from `@opencode-ai/sdk`.
- Health-probe pattern from
  `~/Gin-AI/projects/opentmux/src/bin/opentmux.ts:122` (`isOpencodeHealthy`).

**Manual verification:**
1. In one terminal: `opencode serve --port 4096`.
2. In another: `cd /mnt/nfs/Florian/Gin-AI/projects/octmux &&
   bun run src/index.ts --attach 4096`.
3. Expect `health: ok` and the session count on stdout.

**Handoff to Version 1:** server URL resolution and SDK client construction
proven; no UI, no streaming yet. Version 1 can assume the SDK works.

---

### Version 1 — Hello-world REPL with streaming (1 day)

**Status:** ✓ shipped — see `docs/Version1.md`, log 2026-05-18--22-31

**Goal:** type a prompt, hit Enter, watch the response stream in. Ctrl-C to
quit. **No** raw mode (use Node `readline`). **No** slash commands. **No**
status line.

**Deliverable:** usable single-turn-at-a-time REPL with live streaming.

**Files to create / modify:**
- `src/index.ts` — replace smoke test:
  1. Resolve server URL (`--attach` only).
  2. Create session via `client.session.create({ body: { title: "octmux" } })`.
  3. Open SSE via `await client.event({})`; iterate `for await (const ev of
     stream.stream)`.
  4. `readline` loop reading from stdin; on each line, call
     `client.session.prompt({ path: { id }, body: { parts: [{ type: "text",
     text: input }] } })` (synchronous prompt for Version 1; switch to
     `promptAsync` in Version 4).
  5. On `EventMessageUpdated` with `info.role === "assistant"` and
     `info.finish` set, print newline + redraw `> ` prompt.
- `src/events.ts` — small dispatcher: takes a raw `Event` and the active
  `sessionID`, returns `{ kind, text? }`. Drop events whose
  `properties.part.sessionID` (or `properties.info.sessionID`) doesn't
  match — sub-agent events go to opentmux panes, not our main view.

**Key SDK calls / behaviors:**
- `client.event({})` — SSE subscription returns `{ stream }` async iterable.
- `client.session.prompt({ path, body })` — confirmed in `sdk.gen.d.ts`;
  blocks until completion.
- Event filtering: only show `message.part.updated` where
  `properties.part.type === "text"` and `properties.part.sessionID ===
  ourSessionID`.

**Manual verification:**
1. With opencode server on 4096, run `bun run src/index.ts --attach 4096`.
2. Type `tell me a haiku about tmux`. Tokens stream in. Enter works for a
   second turn.
3. Ctrl-C exits cleanly.

**Out of scope:** tool-call rendering (print `[tool: read]` stub), reasoning
blocks, multi-line input, history, status line, server spawn, slash commands.

**Handoff to Version 1.5:** REPL loop and SSE dispatcher are working;
Version 1.5 adds streaming polish (indicator, abort, permission/question modals) on top of the Version 1 readline skeleton.

---

### Version 1.5 — Streaming UX + interactive modals (½ day)

**Status:** ✓ shipped — see `docs/Version1.md`, log 2026-05-19--15-03 (1.5c+1.5d), 2026-05-19--13-08 (1.5b), 2026-05-19--10-38 (1.5a)

**What was built (4 sub-phases):**

- **1.5a** — switch to `session.promptAsync()` (204 immediately); `isGenerating` flag;
  `[generating…]` indicator on first `message.part.updated` len=0 event; Ctrl-C during
  generation calls `session.abort()` instead of exiting.
- **1.5b** — true streaming via `message.part.delta` — a separate v2-style event type
  not in the v1 SDK `Event` union; cast via `unknown`; chunks arrive ~100–200ms apart.
  Replaced the accumulated-slice approach.
- **1.5c** — `session-status: retry` now prints `[retrying…]`; abort already wired.
- **1.5d** — `permission.updated` (v1) + `permission.asked` (v2, cast via unknown) →
  inline `? Allow: <title>  y=once  a=always  n=reject:` prompt → `postSessionIdPermissionsPermissionId()`.
  `question.asked` (v2, cast via unknown) → numbered-options prompt → raw `fetch()` to
  `POST /question/{reqID}/reply`. Without 1.5d, any agent tool that needs a permission
  or user input hangs the session silently.

**Key discovery:** `message.part.delta` is a v2 event type that the server fires for
all sessions regardless of SDK version. Same cast-via-unknown pattern applies to
`permission.asked` and `question.asked`. The v1 `Event` union omits all three.

**ReplEvent kinds after Version 1.5:** `text-delta`, `session-idle`, `error`,
`generating`, `session-status`, `part-removed`, `permission-asked`, `question-asked` (8 total).

---

### Version 2 — Auto-spawn server + tmux guard (1 day)

**Status:** ✓ shipped — see `docs/Version2.md`, log 2026-05-19--15-37

**Goal:** default mode launches its own server with port rotation; refuses
outside tmux unless overridden.

**Deliverable:** `octmux` (no args) inside tmux picks a free port in
`[4096, 4106]`, spawns `opencode serve --port <port>`, waits for
`/health`, then enters Version-1 REPL. Outside tmux: warning + exit 1.

**Files to create / modify:**
- `src/server-lifecycle.ts` (new):
  - `findFreePort(start, end)` via `net.createServer().listen(port)`
    (copy from `opentmux.ts:94-106`).
  - `findOpencodeBin()` — `which opencode`, fallback `~/.opencode/bin/opencode`
    (copy from `opentmux.ts:60`).
  - `spawnOpencodeServer(port)` via
    `Bun.spawn(["opencode","serve","--port", String(port)], { stdio:
    ["ignore","pipe","pipe"] })`; stderr → `/tmp/octmux-<port>.log`.
  - `waitForHealth(url, timeoutMs)` polling `GET /health`.
  - Returns `{ url, port, dispose() }`; dispose: SIGTERM + 2s grace +
    SIGKILL.
- `src/index.ts` — parse `--attach <port>`, `--no-tmux-guard`, `--help`,
  `--version`. tmux guard: if `!process.env.TMUX && !--no-tmux-guard`:
  warn + exit 1. SIGINT/SIGTERM → `dispose()`.

**Decision:** spawn the `opencode` binary, **not** the SDK's
`createOpencodeServer`. Keeps server lifetime independent of octmux crashes
and matches opentmux's port-rotation model.

**Manual verification:**
1. Outside tmux: refuses with friendly error.
2. Inside tmux: `bun run src/index.ts` → "spawned opencode server on port
   4097", then REPL.
3. Ctrl-C: `lsof -i :4097` empty within 3s (no orphans).
4. Two octmux instances in two tmux windows land on different ports.

**Handoff to Version 3:** server lifecycle is solved end-to-end. Version 3 is
pure UX work on the input layer — no server changes.

---

### Version 3 — Custom raw-mode input layer (2–3 days) — **core UX phase**

**Status:** ✓ superseded — replaced by Version 3 Extended (Ink migration). See log 2026-05-20--17-40 in `docs/Version3.md`.

**Goal:** replace `readline` with our own input handler so typing feels like
Claude Code.

**Deliverable:** Emacs cursor motion, kill ring, multi-line via Alt-Enter,
bracketed-paste support, history with Ctrl-P/N, double-Esc clears buffer.

**Files to create / modify:**
- `src/input.ts` (new) — `LineEditor` class:
  - `process.stdin.setRawMode(true); setEncoding("utf8")`.
  - State: `lines: string[]`, `row`, `col`, `killRing`, `history`,
    `historyIdx`.
  - Escape-sequence parser (byte-by-byte state machine):
    - Arrows `\x1b[A/B/C/D`, ctrl-arrows `\x1b[1;5C/D`.
    - Alt-letters `\x1bb`/`\x1bf`/`\x1bd`.
    - `\x1b\r` (Alt-Enter) → insert newline.
    - `\x1b\x1b` (double-Esc) → clear buffer.
    - Lone `\x1b` (timeout-based) → emit `interrupt` if streaming else no-op.
    - Bracketed paste `\x1b[200~`…`\x1b[201~` → buffer + insert verbatim.
  - Emacs ops: Ctrl-A/E/K/U/W/Y/B/F, Alt-B/F/D, Ctrl-D (forward-delete or
    EOF-on-empty), Ctrl-L (redraw).
  - Enter on last line submits; Alt-Enter inserts a new line.
  - Events: `submit(text)`, `interrupt`, `clear-buffer`, `eof`.
- `src/render.ts` (new):
  - Scrollback above (terminal scrolls naturally).
  - Input area anchored to bottom: `\x1b[s` save / `\x1b[u` restore +
    `\x1b[J` clear-below. Repaint on each keystroke. Track
    `process.stdout.columns` + `SIGWINCH`.
  - Enable bracketed paste at startup (`\x1b[?2004h`), disable on exit.
- `src/index.ts` — swap readline for `LineEditor`. `interrupt` is wired in
  Version 4.

**Manual verification:**
1. Ctrl-A/E, Alt-B/F, Ctrl-W behave as in bash.
2. Alt-Enter inserts newline; Enter submits the full multi-line block.
3. 30-line clipboard paste arrives as one logical input.
4. Ctrl-P recalls last submitted input.
5. Double-Esc on a populated buffer clears it.
6. Ctrl-C exits cleanly with terminal modes restored.

**Risk:** bracketed paste inside tmux needs `set -g extended-keys on` and
`set -ga terminal-features ",*:extkeys"`. Document in README; degrade
gracefully if open-paste sequence never arrives.

**Handoff to Version 4:** input layer is feature-complete; Version 4 layers the
status line, switches to async streaming, and wires Esc-to-abort.

---

### Version 3 Extended — Ink rendering layer (3E.1–3E.6)

**Status:** ✓ shipped — see log 2026-05-20--17-40 in `docs/Version3.md`.

All six sub-phases shipped. octmux is a working REPL: type a prompt, Enter submits to the LLM, streaming response displays in `<Static>` scrollback above the anchored input area, Ctrl-C Ctrl-C exits. Permission and question modals are real Ink components. Mouse wheel navigates history. Ctrl-C during generation aborts and restores the last submitted text.

---

### Version 3 UX — Typed block renderer + tmux multiplex (3U.1–3U.8)

**Status:** ✓ shipped — see log 2026-05-21 in `docs/Version3.md`.

All eight sub-phases shipped. Highlights: flicker-free Static scrollback; typed Block model with ANSI role prefixes; per-role visibility toggles (`/show thinking off`); `Renderer` interface with `StdoutRenderer` and `TmuxWindowRenderer` backends; `--multi-window` (recommended, lazy side windows) multiplex flag; `tool-call` + `tool-result` consolidated to a shared `"tools"` sink; origin window renamed to opencode session label; side windows use `<label>--<key>` naming convention (double-dash); `SubprocessStatus` component shows animated spinner + elapsed timer for active subprocesses; timers clear on role-specific `block-end` events. _(Version 4 subsequently removed `TmuxPaneRenderer` / `--multi-pane` — see `docs/multi-window--vs--multi-pane.md`.)_ See `docs/Version3.md` for full spec, design rationale, and implementation log.

---

### Version 4 — Status line + async streaming + Esc-interrupt + rich parts (2 days)

**Status:** in progress — see `docs/Version4.md`. Shipped: 4.1b (systemd service, 2026-05-22), 4.1c (default attach 4096 + `--auto-spawn` opt-in, 2026-05-22), 4.2 (`/model`, `/rename`, `/exit`, `/show` consolidation, 2026-05-22), 4.2 fix (`/model` interactive picker + context-window display, 2026-05-22). Core StatusLine content, Esc-interrupt, and `state.ts` planned.

**Goal:** bottom status line; Esc aborts a stream; tool calls and reasoning
render distinctly.

**Deliverable:** while streaming, status reads
`[streaming · <model> · in:<n> out:<n> · $<cost>]`. Idle:
`[idle · <model> · <session>]`. Esc aborts the stream.

**Files to create / modify:**
- `src/state.ts` (new) — `{ sessionID, mode: "idle"|"streaming"|
  "awaiting-permission", model, tokens, cost, lastAssistantMessageID,
  orchestraBadge? }` + `subscribe(listener)`.
- `src/render.ts` — `drawStatusLine()` at `rows - 1`, dim ANSI. Input area
  shifts up one row.
- `src/events.ts` — branch on `part.type`: `text` → stream delta; `tool` →
  `● Read(path)` + compact result; `reasoning` → dim italics under `·
  thinking`, collapse if long; `step-start` → blank line.
- `src/index.ts` — swap `prompt` for `promptAsync`. UX driven by SSE alone.
  On `submit`: `mode = streaming`, call `promptAsync`. On `interrupt`:
  `client.session.abort({ path: { id } })`. On `EventMessageUpdated` with
  `info.finish`: update `state.tokens`/`state.cost`, `mode = idle`.

**Constraint:** `promptAsync` returns 204 with no `messageID`. Correlation
is by `sessionID` only — single-user, single-flight. Acceptable.

**Manual verification:**
1. Long prompt → `[streaming]` → Esc aborts within ~500 ms → `[idle]`.
2. Token counter increments live; cost updates on message completion.
3. Tools render as compact `● tool(args)` lines.

**Handoff to Version 5:** UX foundation is complete. Version 5 layers slash
commands on top — `/` input branches before reaching `promptAsync`.

---

### Version 5 — Slash commands: local + forwarded (2 days)

**Status:** /help and live slash-command completion shipped via re-scoped Version 5 (see `docs/Version5.md`). Previously shipped: `/exit`, `/model` (with interactive picker), `/rename`, and `/show` consolidation (Version 4.2). Remaining (deferred): `/clear`, `/agents`, server fall-through for unknown `/foo`.

**Goal:** built-ins with custom UX; forward everything else.

**Deliverable:** `/exit`, `/clear`, `/help`, `/model`, `/agents` all work.
`/brain`, `/duo-plan`, `/duo-act`, `/brain-abandon`, `/duo-abandon`, and any
unknown `/foo` forward to the server.

**Files to create / modify:**
- `src/slash.ts` (new) — `LOCAL` registry:
  - `/exit` — clean shutdown; `dispose()` spawned server.
  - `/clear` — `console.clear()` + new session.
  - `/help` — local help text listing built-ins + fall-through.
  - `/model` — `client.config.providers({})` → picker →
    `client.session.update({ path: { id }, body: { model: { providerID,
    modelID } } })`.
  - `/agents` — `client.app.agents({})` → picker → remember chosen agent on
    next `promptAsync` body.
  - Fall-through: `client.session.command({ path: { id }, body: { command,
    arguments } })`. Render 400/404 as a polite local error.
- `src/picker.ts` (new) — input enters "menu mode": j/k or arrows, Enter
  selects, Esc cancels.
- `src/index.ts` — if input starts with `/`, route to `slash.ts` instead of
  `promptAsync`.

**Manual verification:**
1. `/help` prints local help.
2. `/model` shows providers + models; pick; status line updates; next prompt
   uses new model.
3. `/agents` picker switches active agent.
4. `/brain do X` forwards; if orchestra is installed on the server, it acts;
   400/404 renders politely.
5. `/exit` shuts down cleanly; `/clear` resets to a fresh session.

**Handoff to Version 6:** all command routing is in place; Version 6 adds the
orchestra status badge and the inline permission-prompt UX.

---

### Version 6 — Orchestra badge + permission prompts (1–2 days)

**Status:** planned.

**Goal:** status-line badge for orchestra phase; inline permission prompts.

**Deliverable:**
- Status line shows `[brain: PLAN]` / `[duo: act]` when an orchestra session
  is in-flight on the server.
- Server permission requests show inline `? Run X? (y/N/a)` above input;
  `y`/`N`/`a` reply via the API.

**Files to create / modify:**
- `src/orchestra-watch.ts` (new):
  - Resolve project root: `OPENCODE_PROJECT_DIR` env or `cwd`. With
    `--attach`, fall back to `GET /project/current` if available.
  - `fs.watch(<root>/.opencode/orchestra/sessions/, { recursive: true })`.
    Track subdirs with `.brain-inflight` / `.duo-inflight`. Pick most recent
    active; read adjacent `PLAN.md` first line or `TASKS.json` for stage
    label.
  - Debounce re-scans to 250 ms. Update `state.orchestraBadge`.
- `src/events.ts` — extend:
  - `EventPermissionUpdated` → `mode = awaiting-permission`, enqueue,
    render inline prompt above input.
  - Input enters "permission mode": `y`/`N`/`a` →
    `client.session.permissions({ path: { id, permissionID }, body: {
    response: "once"|"reject"|"always" } })`.
  - `EventPermissionReplied` → clear prompt, restore mode.

**Manual verification:**
1. `/brain do small task` → badge `[brain: PLAN]` appears; opentmux opens
   sub-agent panes on the right; badge clears after `.outcome` is written.
2. Write-tool prompt shows inline `? Run X? (y/N/a)`; `a` is remembered for
   the session.

**Handoff to Version 7:** functionally complete; Version 7 is polish + single
binary + README.

---

### Version 7 — Polish + single-binary build + README (1 day)

**Status:** planned.

**Goal:** ship a self-contained binary.

**Deliverable:**
- `bun build --compile --target=bun-linux-x64 src/index.ts --outfile
  dist/octmux` produces a self-contained binary (~50–90 MB).
- README updated with install, tmux config tip (`set -g extended-keys on`,
  `set -ga terminal-features ",*:extkeys"`), `--attach` flag, slash-command
  reference, sample tmux launch.

**Files to create / modify:**
- `scripts/build.sh` — wraps `bun build --compile` for common targets.
- `src/index.ts` — final pass: restore terminal modes on every exit path via
  `process.on("exit")` and `process.on("uncaughtException")`. Graceful
  SIGTERM.
- `README.md` — expand.

**Manual verification:**
1. `./scripts/build.sh` produces `dist/octmux`.
2. `./dist/octmux` inside tmux behaves identically to `bun run`.
3. Demo: `tmux new-session`, run `./dist/octmux`, ask it to do something
   that triggers orchestra → opentmux splits sub-agent panes to the right;
   octmux owns the main pane.

**Handoff:** project is shippable; further work (memoryless mode,
multi-session views, themes) is post-MVP.

## Critical files

- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/index.tsx` — entry, arg parsing, renderer selection, render(`<App/>`)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/server-lifecycle.ts` — port rotation, spawn, health, dispose
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/events.ts` — SSE dispatcher, block event emission
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/blocks.ts` — typed Block model, `formatLine()` ANSI formatter
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/app.tsx` — `<App>`: chrome + Static scrollback, thin renderer translation
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/editor.ts` — LineEditor state machine
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/types.ts` — `Renderer` interface
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/stdout.ts` — `StdoutRenderer` (default)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/tmux-window.ts` — `TmuxWindowRenderer` (`--multi-window`)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/renderer/visibility.ts` — per-role visibility, `/show` parser
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/commands.ts` — local slash-command parsers (Version 4.2+)
- `/mnt/nfs/Florian/Gin-AI/projects/octmux/src/components/ModelPickerModal.tsx` — interactive model picker (Version 4.2+)

## Reused patterns (do not re-derive)

- Port scanning + health probe + bin lookup:
  `~/Gin-AI/projects/opentmux/src/bin/opentmux.ts:60,94-106,122`.
- SDK client construction + SSE subscription:
  `~/Gin-AI/projects/opentmux/src/index.ts`.
- Orchestra session-state file layout:
  `~/Gin-AI/projects/opencode-orchestra/docs/design.md`,
  `~/Gin-AI/projects/opencode-orchestra/commands/brain.md`.

## Risks / unknowns to resolve before Version 1

1. **SDK package resolution.** SDK is at
   `~/.config/opencode/node_modules/@opencode-ai/sdk`, not on public npm.
   Version 0 must confirm `bun install` resolves
   `"@opencode-ai/sdk": "file:..."` against that path. Compiled binary will
   inline it.
2. **`/command` shape.** `SessionCommandData.body = { command: string,
   arguments: string }` confirmed. Unknown commands return 4xx; render
   politely.
3. **Bracketed paste in tmux.** Needs `extended-keys on` +
   `terminal-features ",*:extkeys"`. Document; degrade gracefully.
4. **`OPENCODE_PROJECT_DIR` in `--attach` mode.** Server sets it. Fallback
   to `GET /project/current` or `cwd`.
5. **Sub-agent event filtering.** Top-level sessions have empty `parentID`;
   sub-agent sessions have `parentID !== ""`. Drop everything not matching
   our `sessionID`. Optional later: surface "sub-agent spawned" notification
   on `EventSessionCreated` where `parentID === ourSessionID`.

## End-to-end verification (after Version 7)

1. `tmux new-session -s demo`.
2. In the main pane: `./dist/octmux`.
3. Status line shows `[idle · <model> · <session>]`. Bracketed paste, Emacs
   keys, Alt-Enter all work.
4. Send a normal prompt → tokens stream → `[streaming]` → Esc aborts.
5. `/model` → picker → switch model → status updates.
6. `/brain implement a small feature` → `[brain: PLAN]` badge appears;
   opentmux spawns Planner/Actor/Reviewer panes on the right; octmux remains
   the primary pane.
7. Permission prompt arrives inline; `y` proceeds.
8. `/exit` → server torn down, no orphan processes, terminal modes restored.

## Version implementation checklist (for whoever picks this up)

When starting a phase:

1. Read this doc top-to-bottom, paying attention to the most recent log
   entry — it carries forward notes from the previous phase that the spec
   below may not capture.
2. Implement only the deliverables and files listed for the current phase.
   Do not pull work forward from later phases.
3. Run the phase's manual verification steps. All must pass.

When finishing a phase:

1. Add a new entry at the top of the phase's Implementation log document with
   today's `YYYY-MM-DD--HH-MM` timestamp. Each entry must include:
   - **Implemented by:** `<agent name (model)> — YYYY-MM-DD--HH-MM`
   - **Commit(s):** `hash1`, `hash2` — all hashes comma-separated on one line
2. Flip the phase's status in "Version plan" to `✓ shipped — see <doc>, log
   YYYY-MM-DD--HH-MM`.
3. Refresh `updated_by` and `updated_at` in the frontmatter of all docs touched.
4. Commit with `feat(octmux): Version N — <short title>`.

## Open questions (to revisit after further operator testing)

This section is a short index of design decisions made conditionally — i.e.
the chosen approach is the smallest viable fix, but an alternative is
already specified and held in reserve in case operator testing reveals the
chosen approach is insufficient. Each entry is one line plus a pointer to
the full design rationale in the relevant per-phase log.

1. **Toggle-on liveness-cache refresh (Version 4.5.2):** active implementation
   is **Option A** — a non-blocking `_refreshLiveIdsAsync()` kick inside
   `TmuxWindowRenderer.setOutputEnabled` on `on=true`. Recovers block 1
   after toggle-on in the typical operator-timing case (~50 ms refresh vs.
   multi-second prompt typing). Race window survives for sub-50ms
   toggle-then-submit timing (rare for humans, common for scripted tests).
   **Option B** — a `_forcedProbeKeys: Set<string>` flag plus a one-time
   synchronous `tmux list-windows` probe at the next `_ensureWindow` for
   that key — provides 100% reliable block 1 recovery at the cost of a
   single Version 4.4.3-style burst-pattern moment for that one block.
   Option B is fully specified (field declaration, both call-site snippets,
   compatibility argument) and additive on top of Option A. Promote A→A+B
   if operator testing shows real block 1 loss in normal workflows. See
   `docs/Version4.md` §Version 4.5.2 for the complete design.
