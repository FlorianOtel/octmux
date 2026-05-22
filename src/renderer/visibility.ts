import { EventEmitter } from "node:events";
import type { Role } from "../blocks.ts";

export class Visibility extends EventEmitter {
  private state: Record<Role, boolean> = {
    user: true, text: true, thinking: true,
    "tool-call": true, "tool-result": true, error: true,
  };
  private counts: Record<Role, number> = {
    user: 0, text: 0, thinking: 0,
    "tool-call": 0, "tool-result": 0, error: 0,
  };
  // Cached snapshot — same reference between mutations so useSyncExternalStore
  // can compare with Object.is() without triggering a render loop.
  private _summaryCache: Array<{ role: Role; count: number }> = [];

  isVisible(r: Role): boolean { return this.state[r]; }
  set(r: Role, on: boolean): void {
    if (this.state[r] === on) return;
    this.state[r] = on;
    if (on) this.counts[r] = 0;
    this._rebuildCache();
    this.emit("changed");
  }
  increment(r: Role): void {
    this.counts[r]++;
    this._rebuildCache();
    this.emit("changed");
  }
  // Returns a stable reference — only replaced when set() or increment() is called.
  hiddenSummary(): Array<{ role: Role; count: number }> {
    return this._summaryCache;
  }
  private _rebuildCache(): void {
    const out: Array<{ role: Role; count: number }> = [];
    for (const r of Object.keys(this.state) as Role[]) {
      if (!this.state[r] && this.counts[r] > 0) out.push({ role: r, count: this.counts[r] });
    }
    this._summaryCache = out;
  }
}
