/**
 * Replay equivalence test (Stage 15.2 C2.1–2.2b, PLAN-C2C3.md §C step 2).
 *
 * The pre-change `replaySession` body is copied verbatim below as `oldReplaySession`
 * (from `git show HEAD:src/replay.ts`, lines 23–187). It is the reference. Each fixture
 * is run through (a) that reference and (b) `translateHistory` followed by `applyHistory`,
 * driving a recording fake renderer and a recording fake editor. The two recorded call
 * sequences must be strictly equal (same methods, same argument lists, same order).
 *
 * Do not edit `oldReplaySession`: it is the frozen v1 behaviour being tested against.
 */
import { describe, expect, test } from "bun:test";
import type { Renderer } from "./renderer/types.ts";
import type { LineEditor } from "./editor.ts";
import { translateHistory, applyHistory, fetchHistory } from "./replay.ts";

// Loose client shape for the reference copy (its body is typed `Client` in replay-HEAD). Only `session.messages` is used.
type Client = { session: { messages: (a: { path: { id: string } }) => Promise<{ data?: any[] }> } };
// The real client parameter type (from fetchHistory), so the fake can be passed to production code.
type RealClient = Parameters<typeof fetchHistory>[0];

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

/** Fake client whose `session.messages` resolves to `data` (or rejects when `data` is an Error). */
function fakeClient(data: unknown): RealClient {
  // Only `session.messages` is implemented; the cast is the test seam, not a real client.
  return ({
    session: {
      messages: async () => {
        if (data instanceof Error) throw data;
        return { data: data as any[] };
      },
    },
  } as unknown as RealClient);
}

// ─── Reference: the pre-change replaySession body (verbatim, renamed) ───
async function oldReplaySession(
  client: Client,
  renderer: Renderer,
  sessionID: string,
  editor: LineEditor,
): Promise<void> {
  try {
    const resp = await client.session.messages({ path: { id: sessionID } });
    const messages = resp.data ?? [];

    if (messages.length === 0) {
      // Fresh session or empty — no history to replay
      return;
    }

    // ─── Pass 1: find the first summary message and count pre-summary assistant messages ───
    let firstSummaryIdx = -1;
    let preSummaryAssistantCount = 0;
    for (let i = 0; i < messages.length; i++) {
      const info = messages[i].info;
      if (info.role === "assistant" && info.summary === true) {
        firstSummaryIdx = i;
        break;
      }
      if (info.role === "assistant") {
        preSummaryAssistantCount++;
      }
    }

    const userTexts: string[] = [];

    // ─── Pass 2: render with compaction awareness ───
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      const info = msg.info;

      // ─── User message: extract text and emit user-input block ───
      if (info.role === "user") {
        const parts = msg.parts ?? [];
        const textParts: string[] = [];
        for (const p of parts) {
          // Filter synthetic/ignored parts to prevent system-reminder parts from
          // appearing in scrollback on session resume (mirrors guard in events.ts
          // line ~386 for live SSE user message handling).
          if (p.type === "text" && p.text && p.synthetic !== true && p.ignored !== true) {
            textParts.push(p.text);
          }
        }
        const text = textParts.join("\n");
        if (text) {
          renderer.commitUserInput(text);
          userTexts.push(text);
        }
        continue;
      }

      // ─── Assistant message ───
      if (info.role === "assistant") {
        const parts = msg.parts ?? [];

        // Pre-summary assistant message: skip rendering (collapsed)
        if (firstSummaryIdx !== -1 && idx < firstSummaryIdx) {
          // Already counted in preSummaryAssistantCount; skip parts rendering.
          // The summary message replaces these collapsed messages.
          continue;
        }

        // The first summary message: render via streaming pipeline (matches live path)
        if (firstSummaryIdx !== -1 && idx === firstSummaryIdx) {
          // Emit collapse indicator if there were collapsed messages
          if (preSummaryAssistantCount > 0) {
            const suffix = preSummaryAssistantCount === 1 ? "" : "s";
            renderer.commitSystemMessage(
              "[" + preSummaryAssistantCount + " earlier message" + suffix + " summarized — see compacted summary below]",
            );
          }

          // Render summary text parts and compaction parts
          for (const p of parts) {
            if (p.type === "text" && p.text) {
              renderer.beginBlock(p.id, "summary");
              renderer.appendToBlock(p.id, p.text);
              renderer.endBlock(p.id, "ok");
            } else if (p.type === "compaction") {
              const compPart = p as unknown as { type: "compaction"; auto?: boolean };
              renderer.commitCompactionDivider(!!compPart.auto);
            }
          }
          renderer.commitTurnEnd();
          continue;
        }

        // Post-summary or no-compaction: normal rendering
        for (const p of parts) {
          // ─── Text part ───
          if (p.type === "text" && p.text) {
            renderer.beginBlock(p.id, "text");
            renderer.appendToBlock(p.id, p.text);
            renderer.endBlock(p.id, "ok");
          }

          // ─── Reasoning (thinking) part ───
          else if (p.type === "reasoning" && p.text) {
            renderer.beginBlock(p.id, "thinking");
            renderer.appendToBlock(p.id, p.text);
            renderer.endBlock(p.id, "ok");
          }

          // ─── Tool part ───
          else if (p.type === "tool") {
            // Use discriminated narrowing to access tool-specific fields
            const toolPart = p as unknown as {
              id: string;
              type: "tool";
              tool: string;
              state: { status: string; output?: string };
            };

            if (toolPart.state.status === "completed") {
              // Tool call block
              renderer.beginBlock(toolPart.id, "tool-call", {
                toolName: toolPart.tool,
              });
              renderer.endBlock(toolPart.id, "ok");

              // Tool result block (if output exists)
              const output = toolPart.state.output ?? "";
              if (output) {
                const resultPartID = toolPart.id + "-result";
                renderer.beginBlock(resultPartID, "tool-result");
                renderer.appendToBlock(resultPartID, output);
                renderer.endBlock(resultPartID, "ok");
              }
            } else if (toolPart.state.status === "error") {
              // Tool error: emit tool-call block with error status, no result
              renderer.beginBlock(toolPart.id, "tool-call", {
                toolName: toolPart.tool,
              });
              renderer.endBlock(toolPart.id, "error");
            }
          }

          // ─── Compaction part (post-summary) ───
          else if (p.type === "compaction") {
            const compPart = p as unknown as { type: "compaction"; auto?: boolean };
            renderer.commitCompactionDivider(!!compPart.auto);
          }

          // ─── Other part types (step-*, snapshot, patch, agent, retry, subtask, file) ───
          // Skip these entirely — out of scope for Stage 5.2
        }

        // End turn after all parts
        renderer.commitTurnEnd();
      }
    }

    // Seed the editor history from collected user texts
    if (userTexts.length > 0) {
      editor.seedHistory(userTexts);
    }
  } catch (err) {
    // Silently swallow errors — replay is best-effort, not critical to startup
  }
}

// ─── Fixtures: v1 `session.messages` data shapes ───

/** Every rendering branch: user text (with filters), reasoning, text, tool completed/error/running, compaction, empty text. */
const PLAIN_HISTORY: any[] = [
  { info: { role: "user" }, parts: [
    { id: "u1", type: "text", text: "hello" },
    { id: "u2", type: "text", text: "<system-reminder>", synthetic: true },
    { id: "u3", type: "text", text: "hidden", ignored: true },
    { id: "u4", type: "text", text: "second line" },
  ] },
  { info: { role: "assistant" }, parts: [
    { id: "a1", type: "reasoning", text: "thinking it over" },
    { id: "a2", type: "text", text: "Hi there" },
    { id: "a3", type: "tool", tool: "bash", state: { status: "completed", output: "file.txt" } },
    { id: "a4", type: "tool", tool: "read", state: { status: "completed", output: "" } },
    { id: "a5", type: "tool", tool: "edit", state: { status: "error" } },
    { id: "a6", type: "tool", tool: "grep", state: { status: "running" } },
    { id: "a7", type: "step-start" },
    { id: "a8", type: "compaction", auto: true },
    { id: "a9", type: "text", text: "" },
  ] },
  { info: { role: "user" }, parts: [{ id: "u5", type: "text", text: "next prompt" }] },
  { info: { role: "assistant" }, parts: [{ id: "a10", type: "text", text: "second answer" }] },
];

/** Compacted: two pre-summary assistants (collapsed, plural suffix), a summary with text/compaction/reasoning, then post-summary turns. */
const COMPACTED_HISTORY: any[] = [
  { info: { role: "user" }, parts: [{ id: "u1", type: "text", text: "before compaction" }] },
  { info: { role: "assistant" }, parts: [{ id: "old1", type: "text", text: "collapsed one" }] },
  { info: { role: "user" }, parts: [{ id: "u2", type: "text", text: "still before" }] },
  { info: { role: "assistant" }, parts: [{ id: "old2", type: "tool", tool: "bash", state: { status: "completed", output: "x" } }] },
  { info: { role: "assistant", summary: true }, parts: [
    { id: "s1", type: "text", text: "Summary text" },
    { id: "s2", type: "compaction" },
    { id: "s3", type: "reasoning", text: "ignored inside summary" },
  ] },
  { info: { role: "user" }, parts: [{ id: "u3", type: "text", text: "after summary" }] },
  { info: { role: "assistant" }, parts: [
    { id: "post1", type: "text", text: "post answer" },
    { id: "post2", type: "compaction", auto: true },
    { id: "post3", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } },
  ] },
];

/** One pre-summary assistant (singular "message" suffix), then a summary whose text part is empty. */
const SINGLE_COLLAPSE_HISTORY: any[] = [
  { info: { role: "assistant" }, parts: [{ id: "old1", type: "text", text: "only one" }] },
  { info: { role: "assistant", summary: true }, parts: [{ id: "s1", type: "text", text: "" }, { id: "s2", type: "text", text: "sum" }] },
];

/** A user turn whose only text is synthetic (so nothing is committed and nothing is seeded). */
const ONLY_SYNTHETIC_USER: any[] = [
  { info: { role: "user" }, parts: [{ id: "u1", type: "text", text: "reminder", synthetic: true }] },
];

/** Tool part with no `state`: the old code throws mid-loop. Output before the throw must be kept, with no seed and no turn-end. */
const MALFORMED_TOOL_HISTORY: any[] = [
  { info: { role: "user" }, parts: [{ id: "u1", type: "text", text: "before" }] },
  { info: { role: "assistant" }, parts: [
    { id: "a1", type: "text", text: "partial" },
    { id: "a2", type: "tool", tool: "bash" },
    { id: "a3", type: "text", text: "never reached" },
  ] },
  { info: { role: "user" }, parts: [{ id: "u2", type: "text", text: "after the throw" }] },
];

const FIXTURES: Array<[string, any[]]> = [
  ["plain history", PLAIN_HISTORY],
  ["compacted history", COMPACTED_HISTORY],
  ["single collapsed message", SINGLE_COLLAPSE_HISTORY],
  ["only synthetic user text", ONLY_SYNTHETIC_USER],
  ["malformed tool part (mid-loop throw)", MALFORMED_TOOL_HISTORY],
  ["empty message list", []],
];

const SID = "ses_replay_test";

/** Runs the old reference body and returns the recorded call sequence. */
async function recordOld(messages: any[]): Promise<Call[]> {
  const { log, renderer, editor } = makeRecorder();
  await oldReplaySession(fakeClient(messages), renderer, SID, editor);
  return log;
}

/** Runs translate + apply and returns the recorded call sequence. */
function recordNew(messages: any[]): Call[] {
  const { log, renderer, editor } = makeRecorder();
  applyHistory(renderer, editor, translateHistory(messages as any));
  return log;
}

describe("replay: old replaySession vs translateHistory + applyHistory", () => {
  for (const [name, messages] of FIXTURES) {
    test(`same renderer/editor call sequence: ${name}`, async () => {
      const oldLog = await recordOld(messages);
      const newLog = recordNew(messages);
      expect(newLog).toStrictEqual(oldLog);
    });
  }

  test("fixtures are non-vacuous: the plain and compacted histories exercise every call kind", async () => {
    const kinds = new Set<string>();
    for (const log of [await recordOld(PLAIN_HISTORY), await recordOld(COMPACTED_HISTORY)]) {
      for (const [name] of log) kinds.add(name);
    }
    expect([...kinds].sort()).toStrictEqual([
      "appendToBlock",
      "beginBlock",
      "commitCompactionDivider",
      "commitSystemMessage",
      "commitTurnEnd",
      "commitUserInput",
      "endBlock",
      "seedHistory",
    ]);
  });

  test("the malformed-tool fixture keeps the partial output, drops the seed and the turn-end", async () => {
    // Reference first: confirms the throw really happens in the old code.
    const oldLog = await recordOld(MALFORMED_TOOL_HISTORY);
    expect(oldLog.some(([name]) => name === "seedHistory")).toBe(false);
    expect(oldLog.some(([name]) => name === "commitTurnEnd")).toBe(false);
    expect(oldLog.some(([name, , text]) => name === "appendToBlock" && text === "partial")).toBe(true);
    expect(recordNew(MALFORMED_TOOL_HISTORY)).toStrictEqual(oldLog);
  });

  test("a rejected message fetch is swallowed: fetchHistory yields [], and applying it makes no calls", async () => {
    const failing = fakeClient(new Error("network down"));
    const ops = await fetchHistory(failing, SID);
    expect(ops).toStrictEqual([]);
    const { log, renderer, editor } = makeRecorder();
    applyHistory(renderer, editor, ops);
    expect(log).toStrictEqual([]);
  });

  test("the empty list translates to no operations", () => {
    expect(translateHistory([])).toStrictEqual([]);
  });
});

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
