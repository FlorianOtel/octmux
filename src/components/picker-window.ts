// Viewport math for picker modals. Ink inline mode emits ESC[2J ESC[3J (clear
// scrollback) whenever the live area is >= terminal rows; iTerm2 flags that as
// "attempted to clear scrollback history". Pickers must therefore stay shorter
// than the window.
export function pickerWindow(
  total: number,
  idx: number,
  rows: number = process.stdout.rows ?? 24,
): { start: number; end: number } {
  // header + 2 indicator lines + prompt/status rows of slack
  const max = Math.max(5, rows - 8);
  if (total <= max) return { start: 0, end: total };
  const start = Math.min(Math.max(0, idx - Math.floor(max / 2)), total - max);
  return { start, end: start + max };
}
