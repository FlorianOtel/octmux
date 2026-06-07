import { test, expect } from "bun:test";
import { LineEditor } from "./editor.ts";

// Stage 3E.7.1 — Fix #6 + regression guards for LineEditor.insertText

test("insertText — cursor lands at end of trimmed last segment (Fix #6)", () => {
  const editor = new LineEditor();
  // Multi-line paste where the last segment ends with trailing whitespace
  // (mimicking terminal mouse-select padding past EOL).
  editor.insertText("line1\nline2\nlast-line   \t  ");
  const lines = editor.getLines();
  // Buffer content preserves the original (untrimmed) text — only the cursor
  // position is adjusted.
  expect(lines).toEqual(["line1", "line2", "last-line   \t  "]);
  expect(editor.getRow()).toBe(2);
  // Cursor lands at end of "last-line" (9 chars), NOT at end of padded line.
  expect(editor.getCol()).toBe("last-line".length);
});

test("insertText — single-line paste regression guard", () => {
  const editor = new LineEditor();
  editor.insertText("hello");
  expect(editor.getLines()).toEqual(["hello"]);
  expect(editor.getRow()).toBe(0);
  expect(editor.getCol()).toBe(5);
});

test("insertText — multi-line with empty trailing segment lands cursor at col 0", () => {
  const editor = new LineEditor();
  editor.insertText("a\nb\n");
  expect(editor.getLines()).toEqual(["a", "b", ""]);
  expect(editor.getRow()).toBe(2);
  expect(editor.getCol()).toBe(0);
});
