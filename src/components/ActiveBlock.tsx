import { Box, Text } from "ink";
import type { Role } from "../blocks.ts";

export function ActiveBlock({ role, ansi, width }: { role: Role | null; ansi: string; width: number }) {
  // Return null if no role or empty ANSI
  if (!role || ansi.length === 0) {
    return null;
  }

  // Split ANSI on \n and render each line
  const lines = ansi.split("\n");

  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
      {/* Empty lines (post-split) render as space to avoid zero-height in Yoga layout */}
      {lines.filter(l => l.length === 0).map((_, idx) => (
        <Text key={`empty-${idx}`}>{" "}</Text>
      ))}
    </Box>
  );
}
