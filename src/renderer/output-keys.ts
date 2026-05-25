import type { Role } from "../blocks.ts";

// Maps each output role to the output gate key it belongs to.
// tool-call and tool-result share one "tools" gate so the full
// call → result sequence can be toggled together.
export const OUTPUT_KEY: Partial<Record<Role, string>> = {
  thinking:      "thinking",
  "tool-call":   "tools",
  "tool-result": "tools",
};

// Unique deduped list of all output gate keys.
export const OUTPUT_KEYS: readonly string[] = [...new Set(Object.values(OUTPUT_KEY))];
