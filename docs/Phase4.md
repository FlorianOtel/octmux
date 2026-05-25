---
title: "octmux — Phase 4: Status line + async streaming + Esc-interrupt + rich parts (planned)"
created_at: 2026-05-21--20-18
created_by: Claude Code (Claude Sonnet 4.6)
updated_by: Claude Code (Claude Opus 4.7)
updated_at: 2026-05-25--16-01
context: >
  Phase 4 is the next major phase focusing on the status line, async streaming,
  Esc-interrupt capability, and rich part rendering. This document contains
  the complete planning and implementation logs for Phase 4.
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
   `YYYY-MM-DD--HH-MM` timestamp. Each entry must include:
   - **Implemented by:** `<agent name (model)> — YYYY-MM-DD--HH-MM`
   - **Commit(s):** `hash1`, `hash2` — all hashes comma-separated on one line
2. Flip the phase's status in the parent plan to `✓ shipped — see log
   YYYY-MM-DD--HH-MM`.
3. Refresh `updated_by` and `updated_at` in the frontmatter.
4. Commit with `feat(octmux): Phase N — <short title>`.

---

## Implementation log (reverse chronological — newest at top)

### 2026-05-25--14-11 — Phase 4.5: /show + /<key>-output slash commands on 4.4.3+4.4.4 foundation

**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-05-25--14-11
**Commit(s):** `25c644a`

**What changed:**

New shared module `src/renderer/output-keys.ts` exports `OUTPUT_KEY` (Role → output-key mapping) and `OUTPUT_KEYS` (deduped key list). This is the single source of truth for both renderers + commands.ts.

`TmuxWindowRenderer` migrated to import `OUTPUT_KEY`/`OUTPUT_KEYS` from the shared module (removed local `WINDOW_KEY`). Behaviour-preserving — the constructor and gate machinery still operate as in Phase 4.4.3+4.4.4. Gate checks in `beginBlock`/`appendToBlock`/`endBlock` remain uniform. `setOutputEnabled(key, true)` now eagerly calls `_ensureWindow(key)` so the side window appears the moment the gate is flipped on — fixes the lazy-creation asymmetry where toggling on after toggling off (or before any content has streamed) would leave the operator with no visible window until the next block-start.

`StdoutRenderer` upgraded from no-op gate (Phase 4.4.3 placeholder) to real gate: `_outputEnabled: Map<string, boolean>` field, real `isOutputEnabled`/`setOutputEnabled` methods, gate checks in `beginBlock`/`appendToBlock`/`endBlock`. In `--single` mode, `/<key>-output off` now suppresses inline scrollback rendering for that block class.

`commands.ts`: `parseShowCommand` replaced — old visibility-toggle behaviour (with `/show <role> on|off` syntax) is gone. New `/show` (no args) reads renderer state and emits a coloured one-line status (ANSI green for on, red for off, pipe-separated). New `parseBlockOutputCommand` handles `/<key>-output [on|off]` — generic regex captures any key, validates against `OUTPUT_KEYS`, returns discoverable error for unknown keys, reports current state when no arg given (`"<key>-output is <on|off>"`), and on toggle replies with the transition (`"<key>-output prev->new"`, e.g. `on->off`, `off->on`, or no-op forms `on->on` / `off->off`) so the operator always sees the resulting state. ANSI constants `GREEN`/`RED`/`RESET` defined inline. `Visibility` and `Role` imports removed (no longer needed). Other parsers (`parseExitCommand`, `parseRenameCommand`, `parseModelCommand`) unchanged.

`app.tsx`: import line extended with `parseBlockOutputCommand`. Old `/show` dispatch block replaced with new pair (`/show` status + `/<key>-output` toggle/query). Dispatch order unchanged: `/exit`, `/rename`, `/model`, `/show`, `/<key>-output`, default send.

`Visibility` class is left intact — only its slash command was removed. `isVisible(role)` checks in both renderers' `beginBlock`/`appendToBlock` paths continue to run (defaulting to all-visible since no user command can toggle them anymore). Kept as inert internal infrastructure.

Gate is uniform across both `--single` and `--multi-window` mode semantics. Per-renderer mechanism differs (FIFO write suppression in multi-window; `_openBlocks` registration + commit suppression in single) but observable user behaviour is the same.

**Files modified:**
- `src/renderer/output-keys.ts` (new)
- `src/renderer/tmux-window.ts`
- `src/renderer/stdout.ts`
- `src/commands.ts`
- `src/app.tsx`

**Verified (operator, 2026-05-25):** `/show`, `/thinking-output [on|off]`, `/tools-output [on|off]` all behave as designed in both `--single` and `--multi-window` modes. Toggle reply transition format (`prev->new`, including no-op `on->on` / `off->off`) confirmed. Eager window creation on toggle-on confirmed — side window appears immediately rather than waiting for next block-start. Unknown `/<key>-output` returns the discoverable error.

---

### 2026-05-23--23-15 — Phase 4.4.4: async background liveness refresh (eliminate per-block tmux overhead)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--23-15
**Commit(s):** `ad60b1c`

**What changed:** Moved the tmux liveness probe off the hot path. `_ensureWindow` now reads an in-memory `_liveIds: Set<string>` cache (zero subprocess cost on warm path); cache refreshed fire-and-forget via `execFile` (callback form) after every `_ensureWindow` call. `_liveIdsRefreshInFlight` single-flight guard prevents concurrent subprocess spawns. Eliminates the per-block ~10–50 ms event-loop block introduced in Phase 4.4.3 that caused thinking deltas to flush in bursts.

**Trade-off:** at most one block of deltas may write to a dead FIFO (lost) if the operator kills a window mid-stream; the async refresh kicked at that block-start lands ~50 ms later and the next block-start recreates the window. Acceptable per operator priority: real-time streaming > zero-loss on manual kill.

**Verified (operator, 2026-05-23):** real-time streaming to side windows confirmed; thinking content now arrives smoothly without the burst pattern observed under Phase 4.4.3's synchronous probe. Window re-creation after manual `tmux kill-window` works on next block-start with no perceptible delay.

---

### 2026-05-23--22-42 — Phase 4.4.3: re-entry safety + outputEnabled gate (TmuxWindowRenderer foundation)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--22-42
**Commit(s):** `1a4523c`

**What changed:**
Added re-entry safety to `TmuxWindowRenderer` via a liveness check in `_ensureWindow` that detects stale window IDs (e.g., when the operator manually kills a side window mid-session) and recreates them. Also added a gating mechanism (`_outputEnabled` map + `isOutputEnabled`/`setOutputEnabled` methods) to suppress output streams for side windows without destroying them, enabling future slash-command controls (e.g., `/thinking off`).

**Key architectural changes:**

1. **Renderer interface** — added two methods:
   - `isOutputEnabled(key: string): boolean` — query gate state
   - `setOutputEnabled(key: string, on: boolean): void` — set gate state

2. **TmuxWindowRenderer** — added three pieces:
   - `_outputEnabled: Map<string, boolean>` initialized with defaults (true for "thinking", "tools")
   - Public `isOutputEnabled`/`setOutputEnabled` methods
   - Hardened `_ensureWindow` with liveness check: runs `tmux list-windows` to get live IDs; if cached ID is stale, closes FIFO, deletes map entries, and clears line buffers before creating a fresh window

3. **Gate checks at three points:**
   - `beginBlock`: skips `_ensureWindow` and window setup if gate is off
   - `appendToBlock`: skips FIFO write if gate is off
   - `endBlock`: skips final flush if gate is off

4. **StdoutRenderer** — added no-op implementations for both new methods (always returns true for query; no-op for set).

**Files modified:**
- `src/renderer/types.ts` — added two methods to Renderer interface
- `src/renderer/stdout.ts` — no-op implementations
- `src/renderer/tmux-window.ts` — _outputEnabled map, public methods, hardened _ensureWindow with liveness check, gate checks in beginBlock/appendToBlock/endBlock

---

### 2026-05-23--18-48 — Phase 4.4.1: orchestra-style status bar (model, ctx bar, project, branch)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--17-20 (initial); Claude Code (Claude Sonnet 4.6) — 2026-05-23--18-48 (UX fixes)
**Commit(s):** `ecf35f9`, `6834548`, `4f702a8`

**What changed:**
Replaced the basic `[idle] hidden: ...` status line with an orchestra-style status bar that renders the active model name + context window, a 20-cell gruvbox-colored context-usage bar (updated on `session-idle`), a cost placeholder, the project basename, and git branch name.

**Design (initial — ecf35f9, 6834548):**
- New `src/utils/formatters.ts` with helper functions: `formatTokens()` (human-readable K/M notation), `fetchGitBranch()` (one-shot git read), `getContextWindow()` (cached lookup via `provider.list()` or fallback map), `prettyModelName()` (display alias), `contextLabel()` (formatted context label).
- New `src/components/StatusLine.tsx`: single `<Text>` line component (preserves fixed height). Accepts `modelLabel`, `tokenUsage`, `projectName`, `gitBranch` props. Bar fill uses `▓`/`░` glyphs with three-stop gruvbox color gradient: green <50%, yellow 50–79%, red ≥80%.
- `src/app.tsx` wired: new `gitBranch` + `tokenUsage` state; mount effects (git fetch, session init); `session-idle` IIFE updates token counts; StatusLine invocation with new props.

**Dropped:**
- The `[idle]` indicator and hidden-role badges are no longer displayed (operator accepted).

**UX bug fixes (4f702a8):**

1. **Context window stuck at 200K** — `getContextWindow` now uses a two-pass lookup: first matches by provider ID + model dict key or `mInfo.id` field; then falls back to all providers regardless of provider ID. Handles cases where `sess.model.id` (e.g. `"kimi-k2.6"`) differs from the provider list's dict key (e.g. `"moonshot/kimi-k2.6"`).

2. **tokenUsage never initialized after `/model` switch** — Added a `useEffect` keyed on `activeModel`. It fetches the context window and updates `tokenUsage.contextWindow` (preserving `used`) whenever the model changes. The startup effect was simplified to only set `activeModel`; the new effect handles the rest.

3. **No token consumption recorded after turns** — The `session-idle` IIFE now reads `msg.providerID` / `msg.modelID` directly from the latest `AssistantMessage` instead of the `activeModel` closure. This eliminates the stale-closure timing dependency and handles mid-session model switches. Also added null guard on `msg.tokens` for non-Anthropic providers. `activeModel` removed from SSE `useEffect` deps to prevent loop teardown/restart on model changes.

**Files modified:**
- `src/utils/formatters.ts` (new in ecf35f9, updated in 4f702a8) — formatters + two-pass context window lookup.
- `src/components/StatusLine.tsx` — orchestra-style bar component (color on bar only).
- `src/app.tsx` — state, effects, event handler, StatusLine invocation; UX fixes in 4f702a8.

---

### 2026-05-23--16-40 — Phase 4.3: /show status + /thinking /tools toggle commands

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-23--16-40
**Commit(s):** `105b17a`

**What changed:**
Refactored `/show`, `/thinking`, and `/tools` commands to unify visibility toggle logic and enable tmux window creation and destruction on demand. All local command parsing and execution now lives in `src/commands.ts`; tmux lifecycle management is delegated to renderer implementations. The `/show` command becomes a pure status display; `/thinking` and `/tools` are dedicated toggle commands that manage tmux resource lifecycle.

**Key architectural changes:**

1. **Renderer interface** — added `setToggleEnabled(key: string, on: boolean): void` to enable uniform toggle control across all renderer backends.

2. **Command layer (`src/commands.ts`)** — two new functions replace the legacy `parseShowCommand`:
   - `handleShowCommand(input: string, renderer: Renderer): boolean` — matches `/show` with no arguments, reads visibility state, reports status in format `"thinking: on | tools: off"`, commits user input + system message, returns true/false.
   - `handleToggleCommand(input: string, renderer: Renderer): boolean` — matches `/thinking` or `/tools` with optional `on|off` action. Query mode (no action): reads state and reports. Toggle mode (action specified): calls `renderer.setToggleEnabled()` to update visibility and manage tmux resources.

3. **Renderer implementations:**
   - `StdoutRenderer.setToggleEnabled()` — uses local `ROLES_BY_KEY` constant to map keys ("thinking", "tools") to roles; calls `visibility.set()` for each.
   - `TmuxWindowRenderer.setToggleEnabled()` — same visibility update; if turning off, calls `_destroyWindow()` to close and clean up the window and FIFO.

4. **Lazy window creation** — `TmuxWindowRenderer._ensureWindow()` includes a hardening check: verifies the stored window still exists; if it's gone, clears maps and recreates.

5. **App dispatch** — `app.tsx` `handleSubmit()` replaced the single `/show` block with:
   ```typescript
   if (handleToggleCommand(text, renderer)) return;
   if (handleShowCommand(text, renderer)) return;
   ```
   Both functions handle commitUserInput/commitSystemMessage internally.

**Files modified:**
- `src/renderer/types.ts` — added `setToggleEnabled(key: string, on: boolean): void` to Renderer interface.
- `src/renderer/stdout.ts` — added `ROLES_BY_KEY` constant; implemented `setToggleEnabled()`.
- `src/renderer/tmux-window.ts` — added `ROLES_BY_KEY` constant; hardened `_ensureWindow()` with existence check; added `_destroyWindow(key)` method; implemented `setToggleEnabled()`.
- `src/commands.ts` — replaced `parseShowCommand()` with `handleShowCommand()` and `handleToggleCommand()`; removed import of `Visibility` (no longer needed directly).
- `src/app.tsx` — updated import to use `handleShowCommand`, `handleToggleCommand`; replaced `/show` dispatch block with the two new function calls.

> **Status (2026-05-25): DEPRECATED — superseded by Phase 4.5.** This first attempt failed because tmux window (re)creation was not re-entry safe; the load-bearing preparation was subsequently delivered in **Phase 4.4.3** (`1a4523c` — re-entry safety + `outputEnabled` gate) and **Phase 4.4.4** (`ad60b1c` — async background liveness refresh). The user-facing commands originally scoped here shipped in **Phase 4.5** (`25c644a` — see that entry for the authoritative description). This entry is retained as historical record of the failed first attempt.

---

### 2026-05-22 — Phase 4.2 fix: /model interactive picker + context window display

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `357fd181`, `487074d8`

**What changed:**
Two fixes to the `/model` command:

1. **Context window defensive coding** — The previous code accessed `mInfo.limit.context` directly; when `limit` or `limit.context` is absent at runtime the output showed `ctx:0`. Now uses optional chaining with a `"?"` fallback.

2. **Interactive model picker** — `/model` no longer prints a static list to scrollback. It now opens an inline picker above the input chrome (same modal pattern as `PermissionModal`/`QuestionModal`). Arrow keys navigate the list, `Enter` selects, `Esc` cancels, number keys `1`–`9` are shortcuts. The current model is marked `←current`. PromptInput is disabled while the picker is open. `/model <providerID>/<modelID>` still works as a direct set (bypasses picker).

**Design note — merged model list (intentional, see source comment):**
`/model` uses `client.provider.list()` (`GET /provider`), which returns OpenCode's **merged** view: the user's `~/.config/opencode/opencode.json` combined with OpenCode's full upstream model catalog. The merge happens server-side inside the OpenCode process; user config entries take precedence (they can override names, limits, costs). The `connected` filter means "has an API key available from any source" (config file, environment variable, or occasionally a provider with free/built-in access) — it is broader than "explicitly configured by the user".

This means the picker shows more models than the user may have consciously set up: any provider whose key happens to be in the environment will appear alongside explicitly configured ones.

**To revert to user-configured models only:** switch `provider.list()` to `client.config.providers()` (`GET /config/providers`) in the `/model list` handler in `src/app.tsx`. That endpoint reads `opencode.json` directly and returns `Provider[]` with a `source` field (`"config" | "env" | "custom" | "api"`). Filter to `source !== "api"` to exclude pure catalog entries, or `source === "config"` for only what is explicitly in `opencode.json`. The `Model` type from that endpoint has `limit.context` non-optional, so the defensive optional-chaining in the loop can be removed.

**Files modified:**
- `src/components/ModelPickerModal.tsx` (new) — picker component with `useInput` for navigation.
- `src/app.tsx` — added `ModelPickerModal` import; added `modelPicker` state; replaced static list with picker-open logic; added `handleModelSelect`/`handleModelCancel` callbacks; rendered picker in JSX; updated PromptInput `disabled` prop.

---

### 2026-05-22 — Phase 4.2: /model, /rename, /exit slash commands + /show consolidation

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `0bdd5174`

**What changed:**
Four slash-command implementations and command parsing consolidation. All local (non-forwarded) slash commands now live in a dedicated `src/commands.ts` module. The `parseShowCommand` function was moved from `visibility.ts` to `commands.ts` to keep all local parsers together. New commands: `/exit` (clean shutdown), `/rename <name>` (rename session in DB and tmux), `/model` (list providers/models or set active model for next prompt).

**Files modified:**
- `src/renderer/types.ts` — added `rename(newLabel: string): void;` to Renderer interface.
- `src/renderer/stdout.ts` — implemented rename as no-op.
- `src/renderer/tmux-window.ts` — implemented rename: renames origin window and all side windows to `<newLabel>--<key>`.
- `src/commands.ts` (new) — consolidated command parsers: `parseShowCommand` (moved from visibility.ts), `parseExitCommand`, `parseRenameCommand`, `parseModelCommand`.
- `src/renderer/visibility.ts` — removed `parseShowCommand` function (moved to commands.ts).
- `src/app.tsx` — rewired command dispatch in `handleSubmit`; added `sessionLabel` and `activeModel` state; updated import to use new `src/commands.ts` module; /model list shows current + available models from connected providers with context window sizes; /model set accepts `<providerID>/<modelID>` syntax and applies to next prompt.

**Design notes:**
- `/rename` updates the session title in the DB (via `client.session.update`) and renames tmux windows via `renderer.rename()` immediately.
- `/model list` fetches provider list and current session model, displays connected providers' models with context limits in human-readable form (e.g., "4k"), marks current model with asterisk.
- `/model set <providerID>/<modelID>` sets local `activeModel` state which is included in next `promptAsync()` body. Does not persist to DB — applies only to the current prompt.
- Command dispatch order: /exit, /rename, /model, /show, then default promptAsync.

---

### 2026-05-22 — Phase 4.1c: Default attach to port 4096 + --auto-spawn warning

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `55581900`, `8e793430`, `fe9a72db`

**What changed:**
The startup behavior has been inverted: `octmux` with no arguments now attaches to the default port 4096 (the systemd service) instead of auto-spawning. Auto-spawn is now an explicit opt-in via `--auto-spawn` flag.

**Rationale:**
- Running multiple opencode instances concurrently risks SQLite locking errors (second instance crashes) and memory bloat from duplicate MCP/LSP processes.
- A single persistent server (managed by `scripts/opencode-server.service`) is the recommended pattern.
- On connection failure to port 4096 (default path), a rich error message guides users to start the server and documents the `--auto-spawn` option with its risks.

**Files changed:** `src/index.tsx`
- Added `--auto-spawn` flag parsing (line 43).
- Updated help text with new usage patterns and `--auto-spawn` warning.
- Rewrote server-lifecycle block (lines 94-138): now prefers attach-to-4096 over auto-spawn; distinct error messages for default vs. explicit `--attach`.

**Amendment — 2026-05-23, commit `12327ea` (Claude Code, Claude Sonnet 4.6):**
Converted the service from system-wide (root-owned) to a proper **user unit**, and made the
port configurable. opencode is single-user (SQLite session store) — a system-wide service was
the wrong abstraction.

- `scripts/opencode-server.service` — full rewrite as user unit: removed `User=florian`,
  `After=network.target`, `Environment=HOME=`, all hardcoded `/home/florian` paths; `%h`
  expansion throughout; `OPENCODE_PORT=4096` env var with optional `EnvironmentFile` override
  at `~/.config/opencode/opencode-server.env`; `WantedBy=default.target`; journal comments
  updated to `--user` flag.
- `scripts/install-opencode-service.sh` — rewritten without root: installs to
  `~/.config/systemd/user/`; `systemctl --user` throughout; errors if accidentally run as
  root; port-override hint and `loginctl enable-linger` hint.
- `src/index.tsx` — `systemctl start` → `systemctl --user start` in the rich error message.

**Logging decision — volatile (journald):** user journal is volatile by default on Debian
(stored in `/run/user/$UID/`, cleared on reboot). This is acceptable for a dev tool.
Query: `journalctl --user -u opencode-server [-f]`.

If persistent logs are needed later, options are:
1. **System-level** (requires root): set `Storage=persistent` in `/etc/systemd/journald.conf`
   and restart journald — all journals (system + user) become persistent in `/var/log/journal/`.
2. **File-based** (user-level, no root): change `StandardOutput=journal` to
   `StandardOutput=append:%h/.local/share/opencode/server.log` in the unit, then add a
   companion logrotate config + systemd user timer for daily rotation with `copytruncate`.

---

### 2026-05-22 — Phase 4.1b: systemd service for opencode headless mode

**Implemented by:** Claude Code (Claude Sonnet 4.6)
**Commit(s):** `cbd48a08`, `00bb1efc`

**What shipped:**
Two files under `scripts/`:

- `scripts/opencode-server.service` — systemd unit that runs `opencode serve --port 4096 --print-logs --log-level INFO` as `User=florian`. `Type=simple` (non-forking). `Restart=on-failure` with `RestartSec=5s` and a burst cap (`StartLimitBurst=3` per 60 s) to avoid restart storms. Logs go to journald (`StandardOutput=journal`, `SyslogIdentifier=opencode-server`); query with `journalctl -u opencode-server -f`.

- `scripts/install-opencode-service.sh` — idempotent install script (run as root from repo root). Copies the unit to `/etc/systemd/system/`, reloads the daemon, and runs `systemctl enable --now`.

**Port:** 4096 (manual dev instances use 4097 / 4101).

**Log rotation:** handled by journald (configured via `/etc/systemd/journald.conf`; default keeps logs until disk use hits 10% or free space drops below 15%).

**Usage after install:**
```
sudo bash scripts/install-opencode-service.sh
journalctl -u opencode-server -f
```

---

### 2026-05-21 — Phase 4.1: Post-Phase3 minor UX fixes

**Implemented by:** Claude Code (Claude Haiku 4.5)
**Commit(s):** `b92c706`, `419ac4e8`

**What shipped:**
`TmuxWindowRenderer` origin window renamed to opencode session label; side window names changed to `<label>--thinking` / `<label>--tools` (double-dash); `SubprocessStatus` component added — animated 2-char spinner + elapsed timer per active subprocess, shown above the input chrome.

Timer start/stop semantics: `thinking` timer starts on `block-start` for the thinking role, clears on its `block-end` (i.e. when the reasoning phase ends, before the text response begins — not at turn end). `tools` timer starts on the first `tool-call block-start`, clears on `tool-result block-end` (normal path — result delivery ends the sequence) or on `tool-call block-end` with `status="error"` (error path — no result follows). Both timers are also cleared on `session-idle` as a safety net. `procTimes` state in `app.tsx` tracks the start timestamps; zero-height when both are null.

---

## Phase 4 Plan

**Status:** planned.

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

**Handoff to Phase 5:** UX foundation is complete. Phase 5 layers slash
commands on top — `/` input branches before reaching `promptAsync`.
