import { describe, test, expect } from "bun:test";
import stringWidth from "string-width";
import { stripAnsi, visualRows, tailSliceByVisualRows } from "./ActiveBlock.tsx";

describe("ActiveBlock helpers", () => {
  test("stripAnsi removes SGR escape sequences", () => {
    const input = "\x1b[31mhi\x1b[0m";
    const result = stripAnsi(input);
    expect(result).toBe("hi");
  });

  test("visualRows('', 80) === 1", () => {
    const result = visualRows("", 80);
    expect(result).toBe(1);
  });

  test("visualRows('hi', 80) === 1", () => {
    const result = visualRows("hi", 80);
    expect(result).toBe(1);
  });

  test("visualRows wraps correctly on width boundary", () => {
    const twoRows = visualRows("a".repeat(160), 80);
    expect(twoRows).toBe(2);

    const threeRows = visualRows("a".repeat(161), 80);
    expect(threeRows).toBe(3);
  });

  test("visualRows defensively handles zero width", () => {
    const result = visualRows("a", 0);
    expect(result).toBeGreaterThanOrEqual(1);
  });

  test("tailSliceByVisualRows with full input fits", () => {
    const input = ["a", "b", "c"];
    const result = tailSliceByVisualRows(input, 80, 10);
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("tailSliceByVisualRows returns last 3 lines", () => {
    const input = ["a", "b", "c", "d", "e"];
    const result = tailSliceByVisualRows(input, 80, 3);
    expect(result).toEqual(["c", "d", "e"]);
  });

  test("tailSliceByVisualRows with wrapping line excludes earlier lines", () => {
    const input = ["short", "a".repeat(240), "tail"];
    // 240-char line counts as 3 rows (ceil(240/80) = 3)
    // tail is 1 row, so total 4 rows
    // with maxRows=4, the last 4 rows are: tail (1) + 240-line (3) = 4
    // "short" should be excluded
    const result = tailSliceByVisualRows(input, 80, 4);
    expect(result).toEqual(["a".repeat(240), "tail"]);
  });

  test("tailSliceByVisualRows truncates when single line exceeds maxRows", () => {
    const input = ["a".repeat(240)];
    // 240 chars = 3 rows, but maxRows=1
    // returns truncated line ending with …
    const result = tailSliceByVisualRows(input, 80, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEndWith("…");
    expect(stripAnsi(result[0]).length).toBeLessThanOrEqual(80);
    expect(result[0]).not.toBe("");
  });

  test("tailSliceByVisualRows with [a,b,c,huge] maxRows=1 truncates", () => {
    const input = ["a", "b", "c", "x".repeat(300)];
    // huge line alone = 300/80 = 3.75 ≈ 4 rows, exceeds maxRows=1
    // returns truncated huge ending with …
    const result = tailSliceByVisualRows(input, 80, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEndWith("…");
    expect(stripAnsi(result[0]).length).toBeLessThanOrEqual(80);
  });

  test("tailSliceByVisualRows with [a,b,c,huge] maxRows=2 truncates", () => {
    const input = ["a", "b", "c", "z".repeat(250)];
    // huge line alone = 250/80 = 3.125 ≈ 4 rows, exceeds maxRows=2
    // returns truncated huge ending with …
    const result = tailSliceByVisualRows(input, 80, 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toEndWith("…");
    expect(stripAnsi(result[0]).length).toBeLessThanOrEqual(160);
  });

  test("visualRows with CJK characters (日) — 10 chars @ width 10 → 2 rows", () => {
    // CJK character "日" has width 2, so 10 chars = 20 columns
    // 20 columns / 10 width = 2 rows
    const result = visualRows("日".repeat(10), 10);
    expect(result).toBe(2);
  });

  test("visualRows with emoji — 5 emoji @ width 10 → 1 row", () => {
    // "🚀" has width 2, so 5 emoji = 10 columns
    // 10 columns / 10 width = 1 row
    const result = visualRows("🚀".repeat(5), 10);
    expect(result).toBe(1);
  });

  test("visualRows with emoji — 6 emoji @ width 10 → 2 rows", () => {
    // "🚀" has width 2, so 6 emoji = 12 columns
    // 12 columns / 10 width = 2 rows (ceil(12/10) = 2)
    const result = visualRows("🚀".repeat(6), 10);
    expect(result).toBe(2);
  });

  test("tailSliceByVisualRows with CJK truncation — 20 CJK @ width 10, maxRows=1", () => {
    // "日" has width 2, so 20 chars = 40 columns
    // With width=10 and maxRows=1, budget = 1*10-1 = 9 columns
    // Should fit 4 chars (8 columns) before exceeding budget
    const input = ["日".repeat(20)];
    const result = tailSliceByVisualRows(input, 10, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEndWith("…");
    expect(stringWidth(result[0])).toBeLessThanOrEqual(10);
  });

  test("tailSliceByVisualRows with CJK truncation — 40 CJK @ width 10, maxRows=2", () => {
    // "日" has width 2, so 40 chars = 80 columns
    // With width=10 and maxRows=2, budget = 2*10-1 = 19 columns
    // Should fit 9 chars (18 columns) before exceeding budget
    const input = ["日".repeat(40)];
    const result = tailSliceByVisualRows(input, 10, 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toEndWith("…");
    expect(stringWidth(result[0])).toBeLessThanOrEqual(20);
  });
});
