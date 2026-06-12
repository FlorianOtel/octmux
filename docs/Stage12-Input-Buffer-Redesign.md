---
title: "Stage 12 — Block-aware input buffer with collapsed-paste handling"
created_at: 2026-06-12--15-59
created_by: Actor (sohoai/qwen3-4b-q6)
updated_by: Actor (sohoai/qwen3-4b-q6) — 2026-06-12--17-29
updated_at: 2026-06-12--17-29
context: >
  Stage 12 — block-aware input buffer with Claude-Code-style collapsed-paste handling (paste >=5 lines renders as a one-line placeholder, atomic for cursor/delete, expands inline on byte-identical re-paste, expands fully on submit).
---

## Read first

This feature implements Claude-Code-style collapsed-paste handling. When the user pastes 5 or more lines, the editor renders a single collapsed placeholder row instead of expanding inline. The internal buffer uses a discriminated-union type `Line = string | PastedBlock` where one `PastedBlock` occupies exactly one row. The canonical entry points are `src/editor.ts` (model + `insertText` threshold/expand logic) and `src/components/PromptInput.tsx` (placeholder render). Note that history/draft/SDK-send all see fully-expanded plain text (no block state persisted).

## Implementation log

### 2026-06-12--17-29 — Stage 12.1 — Block-aware input buffer with collapsed-paste handling
**Implemented by:** Actor (sohoai/qwen3-4b-q6) + Actor-heavy (sohoai/glm-5.1), orchestrated by Brain (anthropic/claude-opus-4-8) via /brain — 2026-06-12--17-29
**Commit(s):** `1588a95`

Design: discriminated-union `Line = string | PastedBlock`; `PastedBlock` {kind, id, content, lineCount, createdAt}; one collapsed block occupies exactly one row; `PASTE_COLLAPSE_LINE_THRESHOLD = 5` exported constant; monotonic id counter (no crypto).

Behavior: paste >=5 lines collapses to placeholder `[pasted text N lines — paste again to expand]`; atomic for cursor traversal (col always 0 on block row) and delete (one backspace/delete removes the whole block, no merge with neighbours); typing on a block row pushes a new plain row out the other side; Alt-Enter inserts an empty row before; byte-identical re-paste expands the block inline to plain text; sub-threshold (<5 line) paste on a block row inserts plain rows after it (never wraps in a block).

getText()/submit/history: getText() expands blocks to content; enterOnLastRow uses getText(); history stores fully-expanded text only; histPrev/histNext/draft restore use plain string rows (no block metadata persisted); loadText stores plain rows.

Renderer: PromptInput branches on PastedBlock, renders the placeholder dim; cursor-on-block renders the placeholder's first char inverse + rest dim (NOT raw content); firstLine coerced to string in PromptInput.tsx and app.tsx slash-completion so a block at row 0 cannot crash `.startsWith("/")`.

Invariants preserved (verified by 16 characterization tests written BEFORE the refactor): Emacs keybindings (Ctrl-A/E/K/Y + B/F/D/U/W/P/N, Alt-B/F/D), arrow nav + 500ms double-Up history (gate lives in keybindings.ts), draft buffering, Ctrl-L pure repaint does NOT expand a block.

Tests: src/editor.test.ts grew to 40 tests (3 original + 13 characterization + 24 block-aware); full suite 186 pass / 0 fail. Reviewer PASS after one FIX iteration (two blockers caught: sub-threshold-on-block wrongly wrapped in a block; cursor-on-block rendered raw content — both fixed).

Pending operator verification (manual paste in live TUI): single dim placeholder on 6-line paste; identical re-paste expands; backspace removes block atomically; Ctrl-L does not expand; submit sends expanded content; slash overlay after paste does not crash.

(End of file - total 41 lines)
