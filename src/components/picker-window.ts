// Viewport math for picker modals. Ink inline mode emits ESC[2J ESC[3J (clear
// scrollback) whenever the live area is >= terminal rows; iTerm2 flags that as
// "attempted to clear scrollback history". Pickers must therefore stay shorter
// than the window. `maxVisible` is computed by the parent from the measured
// chrome height (app.tsx); the fallback is a conservative estimate.
export function pickerWindow(
  total: number,
  idx: number,
  maxVisible?: number,
): { start: number; end: number } {
  const max = Math.max(3, maxVisible ?? (process.stdout.rows ?? 24) - 16);
  if (total <= max) return { start: 0, end: total };
  const start = Math.min(Math.max(0, idx - Math.floor(max / 2)), total - max);
  return { start, end: start + max };
}
