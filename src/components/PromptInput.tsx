import { useInput, Text, Box } from "ink";
import { useReducer, useEffect, useRef } from "react";
import type { LineEditor } from "../editor.ts";

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
    if (key.return && !key.meta) {
      if (editor.isAtBottomRow()) editor.enterOnLastRow();
      else editor.moveDownRow();
    } else if (key.return && key.meta) {
      editor.insertNewline();
    } else if (key.backspace) {
      editor.backspace();
    } else if (key.delete) {
      editor.deleteForward();
    } else if (key.leftArrow && key.ctrl) {
      editor.wordBackward();
    } else if (key.rightArrow && key.ctrl) {
      editor.wordForward();
    } else if (key.leftArrow) {
      editor.moveBackward();
    } else if (key.rightArrow) {
      editor.moveForward();
    } else if (key.upArrow) {
      if (editor.isAtTopRow()) editor.histPrev();
      else editor.moveUpRow();
    } else if (key.downArrow) {
      if (editor.isAtBottomRow()) editor.histNext();
      else editor.moveDownRow();
    } else if (key.escape) {
      const now = Date.now();
      if (now - lastEscRef.current < 500) editor.clearBuffer();
      lastEscRef.current = now;
    } else if (key.meta && input === "b") {
      editor.wordBackward();
    } else if (key.meta && input === "f") {
      editor.wordForward();
    } else if (key.meta && input === "d") {
      editor.killWordForward();
    } else if (input === "\x01") { editor.moveLineStart(); }
    else if (input === "\x05") { editor.moveLineEnd(); }
    else if (input === "\x0b") { editor.killToEnd(); }
    else if (input === "\x15") { editor.killToStart(); }
    else if (input === "\x17") { editor.killWordBackward(); }
    else if (input === "\x19") { editor.yank(); }
    else if (input === "\x02") { editor.moveBackward(); }
    else if (input === "\x06") { editor.moveForward(); }
    else if (input === "\x10") { editor.histPrev(); }
    else if (input === "\x0e") { editor.histNext(); }
    else if (input && input >= " ") {
      editor.insert(input);
    }
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
          return (
            <Box key={i}>
              <Text>{prefix}{before}</Text>
              <Text inverse>{cursorChar}</Text>
              <Text>{after}</Text>
            </Box>
          );
        }
        return <Text key={i}>{prefix}{line}</Text>;
      })}
    </Box>
  );
}
