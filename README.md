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
  --config <path>         octmux config file (default: ~/.config/octmux/octmux.json)
```

`--multi-window` and `--multi-pane` are mutually exclusive. Both require an actual tmux pane (stale-env inherited terminals are detected and rejected).

## Configuration

octmux reads an optional config file at `~/.config/octmux/octmux.json`. Pass `--config <path>` to read a different file.

- The default file is optional. If it does not exist, octmux runs without it.
- A file named by `--config` must exist. If it is missing, octmux exits 1.
- `--config` without a path exits 2.
- The format is JSONC: `//` and `/* */` comments and trailing commas are allowed.
- A working example is in `config/octmux.example.json`.

### Keys

Any key not listed here is an error, so a typo such as `passwrod` fails at startup.

| Key | Type | Effect |
|---|---|---|
| `$schema` | string | Editor hint. Accepted and not used. |
| `server.url` | string | Server endpoint. Used when `--endpoint` is not given. |
| `server.password` | string | Basic-auth password. The username is always `opencode`. |
| `server.directory` | string | Directory path as the server sees it, used as the session location instead of octmux's working directory. Must be absolute. See "Server directory" below. |

### Server directory

Set `server.directory` when the OpenCode server runs on another host, or in a container with different paths. octmux then sends that path to the server as the session location, in place of its own working directory.

- Unset: octmux uses its local working directory, as before.
- Set: the value is the path on the server's side. octmux does not check that it exists on the server, and it is never compared with the local filesystem.
- Must be an absolute path: it starts with `/`, or with a Windows drive letter followed by `\` or `/`. A relative path exits 1 and names the config file and the key.
- Supports the same `{env:NAME}` and `{file:PATH}` tokens as the other `server.*` keys. The value is not a secret, so a `{file:}` file does not need to be chmod 600.
- Cannot be combined with `--worktree`. A worktree is created on the local machine, which the server cannot see, so octmux exits 2 and names the config file.
- Cannot be combined with `--auto-spawn`. The spawned server is local, so octmux exits 2 and names the config file.
- `--resume`, `--resume-last`, and `--fork` still use the resolved session's own directory, as they do without this key.
- When set, octmux prints `octmux: using server directory <dir> (from <config path>)` at startup.
- Local-only things still use the local working directory: the git branch in the status line, and on v1 the orchestra session files. The project name in the status line is the basename of `server.directory`. Slash-completion names come from the server's command list.

### Substitution

`server.url`, `server.password`, and `server.directory` accept these tokens. Tokens are expanded only in parsed values, so text inside comments is ignored.

- `{env:NAME}` is replaced by the value of environment variable `NAME`. If the variable is unset or empty, octmux exits 1.
- `{file:PATH}` is replaced by the file's contents, with surrounding whitespace trimmed.
  - A leading `~/` expands to your home directory.
  - Other relative paths resolve against the directory that holds the config file, not the working directory.
  - A missing or unreadable file exits 1. The error names the resolved path.

### Fail-loud rules

Each of these exits 1 and names the config file:

- malformed JSON, or a root value that is not an object
- an unknown key, such as `server.passwrod`
- a value that is not a string
- an unset or empty `{env:NAME}` variable
- a missing or unreadable `{file:PATH}` file
- a `server.directory` that is not an absolute path after substitution
- a password that resolves to an empty string

### File permissions

Secret files must be private to their owner. Permission checks run before any secret file is read.

- A literal password (any text outside a token) is stored in the config file, so the config file must have no group or other permission bits.
- Each `{file:PATH}` file must have no group or other permission bits.
- A password built only from `{env:NAME}` tokens stores nothing on disk, so no file check applies.

A failing check prints the file and the fix, for example:

```
chmod 600 ~/.config/octmux/octmux.json
```

### Precedence

- Endpoint: `--endpoint <url>` beats `server.url`, which beats the default `http://127.0.0.1:4096`.
- Password: only `server.password` supplies it. There is no flag for it.
- Session directory: `server.directory` (when set) replaces the local working directory as the location sent to the server.
- `--auto-spawn` ignores `server.url` and skips protocol detection.

### Authentication

Every request to the server carries an HTTP Basic `Authorization` header built from `opencode` and `server.password`. The password is never printed. Endpoint URLs in messages have any username and password removed.

### Protocol detection

Unless `--auto-spawn` is given, octmux probes the endpoint at startup. Each probe times out after 3 seconds.

1. `GET /api/info` identifies a v2 server. A JSON 200 response with a `version` field means v2 and authorized. A JSON 401 response with `_tag: UnauthorizedError` means v2 and a password is required.
2. If step 1 is inconclusive, `GET /global/health` identifies a v1 server. A JSON 200 response means v1. Any 401 response means v1 and a password is required.
3. If neither probe identifies a server, the endpoint is unreachable.

A 200 response with `text/html` is never taken as identification, because both server versions serve a web page for unknown paths. A network error on step 1 ends detection at once.

| Detected | Behaviour | Exit |
|---|---|---|
| v1 | Prints a `⚠ octmux: OpenCode v1 server detected …` warning, then runs the v1 client. | continues |
| v1 or v2, 401, no password configured | Names `server.password` and the config path. | 1 |
| v1 or v2, 401, password rejected | Names the config path and `server.password`. Does not print the password. | 1 |
| v2, authorized | Prints a version-gate message if one applies. A different MAJOR version refuses (see Version gate). Prints `octmux: using server directory <dir> (from <path>)` when `server.directory` is set. Then runs the native v2 client. | continues; 1 on a MAJOR mismatch |
| Unreachable | Prints the "no opencode server" hint. For `--endpoint` it prints the shorter `health: failed` form. | 1 |

A v2 server is supported natively, with the same features as v1. The optional `server.directory` config key names the server-side directory that new sessions use. It must be absolute, and `--worktree` and `--auto-spawn` are refused with it (exit 2). octmux reads no OpenCode server files on v2: the orchestra badge comes from the harness session's `metadata.orchestra`, which oconona publishes, and works with a remote server. On v1 (legacy) the badge reads oconona's files and needs the server on the same host. `--auto-spawn` starts a local server and skips detection, so it always runs the v1 client. `--worktree` creates its worktree on the octmux host, so it suits a server on the same host.

### Version gate

The gate compares the server's MAJOR and MINOR version with the bundled client, `@opencode/client` 2.0.28. PATCH is ignored.

| Result | Message |
|---|---|
| Different MAJOR | Refuses with `… major version differs from bundled client … — refusing`. Exit 1. |
| Server has a newer MINOR | Prints `… is newer than the bundled client … (same major version)`. |
| Server has an older MINOR | Warns that some requests may be rejected. |
| Version cannot be parsed | Warns that the versions could not be compared. |
| Exact MINOR match | Prints nothing extra. |

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

**Note:** opentmux integration is not part of Stage 3-UX and is not the immediately-following work. Stage 4 (StatusLine content) and Stage 5 (subagent windows) come first. Future work targets `TmuxWindowRenderer`; pane mode is preserved but not actively developed further.

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
