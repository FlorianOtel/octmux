import { Box, Text, useInput } from "ink";

type Props = {
  title: string;
  /**
   * Resources the permission request covers (C2.11). v2 can raise one ask for several
   * resources (compound commands). v1 always passes `[title]`, which renders as before.
   */
  resources?: string[];
  onAnswer: (a: "once" | "always" | "reject") => void;
};

/**
 * Returns the resources to list under the title, or `null` when the modal should show the
 * title alone. A single resource (every v1 ask, and any v2 ask with one resource) is not
 * listed, so v1's rendered output stays byte-identical.
 */
export function multiResourceList(resources: readonly string[] | undefined): readonly string[] | null {
  if (!resources || resources.length <= 1) return null;
  return resources;
}

export function PermissionModal({ title, resources, onAnswer }: Props) {
  useInput((input) => {
    if (input === "y") onAnswer("once");
    else if (input === "a") onAnswer("always");
    else if (input === "n") onAnswer("reject");
  });
  const list = multiResourceList(resources);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#fe8019" paddingX={1}>
      <Text color="#fe8019" bold>▶ Permission requested</Text>
      <Box marginTop={1}>
        <Text bold color="#ebdbb2">{title}</Text>
      </Box>
      {list ? (
        <Box flexDirection="column" marginTop={1}>
          {list.map((r, i) => (
            <Text key={i} color="#ebdbb2">{`  • ${r}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="#fabd2f" bold>y</Text>
          {" = allow once  "}
          <Text color="#fabd2f" bold>a</Text>
          {" = always  "}
          <Text color="#fabd2f" bold>n</Text>
          {" = reject"}
        </Text>
      </Box>
    </Box>
  );
}
