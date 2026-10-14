import { describe, expect, test } from "bun:test";
import { pickerWindow } from "./picker-window.ts";

describe("pickerWindow", () => {
  test("short list is fully visible", () => {
    expect(pickerWindow(5, 2, 24)).toEqual({ start: 0, end: 5 });
  });
  test("window keeps idx visible and stays below rows", () => {
    for (const idx of [0, 10, 50, 99]) {
      const w = pickerWindow(100, idx, 24);
      expect(w.end - w.start).toBeLessThanOrEqual(8);
      expect(idx).toBeGreaterThanOrEqual(w.start);
      expect(idx).toBeLessThan(w.end);
    }
  });
  test("clamps at end and tiny terminals", () => {
    expect(pickerWindow(100, 99, 24).end).toBe(100);
    expect(pickerWindow(100, 0, 6)).toEqual({ start: 0, end: 3 });
  });
});
