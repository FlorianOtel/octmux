import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

/**
 * Compute the natural width (max content width) of each column across header and all rows.
 * @param header Array of column header cells, each with { tokens: any[] }
 * @param rows Array of row arrays, each row being an array of cells with { tokens: any[] }
 * @param parseCell Function that converts a cell OBJECT (with .tokens) to a rendered string
 * @returns Array of natural widths (one per column)
 */
export function naturalWidths(
  header: { tokens: any }[],
  rows: { tokens: any }[][],
  parseCell: (cell: any) => string
): number[] {
  const N = header.length;
  const natural: number[] = Array(N).fill(0);

  // Compute max width for each column across header
  for (let i = 0; i < N; i++) {
    const parsed = parseCell(header[i]);
    natural[i] = Math.max(natural[i], stringWidth(parsed));
  }

  // Compute max width for each column across all rows
  for (const row of rows) {
    for (let i = 0; i < N; i++) {
      const parsed = parseCell(row[i] ?? {});
      natural[i] = Math.max(natural[i], stringWidth(parsed));
    }
  }

  return natural;
}

/**
 * Compute the actual column widths given natural widths and available space.
 * Goal: fit all columns within realColumns space (including N+1 borders/padding).
 * Strategy: if natural widths fit, use them; otherwise floor proportionally and distribute remaining budget.
 * Always ensure colWidths[i] >= 3 (so contentWidth >= 1).
 *
 * @param natural Array of natural (unconstrained) widths per column
 * @param realColumns Available width in the terminal
 * @returns Array of column widths (including the 2-char padding built into cli-table3)
 */
export function computeColWidths(natural: number[], realColumns: number): number[] {
  const N = natural.length;
  if (N === 0) return [];

  // Space needed for cli-table3 borders: N columns + (N+1) border characters
  const borderSpace = N + 1;
  const availableForContent = realColumns - borderSpace;

  // If we have plenty of room, just add 2-char padding to each natural width
  const sumNatural = natural.reduce((a, b) => a + b, 0);
  const neededWithPadding = sumNatural + 2 * N;

  if (neededWithPadding <= availableForContent) {
    // Natural widths fit; add 2-char padding
    return natural.map((w) => w + 2);
  }

  // Widths don't fit; floor each column proportionally and distribute remainder
  let colWidths = natural.map((w) => Math.max(1, Math.floor((w / sumNatural) * availableForContent) - 2));

  // Clamp each to at least 3 (contentWidth >= 1, plus 2-char padding)
  colWidths = colWidths.map((w) => Math.max(3, w + 2));

  // Recalculate total and distribute any remaining budget
  let totalUsed = colWidths.reduce((a, b) => a + b, 0) + borderSpace;
  let remaining = realColumns - totalUsed;

  // Distribute remaining space proportionally (prefer wider natural columns)
  if (remaining > 0) {
    const maxIdx = natural.indexOf(Math.max(...natural));
    colWidths[maxIdx] += remaining;
  }

  // Shrink the widest column(s) toward the minimum (3) until within budget, or until
  // every column is already at the floor. Below realColumns = 4N+1 the table physically
  // cannot fit N bordered columns — we return the all-minimum widths and accept that the
  // pane is too narrow (unavoidable; bounded, defined output).
  const finalBorderSpace = colWidths.length + 1; // N+1 borders
  while (colWidths.reduce((a, b) => a + b, 0) + finalBorderSpace > realColumns) {
    const maxI = colWidths.indexOf(Math.max(...colWidths));
    if (colWidths[maxI] <= 3) break; // all at floor — cannot shrink further
    colWidths[maxI] -= 1;
  }

  return colWidths;
}

/**
 * Wrap a cell's parsed content to fit within a given contentWidth, preserving all content.
 * @param parsed Rendered cell content (may include ANSI codes)
 * @param contentWidth Maximum width (in visible characters, excluding ANSI codes)
 * @returns Wrapped text (hard-wrapped, no trim, no ellipsis)
 */
export function wrapCell(parsed: string, contentWidth: number): string {
  const safeWidth = Math.max(1, contentWidth);
  return wrapAnsi(parsed, safeWidth, { hard: true, trim: false });
}
