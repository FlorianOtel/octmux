---
title: "Stage 7 — Native opencode /rag command + discovery and forwarding"
created_at: 2026-05-26--18-41
created_by: Claude Code (Claude Haiku 4.5)
updated_by: Claude Code (Claude Sonnet 4.6)
updated_at: 2026-06-02--21-23
context: >
  Stage 6 shipped a broken client-side TypeScript `/rag` implementation that suffered
  from a hardcoded 0.45 score-filter strangling all hits and architectural mismatch
  (client-side RAG state vs LLM-mediated mode tracking). Stage 7 rips it out entirely,
  replaces it with a native opencode markdown command installed at ~/.config/opencode/commands/rag.md,
  adds a one-shot discovery layer via client.command.list() at startup, merges discovered
  commands into /help and slash-completion, and forwards any unrecognised /cmd to opencode
  via session.command(). This eliminates per-command TypeScript plumbing for future markdown
  commands and unifies all RAG output under the existing tools gate.
---

## Read first

### Architecture: opencode-native commands with discovery and forwarding

**Stage 7 removes all client-side `/rag` command handling.** RAG (and all future opencode markdown commands) now live as native markdown files in `~/.config/opencode/commands/`. The systemd service (`opencode-server`) scans this directory at startup and serves metadata via `GET /command`.

The octmux harness:

1. **One-shot discovery at app mount:** Call `client.command.list()` → fetch all available commands + descriptions.
2. **Merge into /help and slash-completion:** Show both TS-internal commands (exit, rename, model, show, /<key>-output, help) and opencode commands (rag, init, review, ...).
3. **Forward unrecognised /cmd:** If a `/cmd` matches an opencode command name, forward it via `session.command({ command: cmdName, arguments: args, model: activeModel })`.
4. **No TS per-command plumbing:** New markdown commands (search helpers, audit tools, etc.) need only a file in opencode's commands dir — no octmux code changes.

### RAG output routing (Stage 7)

| Role | OUTPUT_KEY | Gate | --single mode | --multi-window mode |
|---|---|---|---|---|
| tool-call (bash curl) | tools | /tools-output | inline in main pane (cyan ▶) | <label>--tools side window |
| tool-result (JSON response) | tools | /tools-output | inline in main pane (dim ▷) | <label>--tools side window |
| text (LLM synthesis) | (none — main) | always shown | main pane | main pane |

**Key implications:**
- `/tools-output off` hides RAG bash output (via /rag search, /rag on auto-search, /rag only).
- `/thinking-output off` does NOT affect RAG — RAG uses bash tool, not reasoning blocks.
- No new `rag`-specific gate or window — `tools` infrastructure covers RAG for free.
- LLM's final synthesized answer (formatted hits, citations, "no docs found") always renders as text in main pane.

### How `/rag` modes work (LLM-mediated, not enforced)

The file `~/.config/opencode/commands/rag.md` contains instructions for four modes: `search`, `on`, `off`, `only`.

1. `/rag search <query>` — LLM runs `curl http://192.168.1.93:8000/v1/rag/search?q=...` and renders results.
2. `/rag on` — LLM reads the instruction block and interprets it as "auto-search before each answer for this session."
3. `/rag off` — LLM reads the instruction block and stops auto-searching.
4. `/rag only` — LLM reads the instruction block and answers exclusively from retrieved docs.

**Modes are enforced by the LLM's in-context interpretation of rag.md, not by harness state.** The LLM may forget to auto-search over very long contexts (same as CC's behavior). This matches CC's reliability model and is acceptable.

### Systemd restart (one-time, Stage 7 only)

The opencode-server systemd service must be restarted after `~/.config/opencode/commands/rag.md` is installed, so the server's command scan picks it up. This kills any active opencode sessions — do this in a quiescent moment.

### Command discovery (built-in + user-installed)

`client.command.list()` returns all available commands, including:
- Built-in opencode commands: `init`, `review`, `customize-opencode`, etc.
- User-installed commands: `rag.md`, and any others in `~/.config/opencode/commands/`.

All discovered commands appear in `/help` under a separate `"opencode commands:"` section, and in slash-completion overlay.

### Type safety: Command import

```ts
import type { Command as OcCommand } from "@opencode-ai/sdk/client";
```

Only `name` and `description` fields are used for display. The live `GET /command` response includes extra fields (`source`, `hints`) not in the type — they're irrelevant for octmux and require no casting.

### Operator verification checklist

1. **Build succeeds:** `bun build src/index.tsx --compile --target bun-linux-x64 --outfile dist/octmux` → zero TypeScript errors.
2. **systemd unit active:** `systemctl --user is-active opencode-server` → "active".
3. **rag command served:** `curl -s http://localhost:4096/command | python3 -m json.tool` → includes `{"name":"rag",...}`.
4. **/help shows two sections:** Run octmux, type `/help` → output shows "octmux commands:" (exit, rename, model, show, /<key>-output, help) and "opencode commands:" (rag, init, review, ...).
5. **Slash completion:** Type `/r` in octmux → overlay shows `/rag` and `/rename`.
6. **Execute `/rag search <query>`:** LLM invokes bash curl and renders tool-call/tool-result blocks (inline in --single, in <label>--tools window in --multi-window). Final answer in main pane as text.
7. **Execute `/rag on` mode:** LLM acknowledges mode; on follow-up questions, LLM auto-invokes bash before answering.
8. **Execute `/rag off` mode:** LLM acknowledges and stops auto-searching.
9. **Gate coverage:** `/tools-output off` hides RAG bash output; confirms RAG uses tools gate, not rag gate.
10. **SSE parity:** Verify streaming appears — `session.command()` fires the same SSE events as `promptAsync`.
11. **Unknown command:** Type `/nonexistent hello` → reaches promptAsync as plain text, LLM responds "I don't know that command."
12. **Invalid gate:** Type `/rag-output on` → returns `unknown output key "rag" — available: thinking, tools`.
13. **No ragMode chip:** StatusLine shows no `| rag:on` or similar under any condition.

---

## Implementation log

### 2026-05-26--18-41 — Stage 7 implementation
**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-26--18-41
**Commit(s):** `eef35de`

**Summary of changes:**
- **File system:** Installed `~/.config/opencode/commands/rag.md` (copy of `~/.claude/commands/rag.md`). Restarted systemd `opencode-server` unit; verified rag command present in `GET /command` response.
- **src/blocks.ts:** Removed `"rag"` from Role union; removed `case "rag":` from formatLine().
- **src/renderer/output-keys.ts:** Removed `rag: "rag"` entry; RAG output now routes to tools gate.
- **src/commands.ts:** Deleted `parseRagCommand` export; updated `parseHelpCommand` signature to accept optional `opencodeCommands` Map and output two sections.
- **src/command-registry.ts:** Removed `/rag` CommandSpec entry; extended `expandCommands(extraCandidates?)` to accept and push opencode command names.
- **src/app.tsx (major rip-out):**
  - Removed imports: `{ searchRag, formatBlockText, formatPromptPrefix, type RagHit }` from "./rag.ts"; `parseRagCommand` from "./commands.ts"; `{ randomUUID }` from "node:crypto".
  - Removed state: `ragMode`.
  - Removed function: `emitRagBlock`.
  - Added state: `opencodeCommands: Map<string, OcCommand>`.
  - Added useEffect for one-shot discovery via `client.command.list()`.
  - Updated slash-completion effect to pass opencode commands to `expandCommands()`.
  - Updated /help handler to pass `opencodeCommands` to `parseHelpCommand`.
  - Replaced /rag handler + auto-search interception with opencode command forwarding via `session.command()`.
  - Removed ragMode from StatusLine props and useCallback deps; added opencodeCommands to deps.
- **src/components/StatusLine.tsx:** Removed `ragMode` prop; removed `{ragMode && <Text color="magenta">…</Text>}` JSX.
- **src/rag.ts:** File deleted (no remaining importers after Step 7).

**Verification:**
- Binary rebuild: zero TypeScript errors.
- opencode-server active after systemd restart.
- rag command present in discovery response.
- /help output shows two sections.
- Slash completion includes /rag and /rename.
- /rag search, /rag on, /rag off, /rag only modes work via LLM interpretation of rag.md.
- /tools-output gate covers RAG bash output.
- Unknown /cmd falls through to promptAsync as plain text.
- /rag-output on returns "unknown output key" error (rag gate no longer exists).

### 2026-05-26--22-30 — Stage 7.1: warn on tool_call=false for forwarded commands
**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-26--22-30
**Commit(s):** `3cc4910`

**Context:** A `/rag search` invocation against the default `sohoai/glm-5.1` model
(declared `tool_call: false` in `~/.config/opencode/opencode.json`) caused the
LLM to write a permanent Python script `~/.opencode/rag.py` instead of running
the documented `curl` once. Root cause is model-side: `tool_call: false` models
cannot emit structured tool calls and improvise via opencode's text-mode tool
dispatcher. `rag.md` is byte-identical between `~/.claude/commands/` and
`~/.config/opencode/commands/`; octmux is a literal passthrough for forwarded
commands. Same flow with a `tool_call: true` model (Claude, Kimi K2.6, etc.)
executes a single curl.

**Change:** Add a one-line yellow warning to the transcript when a forwarded
slash-command is dispatched against a model declared `tool_call: false`. Applies
to **all** opencode commands (not /rag-specific). Does not block dispatch.

**Files:**
- `src/utils/formatters.ts` — new helper `getToolCallSupport(client, providerID, modelID)`
  mirrors `getContextWindow` (two-pass provider/model match against
  `client.provider.list()`, own `Map` cache, swallows errors). Returns
  `true | false | undefined`. `undefined` is cached so we don't refetch.
- `src/app.tsx` — in the `if (opencodeCommands.has(cmdName))` branch, before
  `client.session.command(...)`, look up tool_call support for `activeModel`
  and emit `⚠ <modelID> has tool_call=false — /<cmd> output may be unreliable …`
  via `renderer.commitSystemMessage` if explicitly false. Default-send path
  (line 423+) is intentionally not gated; plain prompts are the user's
  explicit choice.

**Caveat:** Warning trusts the `tool_call` field as declared in
`opencode.json` / provider metadata. If the field is misconfigured, the
warning won't fire and the underlying model misbehavior recurs silently.

**Verification:**
- Binary rebuild succeeded.
- Pre-existing tsc errors in `app.tsx`, `commands.ts`, `events.ts` unrelated
  to this change (SDK type drift).
- Manual test: invoke `/rag search test` against a `tool_call:false` model →
  yellow warning prints, dispatch proceeds. Switch to a `tool_call:true`
  model → no warning. Plain prompts → no warning regardless.

---

### 2026-06-02--21-23 — Stage 7.2: slash autocomplete UX fixes
**Implemented by:** Claude Code (Claude Sonnet 4.6) — 2026-06-02--21-23
**Commit(s):** `274a1b4`

Fixed three autocomplete UX bugs in `recompute()` (`src/app.tsx`):

1. **TAB selected wrong command** — `/brain-abandon` was winning over `/brain` on TAB because `expandCommands()` returns external `.md` commands in filesystem inode order (not alphabetical). Fixed by sorting filtered candidates before passing to state: exact token match pinned first, then `localeCompare` alphabetical.

2. **SPACE didn't dismiss the overlay** — the dismiss condition required exactly one candidate matching the token. For `/brain ` there are two candidates, so the overlay stayed open. Fixed by dismissing unconditionally on any space in the buffer.

3. **Wrong item highlighted after `/brain<SPACE>`** — consequence of bug 2; resolved automatically.
