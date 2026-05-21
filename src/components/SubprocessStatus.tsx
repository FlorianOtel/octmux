import { Box, Text } from "ink";
import { useState, useEffect } from "react";

// Spinner frames — 2-char wide so the label column stays stable.
const FRAMES = ["--", "->", ">>", "->"] as const;

function ProcLine({ label, startTime }: { label: string; startTime: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const timer = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  return (
    <Text dimColor>{FRAMES[tick % FRAMES.length]} {label.padEnd(10)} {timer}</Text>
  );
}

export function SubprocessStatus({ thinking, tools }: { thinking: number | null; tools: number | null }) {
  if (thinking === null && tools === null) return null;
  return (
    <Box flexDirection="column">
      {thinking !== null && <ProcLine label="thinking" startTime={thinking} />}
      {tools    !== null && <ProcLine label="tools"    startTime={tools}    />}
    </Box>
  );
}
