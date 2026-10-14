// Viewport math for picker modals. Ink inline mode emits ESC[2J ESC[3J (clear
// scrollback) whenever the live area is >= terminal rows; iTerm2 flags that as
// "attempted to clear scrollback history". Pickers must therefore stay shorter
// than the window.
export function pickerWindow(
  total: number,
  idx: number,
  rows: number = process.stdout.rows ?? 24,
): { start: number; end: number } {
  // Reserve ~16 rows: picker header + 2 indicator lines, plus the always-live
  // chrome below (status, rule, prompt, rule, status/perm/toggle lines,
  // ctrl-c hint) and ActiveBlock slack. The live area must stay < rows.
  const max = Math.max(3, rows - 16);
  if (total <= max) return { start: 0, end: total };
  const start = Math.min(Math.max(0, idx - Math.floor(max / 2)), total - max);
  return { start, end: start + max };
}
