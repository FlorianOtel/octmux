import { Text } from "ink";

type Props = { title?: string; width: number };

export function Rule({ title, width }: Props) {
  if (title) {
    const side = "── ";
    const right = " " + "─".repeat(Math.max(0, width - side.length - title.length - 1));
    return <Text dimColor>{side}{title}{right}</Text>;
  }
  return <Text dimColor>{"─".repeat(width)}</Text>;
}
