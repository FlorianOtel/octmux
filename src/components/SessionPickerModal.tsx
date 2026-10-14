import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { pickerWindow } from "./picker-window.ts";

export type SessionPickerItem = {
  id: string;
  title: string;
  parentID?: string;
  updatedAt: number;
  isCurrent: boolean;
};

type Props = {
  items: SessionPickerItem[];
  initialIdx: number;
  /** Max rows of items to render; computed by the parent from measured chrome height. */
  maxVisible?: number;
  onSelect: (item: SessionPickerItem) => void;
  onCancel: () => void;
};

export function SessionPickerModal({ items, initialIdx, onSelect, onCancel, maxVisible }: Props) {
  const [idx, setIdx] = useState(initialIdx);
  useInput((input, key) => {
    if (key.upArrow)   { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(items.length - 1, i + 1)); return; }
    if (key.return)    { onSelect(items[idx]); return; }
    if (key.escape)    { onCancel(); return; }
    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= Math.min(items.length, 9)) onSelect(items[n - 1]);
  });
  const { start, end } = pickerWindow(items.length, idx, maxVisible);
  return (
    <Box flexDirection="column">
      <Text dimColor>Session picker  (↑↓=navigate  Enter=select  Esc=cancel)</Text>
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {items.slice(start, end).map((item, j) => { const i = start + j; return (
        <Text key={item.id} bold={i === idx}>
          {i === idx ? ">" : " "} {i + 1}. {item.id.slice(0, 8)}  {item.title || "(untitled)"}
          {item.parentID ? `  ← fork of ${item.parentID.slice(0, 8)}` : ""}
          {item.isCurrent ? "  ←current" : ""}
        </Text>
      ); })}
      {end < items.length && <Text dimColor>  ↓ {items.length - end} more</Text>}
    </Box>
  );
}
