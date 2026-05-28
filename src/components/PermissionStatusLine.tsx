import { Text } from "ink";

export type PermissionStatusLineProps = {
  permMode: "ask" | "allow" | "deny";
};

/**
 * Status line showing the current permission mode (ask/allow/deny).
 * Color-coded: deny=red, ask=yellow, allow=green. All mode labels bold.
 */
export function PermissionStatusLine({ permMode }: PermissionStatusLineProps) {
  let modeColor: string | undefined;
  switch (permMode) {
    case "deny":
      modeColor = "#cc241d";
      break;
    case "ask":
      modeColor = "#d79921";
      break;
    case "allow":
      modeColor = "#1dde00";
      break;
  }

  return (
    <Text>
      {"Permissions: "}
      <Text color={modeColor} bold>{permMode}</Text>
    </Text>
  );
}
