/**
 * Tests for `src/turn-status.ts` (Stage 15.2, C2.6b): retry-line dedupe, retry text, and the compaction-failed line.
 */
import { describe, expect, test } from "bun:test";
import { formatCompactionFailedLine, formatRetryLine, generatingStartAfterMessageCompleted, isNewRetryAttempt } from "./turn-status.ts";

describe("isNewRetryAttempt (one line per attempt)", () => {
  test("the first retry of a turn (attempt 2, last shown 0) is new", () => {
    expect(isNewRetryAttempt(0, 2)).toBe(true);
  });

  test("a later attempt than the last shown one is new", () => {
    expect(isNewRetryAttempt(2, 3)).toBe(true);
  });

  test("the same attempt again is not new, so a repeated event adds no second line", () => {
    expect(isNewRetryAttempt(3, 3)).toBe(false);
  });

  test("an older attempt is not new", () => {
    expect(isNewRetryAttempt(5, 4)).toBe(false);
  });
});

describe("formatRetryLine", () => {
  test("uses the spec wording retrying (attempt N): <message>", () => {
    expect(formatRetryLine(2, "provider transport error")).toBe("retrying (attempt 2): provider transport error");
  });

  test("drops the colon when the server gave no message", () => {
    expect(formatRetryLine(4, "")).toBe("retrying (attempt 4)");
  });

  test("treats a whitespace-only message as empty", () => {
    expect(formatRetryLine(4, "   ")).toBe("retrying (attempt 4)");
  });

  test("trims the message", () => {
    expect(formatRetryLine(3, "  boom \n")).toBe("retrying (attempt 3): boom");
  });
});

describe("formatCompactionFailedLine", () => {
  test("prefixes the provider error", () => {
    expect(formatCompactionFailedLine("context too long")).toBe("compaction failed: context too long");
  });

  test("gives the bare label for an empty message", () => {
    expect(formatCompactionFailedLine("")).toBe("compaction failed");
  });

  test("shows the translator fallback as a distinct detail, not a repeated label", () => {
    // The translator sends this text when the server frame has no error message (v2-events.ts).
    expect(formatCompactionFailedLine("no error detail from server")).toBe(
      "compaction failed: no error detail from server",
    );
  });
});

// G1 (Stage 15.2 live defect): a late message-completed after session-idle must not re-arm the generating line.
describe("generatingStartAfterMessageCompleted (G1, no re-arm after the turn ends)", () => {
  test("while the turn runs, the timer restarts at now", () => {
    expect(generatingStartAfterMessageCompleted(true, 1_000)).toBe(1_000);
  });

  test("after session-idle (isGenerating false), a late message-completed leaves the line off", () => {
    expect(generatingStartAfterMessageCompleted(false, 1_000)).toBeNull();
  });
});
