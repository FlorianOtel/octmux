import { Text } from "ink";

type Props = { title?: string; width: number; align?: "left" | "right" };

export function Rule({ title, width, align = "left" }: Props) {
  if (title) {
    if (align === "right") {
      // Format: "───────────── title ────"  (4 trailing dashes)
      const trailing = "─".repeat(4);
      const fill = "─".repeat(Math.max(0, width - 1 - title.length - 1 - trailing.length));
      return <Text dimColor>{fill} {title} {trailing}</Text>;
    }
    const side = "── ";
    const right = " " + "─".repeat(Math.max(0, width - side.length - title.length - 1));
    return <Text dimColor>{side}{title}{right}</Text>;
  }
  return <Text dimColor>{"─".repeat(width)}</Text>;
}
