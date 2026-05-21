import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { makeFifo, type FifoHandle } from "./fifo.ts";
import { StdoutRenderer, type CommittedLine } from "./stdout.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer } from "./types.ts";

// Roles that route to dedicated side panes. Text + user + error stay in the main pane.
const SIDE_ROLES: Role[] = ["thinking", "tool-call", "tool-result"];

export class TmuxPaneRenderer extends EventEmitter implements Renderer {
  readonly kind = "tmux-pane" as const;
  readonly visibility: Visibility;

  private _main: StdoutRenderer;
  private _fifos      = new Map<Role, FifoHandle>();
  private _paneIds    = new Map<Role, string>();
  private _openBlocks = new Map<string, Role>();
  // Per-role line buffers: accumulate partial chunks; flush complete lines with \n
  // so tail -f output is immediately visible (no stdio line-buffering delay).
  private _lineBufs   = new Map<Role, string>();

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    this._main = new StdoutRenderer(visibility);
    this._main.on("changed", () => this.emit("changed"));
  }

  async setup(originPaneId: string): Promise<void> {
    type SplitSpec = { role: Role; dir: "-h" | "-v" };
    const plan: SplitSpec[] = [
      { role: "thinking",    dir: "-h" },
      { role: "tool-call",   dir: "-h" },
      { role: "tool-result", dir: "-v" },
    ];

    let prevPaneId = originPaneId;
    for (const { role, dir } of plan) {
      const fifo = makeFifo(role, process.pid);
      this._fifos.set(role, fifo);
      this._lineBufs.set(role, "");
      // tail -f (lowercase) follows the regular temp file by fd — reliable and immediate.
      const id = execFileSync("tmux", [
        "split-window", dir, "-t", prevPaneId,
        "-P", "-F", "#{pane_id}",
        `tail -f ${fifo.path}`,
      ]).toString().trim();
      this._paneIds.set(role, id);
      execFileSync("tmux", ["select-pane", "-t", id, "-T", role]);
      prevPaneId = id;
    }
    execFileSync("tmux", ["select-pane", "-t", originPaneId]);
  }

  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    this._openBlocks.set(partID, role);
    if (!this._isSideRole(role)) {
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
      // Accumulate in line buffer; write complete lines with \n so tail flushes immediately.
      // NOTE: blank separator lines are NOT forwarded to side panes (see §3U.5 in Phase3-UX.md).
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
        // Flush any remaining partial line.
        const buf = this._lineBufs.get(role) ?? "";
        if (buf) fifo.write(formatLine(role, buf, false) + "\n");
        this._lineBufs.set(role, "");
        fifo.write("\n"); // blank separator after block end
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
      const paneId = this._paneIds.get(role);
      if (paneId) try { execFileSync("tmux", ["kill-pane", "-t", paneId]); } catch {}
      fifo.close();
    }
    await this._main.dispose();
  }

  getCommitted(): CommittedLine[] { return this._main.getCommitted(); }
  getTail(): { role: Role; text: string } | null { return this._main.getTail(); }

  private _isSideRole(r: Role): boolean { return SIDE_ROLES.includes(r); }
}
