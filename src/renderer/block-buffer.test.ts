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
      // Stage 10.4: include trailing \n to trigger flush-on-\n (debounce
      // would otherwise hold the render for ~100 ms). The markdown construct
      // (heading) is unchanged.
      renderer.appendToBlock("h-part", "# Heading One\n");
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
      // Stage 10.4: include trailing \n to trigger flush-on-\n (debounce
      // would otherwise hold the render for ~100 ms). Markdown unchanged.
      renderer.appendToBlock("quote-part", "> A quoted line\n");
      const ansi = renderer.getActiveBlockAnsi();
      // chalk.gray = \x1b[90m, chalk.italic = \x1b[3m
      expect(ansi).toContain("\x1b[90m");
      expect(ansi).toContain("\x1b[3m");
      expect(ansi).toContain("quoted line");
      renderer.endBlock("quote-part", "ok");
    });
  });

  describe("Step 1.4 — Debounce", () => {
    test("100 ms trailing-edge debounce: non-newline delta defers emit until timer fires", async () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "debounce-part-1";
      // Stage 10.7: getActiveBlockAnsi() lazy-flushes on read, so we
      // can't use it as a probe for "no automatic render happened yet".
      // Count `changed` emits instead — the underlying contract.
      let emitCount = 0;
      renderer.on("changed", () => { emitCount++; });
      try {
        renderer.beginBlock(partID, "text");

        // (a) append a non-newline delta — should NOT trigger an immediate emit.
        renderer.appendToBlock(partID, "hello");

        // (b) no emit yet — debounce holds it.
        expect(emitCount).toBe(0);
        // Sanity: the active block buffer DOES contain the text.
        expect(renderer.getActiveBlock()?.text).toBe("hello");

        // (c) wait 110 ms for the trailing-edge timer to fire.
        await new Promise(r => setTimeout(r, 110));

        // (d) the timer has fired exactly once, emitting one `changed`.
        //     Live ANSI now contains the formatted "hello".
        expect(emitCount).toBe(1);
        const ansiAfterFirst = renderer.getActiveBlockAnsi();
        expect(ansiAfterFirst).not.toBe("");
        expect(ansiAfterFirst).toContain("hello");

        // (e) fire two rapid non-newline appends. The first call's timer
        //     should be cancelled by the second call's reset, so still
        //     only one PENDING timer (and no extra emits in the meantime).
        const emitCountBefore = emitCount;
        renderer.appendToBlock(partID, " world");
        renderer.appendToBlock(partID, "!");
        expect(emitCount).toBe(emitCountBefore); // no extra emit yet

        // (f) wait 110 ms for the second timer to fire.
        await new Promise(r => setTimeout(r, 110));

        // (g) exactly one more emit fired (the second timer); live ANSI
        //     now contains the full "hello world!" — the interleaved
        //     appends did NOT cause two extra renders.
        expect(emitCount).toBe(emitCountBefore + 1);
        const ansiAfterSecond = renderer.getActiveBlockAnsi();
        expect(ansiAfterSecond).toContain("hello world!");
        expect(renderer.getActiveBlock()?.text).toBe("hello world!");
      } finally {
        // Test-isolation cleanup: cancel any leftover timer so a failing
        // assertion above doesn't leak a timer into the next test.
        if (renderer._textDebounce !== null) {
          clearTimeout(renderer._textDebounce);
          renderer._textDebounce = null;
        }
      }
    });

    test("flush-on-newline: a delta containing \\n triggers immediate render", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "debounce-part-2";
      try {
        renderer.beginBlock(partID, "text");
        // A delta WITH a newline must render immediately (no wait needed).
        renderer.appendToBlock(partID, "first line\n");
        const ansi = renderer.getActiveBlockAnsi();
        expect(ansi).not.toBe("");
        expect(ansi).toContain("first line");
      } finally {
        if (renderer._textDebounce !== null) {
          clearTimeout(renderer._textDebounce);
          renderer._textDebounce = null;
        }
      }
    });

    test("endBlock pre-flush captures latest live ANSI even mid-debounce (C1.4 preserved)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "debounce-part-3";
      try {
        renderer.beginBlock(partID, "text");
        // Non-newline delta — internal `_activeBlockAnsi` is held by the
        // debounce timer (no automatic flush-on-\n, no timer fire yet).
        renderer.appendToBlock(partID, "mid-debounce content");

        // Stage 10.7: getActiveBlockAnsi() lazy-flushes on read, so a
        // consumer that calls it mid-debounce sees the up-to-date ANSI
        // (NOT "" as it returned pre-Stage-11.1). This is the explicit
        // call-time C1.4 freshness property.
        expect(renderer.getActiveBlockAnsi()).toContain("mid-debounce content");

        // Re-arm the debounce path for the endBlock pre-flush assertion:
        // the lazy flush above cleared the timer; a fresh delta schedules
        // a new one so we can verify endBlock pre-flushes it.
        renderer.appendToBlock(partID, " trailing");

        // endBlock arrives within the 100 ms window — pre-flush must
        // synchronously render so the commit captures the latest ANSI.
        const committedBefore = renderer.getCommitted().length;
        renderer.endBlock(partID, "ok");
        const committedAfter = renderer.getCommitted();
        const newlyCommitted = committedAfter.slice(committedBefore);
        const joined = newlyCommitted.map(l => l.ansi).join("\n");

        // The committed ANSI must contain BOTH the original delta and
        // the trailing delta — proving the pre-flush fired and
        // `_commitActiveText` split a non-stale string.
        expect(joined).toContain("mid-debounce content");
        expect(joined).toContain("trailing");
        // No leftover timer (pre-flush clears it).
        expect(renderer._textDebounce).toBeNull();
        // Active block is gone.
        expect(renderer.getActiveBlock()).toBeNull();
      } finally {
        if (renderer._textDebounce !== null) {
          clearTimeout(renderer._textDebounce);
          renderer._textDebounce = null;
        }
      }
    });
  });

  describe("Stage 10.6 — getActiveBlock identity stability (streaming-freeze regression)", () => {
    test("consecutive calls with no appends return the same object reference", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "identity-part-1";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "hello");
      const first = renderer.getActiveBlock();
      const second = renderer.getActiveBlock();
      expect(first).not.toBeNull();
      expect(first === second).toBe(true);
    });

    test("reference changes after appendToBlock (new string identity = cache invalidation)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "identity-part-2";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "first");
      const before = renderer.getActiveBlock();
      expect(before!.text).toBe("first");
      renderer.appendToBlock(partID, " second");
      const after = renderer.getActiveBlock();
      expect(after!.text).toBe("first second");
      expect(before === after).toBe(false);
    });

    test("returns null after endBlock (lifecycle guard)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "identity-part-3";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "some text");
      const cached = renderer.getActiveBlock();
      expect(cached).not.toBeNull();
      renderer.endBlock(partID, "ok");
      expect(renderer.getActiveBlock()).toBeNull();
    });

    test("multiple appends: each new append returns a new reference, same-append calls return same reference", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "identity-part-4";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "a");
      const ref1a = renderer.getActiveBlock();
      const ref1b = renderer.getActiveBlock();
      expect(ref1a === ref1b).toBe(true);
      renderer.appendToBlock(partID, "b");
      const ref2a = renderer.getActiveBlock();
      const ref2b = renderer.getActiveBlock();
      expect(ref2a === ref2b).toBe(true);
      expect(ref1a === ref2a).toBe(false);
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

  describe("Stage 10.7 — _commitActiveText array-replace", () => {
    test("getCommitted() reference changes after _commitActiveText (array-replace identity)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("p", "text");
      renderer.appendToBlock("p", "hello\n");
      const before = renderer.getCommitted();
      expect(before).toHaveLength(0);
      renderer.endBlock("p", "ok");
      const after = renderer.getCommitted();
      expect(after === before).toBe(false);
      expect(after.length).toBeGreaterThan(0);
    });

    test("C1.4 invariant still holds: committed contains the rendered content", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("p", "text");
      renderer.appendToBlock("p", "# Heading\n\nsome paragraph text");
      renderer.endBlock("p", "ok");
      const committed = renderer.getCommitted();
      const joined = committed.map(l => l.ansi).join("\n");
      expect(joined).toContain("Heading");
      expect(joined).toContain("paragraph text");
      expect(committed.length).toBeGreaterThan(0);
    });
  });

  describe("Stage 10.8 — Inter-message demarcation", () => {
    test("messageID transition: two text blocks with different messageIDs inject one blank CommittedLine between them", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("part-1", "text", { messageID: "msg-1" });
      renderer.appendToBlock("part-1", "hello\n");
      renderer.endBlock("part-1");
      const afterFirst = renderer.getCommitted().length;

      renderer.beginBlock("part-2", "text", { messageID: "msg-2" });
      renderer.appendToBlock("part-2", "world\n");
      renderer.endBlock("part-2");
      const afterSecond = renderer.getCommitted();

      // Stage 10.8.1: 3-line demarcation block — empty / dim-timestamp / empty.
      const emptyTop = afterSecond[afterFirst];
      const tsLine   = afterSecond[afterFirst + 1];
      const emptyBot = afterSecond[afterFirst + 2];
      expect(emptyTop).toBeDefined();
      expect(emptyTop.ansi).toBe("");
      expect(emptyTop.role).toBe("text");
      expect(tsLine).toBeDefined();
      // Timestamp wrapped in dim ANSI (\x1b[2m ... \x1b[22m); content matches
      // YYYY-MM-DD HH:MM (space-separated, single colon).
      expect(tsLine.ansi).toMatch(/^\x1b\[2m\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\x1b\[22m$/);
      expect(tsLine.role).toBe("text");
      expect(emptyBot).toBeDefined();
      expect(emptyBot.ansi).toBe("");
    });

    test("same messageID across consecutive beginBlocks does NOT inject a blank CommittedLine", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("part-1", "text", { messageID: "msg-1" });
      renderer.appendToBlock("part-1", "hello\n");
      renderer.endBlock("part-1");
      const afterFirst = renderer.getCommitted().length;

      renderer.beginBlock("part-2", "text", { messageID: "msg-1" });
      renderer.appendToBlock("part-2", "world\n");
      renderer.endBlock("part-2");
      const afterSecond = renderer.getCommitted();

      const firstNewLine = afterSecond[afterFirst];
      expect(firstNewLine).toBeDefined();
      // Stage 10.8.1: same messageID → NO 3-line demarcation block.
      // First new line is part-2's content (not the dim-timestamp pattern).
      expect(firstNewLine.ansi).not.toMatch(/^\x1b\[2m\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\x1b\[22m$/);
    });
  });

});
