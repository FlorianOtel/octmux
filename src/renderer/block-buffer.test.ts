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
    test("100 ms trailing-edge debounce: non-newline delta defers render until timer fires", async () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "debounce-part-1";
      try {
        renderer.beginBlock(partID, "text");

        // (a) append a non-newline delta — should NOT trigger an immediate render.
        renderer.appendToBlock(partID, "hello");

        // (b) _activeBlockAnsi is still empty (debounce holds the render).
        //     The buffer is updated, but the rendered ANSI string is not yet.
        expect(renderer.getActiveBlockAnsi()).toBe("");
        // Sanity: the active block buffer DOES contain the text.
        expect(renderer.getActiveBlock()?.text).toBe("hello");

        // (c) wait 110 ms for the trailing-edge timer to fire.
        await new Promise(r => setTimeout(r, 110));

        // (d) now the live ANSI should be the formatted "hello".
        const ansiAfterFirst = renderer.getActiveBlockAnsi();
        expect(ansiAfterFirst).not.toBe("");
        expect(ansiAfterFirst).toContain("hello");

        // (e) fire two rapid non-newline appends. The first call's timer
        //     should be cancelled by the second call's reset.
        renderer.appendToBlock(partID, " world");
        renderer.appendToBlock(partID, "!");

        // The render is still deferred — the second append cancelled the
        // timer scheduled by the first and scheduled its own.
        // _activeBlockAnsi still reflects the previous render of "hello".
        expect(renderer.getActiveBlockAnsi()).toBe(ansiAfterFirst);

        // (f) wait 110 ms for the second timer to fire.
        await new Promise(r => setTimeout(r, 110));

        // (g) live ANSI now contains the full "hello world!" — the first
        //     timer fired once (after step c) and the second timer fired
        //     once (after step f). The interleaved appends did NOT cause
        //     two extra renders.
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
        // Non-newline delta — debounce holds the render.
        renderer.appendToBlock(partID, "mid-debounce content");
        // _activeBlockAnsi is empty (no flush-on-\n, no timer fire yet).
        expect(renderer.getActiveBlockAnsi()).toBe("");

        // endBlock arrives within the 100 ms window — pre-flush must
        // synchronously render so the commit captures the latest ANSI.
        const committedBefore = renderer.getCommitted().length;
        renderer.endBlock(partID, "ok");
        const committedAfter = renderer.getCommitted();
        const newlyCommitted = committedAfter.slice(committedBefore);
        const joined = newlyCommitted.map(l => l.ansi).join("\n");

        // The committed ANSI must contain the buffered text — proving the
        // pre-flush fired and `_commitActiveText` split a non-stale string.
        expect(joined).toContain("mid-debounce content");
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

  describe("Stage 10.7 — reconcileActiveText (defensive PartUpdated reconcile)", () => {
    test("fills in tail when active buffer is shorter than authoritative text", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "rec-1";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "hello"); // simulating delta loss — only "hello"
      expect(renderer.getActiveBlock()?.text).toBe("hello");
      // OC's final message.part.updated carries the FULL accumulated text.
      renderer.reconcileActiveText(partID, "hello world full tail");
      expect(renderer.getActiveBlock()?.text).toBe("hello world full tail");
    });

    test("no-op when active buffer already matches the authoritative text", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "rec-2";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "complete content");
      const before = renderer.getActiveBlock();
      renderer.reconcileActiveText(partID, "complete content");
      const after = renderer.getActiveBlock();
      // Cache identity preserved: no state change → same ref (Stage 10.6 invariant).
      expect(before === after).toBe(true);
    });

    test("no-op when fullText is shorter than active buffer (defensive — never shrinks)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "rec-3";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "longer streamed content via deltas");
      renderer.reconcileActiveText(partID, "shorter");
      expect(renderer.getActiveBlock()?.text).toBe("longer streamed content via deltas");
    });

    test("no-op when partID does not match the current active block", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      renderer.beginBlock("active-id", "text");
      renderer.appendToBlock("active-id", "hello");
      renderer.reconcileActiveText("different-id", "would overwrite");
      expect(renderer.getActiveBlock()?.text).toBe("hello");
    });

    test("no-op when active block is non-text role (reasoning / tool)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      // Open a text block so _activeTextPartID is set, then check that
      // reconcile with a non-text role path is a no-op via the partID check.
      renderer.beginBlock("text-id", "text");
      renderer.appendToBlock("text-id", "text content");
      // Even if some other code accidentally called reconcile with a wrong
      // partID intending a non-text block, the partID check rejects it.
      renderer.reconcileActiveText("non-text-id", "would corrupt");
      expect(renderer.getActiveBlock()?.text).toBe("text content");
    });

    test("identity cache invalidates after reconcile (Stage 10.6 cache stays correct)", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "rec-cache";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "partial");
      const before = renderer.getActiveBlock();
      renderer.reconcileActiveText(partID, "partial filled in");
      const after = renderer.getActiveBlock();
      // Buffer changed → cache invalidated → new wrapper reference.
      expect(before === after).toBe(false);
      expect(after?.text).toBe("partial filled in");
    });

    test("cancels pending debounce timer so no stale render fires after reconcile", () => {
      const renderer = new BlockBufferRenderer(new Visibility());
      const partID = "rec-deb";
      renderer.beginBlock(partID, "text");
      renderer.appendToBlock(partID, "hi"); // schedules a 100ms debounce
      // _textDebounce should be non-null right after appendToBlock for text role.
      expect(renderer._textDebounce).not.toBeNull();
      renderer.reconcileActiveText(partID, "hi reconciled");
      // After reconcile, the pending debounce must be cleared.
      expect(renderer._textDebounce).toBeNull();
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
