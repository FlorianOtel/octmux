import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import { formatLine } from "../blocks.ts";
import { Visibility } from "./visibility.ts";
import type { CommittedLine } from "./types.ts";
import { StdoutRenderer } from "./stdout.ts";
import { BlockBufferRenderer } from "./block-buffer.ts";
import { marked } from "marked";
import markedTerminal from "marked-terminal";
import chalk from "chalk";

// Pin chalk.level for determinism
chalk.level = 3;

describe("BlockBufferRenderer", () => {
  describe("Step 1.1 — Interface + scaffold", () => {
    test("appendToBlock for text role buffers full multi-line text (not just trailing partial)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "test-part-1";
      
      // First beginBlock, then append
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "line1\nline2\npart");
      
      // The FULL buffer should be preserved, not just "part"
      expect(renderer.getActiveBlock()).toEqual({
        role: "text" as const,
        text: "line1\nline2\npart",
      });
      
      // Nothing should be committed yet — only endBlock commits
      expect(renderer.getCommitted()).toEqual([]);
    });

    test("endBlock commits the multi-line block", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "test-part-2";
      
      // First beginBlock, then append, then endBlock
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "line1\nline2\npart");
      renderer.endBlock(partID, "ok");
      
      // End the block
      renderer.endBlock(partID, "ok");
      
      // Three lines should be committed at once
      expect(renderer.getCommitted()).toHaveLength(3);
      expect(renderer.getActiveBlock()).toBeNull();
      
      // Verify the committed lines are correct
      expect(renderer.getCommitted()[0].ansi).toBe(formatLine("text", "line1", false));
      expect(renderer.getCommitted()[1].ansi).toBe(formatLine("text", "line2", false));
      expect(renderer.getCommitted()[2].ansi).toBe(formatLine("text", "part", false));
    });

    test("getActiveBlockAnsi returns joined multi-line formatted text during appendToBlock", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "test-part-3";
      
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "line1\nline2\npart");
      
      const active = renderer.getActiveBlockAnsi();
      expect(active).toContain(formatLine("text", "line1", false));
      expect(active).toContain(formatLine("text", "line2", false));
      expect(active).toContain(formatLine("text", "part", false));
    });

    test("subsequent text block after clean endBlock has no leftover state", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID1 = "test-part-4a";
      const partID2 = "test-part-4b";
      
      // First block
      renderer.beginBlock(partID1, "text");
      renderer.appendToBlock(partID1, "hello");
      renderer.endBlock(partID1, "ok");
      
      // Second block after first is clean
      renderer.beginBlock(partID2, "text");
      renderer.appendToBlock(partID2, "world");
      
      expect(renderer.getActiveBlock()).toEqual({
        role: "text" as const,
        text: "world",
      });
    });

    test("non-text role appendToBlock produces committed lines and empty active block", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "test-part-5";
      
      renderer.beginBlock(partID, "thinking");
      renderer.appendToBlock(partID, "foo\nbar");
      
      // Non-text role: committed lines, no active text block
      expect(renderer.getCommitted()).toHaveLength(2);
      expect(renderer.getActiveBlock()).toBeNull();
      expect(renderer.getActiveBlockAnsi()).toBe("");
    });

    test("commitTurnEnd flushes active text block", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "test-part-6";
      
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "flush-me");
      
      renderer.commitTurnEnd();
      
      // Should have 1 committed line (the text) + 2 blank separator lines
      expect(renderer.getCommitted()).toHaveLength(3);
      expect(renderer.getActiveBlock()).toBeNull();
    });

    test("setWidth updates _width", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      expect(renderer._width).toBe(80);
      
      renderer.setWidth(120);
      expect(renderer._width).toBe(120);
    });

    test("byte-identical reference: StdoutRenderer and BlockBufferRenderer produce same ANSI", () => {
      // This is the load-bearing test that StdoutRenderer is the byte-identical reference
      const stdoutRenderer = new StdoutRenderer(new Visibility());
      const blockBufferRenderer = new BlockBufferRenderer(new Visibility());
      
      const source = "Hello\nWorld\nTest";
      
      // StdoutRenderer: line-by-line commit
      stdoutRenderer.beginBlock("std-part", "text");
      stdoutRenderer.appendToBlock("std-part", "Hello\nWorld\nTest");
      const stdCommit1 = stdoutRenderer.getCommitted();
      const stdActive = stdoutRenderer.getActiveBlock();
      stdoutRenderer.endBlock("std-part", "ok");
      
      // BlockBufferRenderer: buffer until endBlock
      blockBufferRenderer.beginBlock("bb-part", "text");
      blockBufferRenderer.appendToBlock("bb-part", "Hello\nWorld\nTest");
      const bbActive = blockBufferRenderer.getActiveBlock();
      blockBufferRenderer.endBlock("bb-part", "ok");
      const bbCommit1 = blockBufferRenderer.getCommitted();
      
      // Both should produce the same committed lines
      expect(stdCommit1).toHaveLength(3);
      expect(bbCommit1).toHaveLength(3);
      
      for (let i = 0; i < 3; i++) {
        expect(stdCommit1[i].ansi).toBe(bbCommit1[i].ansi);
      }
      
      // Active block should also match
      expect(stdActive?.text).toBe("Test");
      expect(bbActive?.text).toBe("Hello\nWorld\nTest");
    });
});

 describe("Markdown construct tests", () => {
    test("heading text is buffered correctly", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("h-part", "text");
      renderer.appendToBlock("h-part", "# Heading");
      expect(renderer.getActiveBlock()).toEqual({
        role: "text" as const,
        text: "# Heading",
      });
      expect(renderer.getActiveBlockAnsi()).toContain("# Heading");
      renderer.endBlock("h-part", "ok");
    });

    test("fenced code block text is buffered correctly", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("code-part", "text");
      renderer.appendToBlock("code-part", "```javascript\nfunction x() {}\n```");
      expect(renderer.getActiveBlock()).toEqual({
        role: "text" as const,
        text: "```javascript\nfunction x() {}\n```",
      });
      renderer.endBlock("code-part", "ok");
    });

    test("bulleted list text is buffered correctly", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("list-part", "text");
      renderer.appendToBlock("list-part", "- Item 1\n- Item 2");
      expect(renderer.getActiveBlock()).toEqual({
        role: "text" as const,
        text: "- Item 1\n- Item 2",
      });
      renderer.endBlock("list-part", "ok");
    });

    test("blockquote text is buffered correctly", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("quote-part", "text");
      renderer.appendToBlock("quote-part", "> A quote");
      expect(renderer.getActiveBlock()).toEqual({
        role: "text" as const,
        text: "> A quote",
      });
      renderer.endBlock("quote-part", "ok");
    });
  });

});
