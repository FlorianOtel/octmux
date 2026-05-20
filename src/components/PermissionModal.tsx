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
    <Box flexDirection="column">
      <Text>? Allow: {title}</Text>
      <Text dimColor>  y=once  a=always  n=reject</Text>
    </Box>
  );
}
