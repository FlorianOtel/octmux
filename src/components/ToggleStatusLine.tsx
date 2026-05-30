import { Text } from "ink";
import type { ToggleBinding } from "../config.ts";

type Props = {
  bindings: ToggleBinding[];
  gateStates: Record<string, boolean>;
};

/**
 * 3rd status line: shows each toggle keybinding and its current on/off state.
 * Key notation and labels use default terminal color (same as surrounding lines).
 * "on" is green bold, "off" is red bold — same palette as PermissionStatusLine.
 */
export function ToggleStatusLine({ bindings, gateStates }: Props) {
  const parts: (JSX.Element | string)[] = [];
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    const on = gateStates[b.gate] ?? b.default;
    if (i > 0) parts.push("  ");
    parts.push(
      <Text key={b.gate}>
        {`${b.key} /${b.gate}-output: `}
        <Text color={on ? "#1dde00" : "#cc241d"} bold>{on ? "on" : "off"}</Text>
      </Text>
    );
  }
  return <Text>{parts}</Text>;
}
