import { EventEmitter } from "node:events";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer, CommittedLine } from "./types.ts";
import { OUTPUT_KEY, OUTPUT_KEYS } from "./output-keys.ts";

export class BlockBufferRenderer extends EventEmitter implements Renderer {
  readonly kind = "block-buffer" as const;
  readonly visibility: Visibility;

  private _committed: CommittedLine[] = [];
  private _nextId = 0;
  private _openBlocks = new Map<string, Role>();
  private _activeTextPartID: string | null = null;
  private _activeTextBuf = "";
  private _activeBlockAnsi = "";
  private _activeBlockRole: Role | null = null;
  private _nonTextTail: { role: Role; text: string } | null = null;
  private _width = 80;
  private _outputEnabled = new Map<string, boolean>();

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    for (const key of OUTPUT_KEYS) {
      this._outputEnabled.set(key, true);
    }
  }

  private _renderActiveTextAnsi(): string {
    if (!this._activeBlockRole) return "";
    // In 1.1: per-line formatLine of each \n-separated chunk
    const lines = this._activeTextBuf.split("\n");
    return lines.map(line => formatLine(this._activeBlockRole, line, false)).join("\n");
  }

  beginBlock(partID: string, role: Role, _meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    const _outKey = OUTPUT_KEY[role];
    if (_outKey && !this.isOutputEnabled(_outKey)) return;
    this._openBlocks.set(partID, role);

    // Block transition: if we're entering a new text block while another is open,
    // auto-flush the prior text block as a side-effect (defensive).
    if (this._activeTextPartID !== null && this._activeTextPartID !== partID && role === "text") {
      this._commitActiveText();
    }
  }

  appendToBlock(partID: string, text: string): void {
    const role = this._openBlocks.get(partID);
    if (!role) return;

    if (!this.visibility.isVisible(role)) {
      this.visibility.increment(role);
      return;
    }

    const _outKey = OUTPUT_KEY[role];
    if (_outKey && !this.isOutputEnabled(_outKey)) return;

    if (role === "text") {
      // First delta of a new text block
      if (this._activeTextPartID === null) {
        this._activeTextPartID = partID;
        this._activeBlockRole = role;
      }
      // Append to the FULL buffer — do NOT split or commit during appendToBlock
      this._activeTextBuf += text;
      // Re-render the FULL buffer to ANSI
      this._activeBlockAnsi = this._renderActiveTextAnsi();
      this.emit("changed");
    } else {
      // Non-text roles: replicate StdoutRenderer's line-streaming
      let buf = text;
      let nl = buf.indexOf("\n");
      const newLines: CommittedLine[] = [];
      while (nl !== -1) {
        newLines.push({ id: this._nextId++, role, ansi: formatLine(role, buf.slice(0, nl), false) });
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      // Process the remaining partial line
      if (buf.length > 0) {
        newLines.push({ id: this._nextId++, role, ansi: formatLine(role, buf, false) });
      }
      this._nonTextTail = buf ? { role, text: buf } : null;
      if (newLines.length > 0) this._committed = [...this._committed, ...newLines];
      this.emit("changed");
    }
  }

  endBlock(partID: string, _status?: "ok" | "error"): void {
    const role = this._openBlocks.get(partID);
    const _outKey = role ? OUTPUT_KEY[role] : undefined;
    if (_outKey && !this.isOutputEnabled(_outKey)) {
      this._openBlocks.delete(partID);
      return;
    }
    if (role && this.visibility.isVisible(role) && this._activeTextPartID === partID) {
      // C1.4 invariant: use the LAST live-rendered ANSI; do NOT re-render here.
      this._commitActiveText();
    }
    this._openBlocks.delete(partID);
    this.emit("changed");
  }

  commitTurnEnd(): void {
    // Flush active text block first
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._activeTextPartID = null;
    this._activeBlockRole = null;
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._committed = [...this._committed,
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitUserInput(text: string): void {
    // Flush active text block first
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._committed = [...this._committed,
      { id: this._nextId++, role: "user", ansi: formatLine("user", text, true) },
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitSystemMessage(text: string): void {
    // Flush active text block first
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._committed = [...this._committed,
      { id: this._nextId++, role: "text", ansi: `→ ${text}` },
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitError(message: string): void {
    // Flush active text block first
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._activeTextPartID = null;
    this._activeBlockRole = null;
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._committed = [...this._committed, {
      id: this._nextId++, role: "error",
      ansi: formatLine("error", message, true),
    }];
    this.emit("changed");
  }

  private _commitActiveText(): void {
    if (this._activeTextPartID === null || this._activeBlockRole === null) return;
    // Split the LAST live-rendered ANSI on \n; commit each line as a CommittedLine.
    const lines = this._activeBlockAnsi.split("\n");
    for (const line of lines) {
      this._committed.push({
        id: this._nextId++,
        role: this._activeBlockRole,
        ansi: line,
      });
    }
    // Reset active state
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._activeBlockRole = null;
    this._activeTextPartID = null;
    this.emit("changed");
  }

  clearAll(): void {
    // Flush active text block first
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._committed = [];
    this._activeTextPartID = null;
    this._activeBlockRole = null;
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._nonTextTail = null;
    this._openBlocks.clear();
    this.emit("changed");
  }

  async dispose(): Promise<void> {
     // Flush active text block
     if (this._activeTextPartID !== null) {
       this._commitActiveText();
     }
     return Promise.resolve();
   }

  rename(_newLabel: string): void { /* no-op for block-buffer backend */ }

  isOutputEnabled(key: string): boolean { return this._outputEnabled.get(key) ?? true; }

  setOutputEnabled(key: string, on: boolean): void { this._outputEnabled.set(key, on); }

  getCommitted(): CommittedLine[] { return this._committed; }
  getActiveBlock(): { role: Role; text: string } | null {
    if (this._activeTextPartID === null) return null;
    // For text role, return the full buffered text
    if (this._activeBlockRole === "text") {
      return { role: this._activeBlockRole, text: this._activeTextBuf };
    }
    // For non-text roles, return the partial tail
    return this._nonTextTail ?? null;
  }
  getActiveBlockAnsi(): string {
    if (this._activeTextPartID === null || this._activeBlockRole === null) return "";
    // For text role, return the live-rendered ANSI
    if (this._activeBlockRole === "text") {
      return this._activeBlockAnsi;
    }
    // For non-text roles, render the partial tail
    if (this._nonTextTail) {
      return formatLine(this._nonTextTail.role, this._nonTextTail.text, false);
    }
    return "";
  }
  setWidth(width: number): void { this._width = width; }
}
