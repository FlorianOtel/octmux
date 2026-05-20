# octmux

Text-only TUI REPL for [opencode](https://opencode.ai), built to mimic the Claude Code CLI feel. Runs inside tmux, communicates with an opencode server via HTTP.

## Usage

```
octmux                    auto-spawn opencode server, enter REPL
octmux --attach <port>    attach to a running server on <port>
octmux --help             show this help
octmux --version          show version

Flags:
  --no-tmux-guard         allow running outside tmux (scripts / CI)
```

## Architecture

octmux uses [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) for layout. The screen is split into two regions:

- **Scrollback (above):** a `<Static>` Ink region that accumulates past turns. Once committed, entries never re-render — the terminal's native scrollback holds them.
- **Input area (below):** a dynamic Ink region always anchored at the bottom. Contains a session-label rule, the multi-line prompt, a bottom rule, and a status line. The layout is pure flexbox; bottom-anchoring is automatic via Ink's Static/dynamic split.

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

```
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
