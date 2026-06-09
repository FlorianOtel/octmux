import { EventEmitter } from "node:events";
import { execFileSync, execFile } from "node:child_process";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { makeFifo, type FifoHandle } from "./fifo.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer, CommittedLine } from "./types.ts";
import { OUTPUT_KEY, OUTPUT_KEYS } from "./output-keys.ts";
import { BlockBufferRenderer } from "./block-buffer.ts";

const SIDE_ROLES: Role[] = Object.keys(OUTPUT_KEY) as Role[];

export class TmuxWindowRenderer extends EventEmitter implements Renderer {
  readonly kind = "tmux-window" as const;
  readonly visibility: Visibility;

  private _main: Renderer;
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
  // Cache of live tmux window IDs, refreshed asynchronously after each
  // _ensureWindow call. Starts empty; first block-start goes directly to
  // fresh-creation path, which populates the cache.
  private _liveIds: Set<string> = new Set();
  // Single-flight guard — ensures at most one async tmux list-windows
  // subprocess is in flight at any moment, regardless of how many
  // rapid beginBlock calls arrive concurrently.
  private _liveIdsRefreshInFlight = false;

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    this._main = new BlockBufferRenderer(visibility);
    this._main.on("changed", () => this.emit("changed"));
    // Register every window key with output enabled by default.
    for (const key of OUTPUT_KEYS) {
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
    // Pure gate — see src/renderer/output-keys.ts for the full contract.
    // Window / FIFO lifecycle is owned exclusively by _ensureWindow, invoked
    // exclusively from beginBlock (Version 4.4.3 load-bearing path).
    this._outputEnabled.set(key, on);
    // Version 4.5.2 — kick a non-blocking liveness-cache refresh on toggle-on.
    // During the gate-off period, no beginBlock fires _ensureWindow, so the
    // _liveIds cache (Version 4.4.4) can become arbitrarily stale — if the
    // operator killed the side window during gate-off, the next block-start
    // after toggle-on would write to a dead FIFO (block 1 lost). The refresh
    // here lands ~50 ms later, well before the operator finishes typing the
    // next prompt in the typical case, so the next _ensureWindow reads fresh
    // cache and recreates if needed. No window/FIFO/block effects — only an
    // internal cache update. See docs/Version4.md §Version 4.5.2 for the full
    // rationale and the Option B alternative (force-sync-probe via flag).
    if (on) this._refreshLiveIdsAsync();
  }

  /**
   * Fire-and-forget async refresh of the live-window ID cache.
   * Single-flight: if a refresh is already in flight, subsequent kicks
   * are no-ops until that call completes. On tmux error the existing
   * cache is kept intact (transient failures must not corrupt our view).
   */
  private _refreshLiveIdsAsync(): void {
    if (this._liveIdsRefreshInFlight) return;
    this._liveIdsRefreshInFlight = true;
    execFile("tmux", ["list-windows", "-F", "#{window_id}"], (err, stdout) => {
      this._liveIdsRefreshInFlight = false;
      if (err) return;
      this._liveIds = new Set(
        stdout.split("\n").map(s => s.trim()).filter(Boolean),
      );
    });
  }

  // Create the window + log file for a given window key on first use,
  // or recreate it if the cached window ID is no longer live.
  // Hot path reads _liveIds (in-memory) only — no synchronous tmux call.
  // A background async refresh is kicked after every invocation so that
  // the next call sees a fresh cache without paying any blocking cost.
  private _ensureWindow(windowKey: string): void {
    if (this._fifos.has(windowKey)) {
      const cachedId = this._windowIds.get(windowKey);
      if (cachedId && this._liveIds.has(cachedId)) {
        this._refreshLiveIdsAsync();
        return;
      }
      // Cached ID absent from _liveIds — window was killed.
      // Close stale FIFO BEFORE deleting the map entry (no fd leak).
      const stale = this._fifos.get(windowKey);
      if (stale) stale.close();
      this._fifos.delete(windowKey);
      this._windowIds.delete(windowKey);
      for (const [role, key] of Object.entries(OUTPUT_KEY) as [Role, string][]) {
        if (key === windowKey) this._lineBufs.delete(role as Role);
      }
      // Fall through to fresh creation.
    }

    // Fresh creation — synchronous new-window is unavoidable here.
    const fifo = makeFifo(windowKey, process.pid);
    this._fifos.set(windowKey, fifo);
    const id = execFileSync("tmux", [
      "new-window", "-d",
      "-P", "-F", "#{window_id}",
      "-n", `${this._sessionLabel}--${windowKey}`,
      `tail -f ${fifo.path}`,
    ]).toString().trim();
    this._windowIds.set(windowKey, id);
    // Add new ID to live cache immediately so the next _ensureWindow
    // sees it without waiting for the background refresh.
    this._liveIds.add(id);
    execFileSync("tmux", ["set-window-option", "-t", id, "automatic-rename", "off"]);
    execFileSync("tmux", ["set-window-option", "-t", id, "allow-rename", "off"]);

    this._refreshLiveIdsAsync();
  }

  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    this._openBlocks.set(partID, role);
    const windowKey = OUTPUT_KEY[role];
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
    const windowKey = OUTPUT_KEY[role];
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
    const windowKey = role ? OUTPUT_KEY[role] : undefined;
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
  commitCompactionDivider(auto: boolean): void {
    this._main.commitCompactionDivider(auto);
  }
  retagBlock(partID: string, newRole: Role): void {
    if (!this._openBlocks.has(partID)) return;
    const oldRole = this._openBlocks.get(partID)!;
    this._openBlocks.set(partID, newRole);
    if (oldRole !== newRole) {
      // _lineBufs is keyed by Role, so clear entry for the old role
      this._lineBufs.delete(oldRole);
    }
    // Delegate to _main to keep main renderer state consistent
    this._main.retagBlock(partID, newRole);
  }

  clearAll(): void {
    this._openBlocks.clear();
    this._lineBufs.clear();
    this._main.clearAll();
    this.emit("changed");
  }

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
  getActiveBlock(): { role: Role; text: string } | null { return this._main.getActiveBlock(); }
  getActiveBlockAnsi(): string { return this._main.getActiveBlockAnsi(); }
  setWidth(width: number) { this._main.setWidth(width); }

  private _isSideRole(r: Role): boolean { return SIDE_ROLES.includes(r); }
}
