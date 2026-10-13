import { describe, test, expect } from "bun:test";
import { findRunningTaskChildSessionID, isTurnStale } from "./backend/v1-queries.ts";

// Regression coverage for the 2026-09-11 incident: a /brain Task-tool dispatch to
// an actor-heavy subagent (sohoai/glm-5.3) hung for 11+ hours because the harness's
// stall watchdog only fired when the newest assistant message had zero parts. Once
// a `task` tool call is dispatched, the message always has non-empty parts (its own
// text + the tool-call part itself), so the watchdog never re-checked the subagent's
// own liveness. These two pure helpers close that gap.

describe("findRunningTaskChildSessionID", () => {
  test("returns null for empty parts", () => {
    expect(findRunningTaskChildSessionID([])).toBeNull();
  });

  test("returns null when the last part is plain text (no task dispatch in flight)", () => {
    const parts = [
      { type: "text" },
    ];
    expect(findRunningTaskChildSessionID(parts)).toBeNull();
  });

  test("returns null when the last part is a task tool call that already completed", () => {
    const parts = [
      { type: "text" },
      { type: "tool", tool: "task", state: { status: "completed", metadata: { sessionId: "ses_child" } } },
    ];
    expect(findRunningTaskChildSessionID(parts)).toBeNull();
  });

  test("returns null when the last part is a non-task tool call, even if running", () => {
    const parts = [
      { type: "tool", tool: "bash", state: { status: "running" } },
    ];
    expect(findRunningTaskChildSessionID(parts)).toBeNull();
  });

  test("returns null when a running task tool call has no paired child session yet", () => {
    const parts = [
      { type: "tool", tool: "task", state: { status: "running", metadata: {} } },
    ];
    expect(findRunningTaskChildSessionID(parts)).toBeNull();
  });

  test("returns the child session ID for a running, paired task tool call", () => {
    const parts = [
      { type: "step-start" },
      { type: "reasoning", text: "" },
      { type: "text", text: "Dispatching subagent..." },
      { type: "tool", tool: "task", state: { status: "running", metadata: { sessionId: "ses_f73437109ffeWvyQEHodWaXMmN" } } },
    ];
    expect(findRunningTaskChildSessionID(parts)).toBe("ses_f73437109ffeWvyQEHodWaXMmN");
  });
});

describe("isTurnStale", () => {
  const NOW = 1_789_070_000_000;
  const THRESHOLD = 180_000;

  test("a completed turn is never stale, regardless of parts", () => {
    expect(isTurnStale([], NOW, NOW, THRESHOLD)).toBe(false);
    expect(isTurnStale([{ time: { start: NOW - 999_999 } }], NOW, NOW, THRESHOLD)).toBe(false);
  });

  test("an incomplete turn with zero parts is stale", () => {
    expect(isTurnStale([], null, NOW, THRESHOLD)).toBe(true);
  });

  test("an incomplete turn whose newest part timestamp is within the threshold is not stale", () => {
    const parts = [
      { time: { start: NOW - 10_000, end: NOW - 9_000 } },
      { time: { start: NOW - 5_000 } }, // still open, started recently
    ];
    expect(isTurnStale(parts, null, NOW, THRESHOLD)).toBe(false);
  });

  test("an incomplete turn whose newest part timestamp exceeds the threshold is stale", () => {
    // Reproduces the exact incident shape: a reasoning part opened and never closed.
    const parts = [
      { type: "step-start" },
      { type: "reasoning", time: { start: NOW - 200_000 } }, // no `end` — never closed
    ];
    expect(isTurnStale(parts, null, NOW, THRESHOLD)).toBe(true);
  });

  test("boundary: exactly at threshold counts as stale", () => {
    const parts = [{ time: { start: NOW - THRESHOLD } }];
    expect(isTurnStale(parts, null, NOW, THRESHOLD)).toBe(true);
  });

  test("parts with no time field at all are treated as stale (no evidence of progress)", () => {
    const parts = [{ type: "step-start" }];
    expect(isTurnStale(parts, null, NOW, THRESHOLD)).toBe(true);
  });
});
