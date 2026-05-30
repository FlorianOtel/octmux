import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ToggleBinding {
  key: string;      // display key, e.g. "^t"
  gate: string;     // output gate name, e.g. "tools"
  default: boolean; // initial on/off state
}

export interface TogglesConfig {
  bindings: ToggleBinding[];
}

// Hardcoded fallback matching the default toggle-keybindings.json content.
const FALLBACK: TogglesConfig = {
  bindings: [
    { key: "^t", gate: "tools",    default: true },
    { key: "^T", gate: "thinking", default: true },
  ],
};

export function loadTogglesConfig(): TogglesConfig {
  try {
    const path = join(homedir(), ".config", "octmux", "toggle-keybindings.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return FALLBACK;
    const bindings: ToggleBinding[] = parsed.filter(
      (e: unknown) =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as Record<string,unknown>).key === "string" &&
        typeof (e as Record<string,unknown>).gate === "string" &&
        typeof (e as Record<string,unknown>).default === "boolean"
    );
    return bindings.length > 0 ? { bindings } : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function getToggleDefaults(config: TogglesConfig): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const b of config.bindings) m.set(b.gate, b.default);
  return m;
}
