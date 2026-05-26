export type Role = "user" | "text" | "thinking" | "tool-call" | "tool-result" | "error" | "rag";

export type Block = {
  id: string;
  role: Role;
  text: string;
  meta?: {
    toolName?: string;
    toolStatus?: "running" | "ok" | "error";
  };
};

// ANSI sequences (inline — no chalk dependency).
const ANSI = {
  reset:   "\x1b[0m",
  dim:     "\x1b[2m",
  bold:    "\x1b[1m",
  cyan:    "\x1b[36m",
  yellow:  "\x1b[33m",
  magenta: "\x1b[35m",
  red:     "\x1b[31m",
  gray:    "\x1b[90m",
  invert:  "\x1b[7m",
};

// Format one line of a block with role-specific ANSI prefix and colour.
// Caller is responsible for line-splitting; this function never receives \n.
export function formatLine(role: Role, line: string, isFirstLine: boolean): string {
  switch (role) {
    case "user":        return ANSI.invert + "> " + line + ANSI.reset;
    case "text":        return line;
    case "thinking":    return ANSI.gray + "│ " + line + ANSI.reset;
    case "tool-call":   return ANSI.cyan + (isFirstLine ? "⚙ " : "  ") + line + ANSI.reset;
    case "tool-result": return ANSI.dim  + (isFirstLine ? "  ↳ " : "    ") + line + ANSI.reset;
    case "error":       return ANSI.red  + "[error] " + line + ANSI.reset;
    case "rag":         return ANSI.magenta + (isFirstLine ? "▽ " : "  ") + line + ANSI.reset;
  }
}

// Convenience for finalised blocks committed all at once (not streamed line by line).
export function formatBlock(block: Block): string {
  const lines = block.text.split("\n");
  return lines.map((l, i) => formatLine(block.role, l, i === 0)).join("\n");
}
