export type Role = "user" | "text" | "thinking" | "tool-call" | "tool-result" | "error" | "summary";

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
  reset:     "\x1b[0m",
  dim:       "\x1b[2m",
  bold:      "\x1b[1m",
  cyan:      "\x1b[36m",
  yellow:    "\x1b[33m",
  magenta:   "\x1b[35m",
  red:       "\x1b[31m",
  gray:      "\x1b[90m",
  invert:    "\x1b[7m",
  dimCyan:   "\x1b[2;36m",
  boldOff:   "\x1b[22m",
  italic:    "\x1b[3m",
  italicOff: "\x1b[23m",
};

// Apply inline markdown styling (bold, italic, inline code) to text.
// Regex-only transformation: no external dependencies.
// Returns the text with ANSI codes inserted for bold, italic, and dim-cyan inline code.
export function renderInlineMarkdown(content: string): string {
  // Step 1: Extract inline code spans. Replace each match with a unique placeholder
  // and accumulate the styled replacement.
  const codeSlots: string[] = [];
  let codeIndex = 0;
  const afterCodeExtraction = content.replace(/`([^`]+)`/g, (_, codeText) => {
    codeSlots.push(ANSI.dimCyan + codeText + ANSI.reset);
    return `\x00CODE_${codeIndex++}\x00`;
  });

  // Step 2: Bold pass. Replace **content** (content is one or more non-* chars)
  // with bold ANSI. Use \x1b[22m (bold-off) to preserve surrounding dim/italic.
  const afterBold = afterCodeExtraction.replace(/\*\*([^*]+)\*\*/g, (_, boldText) => {
    return ANSI.bold + boldText + ANSI.boldOff;
  });

  // Step 3: Italic _word_ pass. Match _word_ with non-word chars on both sides.
  // Regex: (^|[^\w])_([a-zA-Z0-9][^_]*[a-zA-Z0-9]|[a-zA-Z0-9])_(?=[^\w]|$)
  // Captures: $1 = char before, $2 = word content (letters/digits only at boundaries).
  // Ensures snake_case and __dunder__ are NOT matched.
  const afterUnderscoreItalic = afterBold.replace(
    /(^|[^\w])_([a-zA-Z0-9][^_]*[a-zA-Z0-9]|[a-zA-Z0-9])_(?=[^\w]|$)/g,
    (_, prefix, italicText) => {
      return prefix + ANSI.italic + italicText + ANSI.italicOff;
    }
  );

  // Step 4: Italic *word* pass. Match *word* (single asterisk, not adjacent to **).
  // Regex: (^|[^*])\*([^*]+)\*(?=[^*]|$)
  // Captures: $1 = char before (or start), $2 = word content.
  const afterAsteriskItalic = afterUnderscoreItalic.replace(
    /(^|[^*])\*([^*]+)\*(?=[^*]|$)/g,
    (_, prefix, italicText) => {
      return prefix + ANSI.italic + italicText + ANSI.italicOff;
    }
  );

  // Step 5: Re-expand code placeholders.
  const result = afterAsteriskItalic.replace(/\x00CODE_(\d+)\x00/g, (_, indexStr) => {
    const idx = parseInt(indexStr, 10);
    return codeSlots[idx] ?? "";
  });

  return result;
}

// Format one line of a block with role-specific ANSI prefix and colour.
// Caller is responsible for line-splitting; this function never receives \n.
export function formatLine(role: Role, line: string, isFirstLine: boolean): string {
  switch (role) {
    case "user":        return ANSI.invert + "> " + line + ANSI.reset;
    case "text":        return renderInlineMarkdown(line);
    case "thinking":    return ANSI.gray + "│ " + renderInlineMarkdown(line) + ANSI.reset;
    case "tool-call":   return ANSI.cyan + (isFirstLine ? "⚙ " : "  ") + line + ANSI.reset;
    case "tool-result": return ANSI.dim  + (isFirstLine ? "  ↳ " : "    ") + renderInlineMarkdown(line) + ANSI.reset;
    case "summary":     return ANSI.dim + "[compacted summary] " + renderInlineMarkdown(line) + ANSI.reset;
    case "error":       return ANSI.red  + "[error] " + line + ANSI.reset;
  }
}

// Convenience for finalised blocks committed all at once (not streamed line by line).
export function formatBlock(block: Block): string {
  const lines = block.text.split("\n");
  return lines.map((l, i) => formatLine(block.role, l, i === 0)).join("\n");
}
