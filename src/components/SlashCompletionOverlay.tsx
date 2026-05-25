import { Box, Text, useInput } from "ink";

type Props = {
  candidates: string[];
  selectedIdx: number;
  onSelect: (candidate: string) => void;
  onCancel: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

export function SlashCompletionOverlay({
  candidates,
  selectedIdx,
  onSelect,
  onCancel,
  onMoveUp,
  onMoveDown,
}: Props) {
  useInput((input, key) => {
    if (key.tab) {
      if (candidates.length > 0) {
        onSelect(candidates[selectedIdx]);
      }
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      onMoveUp();
      return;
    }
    if (key.downArrow) {
      onMoveDown();
      return;
    }
  });

  // Display: up to 10 candidates, or 10 + "…N more" if more than 10
  const displayCount = Math.min(candidates.length, 10);
  const hasMore = candidates.length > 10;
  const moreCount = candidates.length - 10;

  return (
    <Box flexDirection="column">
      <Text dimColor>slash commands  (↑↓=navigate  Tab=complete  Esc=dismiss)</Text>
      {candidates.slice(0, displayCount).map((candidate, i) => (
        <Text key={i} bold={i === selectedIdx}>
          {i === selectedIdx ? ">" : " "} {candidate}
        </Text>
      ))}
      {hasMore && <Text dimColor>  …{moreCount} more</Text>}
    </Box>
  );
}
