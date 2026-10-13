/**
 * Tests for `src/resync-gate.ts` (Stage 15.2, C2.6b): the one-in-flight coalescing gate and the generating-flag decision.
 */
import { describe, expect, test } from "bun:test";
import { ResyncGate, decideResync, shouldEndCompacting } from "./resync-gate.ts";
import type { HistoryOp } from "./replay.ts";

/** A compaction divider op, as the v2 translator produces it when a compaction completes. */
const DIVIDER: HistoryOp = { op: "compaction-divider", auto: false };
/** A plain turn-end op, standing in for any non-divider history. */
const TURN_END: HistoryOp = { op: "turn-end" };

describe("ResyncGate", () => {
  test("the first request starts a run", () => {
    const gate = new ResyncGate();
    expect(gate.request()).toBe(true);
  });

  test("a request while a run is in flight does not start a second run", () => {
    const gate = new ResyncGate();
    expect(gate.request()).toBe(true);
    expect(gate.request()).toBe(false);
  });

  test("finishing with a queued request asks for exactly one more run", () => {
    const gate = new ResyncGate();
    gate.request();
    gate.request();
    gate.request(); // three requests while one run is in flight still queue one rerun
    expect(gate.finish()).toBe(true);
    expect(gate.finish()).toBe(false);
  });

  test("finishing with nothing queued leaves the gate idle, so the next request starts a run", () => {
    const gate = new ResyncGate();
    gate.request();
    expect(gate.finish()).toBe(false);
    expect(gate.request()).toBe(true);
  });

  test("a request that arrives during the queued rerun is queued for a further run", () => {
    const gate = new ResyncGate();
    gate.request(); // run 1 starts
    gate.request(); // queued
    expect(gate.finish()).toBe(true); // run 2 must start now
    gate.request(); // arrives during run 2
    expect(gate.finish()).toBe(true); // run 3 must start now
    expect(gate.finish()).toBe(false);
  });
});

describe("decideResync", () => {
  test("session still running and generating: nothing to change", () => {
    expect(decideResync(true, true)).toBe("none");
  });

  test("session finished while octmux was generating: end the turn", () => {
    expect(decideResync(true, false)).toBe("end-turn");
  });

  test("session running while octmux was not generating (start missed in the gap): start the turn", () => {
    expect(decideResync(false, true)).toBe("start-turn");
  });

  test("session idle and not generating: nothing to change", () => {
    expect(decideResync(false, false)).toBe("none");
  });

  test("unknown REST answer never changes the flag, in either direction", () => {
    expect(decideResync(true, undefined)).toBe("none");
    expect(decideResync(false, undefined)).toBe("none");
  });
});

describe("shouldEndCompacting", () => {
  test("divider rendered from missed history and session active: the compaction completed, so end it", () => {
    expect(shouldEndCompacting([TURN_END, DIVIDER], true)).toBe(true);
  });

  test("no divider but REST says the session is idle: no compaction can still run, so end it", () => {
    expect(shouldEndCompacting([TURN_END], false)).toBe(true);
  });

  test("no divider and session still active: the compaction is still running, keep it", () => {
    expect(shouldEndCompacting([TURN_END], true)).toBe(false);
  });

  test("no divider and unknown REST answer: an unknown answer is not a signal, keep it", () => {
    expect(shouldEndCompacting([TURN_END], undefined)).toBe(false);
  });

  test("nothing missed and unknown REST answer: keep it", () => {
    expect(shouldEndCompacting([], undefined)).toBe(false);
  });
});
