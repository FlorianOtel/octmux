import type { Visibility } from "./renderer/visibility.ts";
import type { Role } from "./blocks.ts";

// Moved from renderer/visibility.ts — logic unchanged.
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

export function parseExitCommand(
  input: string,
): { handled: boolean } {
  return { handled: /^\/(?:exit|quit)\s*$/.test(input.trim()) };
}

export function parseRenameCommand(
  input: string,
): { handled: boolean; newLabel?: string } {
  const m = input.trim().match(/^\/rename(?:\s+(\S+))?\s*$/);
  if (!m) return { handled: false };
  return { handled: true, newLabel: m[1] };
}

export function parseModelCommand(
  input: string,
): { handled: boolean; action: "list" | "set" | null; providerID?: string; modelID?: string } {
  const m = input.trim().match(/^\/model(?:\s+(\S+))?\s*$/);
  if (!m) return { handled: false };
  const arg = m[1];
  if (!arg) return { handled: true, action: "list" };
  const slash = arg.indexOf("/");
  if (slash <= 0 || slash === arg.length - 1) return { handled: true, action: null };
  return {
    handled: true,
    action: "set",
    providerID: arg.slice(0, slash),
    modelID: arg.slice(slash + 1),
  };
}
