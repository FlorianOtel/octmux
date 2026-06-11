import { Box, Text } from "ink";
import type { Role } from "../blocks.ts";

// Strip ANSI escape sequences to get the plain-text length for wrapped-row counting.
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Count the number of visual terminal rows a single logical line occupies.
// A line of printable length 0 still occupies 1 row (the empty row).
// A line longer than `width` wraps: ceil(length / width) rows.
export function visualRows(line: string, width: number): number {
  const len = stripAnsi(line).length;
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
    const maxChars = Math.max(1, maxRows * Math.max(1, width) - 1); // reserve 1 for the marker
    return [plain.slice(0, maxChars) + "…"];                 // keep head; never blank
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
