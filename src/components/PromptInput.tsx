import { useInput, Text, Box } from "ink";
import { useReducer, useEffect, useRef } from "react";
import type { LineEditor, Line, PastedBlock } from "../editor.ts";
import { handleKey } from "../keybindings.ts";
import { expandCommands } from "../command-registry.ts";

type Props = {
  editor: LineEditor;
  disabled?: boolean;
  overlayOpen?: boolean;
  onSubmit: (text: string) => void;
  onCyclePermMode?: () => void;
  onHelp?: () => void;
  onToggleTools?: () => void;
  onToggleThinking?: () => void;
  onResync?: () => void;
  onRedraw?: () => void;
  setPasteCallback?: (cb: (text: string) => void) => void;
};

export function PromptInput({ editor, disabled = false, overlayOpen = false, onSubmit, onCyclePermMode, onHelp, onToggleTools, onToggleThinking, onResync, onRedraw, setPasteCallback }: Props) {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const lastEscRef = useRef<number>(0);
  // Ink 5's useInput cannot distinguish physical Backspace (\x7f) from the
  // Delete key (\x1b[3~) — both produce key.delete=true with input=''.
  // We capture the raw stdin sequence here so handleKey can tell them apart.
  // prependListener ensures this fires before Ink's own stdin handler, so the
  // ref is populated before our useInput callback reads it.
  const rawSeqRef = useRef<string>('');
  // Stage 3E.7.1 Fix #3: double-Up timestamp (mirrors lastEscRef double-Esc
  // pattern). Single Up at row 0 no longer surprises into history; second Up
  // within 500 ms commits. Ctrl-P remains a single-press history alias.
  const lastUpRef = useRef<number>(0);

  useEffect(() => {
    editor.on("changed", forceUpdate);
    editor.on("submit", onSubmit);
    return () => {
      editor.off("changed", forceUpdate);
      editor.off("submit", onSubmit);
    };
  }, [editor, onSubmit]);

  useEffect(() => {
    const captureRaw = (data: Buffer) => { rawSeqRef.current = data.toString(); };
    process.stdin.prependListener('data', captureRaw);
    return () => { process.stdin.off('data', captureRaw); };
  }, []);

  useEffect(() => {
    if (!setPasteCallback) return;
    setPasteCallback((text) => {
      // Fix #5: drop paste while input is blocked (modal open). useInput is
      // already gated by isActive below, but the paste callback is a separate
      // path and would otherwise mutate the buffer behind the modal.
      if (disabled) return;
      editor.insertText(text);
      // Fix #1: force a full Ink repaint after multi-line paste. Same hook as
      // Ctrl-L (inkRaw.log.clear + lastOutput="" + onRender) — eliminates the
      // inline-mode render-vs-scrollback collision when buffer height grows.
      onRedraw?.();
    });
    return () => { setPasteCallback(() => {}); };
  }, [editor, setPasteCallback, disabled, onRedraw]);

  useInput((input, key) => {
    const result = handleKey(input, key, editor, lastEscRef.current, lastUpRef.current, rawSeqRef.current, overlayOpen ?? false, { onCyclePermMode, onHelp, onToggleTools, onToggleThinking, onResync, onRedraw });
    lastEscRef.current = result.lastEscTime;
    lastUpRef.current = result.lastUpTime;
  }, { isActive: !disabled });

  const lines = editor.getLines();
  const cursorRow = editor.getRow();
  const cursorCol = editor.getCol();

  // Determine if line 0's slash token matches a known command exactly.
  // The highlight is render-only; expandCommands() call is O(commands) ≈ O(10).
  // Coerce firstLine to string, since lines[0] may be a PastedBlock.
  const firstLine = typeof lines[0] === "string" ? lines[0] : "";
  let highlightEnd = 0; // how many characters of line 0 to render bold-cyan
  if (firstLine.startsWith("/")) {
    const token = firstLine.split(/\s/)[0];
    const known = expandCommands();
    if (known.includes(token)) {
      highlightEnd = token.length;
    }
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        // Type guard: if line is a PastedBlock, render placeholder instead of string logic
        if (typeof line !== "string") {
          const block = line as PastedBlock;
          const prefix = i === 0 ? "> " : "  ";
          if (i === cursorRow) {
            const placeholder = `[pasted text ${block.lineCount} lines — paste again to expand]`;
            return (
              <Text key={i}>
                {prefix}
                <Text inverse>{placeholder[0]}</Text>
                <Text dimColor>{placeholder.slice(1)}</Text>
              </Text>
            );
          }
          // Cursor not on block row: render whole placeholder dim
          return (
            <Text key={i}>
              {prefix}
              <Text dimColor>[pasted text {block.lineCount} lines — paste again to expand]</Text>
            </Text>
          );
        }
        const prefix = i === 0 ? "> " : "  ";
        if (i === cursorRow) {
          const before = line.slice(0, cursorCol);
          const cursorChar = line[cursorCol] ?? " ";
          const after = line.slice(cursorCol + 1);
          // Nested <Text> keeps the same element type as non-cursor rows so React
          // diffs in-place (no unmount/remount on row change → no garbled redraw).
          // A single Text flow also lets Yoga wrap the full line correctly, so the
          // cursor char stays visible even when text wraps past the terminal width.

          // Apply highlight to line 0 only when cursor is past the matched token.
          // Skip highlight when cursor is inside the matched token — splitting around the inverse-cursor char is fiddly and not worth it.
          if (i === 0 && highlightEnd > 0 && cursorCol > highlightEnd) {
            const highlightPart = line.slice(0, highlightEnd);
            const plainPart = line.slice(highlightEnd, cursorCol);
            return (
              <Text key={i}>{prefix}<Text bold color="cyan">{highlightPart}</Text>{plainPart}<Text inverse>{cursorChar}</Text>{after}</Text>
            );
          }

          return (
            <Text key={i}>{prefix}{before}<Text inverse>{cursorChar}</Text>{after}</Text>
          );
        }

        // For non-cursor rows on line 0, apply highlight if matched.
        if (i === 0 && highlightEnd > 0) {
          return <Text key={i}>{prefix}<Text bold color="cyan">{firstLine.slice(0, highlightEnd)}</Text>{firstLine.slice(highlightEnd)}</Text>;
        }

        return <Text key={i}>{prefix}{line}</Text>;
      })}
    </Box>
  );
}
