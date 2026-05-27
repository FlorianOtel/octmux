import { Box, Text, useInput } from "ink";
import { useState } from "react";

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
  onSelect: (item: SessionPickerItem) => void;
  onCancel: () => void;
};

export function SessionPickerModal({ items, initialIdx, onSelect, onCancel }: Props) {
  const [idx, setIdx] = useState(initialIdx);
  useInput((input, key) => {
    if (key.upArrow)   { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(items.length - 1, i + 1)); return; }
    if (key.return)    { onSelect(items[idx]); return; }
    if (key.escape)    { onCancel(); return; }
    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= Math.min(items.length, 9)) onSelect(items[n - 1]);
  });
  return (
    <Box flexDirection="column">
      <Text dimColor>Session picker  (↑↓=navigate  Enter=select  Esc=cancel)</Text>
      {items.map((item, i) => (
        <Text key={item.id} bold={i === idx}>
          {i === idx ? ">" : " "} {i + 1}. {item.id.slice(0, 8)}  {item.title || "(untitled)"}
          {item.parentID ? `  ← fork of ${item.parentID.slice(0, 8)}` : ""}
          {item.isCurrent ? "  ←current" : ""}
        </Text>
      ))}
    </Box>
  );
}
