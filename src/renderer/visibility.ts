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

  isVisible(r: Role): boolean { return this.state[r]; }
  set(r: Role, on: boolean): void {
    if (this.state[r] === on) return;
    this.state[r] = on;
    if (on) this.counts[r] = 0;
    this.emit("changed");
  }
  increment(r: Role): void {
    this.counts[r]++;
    this.emit("changed");
  }
  hiddenSummary(): Array<{ role: Role; count: number }> {
    const out: Array<{ role: Role; count: number }> = [];
    for (const r of Object.keys(this.state) as Role[]) {
      if (!this.state[r] && this.counts[r] > 0) out.push({ role: r, count: this.counts[r] });
    }
    return out;
  }
}

export function parseShowCommand(
  input: string,
  vis: Visibility,
): { handled: boolean; reply?: string } {
  const m = input.trim().match(/^\/show(?:\s+(\S+))?(?:\s+(on|off))?$/);
  if (!m) return { handled: false };
  const [, what, action] = m;
  if (!what) {
    const rolesOff = (["thinking", "tool-call", "tool-result"] as Role[]).filter(
      r => !vis.isVisible(r),
    );
    return {
      handled: true,
      reply: rolesOff.length === 0 ? "all visible" : `hidden: ${rolesOff.join(", ")}`,
    };
  }
  const role: Role | null =
    what === "thinking"    ? "thinking"    :
    what === "tools"       ? "tool-call"   :
    what === "tool-call"   ? "tool-call"   :
    what === "tool-result" ? "tool-result" :
    null;
  if (!role || !action) return { handled: false };
  vis.set(role, action === "on");
  if (what === "tools") vis.set("tool-result", action === "on");
  return { handled: true, reply: `${what} ${action}` };
}
