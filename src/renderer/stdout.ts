import { EventEmitter } from "node:events";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer } from "./types.ts";

export type CommittedLine = { id: number; role: Role; ansi: string };

export class StdoutRenderer extends EventEmitter implements Renderer {
  readonly kind = "stdout" as const;
  readonly visibility: Visibility;

  private _committed: CommittedLine[] = [];
  private _tail: { role: Role; text: string } | null = null;
  private _tailBuf = "";
  private _activePart: { partID: string; role: Role } | null = null;
  private _openBlocks = new Map<string, Role>();
  private _nextId = 0;

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
  }

  private _flushTail(): void {
    if (this._tailBuf && this._activePart) {
      const role = this._activePart.role;
      this._committed = [...this._committed, {
        id: this._nextId++, role,
        ansi: formatLine(role, this._tailBuf, false),
      }];
      this._tailBuf = "";
    }
    this._tail = null;
    // _activePart intentionally NOT cleared here — kept for block-transition detection.
  }

  beginBlock(partID: string, role: Role, _meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    this._openBlocks.set(partID, role);
  }

  appendToBlock(partID: string, text: string): void {
    const role = this._openBlocks.get(partID);
    if (!role) return;
    if (!this.visibility.isVisible(role)) {
      this.visibility.increment(role);
      return;
    }
    // Block transition: flush prior tail + 2-line visual separator.
    // NOTE for 3U.5: TmuxPaneRenderer must NOT forward these blank separator lines to FIFOs.
    if (this._activePart && this._activePart.partID !== partID) {
      this._flushTail();
      this._committed = [...this._committed,
        { id: this._nextId++, role: "text", ansi: " " },
        { id: this._nextId++, role: "text", ansi: " " },
      ];
    }
    this._activePart = { partID, role };
    this._tailBuf += text;

    // Split off complete lines and commit them.
    let buf = this._tailBuf;
    let nl = buf.indexOf("\n");
    const newLines: CommittedLine[] = [];
    while (nl !== -1) {
      newLines.push({ id: this._nextId++, role, ansi: formatLine(role, buf.slice(0, nl), false) });
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
    this._tailBuf = buf;
    if (newLines.length > 0) this._committed = [...this._committed, ...newLines];
    this._tail = buf ? { role, text: buf } : null;
    this.emit("changed");
  }

  endBlock(partID: string, _status?: "ok" | "error"): void {
    const role = this._openBlocks.get(partID);
    if (role && this.visibility.isVisible(role) && this._activePart?.partID === partID) {
      this._flushTail();
    }
    this._openBlocks.delete(partID);
    this.emit("changed");
  }

  commitTurnEnd(): void {
    this._flushTail();
    this._activePart = null;
    this._committed = [...this._committed,
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitUserInput(text: string): void {
    this._committed = [...this._committed,
      { id: this._nextId++, role: "user", ansi: formatLine("user", text, true) },
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitSystemMessage(text: string): void {
    this._committed = [...this._committed,
      { id: this._nextId++, role: "text", ansi: `→ ${text}` },
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitError(message: string): void {
    this._flushTail();
    this._activePart = null;
    this._committed = [...this._committed, {
      id: this._nextId++, role: "error",
      ansi: formatLine("error", message, true),
    }];
    this.emit("changed");
  }

  async dispose(): Promise<void> { /* no-op for stdout backend */ }

  rename(_newLabel: string): void { /* no-op for stdout backend */ }

  isOutputEnabled(_key: string): boolean { return true; }

  setOutputEnabled(_key: string, _on: boolean): void { /* no-op for stdout backend */ }

  getCommitted(): CommittedLine[] { return this._committed; }
  getTail(): { role: Role; text: string } | null { return this._tail; }
}
