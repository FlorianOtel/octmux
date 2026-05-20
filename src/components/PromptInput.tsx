import { useInput, Text, Box } from "ink";
import { useReducer, useEffect, useRef } from "react";
import type { LineEditor } from "../editor.ts";
import { handleKey } from "../keybindings.ts";

type Props = {
  editor: LineEditor;
  disabled?: boolean;
  onSubmit: (text: string) => void;
};

export function PromptInput({ editor, disabled = false, onSubmit }: Props) {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const lastEscRef = useRef<number>(0);

  useEffect(() => {
    editor.on("changed", forceUpdate);
    editor.on("submit", onSubmit);
    return () => {
      editor.off("changed", forceUpdate);
      editor.off("submit", onSubmit);
    };
  }, [editor, onSubmit]);

  useInput((input, key) => {
    lastEscRef.current = handleKey(input, key, editor, lastEscRef.current);
  }, { isActive: !disabled });

  const lines = editor.getLines();
  const cursorRow = editor.getRow();
  const cursorCol = editor.getCol();

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const prefix = i === 0 ? "> " : "  ";
        if (i === cursorRow) {
          const before = line.slice(0, cursorCol);
          const cursorChar = line[cursorCol] ?? " ";
          const after = line.slice(cursorCol + 1);
          // Nested <Text> keeps the same element type as non-cursor rows so React
          // diffs in-place (no unmount/remount on row change → no garbled redraw).
          // A single Text flow also lets Yoga wrap the full line correctly, so the
          // cursor char stays visible even when text wraps past the terminal width.
          return (
            <Text key={i}>{prefix}{before}<Text inverse>{cursorChar}</Text>{after}</Text>
          );
        }
        return <Text key={i}>{prefix}{line}</Text>;
      })}
    </Box>
  );
}
