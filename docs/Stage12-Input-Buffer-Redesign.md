---
title: "Stage 12 — Block-aware input buffer with collapsed-paste handling"
created_at: 2026-06-12--15-59
created_by: Actor (sohoai/qwen3-4b-q6)
updated_by: Brain (anthropic/claude-opus-4-8) via direct fix — 2026-06-12--20-16
updated_at: 2026-06-12--20-16
context: >
  Stage 12 — block-aware input buffer with Claude-Code-style collapsed-paste handling (paste >=5 lines renders as a one-line placeholder, atomic for cursor/delete, expands inline on byte-identical re-paste, expands fully on submit).
---

## Read first

This feature implements Claude-Code-style collapsed-paste handling. When the user pastes 5 or more lines, the editor renders a single collapsed placeholder row instead of expanding inline. The internal buffer uses a discriminated-union type `Line = string | PastedBlock` where one `PastedBlock` occupies exactly one row. The canonical entry points are `src/editor.ts` (model + `insertText` threshold/expand logic) and `src/components/PromptInput.tsx` (placeholder render). Note that history/draft/SDK-send all see fully-expanded plain text (no block state persisted).

## Implementation log

### 2026-06-12--20-16 — Stage 12.2 — Paste-UX bug fixes (cursor placement + history repaint)
**Implemented by:** Brain (anthropic/claude-opus-4-8) — direct fix after operator manual verification — 2026-06-12--20-16
**Commit(s):** `PENDING-12.2`

Two operator-reported bugs from manual verification of Stage 12.1, both fixed:

**Bug 1 — cursor landed on the placeholder's first char after a paste.** `insertText`'s block-insert path set the cursor to col 0 of the block row, so the inverse cursor rendered on the placeholder `[`. Confusing, since typing correctly continued *after* the block. Fix: after inserting a block, always keep a plain row immediately after it and land the cursor there (col 0). The splice now produces `[before?, block, after-or-empty]` and the cursor lands on the trailing plain row. When a block is already the current row, splice `block, ""` and land on the empty row. This makes the on-screen cursor match the typing target. The block stays atomic — backspace from that trailing row still removes the whole block via the existing "col 0 of plain row after a block" path.

**Submit trailing-newline guard (consequence of Bug 1 fix).** Because a whole-buffer paste now yields `[block, ""]`, `getText()` gains a trailing `\n`. `enterOnLastRow()` now drops a single trailing empty row before sending/pushing-to-history (only when the buffer has >1 row), so a pasted message submits clean without a spurious trailing newline.

**Bug 2 — recalled paste "disappeared" after history scroll.** Not data loss: the editor correctly restored the draft as expanded plain text (verified by repro). It was a **repaint** bug — history navigation changes buffer height (1 row ↔ N rows) but only fired a React re-render (`"changed"`), never the full Ink repaint that the paste path uses. Inline-mode left stale rows from the previous taller/shorter frame on screen. Fix: a new private `_emitChangedAndRedraw()` emits both `"changed"` and a new `"redraw"` event from every wholesale-buffer-replacement path (`histPrev`/`histNext` pending+draft branches, `_loadHistory`, `setPendingEntry`, `loadText`, `clearBuffer`, and the paste block/expand paths). `PromptInput` subscribes `onRedraw` to the `"redraw"` event (same hook as Ctrl-L: `log.clear` + `lastOutput=""` + `onRender`). History recall continues to return fully-expanded plain text (the earlier agreed behavior); the repaint makes it actually visible.

Tests: src/editor.test.ts grew to 45 tests (added 5 regression tests: cursor-after-paste, mid-line paste before/after preservation, submit-trim, history-restore-emits-redraw, paste/clear/loadText emit redraw). Several existing block tests updated to reflect the new cursor-after-block landing (they now `moveUpRow()` onto the block before exercising block-row ops). Full suite 191 pass / 0 fail. Binary rebuilt.

Pending operator re-verification: (1) after a 6-line paste the cursor sits below the placeholder and typing continues after it; (2) paste, scroll up into history, scroll back down — the pasted text reappears (expanded) and the screen repaints cleanly.

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
