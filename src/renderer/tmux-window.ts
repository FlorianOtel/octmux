import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { makeFifo, type FifoHandle } from "./fifo.ts";
import { StdoutRenderer, type CommittedLine } from "./stdout.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer } from "./types.ts";

const SIDE_ROLES: Role[] = ["thinking", "tool-call", "tool-result"];

export class TmuxWindowRenderer extends EventEmitter implements Renderer {
  readonly kind = "tmux-window" as const;
  readonly visibility: Visibility;

  private _main: StdoutRenderer;
  private _fifos      = new Map<Role, FifoHandle>();
  private _windowIds  = new Map<Role, string>();
  private _openBlocks = new Map<string, Role>();
  private _lineBufs   = new Map<Role, string>();
  private _sessionName = "";
  private _originWindowId = "";

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    this._main = new StdoutRenderer(visibility);
    this._main.on("changed", () => this.emit("changed"));
  }

  async setup(): Promise<void> {
    // Only probe tmux context — no windows spawned yet (lazy).
    this._originWindowId = execFileSync("tmux", [
      "display-message", "-p", "#{window_id}",
    ]).toString().trim();
    this._sessionName = execFileSync("tmux", [
      "display-message", "-p", "#{session_name}",
    ]).toString().trim();
  }

  private _ensureWindow(role: Role): void {
    if (this._fifos.has(role)) return;
    const fifo = makeFifo(role, process.pid);
    this._fifos.set(role, fifo);
    this._lineBufs.set(role, "");
    const id = execFileSync("tmux", [
      "new-window", "-d",
      "-P", "-F", "#{window_id}",
      "-n", `${this._sessionName}-${role}`,
      `tail -f ${fifo.path}`,
    ]).toString().trim();
    this._windowIds.set(role, id);
    execFileSync("tmux", ["set-window-option", "-t", id, "automatic-rename", "off"]);
    execFileSync("tmux", ["set-window-option", "-t", id, "allow-rename", "off"]);
  }

  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    this._openBlocks.set(partID, role);
    if (this._isSideRole(role)) {
      this._ensureWindow(role);
    } else {
      this._main.beginBlock(partID, role, meta);
    }
  }

  appendToBlock(partID: string, text: string): void {
    const role = this._openBlocks.get(partID);
    if (!role) return;
    if (!this.visibility.isVisible(role)) {
      this.visibility.increment(role);
      return;
    }
    if (this._isSideRole(role)) {
      const fifo = this._fifos.get(role);
      if (!fifo) return;
      let buf = (this._lineBufs.get(role) ?? "") + text;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        fifo.write(formatLine(role, buf.slice(0, nl), false) + "\n");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      this._lineBufs.set(role, buf);
    } else {
      this._main.appendToBlock(partID, text);
    }
  }

  endBlock(partID: string, status?: "ok" | "error"): void {
    const role = this._openBlocks.get(partID);
    if (role && this._isSideRole(role)) {
      const fifo = this._fifos.get(role);
      if (fifo) {
        const buf = this._lineBufs.get(role) ?? "";
        if (buf) fifo.write(formatLine(role, buf, false) + "\n");
        this._lineBufs.set(role, "");
        fifo.write("\n");
      }
    } else {
      this._main.endBlock(partID, status);
    }
    this._openBlocks.delete(partID);
  }

  commitTurnEnd():                void { this._main.commitTurnEnd(); }
  commitUserInput(t: string):     void { this._main.commitUserInput(t); }
  commitSystemMessage(t: string): void { this._main.commitSystemMessage(t); }
  commitError(m: string):         void { this._main.commitError(m); }

  async dispose(): Promise<void> {
    for (const [role, fifo] of this._fifos) {
      const windowId = this._windowIds.get(role);
      if (windowId) try { execFileSync("tmux", ["kill-window", "-t", windowId]); } catch {}
      fifo.close();
    }
    await this._main.dispose();
  }

  getCommitted(): CommittedLine[] { return this._main.getCommitted(); }
  getTail(): { role: Role; text: string } | null { return this._main.getTail(); }

  private _isSideRole(r: Role): boolean { return SIDE_ROLES.includes(r); }
}
