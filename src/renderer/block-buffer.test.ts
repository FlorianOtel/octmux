// IMPORTANT: set FORCE_COLOR before any module-level chalk consumer constructs.
// The BlockBufferRenderer constructor runs `_setupChalkLevel()` which inspects
// `process.env.FORCE_COLOR` and `process.stdout.isTTY` — under `bun test` there
// is no TTY, so without FORCE_COLOR the renderer would fall back to chalk.level=0
// and the markdown-construct tests below (which check for specific ANSI codes)
// would fail. Setting FORCE_COLOR=1 here forces the colored path uniformly.
process.env.FORCE_COLOR = "1";

import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import { formatLine } from "../blocks.ts";
import { Visibility } from "./visibility.ts";
import type { CommittedLine } from "./types.ts";
import { StdoutRenderer } from "./stdout.ts";
import { BlockBufferRenderer } from "./block-buffer.ts";
import { Marked, marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";

// Pin chalk.level for determinism (C1.4 invariant test relies on byte-equal ANSI).
chalk.level = 3;

// Build a fresh Marked instance with the SAME aesthetic config as
// BlockBufferRenderer's `_makeMarkedInstance` — this is the "commit path"
// reference renderer for the C1.4 byte-equal invariant test.
function makeCommitPathMarked(): Marked {
  const m = new Marked();
  m.use(markedTerminal({
    heading: chalk.cyan.bold,
    firstHeading: chalk.cyan.bold,
    codespan: chalk.rgb(147, 161, 199),
    code: chalk.reset,
    listitem: chalk.reset,
    blockquote: chalk.gray.italic,
    hr: chalk.dim,
    link: chalk.reset,
    href: chalk.blue.underline,
    strong: chalk.bold,
    em: chalk.italic,
    del: chalk.strikethrough,
    reflowText: false,
    tab: 2,
    unescape: true,
    emoji: true,
  }) as any);
  return m;
}

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

    test("endBlock commits the multi-line block (text role goes through marked)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "test-part-2";

      // First beginBlock, then append, then endBlock
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "line1\nline2\npart");
      // Capture the live ANSI BEFORE endBlock — C1.4 says the commit uses
      // the SAME stored _activeBlockAnsi (no re-render at commit time).
      const liveAnsi = renderer.getActiveBlockAnsi();
      renderer.endBlock(partID, "ok");

      const committed = renderer.getCommitted();
      expect(renderer.getActiveBlock()).toBeNull();
      // C1.4: committed lines, joined on \n, must equal the stored live ANSI.
      const joined = committed.map(l => l.ansi).join("\n");
      expect(joined).toBe(liveAnsi);
      // Plain text without markdown syntax still flows through marked
      // (rendered as a single paragraph) so the line content is preserved.
      expect(joined).toContain("line1");
      expect(joined).toContain("line2");
      expect(joined).toContain("part");
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

    test("StdoutRenderer and BlockBufferRenderer have DIFFERENT text-role rendering (1.2 contract change)", () => {
      // 10.1's "byte-identical reference" test asserted that the new
      // BlockBufferRenderer matched StdoutRenderer's per-line formatLine for
      // text role. 10.2 deliberately diverges: text-role now flows through
      // marked + marked-terminal. The two renderers MUST differ for the text
      // role — and that's a feature, not a bug.
      const stdoutRenderer = new StdoutRenderer(new Visibility());
      const blockBufferRenderer = new BlockBufferRenderer(new Visibility());

      stdoutRenderer.beginBlock("std-part", "text");
      stdoutRenderer.appendToBlock("std-part", "Hello\nWorld\nTest");
      const stdActive = stdoutRenderer.getActiveBlock();
      stdoutRenderer.endBlock("std-part", "ok");
      const stdCommit = stdoutRenderer.getCommitted();

      blockBufferRenderer.beginBlock("bb-part", "text");
      blockBufferRenderer.appendToBlock("bb-part", "Hello\nWorld\nTest");
      const bbActive = blockBufferRenderer.getActiveBlock();
      blockBufferRenderer.endBlock("bb-part", "ok");
      const bbCommit = blockBufferRenderer.getCommitted();

      // Both contain the content; the buffering contract still differs:
      //   - StdoutRenderer's active is the trailing partial only
      //   - BlockBufferRenderer's active is the FULL multi-line buffer
      expect(stdActive?.text).toBe("Test");
      expect(bbActive?.text).toBe("Hello\nWorld\nTest");

      // Both must surface the content somewhere in their committed ANSI.
      const stdJoined = stdCommit.map(l => l.ansi).join("\n");
      const bbJoined = bbCommit.map(l => l.ansi).join("\n");
      expect(stdJoined).toContain("Hello");
      expect(bbJoined).toContain("Hello");
    });
});

 describe("Step 1.2 — Markdown construct ANSI wiring", () => {
    // chalk@5 emits ANSI codes like "\x1b[36m" for cyan, "\x1b[1m" for bold.
    // We assert presence of the expected ANSI marker in the rendered output —
    // this proves the aesthetic config is wired through marked-terminal.

    test("heading renders with cyan-bold ANSI (chalk.cyan.bold)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("h-part", "text");
      renderer.appendToBlock("h-part", "# Heading One");
      const ansi = renderer.getActiveBlockAnsi();
      // chalk.cyan = \x1b[36m, chalk.bold = \x1b[1m
      expect(ansi).toContain("\x1b[36m");
      expect(ansi).toContain("\x1b[1m");
      expect(ansi).toContain("Heading One");
      renderer.endBlock("h-part", "ok");
    });

    test("fenced code block renders with reset ANSI (chalk.reset, no color on body)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("code-part", "text");
      renderer.appendToBlock("code-part", "```js\nconst x = 1;\n```");
      const ansi = renderer.getActiveBlockAnsi();
      // code body should appear; with chalk.reset wrapping it should NOT have
      // a color escape applied around the body itself (no \x1b[33m yellow which
      // is marked-terminal's DEFAULT we explicitly overrode with chalk.reset).
      expect(ansi).toContain("const x = 1;");
      expect(ansi).not.toContain("\x1b[33m");
      renderer.endBlock("code-part", "ok");
    });

    test("bulleted list renders with listitem ANSI (chalk.reset wrapper, \\x1b[0m)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("list-part", "text");
      renderer.appendToBlock("list-part", "- Item 1\n- Item 2");
      const ansi = renderer.getActiveBlockAnsi();
      // listitem = chalk.reset → \x1b[0m wrapper
      expect(ansi).toContain("\x1b[0m");
      expect(ansi).toContain("Item 1");
      expect(ansi).toContain("Item 2");
      // bullet marker present (marked-terminal uses "*" for ul by default)
      expect(ansi).toMatch(/\*\s+\x1b\[0mItem 1/);
      renderer.endBlock("list-part", "ok");
    });

    test("blockquote renders with gray-italic ANSI (chalk.gray.italic)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("quote-part", "text");
      renderer.appendToBlock("quote-part", "> A quoted line");
      const ansi = renderer.getActiveBlockAnsi();
      // chalk.gray = \x1b[90m, chalk.italic = \x1b[3m
      expect(ansi).toContain("\x1b[90m");
      expect(ansi).toContain("\x1b[3m");
      expect(ansi).toContain("quoted line");
      renderer.endBlock("quote-part", "ok");
    });
  });

  describe("Step 1.2 — C1.4 byte-equal invariant", () => {
    test("C1.4 commit-on-end byte-equal invariant: live == committed for /var/tmp/render-this-as-markdown.md", async () => {
      // (a) chalk.level pinned at top of file.
      // (b) read source from /var/tmp/render-this-as-markdown.md
      const source = await Bun.file("/var/tmp/render-this-as-markdown.md").text();

      // (c) construct a BlockBufferRenderer
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "c14-part";
      renderer.beginBlock(partID, "text");

      // (d) feed source via incremental appendToBlock — ~64-byte chunks,
      // with 1ms gaps simulating SSE deltas.
      const chunkSize = 64;
      for (let i = 0; i < source.length; i += chunkSize) {
        renderer.appendToBlock(partID, source.slice(i, i + chunkSize));
        await new Promise(r => setTimeout(r, 1));
      }

      // (e) capture final live ANSI
      const liveAnsi = renderer.getActiveBlockAnsi();

      // (f) endBlock and capture the committed lines for this block
      const committedBefore = renderer.getCommitted().length;
      renderer.endBlock(partID, "ok");
      const committedAfter = renderer.getCommitted();
      const newlyCommitted = committedAfter.slice(committedBefore);
      const committedAnsiJoined = newlyCommitted.map(l => l.ansi).join("\n");

      // (g) re-render via the "commit path" — fresh Marked instance with the
      // same aesthetic config, parsing the full source in one shot. Apply the
      // same trailing-newline strip as `_renderActiveTextAnsi` does.
      const commitPathAnsiRaw = makeCommitPathMarked().parse(source) as string;
      const commitPathAnsi = commitPathAnsiRaw.replace(/\n+$/, "");

      // (h) byte-equal assertions:
      //   liveAnsi === commitPathAnsi  AND  committedAnsiJoined === liveAnsi
      expect(liveAnsi).toBe(commitPathAnsi);
      expect(committedAnsiJoined).toBe(liveAnsi);
    });
  });

});
