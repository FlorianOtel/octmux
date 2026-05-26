---
title: "octmux — Phase 6 implementation log"
created_at: 2026-05-26--14-12
created_by: Claude Code (Claude Haiku 4.5)
updated_by: Claude Code (Claude Opus 4.7)
updated_at: 2026-05-26--17-47
context: >
  Implementation log for Phase 6 of octmux: /rag slash command with four modes
  (search, on, off, only), RAG context retrieval from SoHoAI knowledge base,
  auto-search interception on prompts when rag mode is active, single-fetch
  refactor for efficiency, streamed rag block rendering, and StatusLine chip
  display showing active rag mode. Hotfix 6.1: suppress the slash-completion
  overlay during history navigation so ↑/↓ keep scrolling past entries instead
  of being captured by the popup when a past entry begins with "/".
---

# Phase 6: /rag slash command with search/on/off/only modes and auto-search interception

## Read first when expanding on this work

This section documents the RAG (Retrieval-Augmented Generation) feature design
and integration points for anyone who needs to:
- Add new RAG modes or modify the search/filtering behavior.
- Change the RAG server URL, credentials, or parameters.
- Integrate new block types using the same pattern as `Role: "rag"`.
- Understand the single-fetch refactor that powers auto-search efficiency.

### The RAG feature model

RAG in octmux is implemented as:

1. **New Role type:** `Role` union extended to include `"rag"`. Like `"thinking"`
   and `"tool-call"`, RAG is a first-class streamed block role, automatically
   wired to the output-gate system and side-window rendering in `--multi-window`
   mode (see `src/renderer/output-keys.ts` CONTRACT for the pure-gate semantics).

2. **Four operational modes:** `/rag off` (default), `/rag on` (auto-search
   before each prompt), `/rag only` (answer ONLY from retrieved documents,
   skip forwarding if no relevant hits), `/rag search <query>` (standalone
   search without mode change). Mode state is held in `ragMode: "on" | "only" | null`.

3. **Single-fetch architecture:** The `emitRagBlock(query)` helper in `app.tsx`
   returns `Promise<RagHit[] | null>`. When the operator submits a prompt and
   `ragMode !== null`, the auto-search interception calls `emitRagBlock(text)`
   once, captures the returned hits, and reuses them for:
   - Rendering the block via `formatBlockText(hits)`.
   - Building the prompt prefix via `formatPromptPrefix(hits, ragMode)`.
   - Checking "only" mode threshold logic.

   This avoids a second network call; the block already carries the data.

4. **Filtering by score threshold:** `formatPromptPrefix` filters hits with
   `score >= RAG_SCORE_THRESHOLD` (0.45) before building the context preamble.
   If zero hits pass the threshold in "only" mode, the prompt is not forwarded
   (user sees "no relevant documents found" system message). In "on" mode,
   the prompt is forwarded even if preamble is empty.

5. **Block integration:** RAG blocks are rendered with magenta ANSI colour,
   prefix `▽ ` on first line and `  ` on continuation lines (matching
   `tool-call`/`tool-result` style). They live in the `<label>--rag` side
   window in `--multi-window` mode, or inline in `--single` mode. The
   `rag: "rag"` entry in `OUTPUT_KEYS` auto-wires `/rag-output [on|off]`
   and `/show` listing.

6. **StatusLine chip:** When `ragMode` is non-null, the status bar shows
   a magenta chip `| rag:on ` or `| rag:only ` between cost (`~$0.00`)
   and project name. Chip is absent when `ragMode` is null.

### Adding a new RAG mode

To add a new mode (e.g., `/rag combined <weight>` for weighted reranking):

1. Extend `parseRagCommand` in `src/commands.ts` to match the new pattern and
   return the new action name.
2. Add a new dispatch case in `handleSubmit` for the action.
3. Update `ragMode` type if it needs to carry parameters (currently `"on" | "only"`
   are flags; if "combined" carries weight, change to
   `ragMode: { mode: "on" | "only" | "combined"; weight?: number } | null`
   and adjust comparisons in `if (ragMode !== null)` blocks).
4. Register the new command in `src/command-registry.ts` with correct usage
   and dynamic candidates.

### Changing RAG server or parameters

RAG server config lives in `src/rag.ts`:
- `RAG_URL`: HTTP endpoint for search.
- `RAG_USER`: hardcoded user (currently `florian`).
- `RAG_TOP_K`: max results per query (currently 5).
- `RAG_SCORE_THRESHOLD`: minimum score to include in preamble (currently 0.45).

Changing these requires editing the constants and rebuilding.

### Block type pattern reuse

The `Role: "rag"` pattern can be replicated for new block types:

1. **Type system:** Add the new role to `Role` union in `src/blocks.ts`.
2. **Format:** Add a case in `formatLine(role, ...)` with appropriate ANSI
   colour and prefix.
3. **Output gate:** Add `newRole: "newRole"` to `OUTPUT_KEY` in
   `src/renderer/output-keys.ts` — that single line auto-wires the toggle,
   gate status, side window, and `/show` listing. Do NOT modify
   `setOutputEnabled` in either renderer (pure-gate contract is sacrosanct).
4. **Block lifecycle:** Emit blocks using `renderer.beginBlock`, append with
   `appendToBlock`, finalize with `endBlock`. The gate automatically controls
   visibility. See Phase 4.4.3 docs in `docs/Phase4.md` for the full pattern.

---

## Implementation log (reverse chronological — newest at top)

### 2026-05-26--17-47 — hotfix: suppress slash-completion overlay during history navigation

**Implemented by:** Claude Code (Claude Opus 4.7) — 2026-05-26--17-47
**Commit(s):** `<pending>`

**What changed:**

Regression reported after Phase 6 shipped: pressing ↑ to scroll through input
history would trap the user as soon as the recalled entry began with a `/`. The
slash-completion overlay opened on the recalled `/command` text, captured
subsequent ↑/↓ keys (cycling its `selectedIdx`), and the user could not keep
scrolling. The same trap fired for any past `/<known-command>` — `/rag`,
`/model`, `/help`, `/rename`, etc.

**Root cause:** `LineEditor.histPrev/histNext` call `_loadHistory()`, which
emits `"changed"`. The slash-completion `recompute` in `app.tsx` subscribes to
that event and unconditionally re-opened the overlay when the first line
started with `/`. Once the overlay was mounted, `PromptInput.overlayOpen` was
true, and the arrow-key arms in `keybindings.ts` early-exited — so ↑/↓ no
longer reached `histPrev/histNext`. The overlay's own `useInput` then consumed
them.

**Fix:** Two files, ~10 lines net.

- `src/editor.ts`: new public getter `isInHistoryNav(): boolean` returning
  `histIdx !== -1`. The state was already tracked internally for the
  draft-save/restore logic; this just exposes it.
- `src/app.tsx`: the slash-completion `recompute` checks `editor.isInHistoryNav()`
  first; if true, it clears the overlay and returns. Once the user exits
  history nav (↓ past the last entry restores the draft, or Esc-Esc clears,
  or Enter submits — all of which reset `histIdx` to -1), the overlay resumes
  normal behavior on the next "changed" event.

The minimal-surface gate was chosen over more invasive options (e.g. resetting
`histIdx` on every edit, or tracking a `lastChangeKind` enum in LineEditor)
because the user's instruction was explicit: *"Stop auto-fill / auto-completion
when browsing through the command history."* The gate matches that semantics
exactly, with no behavior change for the typing path.

**Verification:** Build clean (`bun build`, 2.01s, zero TS errors). Manual
smoke test path (operator): `↑` from empty input to a past `/rag on` entry;
confirm overlay does NOT appear; press `↑` again and confirm the previous
history entry loads; `↓↓↓` back to present and confirm overlay re-arms when
typing `/r`.

---

### 2026-05-26--14-12 — /rag slash command (Phase 6)

**Implemented by:** Claude Code (Claude Haiku 4.5) — 2026-05-26--14-12
**Commit(s):** `3bd84cd`

**What changed:**

**New `src/rag.ts`:** Module-level constants for RAG server endpoint, user,
top-K, and score threshold. Exports `RagHit` type (rank, score, file_name,
source_path, content, optional session_title). Three core functions:

- `searchRag(query)`: Fetch helper with 30-second timeout (via AbortController).
  Builds `URLSearchParams` with query, user, top_k. Returns `{ hits: [...] }`
  on success (hits ranked 1..N by array index); `{ error: "HTTP 404" | "timeout (30s)" | ... }` on failure. Network errors and timeouts are caught and returned as error objects (no thrown exceptions).

- `formatBlockText(hits)`: Renders block content. Each hit shows rank, score
  (2 decimals), label (session_title if present, else file_name), source path,
  and first 400 chars of content (preview). Empty hits → "No results found".

- `formatPromptPrefix(hits, mode)`: Builds RAG preamble for prompt injection.
  Filters hits by `score >= 0.45`. Wraps filtered hits in `<RAG context>...</RAG context>`.
  In "only" mode, prepends instruction: "[Answer ONLY from the RAG context below; otherwise say \"No relevant documents found in the SoHoAI knowledge base.\"]".
  Returns empty string if no hits pass threshold.

**`src/commands.ts` new `parseRagCommand`:** Regex `^\/rag(?:\s+(search|on|off|only)(?:\s+([\s\S]+))?)?\s*$`.
Returns `{ handled: false }` if no match; otherwise returns `handled: true` with:
- Bare `/rag` → action: "status".
- `/rag search` (no query) → action: "search", query: undefined (app emits usage).
- `/rag search <query>` → action: "search", query: `"<query>"`.
- `/rag on|off|only` → action: corresponding mode, query: undefined.

**`src/blocks.ts` changes:** `Role` union now includes `"rag"`. New case in
`formatLine`: `case "rag": return ANSI.magenta + (isFirstLine ? "▽ " : "  ") + line + ANSI.reset;`
Magenta colour, chevron-down prefix on first line, two spaces on continuation
lines (matching `tool-call`/`tool-result` pattern).

**`src/renderer/output-keys.ts` changes:** Added `rag: "rag"` to `OUTPUT_KEY`
map (one line). This auto-wires `/rag-output [on|off]` toggle, `/show` gate
listing, completion overlay with `/rag-output on/off`, and side-window routing
in `--multi-window` mode. Pure-gate contract (Phase 4.5.1) preserved — no
renderer internals modified.

**`src/command-registry.ts` changes:** Added `/rag` command entry with usage
`"/rag <search <query> | on | off | only>"`, description `"RAG retrieval from
SoHoAI knowledge base (modes: search, on, off, only)"`, and dynamic expander
returning `["/rag search", "/rag on", "/rag off", "/rag only"]`. Positioned
between `/show` and `/<key>-output` for logical grouping.

**`src/app.tsx` changes:** Four parts:

1. **Imports:** Added `parseRagCommand` from `./commands.ts`, `searchRag`,
   `formatBlockText`, `formatPromptPrefix`, `RagHit` from `./rag.ts`, and
   `randomUUID` from `node:crypto`.

2. **State:** New `ragMode: "on" | "only" | null` hook, initialized null.

3. **Helper:** `emitRagBlock(query): Promise<RagHit[] | null>` generates a
   unique block ID (`"rag-" + randomUUID()`), calls `beginBlock`, emits
   "searching…" placeholder via first `appendToBlock` call, awaits `searchRag`,
   appends formatted results or error, calls `endBlock` with "ok"/"error" status,
   and returns the hits (or null on error). Single-fetch architecture: the
   returned hits are reused by the auto-search interception below.

4. **Dispatch block in `handleSubmit`:** New handler chain element between
   `/<key>-output` and the default `promptAsync` branch. Parses with
   `parseRagCommand`. If handled:
   - "search": Emit rag block if query present; else "usage: /rag search <query>".
   - "on"/"only": Set `ragMode`, emit system message.
   - "off": Set `ragMode` to null, emit system message.
   - "status" (default): Show current mode + usage hint.
   All rag-handler paths call `renderer.commitUserInput(text)` and return early.

5. **Auto-search interception in default branch:** When `ragMode !== null`
   (before `setLastSubmitted`):
   - Call `emitRagBlock(text)` to fetch and render rag block.
   - Call `formatPromptPrefix(hits, ragMode)` to build preamble.
   - If "only" mode AND preamble is empty: commit user input, emit "no relevant
     documents" message, return (skip `promptAsync` entirely).
   - Otherwise: prepend preamble to text (`effectiveText = preamble + "\n\n" + text`
     if preamble non-empty, else text unchanged), call `renderer.commitUserInput(text)`
     with the ORIGINAL text (rag block already shows context), and `promptAsync`
     with the EFFECTIVE text containing the preamble.
   - Both "on" and "only" modes forward the prompt to OpenCode (difference is "only"
     skips forwarding if no threshold-passing hits).
   When `ragMode === null`: standard path — commit input, call `promptAsync` with
   unmodified text.

6. **Closure fix:** Added `ragMode` to `useCallback` dependencies for `handleSubmit`.

7. **StatusLine prop:** Pass `ragMode` to `<StatusLine>` component.

**`src/components/StatusLine.tsx` changes:** Added `ragMode?: "on" | "only" | null`
to `StatusLineProps`. When `ragMode` is non-null, render an inline magenta chip
`| rag:${ragMode} ` (e.g. `| rag:on `) between the cost placeholder (`~$0.00`)
and the project name. Chip is absent when `ragMode` is null or undefined —
existing layout is preserved exactly. All chips remain inside the same outer
`<Text>` wrapper to maintain Yoga layout (nested Text treated as inline).

**Design choices and rationale:**

- **Single-fetch architecture:** Auto-search and manual `/rag search` both go
  through `emitRagBlock`, which emits the block AND returns hits. This avoids
  the typical two-RPC pattern (fetch for rendering, fetch again for preamble).
  The returned-hits contract is explicit in the function signature.

- **Magenta prefix instead of cyan:** RAG blocks use magenta (vs cyan for
  `tool-call`) to differentiate them visually. Future block types can choose
  their own colours (rag precedent: new feature, new colour).

- **Score threshold 0.45 (hardcoded):** Filtering by score makes "only" mode
  safe — no junk documents pollute the prompt. The 0.45 threshold is tuned
  to the SoHoAI RAG server's scoring model; if that model changes, the constant
  needs adjustment. (Future: make configurable via CLI flag or env var.)

- **Preamble injection format:** `<RAG context>...\n</RAG context>` wraps the
  context. The "only" mode instruction is a separate line above the wrapper
  for clarity. This format is compatible with Claude's RAG/instruction syntax.

- **"only" mode skip-if-empty:** If `ragMode === "only"` and no hits pass
  threshold, the prompt is NOT forwarded to OpenCode. User sees a system message.
  This prevents sending uncontextualized prompts when the operator has explicitly
  asked for "answer only from docs" — silence is better than hallucination.
  In "on" mode, the prompt is always forwarded (even with empty context).

- **Status bar chip placement:** Chip appears between cost and project name
  (after `~$0.00 `). Visual flow: model | ctx bar | cost | **rag:mode** | project.
  Chip is inline (no extra height) because it's a `<Text>` sibling inside the
  same outer `<Text>` wrapper (Yoga Flex rule for Text nesting).

**Files modified:**
- `src/blocks.ts` (Role union + formatLine case)
- `src/renderer/output-keys.ts` (rag: "rag" entry)
- `src/rag.ts` (new)
- `src/commands.ts` (parseRagCommand)
- `src/command-registry.ts` (/rag entry)
- `src/app.tsx` (ragMode state + emitRagBlock + /rag dispatch + auto-search interception + StatusLine prop + useCallback deps)
- `src/components/StatusLine.tsx` (ragMode prop + chip rendering)

**Status:** All features implemented and compiled successfully. Binary rebuilt
without TypeScript errors. Pending operator smoke-testing of all four modes,
auto-search interception, "only" mode skip-on-empty, and StatusLine chip display.

**Out of scope:**
- Per-user RAG (hardcoded `user=florian`).
- RAG server config via CLI flags or env vars.
- Persisting `ragMode` across restarts (in-memory only).
- RAG source citations in LLM output (octmux cannot intercept token stream).
- Changing renderer internals or `setOutputEnabled` (pure-gate contract).
- Automated tests (project convention: none).

---
