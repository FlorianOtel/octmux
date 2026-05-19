import { EventEmitter } from "node:events";

export class LineEditor extends EventEmitter {
  // Multi-line buffer. lines[0] is the top line.
  private lines: string[] = [""];
  private row = 0;    // cursor row
  private col = 0;    // cursor col
  private killRing = "";
  private history: string[] = [];
  private histIdx = -1;

  // -----------------------------------------------------------------------
  // Public read-only accessors (for Renderer)
  // -----------------------------------------------------------------------

  getLines(): string[] { return [...this.lines]; }
  getRow(): number { return this.row; }
  getCol(): number { return this.col; }

  // -----------------------------------------------------------------------
  // Edit operations (buffer manipulations, made public)
  // -----------------------------------------------------------------------

  insert(char: string): void {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col) + char + line.slice(this.col);
    this.col++;
    this.emit("changed");
  }

  backspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row];
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col--;
      this.emit("changed");
    } else if (this.row > 0) {
      // Join with previous line
      const prev = this.lines[this.row - 1];
      const cur = this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prev.length;
      this.lines[this.row] = prev + cur;
      this.emit("changed");
    }
  }

  deleteForward(): void {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
    this.emit("changed");
  }

  insertNewline(): void {  // Alt-Enter
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col);
    this.lines.splice(this.row + 1, 0, line.slice(this.col));
    this.row++;
    this.col = 0;
    this.emit("changed");
  }

  enterOnLastRow(): void {
    const text = this.lines.join("\n");
    if (text.trim()) {
      this.history.push(text);
      this.histIdx = -1;
    }
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.emit("submit", text);
  }

  clearBuffer(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.histIdx = -1;
    this.emit("changed");
  }

  // Kill ring
  killToEnd(): void {
    const line = this.lines[this.row];
    this.killRing = line.slice(this.col);
    this.lines[this.row] = line.slice(0, this.col);
    this.emit("changed");
  }

  killToStart(): void {
    const line = this.lines[this.row];
    this.killRing = line.slice(0, this.col);
    this.lines[this.row] = line.slice(this.col);
    this.col = 0;
    this.emit("changed");
  }

  killWordBackward(): void {
    const line = this.lines[this.row];
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.killRing = line.slice(i, this.col);
    this.lines[this.row] = line.slice(0, i) + line.slice(this.col);
    this.col = i;
    this.emit("changed");
  }

  killWordForward(): void {
    const line = this.lines[this.row];
    let i = this.col;
    while (i < line.length && line[i] === " ") i++;
    while (i < line.length && line[i] !== " ") i++;
    this.killRing = line.slice(this.col, i);
    this.lines[this.row] = line.slice(0, this.col) + line.slice(i);
    this.emit("changed");
  }

  yank(): void { this.insert(this.killRing); }

  // Movement
  moveLineStart(): void { this.col = 0; this.emit("changed"); }
  moveLineEnd(): void { this.col = this.lines[this.row].length; this.emit("changed"); }
  moveBackward(): void { if (this.col > 0) { this.col--; this.emit("changed"); } }
  moveForward(): void { if (this.col < this.lines[this.row].length) { this.col++; this.emit("changed"); } }

  wordBackward(): void {
    const line = this.lines[this.row];
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.col = i;
    this.emit("changed");
  }

  wordForward(): void {
    const line = this.lines[this.row];
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
      this.col = Math.min(this.col, this.lines[this.row].length);
      this.emit("changed");
    }
  }

  moveDownRow(): void {
    if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = Math.min(this.col, this.lines[this.row].length);
      this.emit("changed");
    }
  }

  // History navigation
  histPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) this.histIdx = this.history.length - 1;
    else if (this.histIdx > 0) this.histIdx--;
    this._loadHistory();
  }

  histNext(): void {
    if (this.histIdx === -1) return;
    if (this.histIdx < this.history.length - 1) { this.histIdx++; this._loadHistory(); }
    else { this.histIdx = -1; this.lines = [""]; this.row = 0; this.col = 0; this.emit("changed"); }
  }

  // Buffer manipulation
  loadText(text: string): void {
    this.lines = text ? text.split("\n") : [""];
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.emit("changed");
  }

  getText(): string { return this.lines.join("\n"); }

  isAtTopRow(): boolean { return this.row === 0; }
  isAtBottomRow(): boolean { return this.row === this.lines.length - 1; }

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
