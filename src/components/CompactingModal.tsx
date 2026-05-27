import { Box, Text } from "ink";

export function CompactingModal() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">· compacting… (waiting for server)</Text>
      <Text dimColor>Input disabled until compaction completes.</Text>
    </Box>
  );
}
