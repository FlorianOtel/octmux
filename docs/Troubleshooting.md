---
title: "octmux — Troubleshooting Guide"
created_at: 2026-05-19--17-46
created_by: Claude Code (claude-code-kimi-k2.7)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-05-20--10-45
context: >
  This document collects runtime errors, warnings, and edge cases encountered
  while running octmux against the opencode server. Each entry includes the
  observed symptom, root-cause analysis, whether the issue is inside octmux or
  the upstream opencode binary, and any available workarounds. Entries are
  appended in reverse chronological order (newest first).
---

# Troubleshooting Guide

## 2026-05-20--10-45 — Ink 5 key-event delivery quirks — keybinding workarounds

### Symptom

After `<PromptInput>` was first wired in (Stage 3E.2), three categories of
keybindings failed silently:

- **Backspace did nothing.** Pressing the physical Backspace key had no effect
  on the buffer.
- **Alt-Enter did nothing.** Intended to insert a literal newline for multi-line
  input; pressing Alt-Enter was ignored.
- **Emacs-style bindings (Ctrl-A, Ctrl-E, Ctrl-K, etc.) did nothing.** Worse,
  certain Ctrl-letter combos (e.g. Ctrl-A) caused the letter itself ("a") to be
  inserted into the buffer instead.

### Root cause — three distinct Ink 5 quirks

The bugs were diagnosed by reading the Ink 5 source directly:
`node_modules/ink/build/parse-keypress.js` and
`node_modules/ink/build/use-input.js`.

#### QUIRK 1 — `\x7f` (physical Backspace) maps to `key.delete`, not `key.backspace`

Modern terminals (xterm, kitty, alacritty, macOS Terminal, tmux) send `\x7f`
(DEL, char 127) when the user presses the physical Backspace key.
`parse-keypress.js` maps `\x7f` → `key.name = 'delete'`, setting
`key.delete = true`. The older `\x08` byte (BS, char 8 / Ctrl-H) maps to
`key.backspace = true`.

The Ink 5 source acknowledges this with an inline TODO:
> "TODO: enquirer detects delete key as backspace, but I had to split them up
> to avoid breaking changes in Ink. Merge them back together in the next major
> version."

```
Wrong check:   if (key.backspace)              — never fires on modern terminals
Correct check: if (key.backspace || key.delete) — covers both \x08 and \x7f
```

#### QUIRK 2 — Alt-Enter does NOT set `key.return` or `key.meta`

Alt-Enter sends the byte sequence `\x1b\r` (ESC + CR). Ink's `metaKeyCodeRe`
only matches `\x1b` followed by a single alphanumeric character, so `\x1b\r`
falls through all specific cases: `key.return = false`, `key.meta = false`.
`use-input.js` then strips the leading ESC, leaving `input = '\r'` with no
flags set.

```
Wrong check:   if (key.return && key.meta)       — never fires for Alt-Enter
Correct check: else if (input === '\r' || input === '\n')
               — placed *after* the key.return branch for plain Enter
```

#### QUIRK 3 — Ctrl-letter is delivered as `(key.ctrl = true, input = "<letter>")`

When the user presses Ctrl-A the terminal sends `\x01`. `parse-keypress.js`
(lines 178-181) converts single-byte control characters (`<= '\x1a'`) into
their letter: `key.name = String.fromCharCode(charCode + 'a'.charCodeAt(0) - 1)`,
`key.ctrl = true`. `use-input.js` sets `input = keypress.name` — the letter
string, not the raw byte.

```
Wrong check:   input === '\x01'        — never matches in Ink 5
Correct check: key.ctrl && input === "a"   (and equivalently for all others)
```

A related consequence: without a `!key.ctrl && !key.meta` guard on the
printable-character catch-all, any unhandled Ctrl/Meta combo falls through and
inserts its letter into the buffer.

### Fix

All keybindings were extracted to `src/keybindings.ts`, which exports a single
`handleKey(input, key, editor, lastEscTime)` function. Each of the three quirks
is documented at the top of the file with the exact byte sequences, Ink 5 source
line references, and correct check patterns. `PromptInput.tsx` is now a thin
wrapper that calls `handleKey` from its `useInput` handler.

### Why this workaround is future-proof

The fix is isolated to a single file (`src/keybindings.ts`). When Ink 6 merges
`key.delete` and `key.backspace` as its source TODO promises, or if
Alt-Enter detection is fixed, only the corresponding `else if` branch in
`keybindings.ts` needs updating — no other file changes required. The inline
comments cite Ink 5 source locations and include the raw byte sequences, so the
change is self-documenting even without access to the original investigation.

---

## 2026-05-19--17-46 — MaxListenersExceededWarning from opencode server

### Symptom

The opencode server stderr prints a `MaxListenersExceededWarning` shortly after
startup:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:4096

MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 event listeners added to [cI]. MaxListeners is undefined. Use events.setMaxListeners() to increase limit
 emitter: cI {
  _events: [Object ...],
  _eventsCount: 1,
  _maxListeners: undefined,
  [Symbol(kCapture)]: false,
  ...
}
```

### Root cause

The warning originates **inside the compiled opencode binary**, not in octmux
code. Evidence:

- Stack-trace frames point to `/$bunfs/root/chunk-658twvfx.js` — a Bun
  `--compile` artifact, not octmux's `src/` tree.
- `~effect/Effect/evaluate` and `runTasks` indicate the leak is in opencode's
  internal Effect-TS event-stream plumbing.

The `_eventsCount: 1` (single event type) with a listener count of 11 suggests an
opencode internal stream repeatedly adds listeners and fails to remove previous
ones. Octmux opens a **persistent SSE stream** via `client.global.event({})`
(`src/index.ts:129`), which likely triggers the leaky path in opencode's SSE
handler.

### Impact

At 11 listeners this is still a warning, not a fatal error. For short REPL
sessions the leak is negligible. On long-running sessions the listener count
could grow, increasing memory pressure.

### Proposed workaround

Suppress the warning server-side by passing `NODE_NO_WARNINGS=1` in the spawn
environment (`src/server-lifecycle.ts`):

```ts
const proc = Bun.spawn([bin, "serve", "--port", String(port)], {
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
```

### Upstream fix

Report to opencode with:
- Full stack trace (as shown above).
- opencode version (`opencode --version`).
- Reproduction: "Connect any client that opens `client.global.event({})` and
  observe `MaxListenersExceededWarning` after a few events."

The proper fix is for opencode to either:
1. Call `.setMaxListeners(n)` with a higher limit on its internal `EventTarget`,
   or
2. Dispose / remove listeners when an SSE event is fully consumed, preventing
the accumulation.
