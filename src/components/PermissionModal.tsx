import { Box, Text, useInput } from "ink";

type Props = {
  title: string;
  onAnswer: (a: "once" | "always" | "reject") => void;
};

export function PermissionModal({ title, onAnswer }: Props) {
  useInput((input) => {
    if (input === "y") onAnswer("once");
    else if (input === "a") onAnswer("always");
    else if (input === "n") onAnswer("reject");
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#fe8019" paddingX={1}>
      <Text color="#fe8019" bold>▶ Permission requested</Text>
      <Box marginTop={1}>
        <Text bold color="#ebdbb2">{title}</Text>
      </Box>
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
