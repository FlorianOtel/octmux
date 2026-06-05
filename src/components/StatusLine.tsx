import { Text, Box } from "ink";
import { formatTokens, contextLabel } from "../utils/formatters.ts";
import type { OrchestraBadge } from "../orchestra-watch.ts";

const SPINNER_GLYPHS = ['◐', '◓', '◑', '◒'] as const;
const ACTIVITY_FREEZE_MS = 120_000;
const ACTIVE_GREEN = '#1dde00';

/**
 * Helper: determine if lastActivityAt is within the active window.
 * Defaults to active (true) if lastActivityAt is undefined (backward compat).
 */
function isRecentlyActive(lastActivityAt: number | undefined): boolean {
  return lastActivityAt === undefined ? true : (Date.now() - lastActivityAt) <= ACTIVITY_FREEZE_MS;
}

export type StatusLineProps = {
  modelLabel: string;           // already prettified — "Sonnet 4.6 (1M context)"
  tokenUsage: { used: number; contextWindow: number } | null;
  projectName: string;
  gitBranch: string;            // "" if not in git repo
  isCompacting?: boolean;
  runningCost: number;
  orchestraBadge?: OrchestraBadge;
  sseHealth?: "ok" | "reconnecting" | "silent";
  spinnerFrame: number;
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
  spinnerFrame,
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

  // Full status line with downward-stacked orchestra rows
  return (
    <Box flexDirection="column">
      {/* Main status row */}
      <Text>
        {`✦ ${modelLabel} | ctx `}
        <Text color={barColor}>{bar}</Text>
        {` ${percentage}% ${usedStr}/${ctxStr} | Σ$${runningCost.toFixed(2)} | ◆ ${projectName}${gitSuffix}`}
        {orchestraBadge && (
          <Text color="#d3869b">
            {` | ♪ ${orchestraBadge.title}`}
            {(orchestraBadge.parserWarnings?.length ?? 0) > 0 ? " !" : ""}
          </Text>
        )}
        {sseHealthBadge}
        {isCompacting && <Text color="yellow"> · compacting…</Text>}
      </Text>

      {/* Mode row (only when orchestraBadge is not null) */}
      {orchestraBadge && (() => {
        const brainIsActive = isRecentlyActive(orchestraBadge.lastActivityAt);
        const modeText = `${orchestraBadge.mode}${orchestraBadge.parentModelLabel ? " " + orchestraBadge.parentModelLabel : ""}`;
        const spinnerGlyph = SPINNER_GLYPHS[brainIsActive ? spinnerFrame % 4 : 0];

        return (
          <Text>
            <Text color={ACTIVE_GREEN}>{spinnerGlyph} </Text>
            <Text color="#d3869b">{modeText}</Text>
          </Text>
        );
      })()}

      {/* Subagent rows (max 5, oldest first) */}
      {orchestraBadge && orchestraBadge.subagents.slice(0, 5).map((subagent) => {
        const agentIsActive = isRecentlyActive(subagent.lastActivityAt);
        const spinnerGlyph = SPINNER_GLYPHS[agentIsActive ? spinnerFrame % 4 : 0];
        const descText = subagent.description
          ? (subagent.description.length > 30 ? subagent.description.slice(0, 30) + "…" : subagent.description)
          : "";

        return (
          <Text key={subagent.sessionID}>
            <Text color={ACTIVE_GREEN}>{spinnerGlyph} </Text>
            <Text color="#d3869b">{subagent.agent}</Text>
            {subagent.model ? <Text dimColor> [{subagent.model}]</Text> : null}
            {descText ? <Text color="#d3869b">{" " + descText}</Text> : null}
          </Text>
        );
      })}

      {/* Overflow row */}
      {orchestraBadge && orchestraBadge.subagents.length > 5 && (
        <Text color="#d3869b" dimColor>{`+${orchestraBadge.subagents.length - 5} more`}</Text>
      )}
    </Box>
  );
}
