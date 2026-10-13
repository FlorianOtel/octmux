/**
 * Tests for the v2 session reads (src/backend/v2-queries.ts), Stage 15.2 C2.3b.
 *
 * FIXTURES ARE SYNTHESISED, NOT CAPTURED. The operator decided that no captured artefact is committed.
 * Each fixture below is written by hand in the shape that `docs/OpenCode-v2-protocol-capture.md` describes,
 * and the comment above it names the § it mirrors. The IDs, timestamps and text are invented. Only the
 * structure is meant to match the capture.
 *
 * The last `describe` block drives `V2Backend.events` through a fake SDK client, so the fetch wiring is covered
 * as well as the pure functions.
 */
import { describe, expect, test } from "bun:test";
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import type { SessionMessagesResponses } from "@opencode-ai/sdk/client";
import { translateHistory } from "../replay.ts";
import { V2Backend } from "./v2.ts";
import {
  addAssistantCostV2,
  fetchHistoryV2,
  fetchMissedHistoryV2,
  hasPendingToolCallsV2,
  pickPostCompactionAssistantTokenUsageV2,
  queryTokenUsageV2,
  scanLatestAssistantActivityV2,
  translateHistoryV2,
  translateMissedHistoryV2,
} from "./v2-queries.ts";

// ─── Fixture builders ───

/** A fixed base timestamp (ms). Only relative order matters to the code under test. */
const T = 1_791_893_500_000;

/** Model binding used by fixtures (capture §4.3, `model: {id, providerID}`). */
const MODEL = { id: "glm-5.3-flash", providerID: "sohoai" };

type AssistantMsg = Extract<SessionMessageInfo, { type: "assistant" }>;
type AssistantItem = AssistantMsg["content"][number];
type ToolItem = Extract<AssistantItem, { type: "tool" }>;
type CompletedState = Extract<ToolItem["state"], { status: "completed" }>;
type ErrorState = Extract<ToolItem["state"], { status: "error" }>;
type RunningState = Extract<ToolItem["state"], { status: "running" }>;
type Usage = NonNullable<AssistantMsg["tokens"]>;

/** A token usage record with the given input and cache counts (capture §4.3 `tokens`). */
function usage(input: number, cacheRead = 0, cacheWrite = 0): Usage {
  return { input, output: 0, reasoning: 0, cache: { read: cacheRead, write: cacheWrite } };
}

/**
 * A v2 assistant message, shaped after capture §5a: `{id, time, type: "assistant", agent, model, content,
 * finish, cost, tokens}`. `extra` overrides any field.
 */
function assistant(id: string, content: AssistantItem[], extra: Partial<AssistantMsg> = {}): AssistantMsg {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: MODEL,
    time: { created: T, streamed: T + 1, completed: T + 9 },
    content,
    finish: "stop",
    cost: 0,
    tokens: usage(100),
    ...extra,
  };
}

/** A v2 user item, shaped after capture §5a: `{id, time, type: "user", text}` (text is top-level). */
function user(id: string, text: string): SessionMessageInfo {
  return { id, type: "user", time: { created: T }, text };
}

/** A text content item (capture §5a: `{type: "text", text}`, no time). */
function text(value: string): AssistantItem {
  return { type: "text", text: value };
}

/** A reasoning content item (capture §5a: `{type, text, state, time}`). */
function reasoning(value: string): AssistantItem {
  return { type: "reasoning", text: value, time: { created: T + 1, completed: T + 2 } };
}

/**
 * A tool content item (capture §5a: `{type: "tool", id, name, executed, state, time}`). `id` is the `call_…` id.
 * `time` defaults to a completed call.
 */
function tool(id: string, name: string, state: ToolItem["state"], time: ToolItem["time"] = { created: T + 2, ran: T + 3, completed: T + 4 }): ToolItem {
  return { type: "tool", id, name, executed: false, state, time };
}

/** A completed tool state (capture §5a: `state: {status: "completed", input, content, metadata}`). */
function completedState(content: string[], input: Record<string, string | number> = {}, metadata?: Record<string, string | number | boolean>): CompletedState {
  const items = content.map((value) => ({ type: "text" as const, text: value }));
  return {
    status: "completed",
    input,
    content: items as CompletedState["content"],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** An error tool state (capture §4.4: `state: {status: "error", input, error}`, no `content` when rejected). */
function errorState(type: string, message: string, input: Record<string, string> = {}): ErrorState {
  return { status: "error", input, error: { type, message } };
}

/** A running tool state (capture §4.9: the running `subagent` call carries `metadata.sessionID`). */
function runningState(metadata: Record<string, string> = {}, input: Record<string, string> = {}): RunningState {
  return { status: "running", input, metadata };
}

/** A compaction message in the `completed` status (capture §4.12, §5a). */
function compactionCompleted(id: string, summary: string, reason: "auto" | "manual" = "manual"): SessionMessageInfo {
  return {
    id,
    type: "compaction",
    time: { created: T + 20 },
    status: "completed",
    reason,
    model: MODEL,
    summary,
    recent: "",
    cost: 0,
    tokens: usage(0),
  };
}

/** A compaction message in the `failed` status (capture §4.12: `status: "failed"`, `error`). */
function compactionFailed(id: string): SessionMessageInfo {
  return {
    id,
    type: "compaction",
    time: { created: T + 20 },
    status: "failed",
    reason: "manual",
    error: { type: "provider.transport", message: "FailedToOpenSocket: Was there a typo in the url or port?" },
  };
}

/** An idle item (capture §4.8, §5a: `{type: "idle", outcome}`). */
function idle(id: string, outcome: "succeeded" | "failed" | "interrupted"): SessionMessageInfo {
  return { id, type: "idle", time: { created: T + 30 }, outcome };
}

// ─── translateHistoryV2 ───

describe("translateHistoryV2", () => {
  test("empty message list gives no operations", () => {
    expect(translateHistoryV2([])).toEqual([]);
  });

  // Capture §5a, user item. v1: a user message's text parts become one `user-input` and a seed entry.
  test("user text becomes user-input and an editor history seed", () => {
    const ops = translateHistoryV2([user("usr_1", "hello there")]);
    expect(ops).toEqual([
      { op: "user-input", text: "hello there" },
      { op: "seed-history", texts: ["hello there"] },
    ]);
  });

  test("user item with empty text gives no operation and no seed", () => {
    expect(translateHistoryV2([user("usr_1", "")])).toEqual([]);
  });

  // Capture §4.1 and §4.2 (streaming text and reasoning) and §5a (content items). Block ids are
  // `${assistantID}:${index}`, and the content index is the order the live path must match (see the
  // ASSUMPTION note in src/backend/v2-queries.ts). v1: reasoning maps to `thinking`, text to `text`.
  test("assistant reasoning and text blocks keep content order, keyed by content index, then turn-end", () => {
    const ops = translateHistoryV2([
      assistant("ast_1", [reasoning("consider"), text("answer")]),
    ]);
    expect(ops).toEqual([
      { op: "block", partID: "ast_1:0", role: "thinking", text: "consider", status: "ok" },
      { op: "block", partID: "ast_1:1", role: "text", text: "answer", status: "ok" },
      { op: "turn-end" },
    ]);
  });

  test("empty text and reasoning items render nothing", () => {
    const ops = translateHistoryV2([assistant("ast_1", [reasoning(""), text("")])]);
    expect(ops).toEqual([{ op: "turn-end" }]);
  });

  // Capture §4.4 approved shell (`session.tool.success` content text), §5a completed tool item. v1: a completed
  // tool gives a `tool-call` block (with toolName) and a `tool-result` block with partID `${callID}-result`.
  test("completed tool gives tool-call and tool-result blocks, with the result text joined in order", () => {
    const ops = translateHistoryV2([
      assistant("ast_1", [
        tool("call_x9y407un", "shell", completedState(["pwd output\n", "more"], { command: "pwd" })),
      ]),
    ]);
    expect(ops).toEqual([
      { op: "block", partID: "call_x9y407un", role: "tool-call", meta: { toolName: "shell" }, status: "ok" },
      { op: "block", partID: "call_x9y407un-result", role: "tool-result", text: "pwd output\nmore", status: "ok" },
      { op: "turn-end" },
    ]);
  });

  test("completed tool whose content has no text gives a tool-call block and no tool-result", () => {
    const fileOnly: ToolItem = tool("call_f", "read", {
      status: "completed",
      input: {},
      content: [{ type: "file", uri: "file:///tmp/a.png", mime: "image/png" }],
    });
    const ops = translateHistoryV2([assistant("ast_1", [fileOnly])]);
    expect(ops).toEqual([
      { op: "block", partID: "call_f", role: "tool-call", meta: { toolName: "read" }, status: "ok" },
      { op: "turn-end" },
    ]);
  });

  // Capture §4.4 rejected shell. The stored state is `status: "error"` with `error` and no `content`. v1: an
  // error tool gives a `tool-call` block with status error and no result.
  test("rejected tool (permission.rejected) gives a tool-call block with error status and no result", () => {
    const ops = translateHistoryV2([
      assistant("ast_1", [
        tool("call_26cq43v3", "shell", errorState("permission.rejected", "capture: rejected on purpose", { command: "cat ./does-not-exist.txt" })),
      ]),
    ]);
    expect(ops).toEqual([
      { op: "block", partID: "call_26cq43v3", role: "tool-call", meta: { toolName: "shell" }, status: "error" },
      { op: "turn-end" },
    ]);
  });

  // The v2 SDK has `streaming` and `running` tool states. v1 renders neither in history (it renders only
  // completed and error parts), so both give no operation.
  test("streaming and running tools render nothing in history", () => {
    const streaming = tool("call_s", "shell", { status: "streaming", input: "{\"command\":" });
    const running = tool("call_r", "shell", runningState({}, { command: "sleep 20" }), { created: T + 2 });
    const ops = translateHistoryV2([assistant("ast_1", [streaming, running])]);
    expect(ops).toEqual([{ op: "turn-end" }]);
  });

  // Capture §4.4 non-zero exit (`v2-capture-3b/events.sse:101`, stored item `metadata.exit: 1`). The tool is
  // `completed`, not `error`. The call block carries `exitCode` (C2.6b), as the live translator does. The exit
  // line is also the second text item of the result, so the replayed result still shows it.
  test("completed shell with a non-zero exit is an ok tool-call with exitCode, and the exit line stays in the result text", () => {
    const shell = tool(
      "call_hw22vd6l",
      "shell",
      completedState(
        ["cat: ./does-not-exist.txt: No such file or directory\n", "Exited with code 1"],
        { command: "cat ./does-not-exist.txt", workdir: "/tmp/octmux-v2-capture-3b" },
        { status: "completed", truncated: false, exit: 1 },
      ),
    );
    const ops = translateHistoryV2([assistant("ast_1", [shell])]);
    expect(ops).toEqual([
      { op: "block", partID: "call_hw22vd6l", role: "tool-call", meta: { toolName: "shell" }, status: "ok", exitCode: 1 },
      {
        op: "block",
        partID: "call_hw22vd6l-result",
        role: "tool-result",
        text: "cat: ./does-not-exist.txt: No such file or directory\nExited with code 1",
        status: "ok",
      },
      { op: "turn-end" },
    ]);
  });

  // Capture §4.4 interrupt during a running tool, and §4.8. The tool is `error` with `aborted`, the assistant
  // finishes with `error`, and the idle item is `interrupted`. The idle renders the "Interrupted" marker right after
  // the turn-end, as v1 does for a `MessageAbortedError` message (`src/replay.ts`).
  test("interrupted turn: aborted tool is an error block, and the idle renders Interrupted after the turn-end", () => {
    const aborted = tool("call_2c5x770y", "shell", errorState("aborted", "Tool execution interrupted", { command: "sleep 60" }));
    const ops = translateHistoryV2([
      user("usr_1", "run it"),
      assistant("ast_1", [aborted], { finish: "error", rawFinish: "tool_calls" }),
      idle("idl_1", "interrupted"),
    ]);
    expect(ops).toEqual([
      { op: "user-input", text: "run it" },
      { op: "block", partID: "call_2c5x770y", role: "tool-call", meta: { toolName: "shell" }, status: "error" },
      { op: "turn-end" },
      { op: "system-message", text: "Interrupted" },
      { op: "seed-history", texts: ["run it"] },
    ]);
  });

  // Capture §4.8 failed turn (capture 3). The failed assistant has `content: []` and `finish: "error"`. The idle
  // item is `failed`. v1 gives one turn-end per assistant message, with no content blocks.
  test("failed turn: an assistant with empty content gives only a turn-end, and the failed idle adds nothing", () => {
    const failed = assistant("ast_1", [], { finish: "error", cost: undefined, tokens: undefined });
    const ops = translateHistoryV2([failed, idle("idl_1", "failed")]);
    expect(ops).toEqual([{ op: "turn-end" }]);
  });

  // Capture §4.9 subagent. The parent's stored `subagent` item is `completed`, and its content is the child's
  // final text in a <subagent> element. v1 has no subagent special case in history, so this is a plain tool.
  test("completed subagent call renders as an ordinary tool-call and tool-result", () => {
    const sub = tool(
      "call_nja9hdcz",
      "subagent",
      completedState(
        ['<subagent sessionID="ses_child" state="completed">\npong\n</subagent>'],
        { agent: "general", description: "Reply with pong", prompt: "Reply with the single word: pong" },
        { sessionID: "ses_child", status: "completed", truncated: false },
      ),
    );
    const ops = translateHistoryV2([assistant("ast_1", [sub])]);
    expect(ops).toEqual([
      { op: "block", partID: "call_nja9hdcz", role: "tool-call", meta: { toolName: "subagent" }, status: "ok" },
      {
        op: "block",
        partID: "call_nja9hdcz-result",
        role: "tool-result",
        text: '<subagent sessionID="ses_child" state="completed">\npong\n</subagent>',
        status: "ok",
      },
      { op: "turn-end" },
    ]);
  });

  // Capture §4.12 (completed compaction, capture 3b) plus §5a. Assistants before the boundary are collapsed, as
  // v1 does for pre-summary messages. The counted indicator line has v1's exact wording. The summary block gets
  // role `summary`. The divider is `auto: false` for a manual compaction.
  test("completed compaction collapses earlier assistants, shows the summary and divider, then renders on", () => {
    const ops = translateHistoryV2([
      user("usr_1", "first"),
      assistant("ast_a", [text("old one")]),
      assistant("ast_b", [text("old two")]),
      compactionCompleted("cmp_1", "SUMMARY TEXT", "manual"),
      user("usr_2", "second"),
      assistant("ast_c", [text("new")]),
    ]);
    expect(ops).toEqual([
      { op: "user-input", text: "first" },
      { op: "system-message", text: "[2 earlier messages summarized — see compacted summary below]" },
      { op: "block", partID: "cmp_1:summary", role: "summary", text: "SUMMARY TEXT", status: "ok" },
      { op: "compaction-divider", auto: false },
      { op: "turn-end" },
      { op: "user-input", text: "second" },
      { op: "block", partID: "ast_c:0", role: "text", text: "new", status: "ok" },
      { op: "turn-end" },
      { op: "seed-history", texts: ["first", "second"] },
    ]);
  });

  test("one collapsed earlier assistant uses the singular wording", () => {
    const ops = translateHistoryV2([assistant("ast_a", [text("old")]), compactionCompleted("cmp_1", "S")]);
    expect(ops[0]).toEqual({ op: "system-message", text: "[1 earlier message summarized — see compacted summary below]" });
  });

  // An auto compaction sets `auto: true` on the divider. A second completed compaction is not the boundary, so
  // its summary is role `text`, which is what v1 does for a later summary message.
  test("auto compaction sets the divider flag, and a later completed compaction renders its summary as text", () => {
    const ops = translateHistoryV2([
      compactionCompleted("cmp_1", "S1", "auto"),
      assistant("ast_c", [text("mid")]),
      compactionCompleted("cmp_2", "S2", "manual"),
    ]);
    expect(ops).toEqual([
      { op: "block", partID: "cmp_1:summary", role: "summary", text: "S1", status: "ok" },
      { op: "compaction-divider", auto: true },
      { op: "turn-end" },
      { op: "block", partID: "ast_c:0", role: "text", text: "mid", status: "ok" },
      { op: "turn-end" },
      { op: "block", partID: "cmp_2:summary", role: "text", text: "S2", status: "ok" },
      { op: "compaction-divider", auto: false },
      { op: "turn-end" },
    ]);
  });

  // Capture §4.12 failed compaction (capture 3). The failed item is not a boundary and renders nothing. Only the
  // assistant beside it renders.
  test("failed and running compactions render nothing and do not collapse earlier messages", () => {
    const ops = translateHistoryV2([
      assistant("ast_a", [text("kept")]),
      compactionFailed("cmp_f"),
    ]);
    expect(ops).toEqual([
      { op: "block", partID: "ast_a:0", role: "text", text: "kept", status: "ok" },
      { op: "turn-end" },
    ]);
  });

  // Capture §5a: shell, model-switched, synthetic and the other item types have no v1 message-list equivalent.
  // Capture §4.8: an idle item adds no marker of its own. None of them produces an operation.
  test("items with no v1 message-list equivalent produce no operations", () => {
    const ops = translateHistoryV2([
      { id: "shl_1", type: "shell", time: { created: T }, shellID: "sh_1", command: "ls", status: "exited", exit: 0 },
      { id: "mdl_1", type: "model-switched", time: { created: T }, model: MODEL },
      { id: "syn_1", type: "synthetic", time: { created: T }, text: "injected" },
      { id: "sys_1", type: "system", time: { created: T }, text: "system line" },
      { id: "skl_1", type: "skill", time: { created: T }, skill: "s", name: "n", text: "t" },
      { id: "agt_1", type: "agent-switched", time: { created: T }, agent: "general" },
      // location-switched has a `location` shape that this test does not need, so it is cast from a plain object.
      { id: "loc_1", type: "location-switched", time: { created: T }, location: { directory: "/x" } } as unknown as SessionMessageInfo,
      idle("idl_1", "succeeded"),
    ]);
    expect(ops).toEqual([]);
  });

  // Parity: for the same conversation, the v2 translation gives the same HistoryOp kinds, in the same order,
  // that the v1 translator gives. Only the partIDs differ.
  test("for equivalent content, the operation kinds and block roles match the v1 translator", () => {
    const v2Ops = translateHistoryV2([
      user("usr_1", "hello"),
      assistant("ast_1", [reasoning("plan"), text("done"), tool("call_1", "bash", completedState(["ok\n"]))]),
    ]);
    const v1Messages = [
      { info: { id: "m1", role: "user" }, parts: [{ id: "p0", type: "text", text: "hello" }] },
      {
        info: { id: "m2", role: "assistant" },
        parts: [
          { id: "p1", type: "reasoning", text: "plan" },
          { id: "p2", type: "text", text: "done" },
          { id: "call_1", type: "tool", tool: "bash", state: { status: "completed", output: "ok\n" } },
        ],
      },
    ] as unknown as SessionMessagesResponses[200];
    const v1Ops = translateHistory(v1Messages);

    const kinds = (ops: typeof v1Ops) => ops.map((op) => (op.op === "block" ? `block:${op.role}` : op.op));
    expect(kinds(v2Ops)).toEqual(kinds(v1Ops));
    expect(kinds(v2Ops)).toEqual([
      "user-input",
      "block:thinking",
      "block:text",
      "block:tool-call",
      "block:tool-result",
      "turn-end",
      "seed-history",
    ]);
    // The tool-result block is identical, partID included, so the joined v2 content equals v1's output string.
    const v2Result = v2Ops.find((op) => op.op === "block" && op.role === "tool-result");
    const v1Result = v1Ops.find((op) => op.op === "block" && op.role === "tool-result");
    expect(v2Result).toEqual(v1Result);
  });
});

// ─── hasPendingToolCallsV2 ───

describe("hasPendingToolCallsV2", () => {
  test("no assistant message gives false", () => {
    expect(hasPendingToolCallsV2([user("usr_1", "hi")])).toBe(false);
  });

  // Capture §4.4: a running shell call. The state is not completed or error.
  test("latest assistant with a running tool gives true", () => {
    const messages = [assistant("ast_1", [tool("call_1", "shell", runningState({}, { command: "sleep 20" }))])];
    expect(hasPendingToolCallsV2(messages)).toBe(true);
  });

  test("latest assistant with a streaming tool gives true", () => {
    const messages = [assistant("ast_1", [tool("call_1", "shell", { status: "streaming", input: "{" })])];
    expect(hasPendingToolCallsV2(messages)).toBe(true);
  });

  // Capture §4.4 interrupt: the aborted tool is `error`, so nothing is pending. A completed tool is not pending.
  test("latest assistant whose tools are all completed or error gives false", () => {
    const messages = [
      assistant("ast_1", [
        tool("call_1", "shell", completedState(["x"])),
        tool("call_2", "shell", errorState("aborted", "Tool execution interrupted")),
      ]),
    ];
    expect(hasPendingToolCallsV2(messages)).toBe(false);
  });

  // DIVERGENCE from v1: only the latest assistant is checked. An earlier assistant with an unresolved running tool
  // does not hold the guard closed. See the doc comment on hasPendingToolCallsV2.
  test("an earlier assistant's unresolved tool does not count once a later assistant exists", () => {
    const messages = [
      assistant("ast_1", [tool("call_old", "shell", runningState({}, {}))]),
      assistant("ast_2", [text("done")]),
    ];
    expect(hasPendingToolCallsV2(messages)).toBe(false);
  });
});

// ─── scanLatestAssistantActivityV2 ───

/** A fixed "now" for the staleness tests. */
const NOW = T + 10_000_000;

/** A child fetcher that answers from a map. An unknown id gives an empty list (no assistant, so not stale). */
function childFetcher(map: Record<string, SessionMessageInfo[] | undefined>): (id: string) => Promise<SessionMessageInfo[] | undefined> {
  return async (id) => map[id];
}

describe("scanLatestAssistantActivityV2", () => {
  test("no assistant message gives null", async () => {
    expect(await scanLatestAssistantActivityV2([user("usr_1", "hi")], childFetcher({}), NOW)).toBeNull();
  });

  // A completed newest message is never stale, and it needs no child lookup. The fetcher throws, so a lookup
  // would fail the test.
  test("completed newest assistant gives its completion time and never looks up a child", async () => {
    const fetchChild = async (): Promise<SessionMessageInfo[] | undefined> => {
      throw new Error("child should not be fetched");
    };
    const messages = [
      assistant("ast_1", [tool("call_1", "subagent", runningState({ sessionID: "ses_child" }))], {
        time: { created: T, completed: T + 9 },
      }),
    ];
    const result = await scanLatestAssistantActivityV2(messages, fetchChild, NOW);
    expect(result).toEqual({ hasContent: true, completedAt: T + 9, openChild: null });
  });

  test("incomplete newest assistant with no content has hasContent false and no child", async () => {
    const messages = [assistant("ast_1", [], { time: { created: T } })];
    expect(await scanLatestAssistantActivityV2(messages, childFetcher({}), NOW)).toEqual({
      hasContent: false,
      completedAt: undefined,
      openChild: null,
    });
  });

  test("incomplete turn with only text has no open child", async () => {
    const messages = [assistant("ast_1", [text("streaming")], { time: { created: T } })];
    expect(await scanLatestAssistantActivityV2(messages, childFetcher({}), NOW)).toEqual({
      hasContent: true,
      completedAt: undefined,
      openChild: null,
    });
  });

  // Capture §4.9 parent-side link: the running `subagent` call carries the child's session ID in metadata.
  // A child whose newest activity is recent is not stale.
  test("running subagent with a fresh child gives openChild with stale false", async () => {
    const messages = [
      assistant("ast_1", [tool("call_nja9hdcz", "subagent", runningState({ sessionID: "ses_child" }))], {
        time: { created: T },
      }),
    ];
    const child = [assistant("ast_c", [text("working")], { time: { created: NOW - 1_000 } })];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({ ses_child: child }), NOW);
    expect(result).toEqual({
      hasContent: true,
      completedAt: undefined,
      openChild: { sessionID: "ses_child", stale: false },
    });
  });

  // The child's newest activity is 200 s old, which is past the 180 s watchdog window, so it is stale.
  test("running subagent with a child idle past 3 minutes gives openChild with stale true", async () => {
    const messages = [
      assistant("ast_1", [tool("call_nja9hdcz", "subagent", runningState({ sessionID: "ses_child" }))], {
        time: { created: T },
      }),
    ];
    const child = [assistant("ast_c", [text("hung")], { time: { created: NOW - 200_000 } })];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({ ses_child: child }), NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: true });
  });

  test("a child with no assistant message is not stale", async () => {
    const messages = [
      assistant("ast_1", [tool("call_1", "subagent", runningState({ sessionID: "ses_child" }))], { time: { created: T } }),
    ];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({ ses_child: [] }), NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });

  test("a child list that cannot be fetched is not stale", async () => {
    const messages = [
      assistant("ast_1", [tool("call_1", "subagent", runningState({ sessionID: "ses_child" }))], { time: { created: T } }),
    ];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({}), NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });

  test("a child whose own turn completed is never stale, however old", async () => {
    const messages = [
      assistant("ast_1", [tool("call_1", "subagent", runningState({ sessionID: "ses_child" }))], { time: { created: T } }),
    ];
    const child = [assistant("ast_c", [text("done")], { time: { created: NOW - 900_000, completed: NOW - 800_000 } })];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({ ses_child: child }), NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });

  // A running subagent with no session ID in metadata cannot be linked, so no child is reported.
  test("running subagent without a child session ID gives no open child", async () => {
    const messages = [assistant("ast_1", [tool("call_1", "subagent", runningState({}))], { time: { created: T } })];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({}), NOW);
    expect(result?.openChild).toBeNull();
  });

  // Capture §4.4 parallel calls: the subagent is found even when another call comes after it in the same step.
  // v1 checks only the last part, which would miss this.
  test("a running subagent is found even when a shell call follows it in the same step", async () => {
    const messages = [
      assistant(
        "ast_1",
        [
          tool("call_sub", "subagent", runningState({ sessionID: "ses_child" })),
          tool("call_sh", "shell", runningState({}, { command: "sleep 20" })),
        ],
        { time: { created: T } },
      ),
    ];
    const child = [assistant("ast_c", [text("fresh")], { time: { created: NOW - 1_000 } })];
    const result = await scanLatestAssistantActivityV2(messages, childFetcher({ ses_child: child }), NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });
});

// ─── pickPostCompactionAssistantTokenUsageV2 ───

describe("pickPostCompactionAssistantTokenUsageV2", () => {
  test("no assistant gives null", () => {
    expect(pickPostCompactionAssistantTokenUsageV2([user("usr_1", "hi")])).toBeNull();
  });

  // Capture §4.3 (`session.step.ended` tokens) and §5a (`tokens`). The context size is input plus cache read plus
  // cache write, as v1 computes it. The model comes from the newest assistant.
  test("with no compaction, uses the newest assistant's input plus cache tokens and its model", () => {
    const messages = [
      assistant("ast_1", [text("a")], { tokens: usage(100, 20, 5) }),
      assistant("ast_2", [text("b")], { tokens: usage(8019, 16064, 0), model: { id: "glm-5.3-flash", providerID: "sohoai" } }),
    ];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)).toEqual({
      used: 8019 + 16064,
      providerID: "sohoai",
      modelID: "glm-5.3-flash",
    });
  });

  // Mirrors v1's zero-usage fallback. The newest assistant has zero usage, so the most recent earlier non-zero
  // one is used. The model is still the newest assistant's, as v1 keeps it.
  test("a zero-usage newest assistant falls back to the most recent earlier non-zero usage, keeping the newest model", () => {
    const messages = [
      assistant("ast_1", [text("a")], { tokens: usage(500), model: { id: "older", providerID: "p-old" } }),
      assistant("ast_2", [text("b")], { tokens: usage(0), model: MODEL }),
    ];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)).toEqual({
      used: 500,
      providerID: MODEL.providerID,
      modelID: MODEL.id,
    });
  });

  // Capture §5a: a failed step has tokens null. The newest assistant then gives null, as in v1.
  test("a newest assistant with no tokens gives null", () => {
    const messages = [assistant("ast_1", [text("a")], { tokens: undefined })];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)).toBeNull();
  });

  // Capture §4.12 boundary: the completed compaction plays v1's summary boundary. Usage from before it is ignored.
  test("usage before a completed compaction is ignored, and the newest assistant after it is used", () => {
    const messages = [
      assistant("ast_old", [text("old")], { tokens: usage(99_999) }),
      compactionCompleted("cmp_1", "S"),
      assistant("ast_new", [text("new")], { tokens: usage(1200) }),
    ];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)?.used).toBe(1200);
  });

  test("a compaction with no assistant after it gives null", () => {
    const messages = [assistant("ast_old", [text("old")], { tokens: usage(99_999) }), compactionCompleted("cmp_1", "S")];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)).toBeNull();
  });

  // Capture §4.12: a failed compaction is not a boundary, so the earlier usage still counts.
  test("a failed compaction is not a boundary", () => {
    const messages = [assistant("ast_1", [text("a")], { tokens: usage(700) }), compactionFailed("cmp_f")];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)?.used).toBe(700);
  });

  // With two completed compactions, the LAST one is the boundary, as v1 uses its last summary.
  test("with two completed compactions, only assistants after the last one count", () => {
    const messages = [
      assistant("ast_1", [text("a")], { tokens: usage(5000) }),
      compactionCompleted("cmp_1", "S1"),
      assistant("ast_2", [text("b")], { tokens: usage(3000) }),
      compactionCompleted("cmp_2", "S2"),
      assistant("ast_3", [text("c")], { tokens: usage(800) }),
    ];
    expect(pickPostCompactionAssistantTokenUsageV2(messages)?.used).toBe(800);
  });
});

// ─── addAssistantCostV2 ───

describe("addAssistantCostV2", () => {
  // The same skip rules as v1's addAssistantCost: missing, NaN, negative and zero are not added. Non-assistant
  // items are ignored.
  test("adds assistant costs in order and skips missing, NaN, negative, zero and non-assistant items", () => {
    const messages: SessionMessageInfo[] = [
      assistant("ast_1", [text("a")], { cost: 0.25 }),
      assistant("ast_2", [text("b")], { cost: Number.NaN }),
      assistant("ast_3", [text("c")], { cost: -1 }),
      assistant("ast_4", [text("d")], { cost: 0 }),
      assistant("ast_5", [text("e")], { cost: undefined }),
      user("usr_1", "hi"),
    ];
    expect(addAssistantCostV2(1, messages)).toBe(1.25);
  });
});

// ─── queryTokenUsageV2 (fake fetchers) ───

describe("queryTokenUsageV2", () => {
  // No post-boundary usage gives null, and the children are not fetched at all (as v1 skips the roll-up).
  test("null when there is no post-boundary usage, and children are not listed", async () => {
    let childrenListed = false;
    const result = await queryTokenUsageV2(
      async () => [compactionCompleted("cmp_1", "S")],
      async () => {
        childrenListed = true;
        return [];
      },
      "ses_parent",
    );
    expect(result).toBeNull();
    expect(childrenListed).toBe(false);
  });

  // Capture §4.9 and P3: child costs roll into the parent's running cost, one level deep.
  test("the running cost sums the parent's assistant costs and each child's", async () => {
    const parent = [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })];
    const child = [assistant("ast_c", [text("c")], { cost: 0.25, tokens: usage(7296) })];
    const result = await queryTokenUsageV2(
      async (id) => (id === "ses_parent" ? parent : child),
      async () => [{ id: "ses_child" }],
      "ses_parent",
    );
    expect(result).toEqual({ used: 900, providerID: MODEL.providerID, modelID: MODEL.id, runningCost: 0.75 });
  });

  test("a child whose messages cannot be fetched is skipped, and the other child still counts", async () => {
    const parent = [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })];
    const goodChild = [assistant("ast_g", [text("g")], { cost: 0.125, tokens: usage(1) })];
    const result = await queryTokenUsageV2(
      async (id) => {
        if (id === "ses_parent") return parent;
        if (id === "ses_bad") throw new Error("child fetch failed");
        return goodChild;
      },
      async () => [{ id: "ses_bad" }, { id: "ses_good" }],
      "ses_parent",
    );
    expect(result?.runningCost).toBe(0.625);
  });

  test("a child fetch that resolves undefined adds nothing", async () => {
    const parent = [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })];
    const result = await queryTokenUsageV2(
      async (id) => (id === "ses_parent" ? parent : undefined),
      async () => [{ id: "ses_child" }],
      "ses_parent",
    );
    expect(result?.runningCost).toBe(0.5);
  });

  // The children endpoint failing leaves the parent's cost on its own.
  test("a children listing that throws leaves the parent cost on its own", async () => {
    const parent = [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })];
    const result = await queryTokenUsageV2(
      async () => parent,
      async () => {
        throw new Error("children endpoint down");
      },
      "ses_parent",
    );
    expect(result?.runningCost).toBe(0.5);
  });

  test("a children listing that resolves undefined leaves the parent cost on its own", async () => {
    const parent = [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })];
    const result = await queryTokenUsageV2(async () => parent, async () => undefined, "ses_parent");
    expect(result?.runningCost).toBe(0.5);
  });
});

// ─── fetchHistoryV2 ───

describe("fetchHistoryV2", () => {
  test("translates the fetched messages", async () => {
    const ops = await fetchHistoryV2(async () => [user("usr_1", "hi")], "ses_1");
    expect(ops).toEqual([
      { op: "user-input", text: "hi" },
      { op: "seed-history", texts: ["hi"] },
    ]);
  });

  // Replay is best-effort, as v1's fetchHistory is: a failure or a missing list gives [], not a throw.
  test("a fetch that throws, or resolves undefined, gives []", async () => {
    expect(
      await fetchHistoryV2(async () => {
        throw new Error("boom");
      }, "ses_1"),
    ).toEqual([]);
    expect(await fetchHistoryV2(async () => undefined, "ses_1")).toEqual([]);
  });
});

// ─── V2Backend.events wiring (fake SDK client) ───

/** A message-list entry for the fake client's `message.list`. */
type FakeMessages = Record<string, SessionMessageInfo[]>;

/**
 * Builds a V2Backend over a fake SDK client. `message.list` answers from `messages` by session ID, and
 * `session.list` answers children from `children` by `parentID`. A session ID in `failing` throws from
 * `message.list`. The fake's shape is the subset that V2Backend calls.
 */
function wiringBackend(messages: FakeMessages, children: Record<string, string[]> = {}, failing: string[] = []): V2Backend {
  const client = {
    message: {
      list: async (input: { sessionID: string }) => {
        if (failing.includes(input.sessionID)) throw new Error("message list failed");
        return { data: messages[input.sessionID] ?? [], cursor: { next: null } };
      },
    },
    session: {
      list: async (input: { parentID?: string }) => {
        const ids = input.parentID !== undefined ? (children[input.parentID] ?? []) : [];
        const data = ids.map((id) => ({
          id,
          parentID: input.parentID,
          title: "child",
          location: { directory: "/work/project" },
          time: { updated: T },
        }));
        return { data, cursor: { next: null } };
      },
    },
  };
  return new V2Backend("http://127.0.0.1:1", "/work/project", client as unknown as OpenCodeClient);
}

describe("V2Backend.events wiring", () => {
  test("getHistory reads the message list and translates it", async () => {
    const backend = wiringBackend({ ses_1: [user("usr_1", "hello")] });
    expect(await backend.events.getHistory("ses_1")).toEqual([
      { op: "user-input", text: "hello" },
      { op: "seed-history", texts: ["hello"] },
    ]);
  });

  test("hasPendingToolCalls reads the message list", async () => {
    const backend = wiringBackend({
      ses_1: [assistant("ast_1", [tool("call_1", "shell", runningState({}, { command: "sleep 5" }))])],
    });
    expect(await backend.events.hasPendingToolCalls("ses_1")).toBe(true);
  });

  test("getLatestAssistantActivity returns null for a session with no assistant", async () => {
    const backend = wiringBackend({ ses_1: [user("usr_1", "hi")] });
    expect(await backend.events.getLatestAssistantActivity("ses_1")).toBeNull();
  });

  // The child is listed through session.list with parentID, then its messages are fetched, as in §4.9 and P3.
  test("getTokenUsage adds the child's cost, read from the children listing and the child's messages", async () => {
    const backend = wiringBackend(
      {
        ses_parent: [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })],
        ses_child: [assistant("ast_c", [text("c")], { cost: 0.25, tokens: usage(7296) })],
      },
      { ses_parent: ["ses_child"] },
    );
    expect(await backend.events.getTokenUsage("ses_parent")).toEqual({
      used: 900,
      providerID: MODEL.providerID,
      modelID: MODEL.id,
      runningCost: 0.75,
    });
  });

  test("getTokenUsage skips a child whose messages fail to load", async () => {
    const backend = wiringBackend(
      {
        ses_parent: [assistant("ast_p", [text("p")], { cost: 0.5, tokens: usage(900) })],
      },
      { ses_parent: ["ses_child"] },
      ["ses_child"],
    );
    expect((await backend.events.getTokenUsage("ses_parent"))?.runningCost).toBe(0.5);
  });
});

// ─── Missed history and rendered tracking (Stage 15.2, D-A fix) ───

/** A live `session.text.started` frame for one assistant message (capture §4.1), as `translateEvent` takes it. */
function liveTextStart(sessionID: string, messageID: string) {
  return { type: "session.text.started", data: { sessionID, assistantMessageID: messageID, ordinal: 0 } } as never;
}

describe("translateHistoryV2 include predicate (D-A fix)", () => {
  test("the default includes every item, so the output is unchanged", () => {
    const messages = [user("usr_1", "hi"), assistant("ast_1", [text("hello")])];
    expect(translateHistoryV2(messages, () => true)).toEqual(translateHistoryV2(messages));
  });

  test("an excluded boundary compaction gives no collapse line and no summary, and the collapsed messages stay collapsed", () => {
    // The compaction was already rendered live. Only the assistant message after it is missing.
    const messages = [assistant("ast_a", [text("old")]), compactionCompleted("cmp_1", "S"), assistant("ast_b", [text("new")])];
    expect(translateHistoryV2(messages, (m) => m.id !== "cmp_1")).toEqual([
      { op: "block", partID: "ast_b:0", role: "text", text: "new", status: "ok" },
      { op: "turn-end" },
    ]);
  });
});

describe("translateMissedHistoryV2 (D-A fix)", () => {
  test("nothing selected gives no operations and no ids", () => {
    const messages = [user("usr_1", "hi"), assistant("ast_1", [text("hello")])];
    expect(translateMissedHistoryV2(messages, () => true)).toEqual({ ops: [], renderedIDs: [] });
  });

  test("one missed complete turn gives exactly that turn's operations, and its ids", () => {
    const messages = [
      user("usr_1", "first"),
      assistant("ast_1", [text("reply one")]),
      user("usr_2", "second"),
      assistant("ast_2", [text("reply two")]),
    ];
    const rendered = new Set(["usr_1", "ast_1"]);
    expect(translateMissedHistoryV2(messages, (m) => rendered.has(m.id))).toEqual({
      ops: [
        { op: "user-input", text: "second" },
        { op: "block", partID: "ast_2:0", role: "text", text: "reply two", status: "ok" },
        { op: "turn-end" },
        { op: "seed-history", texts: ["second"] },
      ],
      renderedIDs: ["usr_2", "ast_2"],
    });
  });

  test("an in-flight assistant message (no time.completed) is not selected", () => {
    // An in-flight step has no finish, no error and no completed time (capture §5a). The helper's default finish is
    // removed here, since G3 counts a finish as an end signal.
    const inFlight = assistant("ast_3", [text("par")], { time: { created: T, streamed: T + 1 }, finish: undefined } as Partial<AssistantMsg>);
    expect(translateMissedHistoryV2([inFlight], () => false)).toEqual({ ops: [], renderedIDs: [] });
  });

  // G3 (Stage 15.2 live defect). An interrupted or failed assistant message can lack `time.completed`. Capture §5a
  // shows the aborted item with `finish: "error"` and `error: {type: "aborted"}`. Without the completed time it was
  // never selected, so a resync after a gap lost the turn. These fixtures drop `time.completed` and rely on the
  // other signals.
  test("G3: an aborted assistant without time.completed but with finish error and error aborted is selected", () => {
    const aborted = assistant("ast_abort", [text("partial")], {
      time: { created: T, streamed: T + 1 },
      finish: "error",
      error: { type: "aborted", message: "Step interrupted" },
    } as Partial<AssistantMsg>);
    const result = translateMissedHistoryV2([user("usr_1", "go"), aborted], (m) => m.id === "usr_1");
    expect(result.renderedIDs).toEqual(["ast_abort"]);
    expect(result.ops).toContainEqual({ op: "block", partID: "ast_abort:0", role: "text", text: "partial", status: "ok" });
  });

  test("G3: a failed assistant without time.completed but with an error is selected", () => {
    const failed = assistant("ast_fail", [], {
      time: { created: T, streamed: T + 1 },
      finish: "error",
      error: { type: "provider.transport", message: "FailedToOpenSocket" },
    } as Partial<AssistantMsg>);
    const result = translateMissedHistoryV2([failed], () => false);
    expect(result.renderedIDs).toEqual(["ast_fail"]);
    expect(result.ops).toEqual([{ op: "turn-end" }]);
  });

  // Capture 3 retry-loop interrupt: the assistant has no finish, no error and no completed time, but the idle after
  // it is `interrupted`. The idle marks the message as over.
  test("G3: an interrupted assistant with no finish, error or completed time is selected when an idle follows it", () => {
    const interrupted = assistant("ast_int", [], {
      time: { created: T, streamed: T + 1 },
      finish: undefined,
    } as Partial<AssistantMsg>);
    const messages = [user("usr_1", "go"), interrupted, idle("idl_1", "interrupted")];
    const result = translateMissedHistoryV2(messages, (m) => m.id === "usr_1");
    expect(result.renderedIDs).toEqual(["ast_int"]);
  });

  test("G3: an idle BEFORE an in-flight assistant does not end it", () => {
    const inFlight = assistant("ast_live", [text("par")], {
      time: { created: T, streamed: T + 1 },
      finish: undefined,
    } as Partial<AssistantMsg>);
    const messages = [idle("idl_0", "succeeded"), inFlight];
    expect(translateMissedHistoryV2(messages, () => false)).toEqual({ ops: [], renderedIDs: [] });
  });

  test("a running compaction is not selected, so a later completed one can still render", () => {
    const running: SessionMessageInfo = {
      id: "cmp_9",
      type: "compaction",
      time: { created: T + 20 },
      status: "running",
      reason: "auto",
    } as SessionMessageInfo;
    expect(translateMissedHistoryV2([running], () => false)).toEqual({ ops: [], renderedIDs: [] });
  });

  test("a user item whose own text prefix matches is left to the caller's predicate", () => {
    const messages = [user("usr_cmd", "# /brain-abandon\n\nClean up.")];
    expect(translateMissedHistoryV2(messages, () => true)).toEqual({ ops: [], renderedIDs: [] });
  });

  // An interrupted turn's idle is never selected, so a resync never renders its "Interrupted" marker. Only a full
  // replay shows it. The user and the aborted assistant are still selected, and their ids are recorded.
  test("an interrupted idle is never selected on resync, so the Interrupted marker is never rendered", () => {
    const aborted = assistant("ast_abort", [text("partial")], {
      time: { created: T, streamed: T + 1 },
      finish: "error",
      error: { type: "aborted", message: "Step interrupted" },
    } as Partial<AssistantMsg>);
    const messages = [user("usr_1", "go"), aborted, idle("idl_1", "interrupted")];
    const result = translateMissedHistoryV2(messages, () => false);
    expect(result.renderedIDs).toEqual(["usr_1", "ast_abort"]);
    expect(result.renderedIDs).not.toContain("idl_1");
    expect(result.ops.some((op) => op.op === "system-message")).toBe(false);
    expect(result.ops[result.ops.length - 1]).toEqual({ op: "seed-history", texts: ["go"] });
  });

  test("a completed compaction not yet rendered gives the collapse line, summary and divider, once", () => {
    const messages = [assistant("ast_a", [text("old")]), compactionCompleted("cmp_1", "S", "auto"), assistant("ast_b", [text("new")])];
    expect(translateMissedHistoryV2(messages, () => false).ops).toEqual([
      { op: "system-message", text: "[1 earlier message summarized — see compacted summary below]" },
      { op: "block", partID: "cmp_1:summary", role: "summary", text: "S", status: "ok" },
      { op: "compaction-divider", auto: true },
      { op: "turn-end" },
      { op: "block", partID: "ast_b:0", role: "text", text: "new", status: "ok" },
      { op: "turn-end" },
    ]);
  });
});

describe("fetchHistoryV2 onFetched and fetchMissedHistoryV2 (D-A fix)", () => {
  test("onFetched sees the fetched list before translation", async () => {
    const seen: string[] = [];
    await fetchHistoryV2(async () => [user("usr_1", "hi")], "ses_1", (messages) => seen.push(...messages.map((m) => m.id)));
    expect(seen).toEqual(["usr_1"]);
  });

  test("onFetched is not called when the fetch fails", async () => {
    let called = false;
    await fetchHistoryV2(async () => undefined, "ses_1", () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test("a failed fetch yields no operations and no ids, so the next resync tries again", async () => {
    expect(
      await fetchMissedHistoryV2(
        async () => {
          throw new Error("boom");
        },
        "ses_1",
        () => false,
      ),
    ).toEqual({ ops: [], renderedIDs: [] });
  });
});

describe("V2Backend.events missed history (D-A fix, fake SDK client)", () => {
  test("nothing missing: a live turn already shown gives zero operations on resync", async () => {
    const messages: FakeMessages = {
      ses_1: [user("usr_1", "hello"), assistant("ast_1", [text("hi")])],
    };
    const backend = wiringBackend(messages);
    // The own prompt was rendered by the app at send time. The reply's first text frame rendered it live.
    backend.events.recordOwnMessageID("usr_1");
    backend.events.translateEvent(liveTextStart("ses_1", "ast_1"), "ses_1");
    expect(await backend.events.getMissedHistory("ses_1")).toEqual([]);
  });

  test("one missed complete turn renders exactly that turn, and not again on the next resync", async () => {
    const messages: FakeMessages = {
      ses_1: [user("usr_1", "hello"), assistant("ast_1", [text("hi")])],
    };
    const backend = wiringBackend(messages);
    backend.events.recordOwnMessageID("usr_1");
    backend.events.translateEvent(liveTextStart("ses_1", "ast_1"), "ses_1");
    // Turn two completed while frames were missed, so the translator never saw it.
    messages.ses_1 = [...messages.ses_1, user("usr_2", "again"), assistant("ast_2", [text("second reply")])];

    expect(await backend.events.getMissedHistory("ses_1")).toEqual([
      { op: "user-input", text: "again" },
      { op: "block", partID: "ast_2:0", role: "text", text: "second reply", status: "ok" },
      { op: "turn-end" },
      { op: "seed-history", texts: ["again"] },
    ]);
    expect(await backend.events.getMissedHistory("ses_1")).toEqual([]);
  });

  test("an in-flight message is skipped, then rendered by a later resync once it completes", async () => {
    const messages: FakeMessages = {
      ses_1: [
        user("usr_1", "hello"),
        assistant("ast_1", [text("still going")], { time: { created: T, streamed: T + 1 }, finish: undefined } as Partial<AssistantMsg>),
      ],
    };
    const backend = wiringBackend(messages);
    backend.events.recordOwnMessageID("usr_1");

    expect(await backend.events.getMissedHistory("ses_1")).toEqual([]);

    messages.ses_1 = [user("usr_1", "hello"), assistant("ast_1", [text("still going, done")])];
    expect(await backend.events.getMissedHistory("ses_1")).toEqual([
      { op: "block", partID: "ast_1:0", role: "text", text: "still going, done", status: "ok" },
      { op: "turn-end" },
    ]);
  });

  test("getHistory records the messages it returns, so a later resync renders none of them again", async () => {
    const messages: FakeMessages = {
      ses_1: [user("usr_1", "hello"), assistant("ast_1", [text("hi")])],
    };
    const backend = wiringBackend(messages);
    expect(await backend.events.getHistory("ses_1")).toEqual([
      { op: "user-input", text: "hello" },
      { op: "block", partID: "ast_1:0", role: "text", text: "hi", status: "ok" },
      { op: "turn-end" },
      { op: "seed-history", texts: ["hello"] },
    ]);
    expect(await backend.events.getMissedHistory("ses_1")).toEqual([]);
  });

  test("resetEventState clears the record, so the next resync renders the complete messages again", async () => {
    const messages: FakeMessages = {
      ses_1: [user("usr_1", "hello"), assistant("ast_1", [text("hi")])],
    };
    const backend = wiringBackend(messages);
    await backend.events.getHistory("ses_1");
    backend.events.resetEventState();
    expect((await backend.events.getMissedHistory("ses_1")).length).toBeGreaterThan(0);
  });

  test("a failed message list gives no operations", async () => {
    const backend = wiringBackend({}, {}, ["ses_1"]);
    expect(await backend.events.getMissedHistory("ses_1")).toEqual([]);
  });
});

// ─── G2: the context meter follows the newest assistant across turns, through the paged REST fetch ───

/**
 * A fake `message.list` that serves `messages` in pages of `pageSize`, oldest first, the way the first `order: "asc"`
 * call and the `cursor`-only calls do (capture §4.11). The cursor is the index of the next page, as a string.
 * The last page answers `cursor.next: null`. The fake records every call, so a test can check the paging shape.
 */
function pagedBackend(getMessages: () => SessionMessageInfo[], pageSize: number): V2Backend {
  const client = {
    message: {
      list: async (input: { sessionID: string; cursor?: string }) => {
        const all = getMessages();
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const data = all.slice(start, start + pageSize);
        const nextStart = start + pageSize;
        return { data, cursor: { next: nextStart < all.length ? String(nextStart) : null } };
      },
    },
    session: {
      list: async () => ({ data: [], cursor: { next: null } }),
    },
  };
  return new V2Backend("http://127.0.0.1:1", "/work/project", client as unknown as OpenCodeClient);
}

/** An assistant message whose context size is `used` (input only, no cache), so the sum is exact. */
function assistantUsing(id: string, used: number): AssistantMsg {
  return assistant(id, [text("reply")], { tokens: usage(used) });
}

describe("G2: getTokenUsage follows the newest assistant across turns (paged fetch)", () => {
  test("after each turn the meter shows that turn's context, with pages smaller than the list", async () => {
    // Context sizes of the successive assistant steps in capture 3b (v2-capture-3b, obs4 list, oldest first):
    // input plus cache read, as capture §4.3 reports them. Each turn is user, assistant, idle.
    const usages = [7974, 8011, 8096, 8121, 8209, 8315, 8427];
    const messages: SessionMessageInfo[] = [];
    const backend = pagedBackend(() => messages, 2);

    for (let turn = 0; turn < usages.length; turn++) {
      messages.push(user(`usr_${turn}`, `turn ${turn}`), assistantUsing(`ast_${turn}`, usages[turn]), idle(`idl_${turn}`, "succeeded"));
      const usage = await backend.events.getTokenUsage("ses_1");
      expect(usage?.used).toBe(usages[turn]);
    }
  });

  test("a turn whose newest assistant lies on the last page is still read", async () => {
    // Five messages with page size 2: the newest assistant is on the third page, the one a first-page-only read would miss.
    const messages: SessionMessageInfo[] = [
      user("usr_1", "a"),
      assistantUsing("ast_1", 8000),
      idle("idl_1", "succeeded"),
      user("usr_2", "b"),
      assistantUsing("ast_2", 8500),
    ];
    const backend = pagedBackend(() => messages, 2);
    expect((await backend.events.getTokenUsage("ses_1"))?.used).toBe(8500);
  });
});
