/**
 * Replay operation tests (Stage 15.2 C2.6b). `applyHistory` is the only code in `src/replay.ts` that
 * drives the renderer and editor. These tests run it against a recording fake renderer and editor.
 */
import { describe, expect, test } from "bun:test";
import type { Renderer } from "./renderer/types.ts";
import type { LineEditor } from "./editor.ts";
import { applyHistory } from "./replay.ts";

/** One recorded call: the method name followed by its exact argument list. */
type Call = [string, ...unknown[]];

/**
 * Builds a fake renderer and editor that record every call into one shared log, so the
 * relative order of renderer and editor calls is also compared. Rest parameters keep the
 * argument count, so a call made with two arguments is not confused with one made with three.
 */
function makeRecorder(): { log: Call[]; renderer: Renderer; editor: LineEditor } {
  const log: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    log.push([name, ...args]);
  };
  const renderer = {
    beginBlock: rec("beginBlock"),
    appendToBlock: rec("appendToBlock"),
    endBlock: rec("endBlock"),
    commitUserInput: rec("commitUserInput"),
    commitSystemMessage: rec("commitSystemMessage"),
    commitTurnEnd: rec("commitTurnEnd"),
    commitCompactionDivider: rec("commitCompactionDivider"),
  } as unknown as Renderer;
  const editor = {
    seedHistory: rec("seedHistory"),
  } as unknown as LineEditor;
  return { log, renderer, editor };
}

// Stage 15.2 (C2.6b): `HistoryOp` block ops may carry `exitCode` (v2 non-zero shell exit). applyHistory passes it
// to endBlock as a third argument. A block without it keeps the two-argument call the v1 history has always made.
describe("replay: exitCode passthrough (C2.6b)", () => {
  test("a block op with exitCode calls endBlock with the status and the exit code", () => {
    const { log, renderer, editor } = makeRecorder();
    applyHistory(renderer, editor, [
      { op: "block", partID: "call_1", role: "tool-call", meta: { toolName: "shell" }, status: "ok", exitCode: 1 },
    ]);
    expect(log.filter(([name]) => name === "endBlock")).toEqual([["endBlock", "call_1", "ok", 1]]);
  });

  test("a block op without exitCode keeps the two-argument endBlock call", () => {
    const { log, renderer, editor } = makeRecorder();
    applyHistory(renderer, editor, [
      { op: "block", partID: "call_1", role: "tool-call", meta: { toolName: "shell" }, status: "ok" },
    ]);
    expect(log.filter(([name]) => name === "endBlock")).toEqual([["endBlock", "call_1", "ok"]]);
  });
});
