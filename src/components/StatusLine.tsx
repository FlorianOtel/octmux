import { Text } from "ink";
import { useSyncExternalStore } from "react";
import type { Visibility } from "../renderer/visibility.ts";

export function StatusLine({ vis }: { vis: Visibility }) {
  const summary = useSyncExternalStore(
    (cb) => { vis.on("changed", cb); return () => vis.off("changed", cb); },
    () => vis.hiddenSummary(),
  );
  if (summary.length === 0) return <Text dimColor>[idle]</Text>;
  const parts = summary.map(s => {
    const icon = s.role === "thinking" ? "T" : s.role === "tool-call" ? "⚙" : "·";
    return `${icon}·${s.count}`;
  });
  return <Text dimColor>[idle]  hidden: {parts.join(" ")}</Text>;
}
