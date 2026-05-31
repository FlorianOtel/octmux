import { OUTPUT_KEYS } from "./renderer/output-keys.ts";
import { COMMANDS } from "./command-registry.ts";

const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const RESET = "\x1b[0m";

// List all known slash commands with their usage and descriptions.
export function parseHelpCommand(
  input: string,
  opencodeCommands?: Map<string, { name: string; description?: string }>,
): { handled: boolean; reply?: string } {
  const m = input.trim().match(/^\/help\s*$/);
  if (!m) return { handled: false };
  const lines: string[] = ["octmux commands:"];
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.usage}  — ${cmd.description}`);
  }
  if (opencodeCommands && opencodeCommands.size > 0) {
    lines.push("");
    lines.push("opencode commands:");
    for (const [name, cmd] of opencodeCommands) {
      lines.push(`  /${name}  — ${cmd.description || "(no description)"}`);
    }
  }
  return { handled: true, reply: lines.join("\n") };
}

// Display output gate status for all keys.
export function parseShowCommand(
  input: string,
  renderer: { isOutputEnabled(k: string): boolean },
): { handled: boolean; reply?: string } {
  const m = input.trim().match(/^\/show\s*$/);
  if (!m) return { handled: false };
  const parts: string[] = [];
  for (const key of OUTPUT_KEYS) {
    const isOn = renderer.isOutputEnabled(key);
    parts.push(isOn ? `${GREEN}${key}:on${RESET}` : `${RED}${key}:off${RESET}`);
  }
  return { handled: true, reply: "output gates — " + parts.join(" | ") };
}

// Toggle or query output gate state.
export function parseBlockOutputCommand(
  input: string,
  renderer: { isOutputEnabled(k: string): boolean; setOutputEnabled(k: string, on: boolean): void },
): { handled: boolean; reply?: string } {
  const m = input.trim().match(/^\/(\w+)-output(?:\s+(on|off))?\s*$/);
  if (!m) return { handled: false };
  const [, key, arg] = m;
  if (!OUTPUT_KEYS.includes(key)) {
    return { handled: true, reply: `unknown output key "${key}" — available: ${OUTPUT_KEYS.join(", ")}` };
  }
  if (!arg) {
    const isOn = renderer.isOutputEnabled(key);
    return { handled: true, reply: `${key}-output is ${isOn ? "on" : "off"}` };
  }
  const prev = renderer.isOutputEnabled(key) ? "on" : "off";
  const on = arg === "on";
  renderer.setOutputEnabled(key, on);
  return { handled: true, reply: `${key}-output ${prev}->${arg}` };
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

export function parseNewCommand(input: string): { handled: boolean } {
  return { handled: /^\/(?:new|clear)\s*$/.test(input.trim()) };
}

export function parseCompactCommand(input: string): { handled: boolean } {
  return { handled: /^\/(?:compact|summarize)\s*$/.test(input.trim()) };
}

export function parseSessionsCommand(input: string): { handled: boolean } {
  return { handled: /^\/(?:sessions|resume)\s*$/.test(input.trim()) };
}

export function parseForkCommand(input: string): { handled: boolean } {
  return { handled: /^\/fork\s*$/.test(input.trim()) };
}

export function parseResyncCommand(input: string): { handled: boolean } {
  return { handled: /^\/resync\s*$/.test(input.trim()) };
}

