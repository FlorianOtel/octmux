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
  private _fifos   = new Map<Role, FifoHandle>();
  private _paneIds = new Map<Role, string>();
  // Tracks ALL open partIDs (side and main) for routing in appendToBlock/endBlock.
  private _openBlocks = new Map<string, Role>();

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    this._main = new StdoutRenderer(visibility);
    // Forward "changed" events from main renderer so useSyncExternalStore in app.tsx works.
    this._main.on("changed", () => this.emit("changed"));
  }

  async setup(originPaneId: string): Promise<void> {
    // Layout: thinking (right of main), tool-call (right of thinking), tool-result (below tool-call).
    // Each split uses the previous pane as target to chain them correctly.
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
      const id = execFileSync("tmux", [
        "split-window", dir, "-t", prevPaneId,
        "-P", "-F", "#{pane_id}",
        `tail -F ${fifo.path}`,
      ]).toString().trim();
      this._paneIds.set(role, id);
      // Set pane title (the ONLY tmux appearance call octmux makes).
      execFileSync("tmux", ["select-pane", "-t", id, "-T", role]);
      prevPaneId = id;
    }
    // Return focus to the octmux chrome (origin) pane.
    execFileSync("tmux", ["select-pane", "-t", originPaneId]);
  }

  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    this._openBlocks.set(partID, role);
    // Delegate non-side blocks to main renderer for Static/tail rendering.
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
      // Raw formatted content only — NO blank separators (see §3U.5 note in docs/Phase3-UX.md).
      const fifo = this._fifos.get(role);
      if (fifo) try { fifo.writer.write(formatLine(role, text, false)); } catch {}
    } else {
      this._main.appendToBlock(partID, text);
    }
  }

  endBlock(partID: string, status?: "ok" | "error"): void {
    const role = this._openBlocks.get(partID);
    if (role && this._isSideRole(role)) {
      // Single trailing newline — not a 2-blank separator; just terminates the last line cleanly.
      const fifo = this._fifos.get(role);
      if (fifo) try { fifo.writer.write("\n"); } catch {}
    } else {
      this._main.endBlock(partID, status);
    }
    this._openBlocks.delete(partID);
  }

  commitTurnEnd():              void { this._main.commitTurnEnd(); }
  commitUserInput(t: string):   void { this._main.commitUserInput(t); }
  commitSystemMessage(t: string): void { this._main.commitSystemMessage(t); }
  commitError(m: string):       void { this._main.commitError(m); }

  async dispose(): Promise<void> {
    for (const [role, fifo] of this._fifos) {
      const paneId = this._paneIds.get(role);
      if (paneId) try { execFileSync("tmux", ["kill-pane", "-t", paneId]); } catch {}
      await fifo.close();
    }
    await this._main.dispose();
  }

  // Delegate to main renderer — needed by app.tsx useSyncExternalStore subscriptions.
  getCommitted(): CommittedLine[] { return this._main.getCommitted(); }
  getTail(): { role: Role; text: string } | null { return this._main.getTail(); }

  private _isSideRole(r: Role): boolean { return SIDE_ROLES.includes(r); }
}
