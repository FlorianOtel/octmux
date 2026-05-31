import { Text } from "ink";
import { formatTokens, contextLabel } from "../utils/formatters.ts";

export type StatusLineProps = {
  modelLabel: string;           // already prettified — "Sonnet 4.6 (1M context)"
  tokenUsage: { used: number; contextWindow: number } | null;
  projectName: string;
  gitBranch: string;            // "" if not in git repo
  isCompacting?: boolean;
  runningCost: number;
  orchestraBadge?: { mode: "brain" | "duo"; title: string; stage?: string | null } | null;
  sseHealth?: "ok" | "reconnecting" | "silent";
};

/**
 * Orchestra-style status bar showing model, context bar, cost placeholder, project, and git branch.
 * Single <Text> line to maintain fixed height.
 */
export function StatusLine({
  modelLabel,
  tokenUsage,
  projectName,
  gitBranch,
  isCompacting,
  runningCost,
  orchestraBadge,
  sseHealth,
}: StatusLineProps) {
  // Compute bar fill
  let filledCount = 0;
  let percentage = 0;
  let usedStr = "0K";
  let ctxStr: string;

  if (tokenUsage === null) {
    // No data yet; show empty bar
    filledCount = 0;
    percentage = 0;
    usedStr = "0K";
    ctxStr = "?";
  } else {
    const { used, contextWindow } = tokenUsage;
    percentage = Math.round((used / contextWindow) * 100);
    filledCount = Math.max(0, Math.min(20, Math.round((used / contextWindow) * 20)));
    usedStr = formatTokens(used);
    ctxStr = formatTokens(contextWindow);
  }

  // Build bar: 20 cells total
  let barColor: string | undefined;
  if (percentage >= 80) {
    barColor = "#cc241d"; // gruvbox red
  } else if (percentage >= 50) {
    barColor = "#d79921"; // gruvbox yellow
  } else if (percentage > 0) {
    barColor = "#98971a"; // gruvbox green
  }
  // else: no color at 0% (default dim)

  const bar = "▓".repeat(filledCount) + "░".repeat(20 - filledCount);

  // Build git branch suffix
  const gitSuffix = gitBranch ? ` | ⎇ ${gitBranch}` : "";

  // SSE health badge
  let sseHealthBadge: JSX.Element | null = null;
  if (sseHealth === "ok") {
    sseHealthBadge = <Text dimColor> | SSE ok</Text>;
  } else if (sseHealth === "reconnecting") {
    sseHealthBadge = <Text color="yellow"> | SSE reconnect…</Text>;
  } else if (sseHealth === "silent") {
    sseHealthBadge = <Text color="yellow"> | SSE silent</Text>;
  }

  // Full status line: color only the bar, not the rest
  return (
    <Text>
      {`✦ ${modelLabel} | ctx `}
      <Text color={barColor}>{bar}</Text>
      {` ${percentage}% ${usedStr}/${ctxStr} | Σ$${runningCost.toFixed(2)} | ◆ ${projectName}${gitSuffix}`}
      {orchestraBadge && (
        <Text color="#d3869b">{` | ♪ ${orchestraBadge.mode === "duo" ? "plan" : "brain"} ${orchestraBadge.title}`}</Text>
      )}
      {orchestraBadge?.stage && (
        <Text color="#d79921">{`  ▶ ${orchestraBadge.stage}`}</Text>
      )}
      {sseHealthBadge}
      {isCompacting && <Text color="yellow"> · compacting…</Text>}
    </Text>
  );
}
