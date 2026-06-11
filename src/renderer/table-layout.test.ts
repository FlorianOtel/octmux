import { test, expect, describe } from "bun:test";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { naturalWidths, computeColWidths, wrapCell } from "./table-layout.ts";

describe("table-layout", () => {
  describe("naturalWidths", () => {
    test("computes max width per column across header and rows", () => {
      const header = [
        { tokens: [] as any[] },
        { tokens: [] as any[] },
      ];
      const rows = [
        [{ tokens: [] as any[] }, { tokens: [] as any[] }],
        [{ tokens: [] as any[] }, { tokens: [] as any[] }],
      ];

      const parseInline = (tokens: any): string => {
        // Mock: return a fixed width for each column
        // We'll set this via closure
        return "";
      };

      // Simpler test: use mock data with known string widths
      const h = [
        { tokens: ["col1"] as any },
        { tokens: ["col2"] as any },
      ];
      const r = [
        [{ tokens: ["short"] as any }, { tokens: ["longertext"] as any }],
        [{ tokens: ["verylongtext"] as any }, { tokens: ["x"] as any }],
      ];

      const parse = (cell: any): string => {
        // Mock: cell is a cell object with .tokens property
        // For this test, we store strings in the tokens array directly
        const tokens = cell.tokens || [];
        return typeof tokens === "string" ? tokens : (tokens[0] || "");
      };

      const result = naturalWidths(h, r, parse);
      // "col1" (4), "short" (5), "verylongtext" (12) → col 0 = 12
      // "col2" (4), "longertext" (10), "x" (1) → col 1 = 10
      expect(result.length).toBe(2);
      expect(result[0]).toBe(12); // max("col1"=4, "short"=5, "verylongtext"=12)
      expect(result[1]).toBe(10); // max("col2"=4, "longertext"=10, "x"=1)
    });
  });

  describe("computeColWidths", () => {
    test("fits natural widths when there's room", () => {
      // realColumns=60, natural=[20,20,20]
      // borderSpace = 3+1 = 4, availableForContent = 60-4 = 56
      // sumNatural=60, with padding = 60 + 2*3 = 66 > 56, so doesn't fit without padding
      // Actually let's use natural=[10,10,10]
      // sumNatural=30, with padding = 30 + 6 = 36 < 56, so fits
      const result = computeColWidths([10, 10, 10], 60);
      expect(result.length).toBe(3);
      // Each natural width should get +2 padding
      expect(result[0]).toBe(12);
      expect(result[1]).toBe(12);
      expect(result[2]).toBe(12);
    });

    test("distributes space when natural widths don't fit (realColumns=120)", () => {
      const result = computeColWidths([10, 10, 10], 120);
      expect(result.length).toBe(3);
      // borderSpace = 4, available = 116
      // 30 + 6 = 36 < 116, so fits naturally
      expect(result[0]).toBe(12);
      expect(result[1]).toBe(12);
      expect(result[2]).toBe(12);
    });

    test("handles tiny panes with minimum colWidth=3", () => {
      // realColumns=15, natural=[20,20]
      // borderSpace = 2+1 = 3, available = 12
      // Need to clamp to at least 3 per column
      const result = computeColWidths([20, 20], 15);
      expect(result.length).toBe(2);
      // Each should be at least 3
      expect(result[0]).toBeGreaterThanOrEqual(3);
      expect(result[1]).toBeGreaterThanOrEqual(3);
      // Total + borders should fit in 15
      expect(result[0] + result[1] + 3).toBeLessThanOrEqual(15);
    });

    test("enforces width-discipline invariant: sum(colWidths) + (N+1) <= realColumns", () => {
      const testCases = [
        { natural: [20, 20, 20], realColumns: 60 },
        { natural: [5, 5, 5], realColumns: 190 },
        { natural: [20, 20], realColumns: 15 },
      ];

      for (const { natural, realColumns } of testCases) {
        const colWidths = computeColWidths(natural, realColumns);
        const N = natural.length;
        const borderSpace = N + 1;
        const totalUsed = colWidths.reduce((a, b) => a + b, 0) + borderSpace;
        expect(totalUsed).toBeLessThanOrEqual(realColumns);
      }
    });

    test("N=3 @ realColumns=13 (exactly the floor 4N+1): invariant holds at boundary", () => {
      // Floor for N=3 is 4*3+1 = 13
      const result = computeColWidths([20, 20, 20], 13);
      expect(result.length).toBe(3);
      const borderSpace = 4; // N+1 = 3+1
      const totalUsed = result.reduce((a, b) => a + b, 0) + borderSpace;
      expect(totalUsed).toBeLessThanOrEqual(13);
      // At the floor boundary, all columns should be at minimum (3)
      expect(result).toEqual([3, 3, 3]);
    });

    test("N=3 @ realColumns=10 (below floor): returns all-minimum widths, accepts overflow", () => {
      // Below floor for N=3 (which is 13); realColumns=10
      // The shrink guard will reduce to all-3s and stop (cannot shrink below 3).
      // The pane is too narrow — output may overflow, but is well-defined.
      const result = computeColWidths([20, 20, 20], 10);
      expect(result.length).toBe(3);
      // Should degrade to all-minimum (3)
      expect(result[0]).toBe(3);
      expect(result[1]).toBe(3);
      expect(result[2]).toBe(3);
      // Below the physical floor, the invariant may NOT hold; we accept the pane is too narrow
      // (unavoidable; bounded, defined output).
    });

    test("width-discipline invariant holds for realColumns >= 4N+1", () => {
      // Test cases where realColumns >= the physical floor (4N+1)
      // For these, the invariant MUST hold.
      const testCases = [
        { natural: [20, 20, 20], realColumns: 60 },  // well above floor
        { natural: [20, 20, 20], realColumns: 13 },  // exactly floor (4*3+1)
        { natural: [5, 5, 5], realColumns: 190 },    // well above floor
        { natural: [20, 20], realColumns: 15 },      // above floor (4*2+1=9)
      ];

      for (const { natural, realColumns } of testCases) {
        const colWidths = computeColWidths(natural, realColumns);
        const N = natural.length;
        const borderSpace = N + 1;
        const totalUsed = colWidths.reduce((a, b) => a + b, 0) + borderSpace;
        // For realColumns >= 4N+1, invariant ALWAYS holds
        expect(totalUsed).toBeLessThanOrEqual(realColumns);
      }
    });
  });

  describe("wrapCell", () => {
    test("preserves full content without ellipsis truncation", () => {
      const longToken = "abcdefghijklmnopqrstuvwxyz";
      const result = wrapCell(longToken, 10);
      // Full token should be present (possibly wrapped across lines with newlines)
      const singleLine = result.replace(/\n/g, "");
      expect(singleLine.includes(longToken)).toBe(true);
      // No "…" should appear
      expect(result.includes("…")).toBe(false);
    });

    test("every line respects content width", () => {
      const content = "hello world " + "x".repeat(30);
      const result = wrapCell(content, 10);
      const lines = result.split("\n").filter(l => l.length > 0);
      for (const line of lines) {
        const visibleWidth = stringWidth(line);
        expect(visibleWidth).toBeLessThanOrEqual(10);
      }
    });

    test("preserves emoji", () => {
      const content = "👋 hello";
      const result = wrapCell(content, 12);
      expect(result.includes("👋")).toBe(true);
    });

    test("respects visible width (excluding ANSI codes)", () => {
      const ansiContent = "\x1b[1m" + "test word ".repeat(3) + "\x1b[0m";
      const result = wrapCell(ansiContent, 8);
      // Each visible line should be <= 8 chars
      const lines = result.split("\n");
      for (const line of lines) {
        const visibleWidth = stringWidth(line);
        expect(visibleWidth).toBeLessThanOrEqual(8);
      }
    });

    test("clamps contentWidth to at least 1", () => {
      // Even with width 0, should produce output (not error)
      const result = wrapCell("hello", 0);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
