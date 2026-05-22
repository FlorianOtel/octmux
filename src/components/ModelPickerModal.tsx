import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type ModelPickerItem = {
  providerID: string;
  modelID: string;
  name: string;
  ctxLabel: string;
  isCurrent: boolean;
};

type Props = {
  items: ModelPickerItem[];
  initialIdx: number;
  onSelect: (item: ModelPickerItem) => void;
  onCancel: () => void;
};

export function ModelPickerModal({ items, initialIdx, onSelect, onCancel }: Props) {
  const [idx, setIdx] = useState(initialIdx);

  useInput((input, key) => {
    if (key.upArrow)   { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(items.length - 1, i + 1)); return; }
    if (key.return)    { onSelect(items[idx]); return; }
    if (key.escape)    { onCancel(); return; }
    // Number shortcuts 1–9
    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= items.length) { onSelect(items[n - 1]); return; }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>Model picker  (↑↓=navigate  Enter=select  Esc=cancel)</Text>
      {items.map((item, i) => (
        <Text key={i} bold={i === idx}>
          {i === idx ? ">" : " "} {i + 1}. {item.providerID}/{item.modelID}{"  "}{item.name}{"  ctx:"}{item.ctxLabel}{item.isCurrent ? "  ←current" : ""}
        </Text>
      ))}
    </Box>
  );
}
