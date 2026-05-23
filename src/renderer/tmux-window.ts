import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { makeFifo, type FifoHandle } from "./fifo.ts";
import { StdoutRenderer, type CommittedLine } from "./stdout.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer } from "./types.ts";

// Maps each side role to the window key it streams into.
// tool-call and tool-result share one "tools" window so the full
// call → result sequence is visible in a single scrollback buffer.
const WINDOW_KEY: Partial<Record<Role, string>> = {
  thinking:      "thinking",
  "tool-call":   "tools",
  "tool-result": "tools",
};

const SIDE_ROLES: Role[] = Object.keys(WINDOW_KEY) as Role[];

export class TmuxWindowRenderer extends EventEmitter implements Renderer {
  readonly kind = "tmux-window" as const;
  readonly visibility: Visibility;

  private _main: StdoutRenderer;
  // Keyed by window key (e.g. "thinking", "tools") — at most 2 entries.
  private _fifos      = new Map<string, FifoHandle>();
  private _windowIds  = new Map<string, string>();
  private _openBlocks = new Map<string, Role>();
  // Line buffers keyed by Role — tool-call and tool-result have distinct
  // ANSI prefixes even though they share a window.
  private _lineBufs   = new Map<Role, string>();
  private _sessionLabel = "";
  private _originWindowId = "";
  // Keyed by window key ("thinking", "tools"). Default true for all registered keys.
  // When false, beginBlock/appendToBlock/endBlock skip the side path entirely.
  private _outputEnabled = new Map<string, boolean>();

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    this._main = new StdoutRenderer(visibility);
    this._main.on("changed", () => this.emit("changed"));
    // Register every window key with output enabled by default.
    for (const key of new Set(Object.values(WINDOW_KEY))) {
      this._outputEnabled.set(key, true);
    }
  }

  async setup(sessionLabel: string): Promise<void> {
    // Probe tmux context and rename origin window to the session label.
    this._sessionLabel = sessionLabel;
    this._originWindowId = execFileSync("tmux", [
      "display-message", "-p", "#{window_id}",
    ]).toString().trim();
    // Rename origin window to the session label and lock it.
    execFileSync("tmux", [
      "rename-window", "-t", this._originWindowId, sessionLabel,
    ]);
    execFileSync("tmux", [
      "set-window-option", "-t", this._originWindowId, "automatic-rename", "off",
    ]);
    execFileSync("tmux", [
      "set-window-option", "-t", this._originWindowId, "allow-rename", "off",
    ]);
  }

  isOutputEnabled(key: string): boolean {
    return this._outputEnabled.get(key) ?? true;
  }

  setOutputEnabled(key: string, on: boolean): void {
    this._outputEnabled.set(key, on);
  }

  // Create the window + log file for a given window key on first use.
  // Future: /rename will call `tmux rename-window` on all _windowIds; subagents follow the same `<label>--<key>` pattern.
  private _ensureWindow(windowKey: string): void {
    if (this._fifos.has(windowKey)) {
      const liveIds = new Set(
        execFileSync("tmux", ["list-windows", "-F", "#{window_id}"])
          .toString()
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean),
      );
      const cachedId = this._windowIds.get(windowKey);
      if (cachedId && liveIds.has(cachedId)) {
        return;
      }
      const stale = this._fifos.get(windowKey);
      if (stale) stale.close();
      this._fifos.delete(windowKey);
      this._windowIds.delete(windowKey);
      for (const [role, key] of Object.entries(WINDOW_KEY) as [Role, string][]) {
        if (key === windowKey) this._lineBufs.delete(role as Role);
      }
    }
    const fifo = makeFifo(windowKey, process.pid);
    this._fifos.set(windowKey, fifo);
    const id = execFileSync("tmux", [
      "new-window", "-d",
      "-P", "-F", "#{window_id}",
      "-n", `${this._sessionLabel}--${windowKey}`,
      `tail -f ${fifo.path}`,
    ]).toString().trim();
    this._windowIds.set(windowKey, id);
    // Prevent tmux from auto-renaming the window to "tail" once the command starts.
    execFileSync("tmux", ["set-window-option", "-t", id, "automatic-rename", "off"]);
    execFileSync("tmux", ["set-window-option", "-t", id, "allow-rename", "off"]);
  }

  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    this._openBlocks.set(partID, role);
    const windowKey = WINDOW_KEY[role];
    if (windowKey) {
      if (!this.isOutputEnabled(windowKey)) return;
      this._ensureWindow(windowKey);
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
    const windowKey = WINDOW_KEY[role];
    if (windowKey) {
      if (!this.isOutputEnabled(windowKey)) return;
      const fifo = this._fifos.get(windowKey);
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
    const windowKey = role ? WINDOW_KEY[role] : undefined;
    if (role && windowKey) {
      if (this.isOutputEnabled(windowKey)) {
        const fifo = this._fifos.get(windowKey);
        if (fifo) {
          const buf = this._lineBufs.get(role) ?? "";
          if (buf) fifo.write(formatLine(role, buf, false) + "\n");
          this._lineBufs.set(role, "");
          fifo.write("\n");
        }
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

  rename(newLabel: string): void {
    execFileSync("tmux", ["rename-window", "-t", this._originWindowId, newLabel]);
    for (const [windowKey, windowId] of this._windowIds) {
      execFileSync("tmux", ["rename-window", "-t", windowId, `${newLabel}--${windowKey}`]);
    }
    this._sessionLabel = newLabel;
  }

  async dispose(): Promise<void> {
    for (const [windowKey, fifo] of this._fifos) {
      const windowId = this._windowIds.get(windowKey);
      if (windowId) try { execFileSync("tmux", ["kill-window", "-t", windowId]); } catch {}
      fifo.close();
    }
    await this._main.dispose();
  }

  getCommitted(): CommittedLine[] { return this._main.getCommitted(); }
  getTail(): { role: Role; text: string } | null { return this._main.getTail(); }

  private _isSideRole(r: Role): boolean { return SIDE_ROLES.includes(r); }
}
