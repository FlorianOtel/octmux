import { Text } from "ink";

export type PermissionStatusLineProps = {
  permMode: "ask" | "allow" | "deny";
};

/**
 * Status line showing the current permission mode (ask/allow/deny).
 * Color-coded: deny=red, ask=yellow, allow=green.
 */
export function PermissionStatusLine({ permMode }: PermissionStatusLineProps) {
  let modeColor: string | undefined;
  switch (permMode) {
    case "deny":
      modeColor = "#cc241d"; // gruvbox red
      break;
    case "ask":
      modeColor = "#d79921"; // gruvbox yellow
      break;
    case "allow":
      modeColor = "#98971a"; // gruvbox green
      break;
  }

  return (
    <Text>
      {"Permissions: "}
      <Text color={modeColor}>{permMode}</Text>
    </Text>
  );
}
