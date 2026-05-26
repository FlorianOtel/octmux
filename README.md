# octmux

Text-only TUI REPL for [opencode](https://opencode.ai), built to mimic the Claude Code CLI feel. Runs inside tmux, communicates with an opencode server via HTTP.

## Usage

```
octmux                    auto-spawn opencode server, enter REPL
octmux --attach <port>    attach to a running server on <port>
octmux --multi-window     split into tmux windows (thinking + tools; recommended)
octmux --multi-pane       split into tmux panes (thinking + tools; wide-terminal mode)
octmux --help             show this help
octmux --version          show version

Flags:
  --no-tmux-guard         allow running outside tmux (scripts / CI)
```

`--multi-window` and `--multi-pane` are mutually exclusive. Both require an actual tmux pane (stale-env inherited terminals are detected and rejected).

## Output architecture

octmux routes every piece of streamed content through a typed **Block model** with a `Role`:

| Role | Content | ANSI prefix |
|---|---|---|
| `text` | main LLM response | (none) |
| `thinking` | reasoning blocks | `│ ` dim grey |
| `tool-call` | tool invocation input | `⚙ ` cyan |
| `tool-result` | tool output | `↳ ` dim |
| `user` | your submitted prompt | `> ` inverted |
| `error` | errors | `[error] ` red |

A **`Renderer` interface** decouples `<App>` from the output backend. Three backends ship:

| Backend | Flag | Description |
|---|---|---|
| `StdoutRenderer` | (default) | Writes all roles to the single REPL pane via `<Static>` scrollback |
| `TmuxWindowRenderer` | `--multi-window` | Spawns tmux windows lazily on first block per role group |
| `TmuxPaneRenderer` | `--multi-pane` | Spawns 2 tmux panes eagerly at startup |

Both multiplex backends consolidate `tool-call` and `tool-result` into a single **`tools`** sink — the full call→result sequence appears in one scrollback buffer.

## Slash commands

| Command | Effect |
|---|---|
| `/show` | Show current visibility state for all roles |
| `/show thinking off` | Suppress thinking blocks (hidden count shown in status line) |
| `/show thinking on` | Resume showing thinking blocks |
| `/show tools off` | Suppress tool-call and tool-result blocks |
| `/show tools on` | Resume showing tool blocks |

Hidden blocks are counted but not rendered. The StatusLine shows `hidden: T·N` / `⚙·N` badges while roles are suppressed. Toggling back on does not back-fill already-hidden content.

## Multiplex modes

### Choosing between `--multi-window` and `--multi-pane`

**`--multi-window` (recommended for most workflows):**
- Works on any terminal width — 80-column SSH sessions and wide local terminals alike
- Native click-drag text selection in each window (no copy-mode needed)
- Independent scrollback per role — scroll thinking without losing tool output
- Windows spawn lazily: a session with no tool calls gets no tools window
- Activity indicators in the tmux status line when a non-focused window has new output (with `monitor-activity on`)

**`--multi-pane` (for wide local terminals):**
- All streams visible simultaneously — watch thinking arrive while reading the response
- Panes spawn eagerly at startup regardless of whether those roles produce output
- Requires more terminal width to be readable; impractical on narrow TTYs
- Text selection requires Shift+drag or copy-mode to scope within one pane

### Window layout (`--multi-window`)

Three tmux windows after a session with thinking and tool calls:
```
window 0: <session>            (origin — renamed to opencode session label at startup)
window 1: <session>--thinking  (spawned on first thinking block)
window 2: <session>--tools     (spawned on first tool-call or tool-result block)
```
Navigate with `prefix n`/`prefix p`, `prefix <number>`, or `prefix w` for the list.

### Pane layout (`--multi-pane`)

```
┌──────────────┬───────────┐
│              │ thinking  │
│  main        ├───────────┤
│  (chrome)    │  tools    │
└──────────────┴───────────┘
```

### tmux configuration for `--multi-window`

No configuration required. Optionally add to `~/.tmux.conf` for activity indicators:

```tmux
set -g monitor-activity on
set -g visual-activity off
```

Reload with `tmux source-file ~/.tmux.conf`.

### tmux configuration for `--multi-pane`

No configuration required. For per-pane title bars (recommended):

```tmux
set -g pane-border-status top
set -g pane-border-format " #[fg=cyan,bold]#{pane_title}#[default] "
set -g pane-active-border-style "fg=cyan"
set -g pane-border-style "fg=brightblack"
set -g pane-border-lines heavy
```

Reload with `tmux source-file ~/.tmux.conf`.

### Log file cleanup

On a crash, log files may be left in `/tmp`. Clean up with:
```
rm /tmp/octmux-*.log
```

## Integration with opentmux

octmux establishes a contract for external consumers (e.g. opentmux):

| Primitive | Details |
|---|---|
| Log file path | `/tmp/octmux-${pid}-${sinkKey}.log` (`thinking` or `tools`) |
| Window name | `<session>--thinking`, `<session>--tools` (window mode) |
| Pane title | `thinking`, `tools` via `select-pane -T` (pane mode) |

opentmux can integrate in two modes: (A) take over spawning — octmux creates log files and announces them; opentmux creates panes/windows with its own geometry; (B) take over consumption — octmux spawns panes/windows as normal; opentmux re-skins them from outside. Mode B requires no octmux changes. See `docs/Version3-UX.md` §"Sequencing toward opentmux integration" for full details.

**Note:** opentmux integration is not part of Version 3-UX and is not the immediately-following work. Version 4 (StatusLine content) and Version 5 (subagent windows) come first. Future work targets `TmuxWindowRenderer`; pane mode is preserved but not actively developed further.

## Architecture

octmux uses [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) strictly for the interactive chrome — input editor, rules, status line, and modals. tmux owns all multi-pane/multi-window layout. The screen is split into:

- **Scrollback (above):** a `<Static>` Ink region that accumulates past turns. Committed entries never re-render — the terminal's native scrollback holds them.
- **Input area (below):** a dynamic Ink region anchored at the bottom. Contains a session-label rule, the multi-line prompt, a bottom rule, and a status line.

The input layer is a pure `LineEditor` state machine (`src/editor.ts`) driven by Ink's `useInput` hook. All key dispatch lives in `src/keybindings.ts`.

## Key bindings

| Key | Action |
|-----|--------|
| **Enter** | Submit prompt (on last line of buffer) |
| **Alt-Enter** | Insert newline (multi-line input) |
| **Up / Down arrow** | Move cursor within multi-line buffer; navigate history at row boundary |
| **Mouse wheel** | Navigate history (maps to Up/Down via alternate scroll mode) |
| **Ctrl-A / Ctrl-E** | Move to line start / end |
| **Ctrl-B / Ctrl-F** | Move backward / forward one character |
| **Alt-B / Alt-F** | Move backward / forward one word |
| **Ctrl-P / Ctrl-N** | History previous / next |
| **Ctrl-K** | Kill to end of line |
| **Ctrl-U** | Kill to start of line |
| **Ctrl-W** | Kill word backward |
| **Alt-D** | Kill word forward |
| **Ctrl-Y** | Yank (paste last kill) |
| **Backspace** | Delete character before cursor |
| **Ctrl-D** | Delete character forward (or EOF on empty buffer) |
| **Esc Esc** | Clear entire buffer (double-press within 500 ms) |
| **Ctrl-C** | While generating: abort + restore last prompt. While idle with text: clear buffer. While idle and empty: double-press to exit. |

## tmux configuration

For full UX (bracketed paste, extended keys, mouse wheel), add to `~/.tmux.conf`:

```tmux
set -g mouse on
set -g extended-keys on
set -ga terminal-features ",*:extkeys"
```

Then reload with `tmux source-file ~/.tmux.conf`.

Mouse wheel scroll maps to Up/Down arrow keys via `DECSET 1007` (alternate scroll mode). Text selection still works normally — hold nothing, just click and drag.

## Requirements

- [Bun](https://bun.sh) runtime
- tmux (required at runtime; bypass with `--no-tmux-guard`)
- opencode server (auto-spawned or via `--attach`)
