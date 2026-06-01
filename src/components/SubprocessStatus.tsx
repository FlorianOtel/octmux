import { Box, Text } from "ink";
import { useState, useEffect } from "react";

// circleHalves spinner (sindresorhus/cli-spinners) — 1-char, 50 ms/frame.
const FRAMES = ["◐", "◓", "◑", "◒"] as const;

function ProcLine({ label, startTime }: { label: string; startTime: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 50);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const timer = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  return (
    <Text dimColor>{FRAMES[tick % FRAMES.length]} {label.padEnd(10)} {timer}</Text>
  );
}

export function SubprocessStatus({ thinking, tools, generating }: { thinking: number | null; tools: number | null; generating: number | null }) {
  if (thinking === null && tools === null && generating === null) return null;
  return (
    <Box flexDirection="column">
      {thinking   !== null && <ProcLine label="thinking"   startTime={thinking}   />}
      {tools      !== null && <ProcLine label="tools"      startTime={tools}      />}
      {generating !== null && <ProcLine label="generating" startTime={generating} />}
    </Box>
  );
}
