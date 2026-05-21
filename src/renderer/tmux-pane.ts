import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { makeFifo, type FifoHandle } from "./fifo.ts";
import { StdoutRenderer, type CommittedLine } from "./stdout.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer } from "./types.ts";

// Maps each side role to the pane key it streams into.
// tool-call and tool-result share one "tools" pane so the full
// call → result sequence is visible in a single scrollback buffer.
const PANE_KEY: Partial<Record<Role, string>> = {
  thinking:      "thinking",
  "tool-call":   "tools",
  "tool-result": "tools",
};

const SIDE_ROLES: Role[] = Object.keys(PANE_KEY) as Role[];

export class TmuxPaneRenderer extends EventEmitter implements Renderer {
  readonly kind = "tmux-pane" as const;
  readonly visibility: Visibility;

  private _main: StdoutRenderer;
  // Keyed by pane key ("thinking", "tools") — at most 2 entries.
  private _fifos      = new Map<string, FifoHandle>();
  private _paneIds    = new Map<string, string>();
  private _openBlocks = new Map<string, Role>();
  // Per-role line buffers: accumulate partial chunks; flush complete lines with \n
  // so tail -f output is immediately visible (no stdio line-buffering delay).
  // tool-call and tool-result have distinct ANSI prefixes even in the same pane.
  private _lineBufs   = new Map<Role, string>();

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    this._main = new StdoutRenderer(visibility);
    this._main.on("changed", () => this.emit("changed"));
  }

  async setup(originPaneId: string): Promise<void> {
    // Layout: main | thinking (right), thinking | tools (below thinking).
    // Two panes instead of three — tool-call and tool-result share "tools".
    type SplitSpec = { key: string; dir: "-h" | "-v"; splitFrom: string };
    const plan: SplitSpec[] = [
      { key: "thinking", dir: "-h", splitFrom: originPaneId },
    ];

    // Create thinking pane first so we can split below it for tools.
    const thinkingFifo = makeFifo("thinking", process.pid);
    this._fifos.set("thinking", thinkingFifo);
    this._lineBufs.set("thinking", "");
    const thinkingId = execFileSync("tmux", [
      "split-window", "-h", "-t", originPaneId,
      "-P", "-F", "#{pane_id}",
      `tail -f ${thinkingFifo.path}`,
    ]).toString().trim();
    this._paneIds.set("thinking", thinkingId);
    execFileSync("tmux", ["select-pane", "-t", thinkingId, "-T", "thinking"]);

    // Tools pane: split below thinking.
    const toolsFifo = makeFifo("tools", process.pid);
    this._fifos.set("tools", toolsFifo);
    this._lineBufs.set("tool-call", "");
    this._lineBufs.set("tool-result", "");
    const toolsId = execFileSync("tmux", [
      "split-window", "-v", "-t", thinkingId,
      "-P", "-F", "#{pane_id}",
      `tail -f ${toolsFifo.path}`,
    ]).toString().trim();
    this._paneIds.set("tools", toolsId);
    execFileSync("tmux", ["select-pane", "-t", toolsId, "-T", "tools"]);

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
    const paneKey = PANE_KEY[role];
    if (paneKey) {
      // Accumulate in line buffer; write complete lines with \n so tail flushes immediately.
      const fifo = this._fifos.get(paneKey);
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
    const paneKey = role ? PANE_KEY[role] : undefined;
    if (role && paneKey) {
      const fifo = this._fifos.get(paneKey);
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
    for (const [paneKey, fifo] of this._fifos) {
      const paneId = this._paneIds.get(paneKey);
      if (paneId) try { execFileSync("tmux", ["kill-pane", "-t", paneId]); } catch {}
      fifo.close();
    }
    await this._main.dispose();
  }

  getCommitted(): CommittedLine[] { return this._main.getCommitted(); }
  getTail(): { role: Role; text: string } | null { return this._main.getTail(); }

  private _isSideRole(r: Role): boolean { return SIDE_ROLES.includes(r); }
}
