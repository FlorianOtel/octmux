import { Box, Text } from "ink";
import type { Role } from "../blocks.ts";
import stringWidth from "string-width";

// Strip ANSI escape sequences to get the plain-text length for wrapped-row counting.
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Count the number of visual terminal rows a single logical line occupies.
// A line of printable length 0 still occupies 1 row (the empty row).
// A line longer than `width` wraps: ceil(length / width) rows.
export function visualRows(line: string, width: number): number {
  const len = stringWidth(line);
  return Math.max(1, Math.ceil(len / Math.max(1, width)));
}

// Slice the last `maxRows` visual rows of an ANSI-split line array, bottom-up.
export function tailSliceByVisualRows(all: string[], width: number, maxRows: number): string[] {
  let used = 0;
  let start = all.length;
  for (let i = all.length - 1; i >= 0; i--) {
    const r = visualRows(all[i], width);
    if (used + r > maxRows) break;
    used += r;
    start = i;
  }
  if (start < all.length) return all.slice(start);          // ≥1 line fits — unchanged behaviour
  if (all.length > 0) {                                      // pathological: last line alone > maxRows
    const plain = stripAnsi(all[all.length - 1]);
    // Column-budget walk: accumulate visible width per code point (Array.from avoids
    // splitting surrogate pairs) so a CJK/emoji line cannot exceed the row budget.
    const budget = Math.max(1, maxRows * Math.max(1, width) - 1); // reserve 1 col for the marker
    let used = 0;
    let out = "";
    for (const ch of Array.from(plain)) {
      const cw = stringWidth(ch);
      if (used + cw > budget) break;
      out += ch;
      used += cw;
    }
    return [out + "…"];
  }
  return [];
}

export function ActiveBlock({ role, ansi, width, maxRows }:
  { role: Role | null; ansi: string; width: number; maxRows: number }) {
  if (!role || ansi.length === 0) return null;

  const all = ansi.split("\n");
  const lines = tailSliceByVisualRows(all, width, maxRows);

  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, idx) => (
        <Text key={idx}>{line.length === 0 ? " " : line}</Text>
      ))}
    </Box>
  );
}
