---
title: "octmux — Phase 4: Status line + async streaming + Esc-interrupt + rich parts (planned)"
created_at: 2026-05-21--20-18
created_by: Claude Code (Claude Sonnet 4.6)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-05-22--21-46
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
   `YYYY-MM-DD--HH-MM` timestamp.
2. Flip the phase's status in the parent plan to `✓ shipped — see log
   YYYY-MM-DD--HH-MM`.
3. Refresh `updated_by` and `updated_at` in the frontmatter.
4. Commit with `feat(octmux): Phase N — <short title>`.

---

## Implementation log (reverse chronological — newest at top)

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
- `src/renderer/tmux-pane.ts` — added `_sessionLabel` field; implemented rename to update pane titles.
- `src/commands.ts` (new) — consolidated command parsers: `parseShowCommand` (moved from visibility.ts), `parseExitCommand`, `parseRenameCommand`, `parseModelCommand`.
- `src/renderer/visibility.ts` — removed `parseShowCommand` function (moved to commands.ts).
- `src/app.tsx` — rewired command dispatch in `handleSubmit`; added `sessionLabel` and `activeModel` state; updated import to use new `src/commands.ts` module; /model list shows current + available models from connected providers with context window sizes; /model set accepts `<providerID>/<modelID>` syntax and applies to next prompt.

**Design notes:**
- `/rename` updates the session title in the DB (via `client.session.update`) and renames tmux windows/panes via `renderer.rename()` immediately.
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
