import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Block-aware line model: discriminated-union Line type
// ---------------------------------------------------------------------------

export type PastedBlock = {
  readonly kind: "block";
  readonly id: string;            // stable id, monotonic counter at paste time
  readonly content: string;       // exact bytes received from paste-filter
  readonly lineCount: number;     // content.split("\n").length
  readonly createdAt: number;
};

export type Line = string | PastedBlock;

export const PASTE_COLLAPSE_LINE_THRESHOLD = 5;   // exported public constant

// Monotonic id generator (module-level counter, no crypto import)
let _blockIdCounter = 0;

export class LineEditor extends EventEmitter {
  // Multi-line buffer. lines[0] is the top line.
  private lines: Line[] = [""];
  private row = 0;    // cursor row
  private col = 0;    // cursor col
  private killRing = "";
  private history: string[] = [];
  private histIdx = -1;
  // Unsaved draft saved when user starts navigating history; restored on return to present.
  private _draft: string | null = null;
  private _queueMode = false;
  private _pendingEntry: string | null = null;
  private _viewingPending = false;

  // -----------------------------------------------------------------------
  // Public read-only accessors (for Renderer)
  // -----------------------------------------------------------------------

  getLines(): Line[] { return [...this.lines]; }
  getRow(): number { return this.row; }
  getCol(): number { return this.col; }

  // -----------------------------------------------------------------------
  // Block helpers (private)
  // -----------------------------------------------------------------------

  private _isBlock(row: number): boolean {
    return typeof this.lines[row] === "object" && this.lines[row] !== null;
  }

  private _currentLine(): string {
    if (this._isBlock(this.row)) return "";
    return this.lines[this.row] as string;
  }

  // -----------------------------------------------------------------------
  // Edit operations (buffer manipulations, made public)
  // -----------------------------------------------------------------------

  insert(char: string): void {
    if (this._isBlock(this.row)) {
      // On a block row at col 0: preserve the block, insert a new plain row
      // AFTER the block row with the char; cursor moves to new row col 1.
      const newRow = this.row + 1;
      this.lines.splice(newRow, 0, char);
      this.row = newRow;
      this.col = 1;
      this.emit("changed");
      return;
    }
    const line = this.lines[this.row] as string;
    this.lines[this.row] = line.slice(0, this.col) + char + line.slice(this.col);
    this.col++;
    this.emit("changed");
  }

  insertText(text: string): void {
    if (!text) return;
    const lineCount = text.split("\n").length;

    // Block collapse path: >= threshold lines
    if (lineCount >= PASTE_COLLAPSE_LINE_THRESHOLD) {
      // Check for byte-identical re-paste of an existing block
      let matchIdx = -1;
      for (let i = this.row; i < this.lines.length; i++) {
        const l = this.lines[i];
        if (typeof l === "object" && l.kind === "block" && l.content === text) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx === -1) {
        // No match at/after cursor; search before cursor as fallback
        for (let i = this.row - 1; i >= 0; i--) {
          const l = this.lines[i];
          if (typeof l === "object" && l.kind === "block" && l.content === text) {
            matchIdx = i;
            break;
          }
        }
      }

      if (matchIdx !== -1) {
        // Expand the matching block inline: replace the single block row with
        // the content split into plain string rows.
        const expanded = (this.lines[matchIdx] as PastedBlock).content.split("\n");
        this.lines.splice(matchIdx, 1, ...expanded);
        // Cursor lands on the last new row at end of meaningful content (Fix #6)
        this.row = matchIdx + expanded.length - 1;
        const last = expanded[expanded.length - 1];
        this.col = last.trimEnd().length;
        this.emit("changed");
        return;
      }

      // No match: create a new PastedBlock and insert as a single row at cursor
      const block: PastedBlock = {
        kind: "block",
        id: `b${++_blockIdCounter}`,
        content: text,
        lineCount,
        createdAt: Date.now(),
      };

      const currentRow = this.lines[this.row];
      if (this._isBlock(this.row)) {
        // Current row is already a block; just splice the new block after it
        this.lines.splice(this.row + 1, 0, block);
        this.row = this.row + 1;
        this.col = 0;
      } else {
        const line = currentRow as string;
        const before = line.slice(0, this.col);
        const after = line.slice(this.col);
        // Replace current row with: [before?], block, [after?]
        const spliceArgs: Line[] = [];
        let blockInsertIdx: number;
        if (before.length > 0 && after.length > 0) {
          spliceArgs.push(before, block, after);
          blockInsertIdx = 1;
        } else if (before.length > 0) {
          spliceArgs.push(before, block);
          blockInsertIdx = 1;
        } else if (after.length > 0) {
          spliceArgs.push(block, after);
          blockInsertIdx = 0;
        } else {
          // Empty current row — just replace with block
          spliceArgs.push(block);
          blockInsertIdx = 0;
        }
        this.lines.splice(this.row, 1, ...spliceArgs);
        this.row = this.row + blockInsertIdx;
        this.col = 0;
      }
      this.emit("changed");
      return;
    }

    // Existing single/multi-line insertion path (lineCount < threshold).
    // If on a block row, preserve the block and splice the text as PLAIN rows
    // after it (sub-threshold text is normal text, never a new block).
    if (this._isBlock(this.row)) {
      const segments = text.split("\n");
      this.lines.splice(this.row + 1, 0, ...segments);
      this.row = this.row + segments.length;
      this.col = segments[segments.length - 1].trimEnd().length;
      this.emit("changed");
      return;
    }
    const segments = text.split("\n");
    const line = this._currentLine();
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    if (segments.length === 1) {
      this.lines[this.row] = before + segments[0] + after;
      this.col += segments[0].length;
    } else {
      this.lines[this.row] = before + segments[0];
      const middle = segments.slice(1, -1);
      const last = segments[segments.length - 1];
      this.lines.splice(this.row + 1, 0, ...middle, last + after);
      this.row += segments.length - 1;
      // Fix #6 (Stage 3E.7.1): land cursor at end of meaningful content, not
      // end of trailing whitespace. Buffer content (last + after) is unchanged;
      // only the cursor position is adjusted so it stays visible after pastes
      // that include terminal mouse-select padding.
      this.col = last.trimEnd().length;
    }
    this.emit("changed");
  }

  backspace(): void {
    // Current row is a block: atomic-delete the block
    if (this._isBlock(this.row)) {
      this.lines.splice(this.row, 1);
      if (this.lines.length === 0) this.lines = [""];
      this.row = Math.max(0, this.row - 1);
      this.col = this._isBlock(this.row) ? 0 : (this.lines[this.row] as string).length;
      this.emit("changed");
      return;
    }

    if (this.col > 0) {
      // Standard single-char delete within a plain row
      const line = this.lines[this.row] as string;
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col--;
      this.emit("changed");
    } else if (this.row > 0) {
      const prevIsBlock = this._isBlock(this.row - 1);
      if (prevIsBlock) {
        // Atomic-delete the block row above; do NOT merge
        this.lines.splice(this.row - 1, 1);
        this.row--;
        this.col = 0;
        // Ensure at least one row remains
        if (this.lines.length === 0) this.lines = [""];
        this.emit("changed");
      } else {
        // Join with previous plain string row (original behaviour)
        const prev = this.lines[this.row - 1] as string;
        const cur = this.lines[this.row] as string;
        this.lines.splice(this.row, 1);
        this.row--;
        this.col = prev.length;
        this.lines[this.row] = prev + cur;
        this.emit("changed");
      }
    }
  }

  deleteForward(): void {
    // Current row is a block: atomic-delete this block row
    if (this._isBlock(this.row)) {
      this.lines.splice(this.row, 1);
      if (this.lines.length === 0) this.lines = [""];
      this.row = Math.min(this.row, this.lines.length - 1);
      this.col = this._isBlock(this.row) ? 0 : (this.lines[this.row] as string).length;
      this.emit("changed");
      return;
    }

    const line = this.lines[this.row] as string;
    if (this.col < line.length) {
      // Delete the character under the cursor.
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
      this.emit("changed");
    } else if (this.row < this.lines.length - 1) {
      const nextIsBlock = this._isBlock(this.row + 1);
      if (nextIsBlock) {
        // Atomic-delete the block row below; do NOT merge
        this.lines.splice(this.row + 1, 1);
        // col stays the same (end of current line)
        this.emit("changed");
      } else {
        // At end of line: forward-delete the newline by joining with the next line.
        const next = this.lines[this.row + 1] as string;
        this.lines.splice(this.row + 1, 1);
        this.lines[this.row] = line + next;
        this.emit("changed");
      }
    }
  }

  insertNewline(): void {  // Alt-Enter
    if (this._isBlock(this.row)) {
      // Insert a new empty plain row BEFORE the block row
      this.lines.splice(this.row, 0, "");
      // Cursor stays on the new empty row (same row index, which is now the new row)
      this.col = 0;
      this.emit("changed");
      return;
    }
    const line = this.lines[this.row] as string;
    this.lines[this.row] = line.slice(0, this.col);
    this.lines.splice(this.row + 1, 0, line.slice(this.col));
    this.row++;
    this.col = 0;
    this.emit("changed");
  }

  enterOnLastRow(): void {
    const text = this.getText();  // now expands blocks
    if (text.trim() && !this._queueMode) {
      this.history.push(text);
      this.histIdx = -1;
      this._draft = null;
    }
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    // "changed" clears the visible buffer; "submit" only fires for non-empty input
    this.emit("changed");
    if (text.trim()) this.emit("submit", text);
    // Reset navigation state AFTER emit — handleSubmit reads isViewingPending()
    // during the synchronous event callback, so we reset only after it returns.
    this.histIdx = -1;
    this._draft = null;
    this._viewingPending = false;
  }

  clearBuffer(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.histIdx = -1;
    this._draft = null;
    this.emit("changed");
  }

  // Kill ring
  killToEnd(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    this.killRing = line.slice(this.col);
    this.lines[this.row] = line.slice(0, this.col);
    this.emit("changed");
  }

  killToStart(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    this.killRing = line.slice(0, this.col);
    this.lines[this.row] = line.slice(this.col);
    this.col = 0;
    this.emit("changed");
  }

  killWordBackward(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.killRing = line.slice(i, this.col);
    this.lines[this.row] = line.slice(0, i) + line.slice(this.col);
    this.col = i;
    this.emit("changed");
  }

  killWordForward(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    let i = this.col;
    while (i < line.length && line[i] === " ") i++;
    while (i < line.length && line[i] !== " ") i++;
    this.killRing = line.slice(this.col, i);
    this.lines[this.row] = line.slice(0, this.col) + line.slice(i);
    this.emit("changed");
  }

  yank(): void { this.insert(this.killRing); }

  // Movement
  moveLineStart(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    this.col = 0;
    this.emit("changed");
  }
  moveLineEnd(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    this.col = (this.lines[this.row] as string).length;
    this.emit("changed");
  }

  moveBackward(): void {
    if (this.col > 0) {
      this.col--;
      this.emit("changed");
    } else if (this.col === 0 && this.row > 0) {
      // Cross-row backward: move to previous row
      this.row--;
      // If previous row is a block, land at col 0 on it
      if (this._isBlock(this.row)) {
        this.col = 0;
      } else {
        this.col = (this.lines[this.row] as string).length;
      }
      this.emit("changed");
    }
  }

  moveForward(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    if (this.col < line.length) { this.col++; this.emit("changed"); }
  }

  wordBackward(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.col = i;
    this.emit("changed");
  }

  wordForward(): void {
    if (this._isBlock(this.row)) return;  // no-op on block row
    const line = this.lines[this.row] as string;
    let i = this.col;
    while (i < line.length && line[i] === " ") i++;
    while (i < line.length && line[i] !== " ") i++;
    this.col = i;
    this.emit("changed");
  }

  // Multi-line navigation
  moveUpRow(): void {
    if (this.row > 0) {
      this.row--;
      if (this._isBlock(this.row)) {
        this.col = 0;
      } else {
        this.col = Math.min(this.col, (this.lines[this.row] as string).length);
      }
      this.emit("changed");
    }
  }

  moveDownRow(): void {
    if (this.row < this.lines.length - 1) {
      this.row++;
      if (this._isBlock(this.row)) {
        this.col = 0;
      } else {
        this.col = Math.min(this.col, (this.lines[this.row] as string).length);
      }
      this.emit("changed");
    }
  }

  // History navigation
  histPrev(): void {
    if (this.histIdx === -1 && !this._viewingPending) {
      this._draft = this.getText();
      if (this._pendingEntry !== null) {
        this._viewingPending = true;
        this.lines = this._pendingEntry.split("\n");
        this.row = this.lines.length - 1;
        this.col = this.lines[this.row].length;
        this.emit("changed");
        return;
      }
      if (this.history.length === 0) return;
      this.histIdx = this.history.length - 1;
      this._loadHistory();
      return;
    }
    if (this._viewingPending) {
      this._viewingPending = false;
      if (this.history.length > 0) {
        this.histIdx = this.history.length - 1;
        this._loadHistory();
      }
      return;
    }
    if (this.histIdx > 0) { this.histIdx--; this._loadHistory(); }
  }

  histNext(): void {
    if (this.histIdx === -1 && !this._viewingPending) return;
    if (this._viewingPending) {
      this._viewingPending = false;
      const draft = this._draft ?? "";
      this._draft = null;
      this.histIdx = -1;
      this.lines = draft ? draft.split("\n") : [""];
      this.row = this.lines.length - 1;
      this.col = this.lines[this.row].length;
      this.emit("changed");
      return;
    }
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this._loadHistory();
    } else {
      this.histIdx = -1;
      if (this._pendingEntry !== null) {
        this._viewingPending = true;
        this.lines = this._pendingEntry.split("\n");
        this.row = this.lines.length - 1;
        this.col = this.lines[this.row].length;
        this.emit("changed");
      } else {
        const draft = this._draft ?? "";
        this._draft = null;
        this.lines = draft ? draft.split("\n") : [""];
        this.row = this.lines.length - 1;
        this.col = this.lines[this.row].length;
        this.emit("changed");
      }
    }
  }

  // Buffer manipulation
  loadText(text: string): void {
    this.lines = text ? text.split("\n") : [""];  // plain string rows, no collapse
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.emit("changed");
  }

  getText(): string {
    return this.lines.map(l => typeof l === "string" ? l : l.content).join("\n");
  }

  isAtTopRow(): boolean { return this.row === 0; }
  isAtBottomRow(): boolean { return this.row === this.lines.length - 1; }

  // True iff the buffer was loaded via histPrev/histNext and the user has not
  // yet returned to the present draft (↓ past last entry) or cleared/submitted.
  // The slash-completion overlay uses this to stay closed during history
  // navigation — otherwise scrolling to a past "/command" entry would pop the
  // overlay and steal the arrow keys, trapping the user mid-scroll.
  isInHistoryNav(): boolean { return this.histIdx !== -1 || this._viewingPending; }

  isViewingPending(): boolean { return this._viewingPending; }

  // Seed the history from an external source (e.g. replay synthesiser on resume).
  // Replaces any existing history.
  seedHistory(items: string[]): void {
    this.history = [...items];
    this.histIdx = -1;
    this._draft = null;
  }

  setQueueMode(on: boolean): void { this._queueMode = on; }

  addToHistory(text: string): void {
    if (text.trim()) { this.history.push(text); this.histIdx = -1; this._draft = null; }
  }

  setPendingEntry(text: string | null): void {
    this._pendingEntry = text;
    if (text === null && this._viewingPending) {
      this._viewingPending = false;
      this.histIdx = -1;
      const draft = this._draft ?? "";
      this._draft = null;
      this.lines = draft ? draft.split("\n") : [""];
      this.row = this.lines.length - 1;
      this.col = this.lines[this.row].length;
      this.emit("changed");
    }
  }

  // Public accessor for tests: return block at row if it is a PastedBlock, else null
  getBlockAt(row: number): PastedBlock | null {
    if (row >= 0 && row < this.lines.length && this._isBlock(row)) {
      return this.lines[row] as PastedBlock;
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _loadHistory(): void {
    this.lines = this.history[this.histIdx].split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.emit("changed");
  }
}
