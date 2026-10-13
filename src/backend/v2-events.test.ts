/**
 * Tests for the v2 event translator (src/backend/v2-events.ts), Stage 15.2 C2.4a "core streaming" and C2.4b
 * (permissions, forms, subagent children, compaction, model-selected).
 *
 * Every frame here is SYNTHESISED. Each one follows the shape quoted in `docs/OpenCode-v2-protocol-capture.md`,
 * and the comment on each test names the section or the capture line it mirrors. No capture artefact is
 * committed (operator decision C6).
 *
 * `Feed` builds the frames. Durable frames get consecutive `seq` values, as the server does (capture §2b).
 * A gap therefore appears only where a test asks for one. Non-durable frames carry no `seq`.
 */
import { describe, expect, test } from "bun:test";
import type { ReplEvent } from "../events.ts";
import { V2EventTranslator } from "./v2-events.ts";

// ─── Fixtures ───

/** The session the REPL is showing in most tests. */
const SID = "ses_parent";
/** An assistant message id, as in capture §4.1 (`msg_…`). */
const MSG = "msg_1350d8922001Upjb4nJACI32IY";
/** A tool call id, as in capture §4.4 (`call_…`). */
const CALL = "call_x9y407un";
/** A shell id, as in capture §4.5 (`sh_…`). */
const SHELL = "sh_1352d145f001ub3SojHujD3yLh";
/** A subagent child session id, as in capture §4.9 (`ses_…`). */
const CHILD = "ses_ecad2e243ffeRU5SRXXCTakYE0";

/**
 * Builds frames for one session. `session` is merged into each `data` (capture §2c), unless `data` already
 * sets it. `durable(seq)` gives the next seq in order. Pass an explicit `seq` to model a gap or a duplicate.
 */
class Feed {
  readonly frames: unknown[] = [];
  private seq = 0;

  /**
   * @param session  The session every frame of this feed belongs to.
   * @param startSeq The seq of the first durable frame. Set it to continue another feed's parent session, so that two
   *                 feeds interleaved in one list still form one ordered seq run.
   */
  constructor(private readonly session: string = SID, startSeq = 0) {
    this.seq = startSeq;
  }

  /** A durable frame: carries `durable.seq` (capture §2b). */
  durable(type: string, data: Record<string, unknown>, seq?: number): this {
    const value = seq ?? this.seq;
    this.seq = value + 1;
    this.frames.push({
      id: `evt_${value}`,
      created: 1,
      type,
      location: { directory: "/tmp/octmux-test" },
      data: { sessionID: this.session, ...data },
      durable: { aggregateID: this.session, seq: value, version: 1 },
    });
    return this;
  }

  /** A non-durable frame: no `durable` and no `seq` (capture §2b). */
  live(type: string, data: Record<string, unknown>): this {
    this.frames.push({ id: "evt_live", created: 1, type, data: { sessionID: this.session, ...data } });
    return this;
  }
}

/** Feeds frames to a translator in order and returns every event produced, flattened into one list. */
function run(translator: V2EventTranslator, frames: unknown[], sessionID: string = SID): ReplEvent[] {
  const out: ReplEvent[] = [];
  for (const frame of frames) {
    const result = translator.translate(frame, sessionID);
    if (result === null) continue;
    out.push(...(Array.isArray(result) ? result : [result]));
  }
  return out;
}

// ─── Turns, text and reasoning (§4.1, §4.2, §4.3, §4.8) ───

describe("v2 translator: a full text and reasoning turn (§4.1, §4.2, §4.3, §4.8)", () => {
  test("maps to the same ReplEvent sequence v1 produces for a reasoning-then-text turn", () => {
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.execution.started", {}) // §4.8: busy begins
      .durable("session.step.started", { assistantMessageID: MSG, agent: "build" }) // §4.3: nothing visible
      .durable("session.reasoning.started", { assistantMessageID: MSG, ordinal: 0, state: { reasoningField: "reasoning_content" } }) // §4.2
      .live("session.reasoning.delta", { assistantMessageID: MSG, ordinal: 0, delta: "The user wants" })
      .live("session.reasoning.delta", { assistantMessageID: MSG, ordinal: 0, delta: " a simple sequence." })
      .durable("session.reasoning.ended", { assistantMessageID: MSG, ordinal: 0, text: "The user wants a simple sequence." }) // §4.2
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }) // §4.1
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "done" }) // §4.1
      .durable("session.text.ended", { assistantMessageID: MSG, ordinal: 0, text: "done" }) // §4.1
      .durable("session.step.ended", { assistantMessageID: MSG, finish: "stop", cost: 0 }) // §4.3
      .durable("session.execution.succeeded", {}); // §4.8

    // Reasoning takes content index 0 and text takes index 1, because reasoning starts first (capture 3b stored
    // content `[reasoning, text]`, see the class note in v2-events.ts).
    expect(run(t, f.frames)).toEqual([
      { kind: "generating" },
      { kind: "block-start", partID: `${MSG}:0`, role: "thinking" },
      { kind: "block-delta", partID: `${MSG}:0`, role: "thinking", text: "The user wants" },
      { kind: "block-delta", partID: `${MSG}:0`, role: "thinking", text: " a simple sequence." },
      { kind: "block-end", partID: `${MSG}:0`, role: "thinking" },
      { kind: "block-start", partID: `${MSG}:1`, role: "text", messageID: MSG },
      { kind: "generating" },
      { kind: "block-delta", partID: `${MSG}:1`, role: "text", text: "done" },
      { kind: "block-end", partID: `${MSG}:1`, role: "text" },
      { kind: "message-completed", messageID: MSG },
      { kind: "parent-turn-end", reason: "idle" },
      { kind: "session-idle" },
    ]);
    // Nothing is left open after the terminal frame, so the reconciler has nothing to close.
    expect(t.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });
});

describe("v2 translator: overlapping reasoning and text (§4.1, §4.2; capture 3b)", () => {
  test("keeps the two blocks apart when text starts before reasoning ends, with no ordinal collision", () => {
    // Capture 3b (`v2-capture-3b/events.sse:37` to `:47`): reasoning and text both have ordinal 0 in one message,
    // and the text starts before the reasoning ends. A key of `${msg}:${ordinal}` would send the text deltas
    // into the reasoning block.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.execution.started", {})
      .durable("session.reasoning.started", { assistantMessageID: MSG, ordinal: 0 })
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 })
      .live("session.reasoning.delta", { assistantMessageID: MSG, ordinal: 0, delta: "The user" })
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "ok" })
      .durable("session.text.ended", { assistantMessageID: MSG, ordinal: 0, text: "ok" })
      .live("session.reasoning.delta", { assistantMessageID: MSG, ordinal: 0, delta: " wants" })
      .durable("session.reasoning.ended", { assistantMessageID: MSG, ordinal: 0, text: "The user wants" });

    expect(run(t, f.frames)).toEqual([
      { kind: "generating" },
      { kind: "block-start", partID: `${MSG}:0`, role: "thinking" },
      { kind: "block-start", partID: `${MSG}:1`, role: "text", messageID: MSG },
      { kind: "generating" },
      { kind: "block-delta", partID: `${MSG}:0`, role: "thinking", text: "The user" },
      { kind: "block-delta", partID: `${MSG}:1`, role: "text", text: "ok" },
      { kind: "block-end", partID: `${MSG}:1`, role: "text" },
      // The reasoning block stays open across the text start and the text end. Its own end closes it.
      { kind: "block-delta", partID: `${MSG}:0`, role: "thinking", text: " wants" },
      { kind: "block-end", partID: `${MSG}:0`, role: "thinking" },
    ]);
  });
});

describe("v2 translator: text and reasoning edge cases (§4.1, §4.2, §2b)", () => {
  test("drops empty deltas, deltas for unknown or closed blocks, and a duplicate start", () => {
    const t = new V2EventTranslator();
    const f = new Feed()
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "orphan" }) // no start yet
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 })
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "" }) // empty: dropped (v1 parity)
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }) // duplicate start: ignored
      .durable("session.text.ended", { assistantMessageID: MSG, ordinal: 0, text: "x" })
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "late" }); // after the block closed

    expect(run(t, f.frames)).toEqual([
      { kind: "block-start", partID: `${MSG}:0`, role: "text", messageID: MSG },
      { kind: "generating" },
      { kind: "block-end", partID: `${MSG}:0`, role: "text" },
    ]);
  });

  test("emits message-completed once per assistant message, even if step.ended repeats", () => {
    // §4.3: one step.ended per assistant message. The repeat guards against a replayed frame (v1 completedAssistantMessageIDs).
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.step.ended", { assistantMessageID: MSG, finish: "tool-calls" })
      .durable("session.step.ended", { assistantMessageID: MSG, finish: "tool-calls" });
    expect(run(t, f.frames)).toEqual([{ kind: "message-completed", messageID: MSG }]);
  });
});

// ─── Tool lifecycle (§4.4, §4.5) ───

describe("v2 translator: a shell tool that exits 0 (§4.4 shell sequence; §4.5 capture 1)", () => {
  test("opens a tool-call block with toolName, closes it ok, and adds the result block with no exitCode", () => {
    // Capture 1 (`v2-capture/events.sse:73` to `:89`): input.started, input.ended, called, shell.created,
    // progress with metadata.shellID, shell.exited, then success with metadata.exit 0.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "shell" })
      .durable("session.tool.input.ended", { assistantMessageID: MSG, id: CALL, text: "{\"command\":\"ls -la\"}" })
      .durable("session.tool.called", { assistantMessageID: MSG, id: CALL, executed: false })
      .live("shell.created", { info: { id: SHELL, status: "running", command: "ls -la", metadata: { sessionID: SID } } })
      .live("session.tool.progress", { assistantMessageID: MSG, id: CALL, metadata: { shellID: SHELL } })
      .live("shell.exited", { id: SHELL, exit: 0, status: "exited" })
      .durable("session.tool.success", {
        assistantMessageID: MSG,
        id: CALL,
        content: [{ type: "text", text: "total 24\n" }],
        metadata: { status: "completed", truncated: false, exit: 0 },
        executed: false,
      });

    const events = run(t, f.frames);
    expect(events).toEqual([
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "shell" },
      { kind: "block-end", partID: CALL, role: "tool-call", status: "ok" },
      { kind: "block-start", partID: `${CALL}-result`, role: "tool-result" },
      { kind: "block-delta", partID: `${CALL}-result`, role: "tool-result", text: "total 24\n" },
      { kind: "block-end", partID: `${CALL}-result`, role: "tool-result", status: "ok" },
    ]);
    // A zero exit sets no exitCode, so the block-end has no such key at all.
    expect(events[1]).not.toHaveProperty("exitCode");
    expect(t.hasOpenStreamingPart()).toBe(false);
  });
});

describe("v2 translator: a non-zero shell exit (§4.4 Non-zero exit; capture 3b)", () => {
  test("closes the tool ok with exitCode set, and joins the content text items in order", () => {
    // Capture 3b (`v2-capture-3b/events.sse:101`): `metadata.exit` 1, and two text items. The first ends in "\n".
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "shell" })
      .durable("session.tool.success", {
        assistantMessageID: MSG,
        id: CALL,
        content: [
          { type: "text", text: "cat: ./does-not-exist.txt: No such file or directory\n" },
          { type: "text", text: "Exited with code 1" },
        ],
        metadata: { status: "completed", truncated: false, exit: 1 },
        executed: false,
      });

    expect(run(t, f.frames)).toEqual([
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "shell" },
      { kind: "block-end", partID: CALL, role: "tool-call", status: "ok", exitCode: 1 },
      { kind: "block-start", partID: `${CALL}-result`, role: "tool-result" },
      {
        kind: "block-delta",
        partID: `${CALL}-result`,
        role: "tool-result",
        text: "cat: ./does-not-exist.txt: No such file or directory\nExited with code 1",
      },
      { kind: "block-end", partID: `${CALL}-result`, role: "tool-result", status: "ok" },
    ]);
  });
});

describe("v2 translator: parallel tool calls in one step (§4.4 parallel calls; capture 2)", () => {
  test("keeps two call blocks apart, closes each on its own frame, and advances the content index per call", () => {
    // Capture 2 (`v2-capture-2/events.sse:49`, `:51`): two shell calls start before either ends. Call B is rejected
    // (`session.tool.failed`, §4.4) and call A succeeds. A text item after both gets content index 2.
    const CALL_A = "call_x9y407un";
    const CALL_B = "call_26cq43v3";
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL_A, name: "shell" })
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL_B, name: "shell" })
      .durable("session.tool.failed", {
        assistantMessageID: MSG,
        id: CALL_B,
        error: { type: "permission.rejected", message: "capture: rejected on purpose" },
        executed: false,
      })
      .durable("session.tool.success", {
        assistantMessageID: MSG,
        id: CALL_A,
        content: [{ type: "text", text: "a.txt\n" }],
        metadata: { status: "completed", truncated: false, exit: 0 },
        executed: false,
      })
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 });

    expect(run(t, f.frames)).toEqual([
      { kind: "block-start", partID: CALL_A, role: "tool-call", toolName: "shell" },
      { kind: "block-start", partID: CALL_B, role: "tool-call", toolName: "shell" },
      // A rejected call closes as error with no result block (§4.4 rejected sequence, v1 generic error branch).
      { kind: "block-end", partID: CALL_B, role: "tool-call", status: "error" },
      { kind: "block-end", partID: CALL_A, role: "tool-call", status: "ok" },
      { kind: "block-start", partID: `${CALL_A}-result`, role: "tool-result" },
      { kind: "block-delta", partID: `${CALL_A}-result`, role: "tool-result", text: "a.txt\n" },
      { kind: "block-end", partID: `${CALL_A}-result`, role: "tool-result", status: "ok" },
      // Call A is content index 0 and call B is index 1, so the text is index 2.
      { kind: "block-start", partID: `${MSG}:2`, role: "text", messageID: MSG },
      { kind: "generating" },
    ]);
  });
});

describe("v2 translator: tool frames without an open block (§4.4)", () => {
  test("a success with no open block is dropped, so no orphan result block appears", () => {
    const t = new V2EventTranslator();
    const f = new Feed().durable("session.tool.success", {
      assistantMessageID: MSG,
      id: CALL,
      content: [{ type: "text", text: "late" }],
      metadata: { status: "completed", exit: 0 },
    });
    expect(run(t, f.frames)).toEqual([]);
  });
});

// ─── Interrupt, retry and failure (§4.3, §4.4, §4.8) ───

describe("v2 translator: an interrupt during a running tool (§4.4 interrupt; capture 3b)", () => {
  test("closes the tool as error, emits one parent-turn-end and one idle, and leaves no orphan block", () => {
    // Capture 3b (`v2-capture-3b/events.sse:233` to `:243`): shell.deleted, tool.failed (aborted), step.failed
    // (aborted), usage.updated, execution.interrupted, then a late shell.exited with no `exit`.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.execution.started", {}) // seq 0
      .durable("session.step.started", { assistantMessageID: MSG }) // seq 1
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "shell" }) // seq 2
      .live("shell.created", { info: { id: SHELL, metadata: { sessionID: SID } } })
      .live("session.tool.progress", { assistantMessageID: MSG, id: CALL, metadata: { shellID: SHELL } })
      .live("shell.deleted", { id: SHELL })
      .durable("session.tool.failed", {
        assistantMessageID: MSG,
        id: CALL,
        error: { type: "aborted", message: "Tool execution interrupted" },
        metadata: { shellID: SHELL },
        executed: false,
      }) // seq 3
      .durable("session.step.failed", {
        assistantMessageID: MSG,
        error: { type: "aborted", message: "Step interrupted" },
      }) // seq 4
      .live("session.usage.updated", { cost: 0, tokens: { input: 106, output: 39 } })
      .durable("session.execution.interrupted", { reason: "user" }) // seq 5
      .live("shell.exited", { id: SHELL, status: "exited" }); // late, after the turn ended

    const events = run(t, f.frames);
    expect(events).toEqual([
      { kind: "generating" },
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "shell" },
      { kind: "block-end", partID: CALL, role: "tool-call", status: "error" },
      { kind: "parent-turn-end", reason: "aborted" },
      { kind: "session-idle" },
    ]);
    // Exactly one turn end, and no `error` line for an operator interrupt.
    expect(events.filter((e) => e.kind === "parent-turn-end")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "session-idle")).toHaveLength(1);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    // No orphan open block: the reconciler's idle synthesis has nothing to close.
    expect(t.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });
});

describe("v2 translator: a failed execution with retries (§4.3 model-failure path; capture 3)", () => {
  test("shows each retry as turn-retry, then one error, one parent-turn-end error and one idle", () => {
    // Capture 3 (`v2-capture-3/events.sse:37`, `:93`, `:95`): retry.scheduled between attempts, step.failed after the
    // last attempt, then execution.failed with the same error.
    const ERR = { type: "provider.transport", message: "FailedToOpenSocket: Was there a typo in the url or port?" };
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.execution.started", {})
      .durable("session.step.started", { assistantMessageID: MSG })
      .durable("session.retry.scheduled", { assistantMessageID: MSG, attempt: 2, at: 1791897965584, error: ERR })
      .durable("session.step.started", { assistantMessageID: MSG })
      .durable("session.retry.scheduled", { assistantMessageID: MSG, attempt: 3, at: 1791897969286, error: ERR })
      .durable("session.step.started", { assistantMessageID: MSG })
      .durable("session.retry.scheduled", { assistantMessageID: MSG, attempt: 4, at: 1791897972000, error: ERR })
      .durable("session.step.started", { assistantMessageID: MSG })
      .durable("session.step.failed", { assistantMessageID: MSG, error: ERR })
      .durable("session.execution.failed", { error: ERR });

    expect(run(t, f.frames)).toEqual([
      { kind: "generating" },
      { kind: "turn-retry", sessionID: SID, attempt: 2, message: ERR.message },
      { kind: "turn-retry", sessionID: SID, attempt: 3, message: ERR.message },
      { kind: "turn-retry", sessionID: SID, attempt: 4, message: ERR.message },
      { kind: "parent-turn-end", reason: "error" },
      { kind: "error", message: ERR.message },
      { kind: "session-idle" },
    ]);
  });
});

// ─── User turns (§4.5, §4.12) ───

describe("v2 translator: own echoes and foreign user turns (§4.5, §4.12)", () => {
  test("suppresses our own prompt echo, emits a foreign turn once across enqueued and delivered", () => {
    // Capture 3 (`v2-capture-3/events-p2.sse:15`): a user item is enqueued, then delivered. Its `inboxID` is the client
    // prompt id, so an id we minted is an own echo (capture §A, §5 "client-supplied id").
    const t = new V2EventTranslator();
    t.recordOwnMessageID("msg_own_1");
    const item = (text: string) => ({ type: "user", payload: { text }, delivery: "steer" });
    const f = new Feed()
      .durable("session.inbox.enqueued", { inboxID: "msg_own_1", item: item("my prompt") })
      .durable("session.inbox.delivered", { inboxID: "msg_own_1", item: item("my prompt") })
      .durable("session.inbox.enqueued", { inboxID: "msg_for_1", item: item("from mobile") })
      .durable("session.inbox.delivered", { inboxID: "msg_for_1", item: item("from mobile") })
      // A synthetic user-shell item and a compaction item are not user turns (§4.5, §4.12).
      .durable("session.inbox.enqueued", {
        inboxID: "msg_syn_1",
        item: { type: "synthetic", payload: { text: "The following shell command was executed by the user" } },
      })
      .durable("session.inbox.enqueued", { inboxID: "msg_cmp_1", item: { type: "compaction", payload: {} } });

    expect(run(t, f.frames)).toEqual([{ kind: "foreign-user-turn", messageID: "msg_for_1", text: "from mobile" }]);
    // v2 delivers the whole user text in one frame, so the v1 debounce classification has nothing to do (§4.5).
    expect(t.classifyUserTurn("msg_for_1")).toEqual([]);
  });

  test("suppresses a command's expanded text by prefix (v1 backstop; §4.12 expanded template)", () => {
    // Capture 3 (`v2-capture-3/events.sse:229`): the expanded command arrives as an ordinary user item, with no
    // marker. The prefix is the one app.tsx records for a command (`"# /" + name`).
    const t = new V2EventTranslator();
    t.recordOwnCommandPrefix("# /brain-abandon");
    const f = new Feed()
      .durable("session.inbox.enqueued", {
        inboxID: "msg_cmd_1",
        item: { type: "user", payload: { text: "# /brain-abandon\n\nClean up the session." } },
      })
      .durable("session.inbox.enqueued", { inboxID: "msg_plain_1", item: { type: "user", payload: { text: "hello" } } });

    expect(run(t, f.frames)).toEqual([{ kind: "foreign-user-turn", messageID: "msg_plain_1", text: "hello" }]);
  });
});

// ─── Attribution and durable seq (§2b, §2c) ───

describe("v2 translator: frames for other sessions are ignored (§2c, §4.10)", () => {
  test("other-session turns and shells produce nothing and do not close our open block", () => {
    const t = new V2EventTranslator();
    const ours = new Feed().durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }).frames;
    // A child or another session. Its frames, its shell and its turn end must not touch our block.
    const other = new Feed("ses_other")
      .durable("session.execution.started", {})
      .durable("session.text.started", { assistantMessageID: "msg_other", ordinal: 0 })
      .durable("session.execution.succeeded", {})
      .frames;
    const otherShell = [
      { id: "evt_s", created: 1, type: "shell.created", data: { info: { id: "sh_other", metadata: { sessionID: "ses_other" } } } },
      { id: "evt_x", created: 1, type: "shell.exited", data: { id: "sh_other", exit: 0, status: "exited" } },
    ];

    expect(run(t, [...ours, ...other, ...otherShell])).toEqual([
      { kind: "block-start", partID: `${MSG}:0`, role: "text", messageID: MSG },
      { kind: "generating" },
    ]);
    // Our block is still open. The other session's terminal frame did not close it.
    expect(t.synthesizeSessionIdleEvents()).toEqual([
      { kind: "session-idle" },
      { kind: "block-end", partID: `${MSG}:0`, role: "text" },
    ]);
  });
});

describe("v2 translator: durable seq gaps and duplicates (§2b, §4.11)", () => {
  test("a gap closes the open blocks with block-end, then emits resync-needed; a duplicate is ignored", () => {
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.execution.started", {}, 0)
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }, 1)
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "par" })
      // Seq 2 to 4 were missed while disconnected (§4.11). Seq 5 is the first frame seen after the gap.
      .durable("session.execution.succeeded", {}, 5)
      // The open text block is closed on the gap, so the renderer does not keep it open for ever. Its later delta
      // is then ignored, as for any closed block.
      .live("session.text.delta", { assistantMessageID: MSG, ordinal: 0, delta: "more" })
      .durable("session.execution.started", {}, 6) // back in sequence
      .durable("session.execution.started", {}, 6); // duplicate of the same seq

    expect(run(t, f.frames)).toEqual([
      { kind: "generating" },
      { kind: "block-start", partID: `${MSG}:0`, role: "text", messageID: MSG },
      { kind: "generating" },
      { kind: "block-delta", partID: `${MSG}:0`, role: "text", text: "par" },
      { kind: "block-end", partID: `${MSG}:0`, role: "text" },
      { kind: "resync-needed", sessionID: SID },
      { kind: "generating" },
    ]);
    // Nothing is left open after the gap.
    expect(t.hasOpenStreamingPart()).toBe(false);
    expect(t.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });

  test("a gap closes an open tool block as well as text blocks", () => {
    // A tool block is open when seq 2 and 3 are missed (§4.4). Its block-end is emitted on the gap, not dropped.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.tool.input.started", { id: CALL, name: "shell", assistantMessageID: MSG }, 0)
      .durable("session.execution.started", {}, 1)
      .durable("session.execution.started", {}, 4); // seq 2 and 3 missed, and this gapped frame is not translated

    expect(run(t, f.frames)).toEqual([
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "shell" },
      { kind: "generating" },
      { kind: "block-end", partID: CALL, role: "tool-call" },
      { kind: "resync-needed", sessionID: SID },
    ]);
    expect(t.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });
});

// ─── Reset ───

describe("v2 translator: resetEventState clears everything (P6)", () => {
  test("open blocks, own ids, command prefixes, dedupe sets, content indices and seq all start again", () => {
    const t = new V2EventTranslator();
    t.recordOwnMessageID("msg_own");
    t.recordOwnCommandPrefix("# /brain");
    const before = new Feed()
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }, 0)
      .durable("session.inbox.enqueued", { inboxID: "msg_x", item: { type: "user", payload: { text: "foreign" } } }, 1);
    expect(run(t, before.frames)).toEqual([
      { kind: "block-start", partID: `${MSG}:0`, role: "text", messageID: MSG },
      { kind: "generating" },
      { kind: "foreign-user-turn", messageID: "msg_x", text: "foreign" },
    ]);

    t.resetEventState();

    // No open block survives the reset.
    expect(t.hasOpenStreamingPart()).toBe(false);
    expect(t.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
    // The old text block's delta no longer routes.
    expect(t.translate({ type: "session.text.delta", data: { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: "x" } }, SID)).toBeNull();

    // Own id, command prefix and dedupe set are all gone, so each frame below is now a foreign turn.
    // Seq starts again at 0 with no resync. Text content indices restart at 0.
    const after = new Feed()
      .durable("session.inbox.enqueued", { inboxID: "msg_own", item: { type: "user", payload: { text: "mine" } } }, 0)
      .durable("session.inbox.enqueued", { inboxID: "msg_x", item: { type: "user", payload: { text: "foreign" } } }, 1)
      .durable("session.inbox.enqueued", { inboxID: "msg_cmd", item: { type: "user", payload: { text: "# /brain-abandon" } } }, 2)
      .durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }, 3);
    expect(run(t, after.frames)).toEqual([
      { kind: "foreign-user-turn", messageID: "msg_own", text: "mine" },
      { kind: "foreign-user-turn", messageID: "msg_x", text: "foreign" },
      { kind: "foreign-user-turn", messageID: "msg_cmd", text: "# /brain-abandon" },
      { kind: "block-start", partID: `${MSG}:0`, role: "text", messageID: MSG },
      { kind: "generating" },
    ]);
  });
});

describe("v2 translator: unknown and non-envelope frames (§2a)", () => {
  test("return null without throwing", () => {
    const t = new V2EventTranslator();
    expect(t.translate({ type: "session.bogus", data: { sessionID: SID } }, SID)).toBeNull();
    expect(t.translate({ type: "server.connected", data: {} }, SID)).toBeNull(); // global frame
    expect(t.translate({ type: "permission.asked", properties: { sessionID: SID } }, SID)).toBeNull(); // v1 shape
    expect(t.translate({ data: { sessionID: SID } }, SID)).toBeNull(); // no type
    expect(t.translate("not a frame", SID)).toBeNull();
    expect(t.translate(null, SID)).toBeNull();
    expect(t.translate({ type: "session.text.delta" }, SID)).toBeNull(); // no data at all
  });
});

// ─── Permissions (C2.4b, capture §4.7) ───

describe("v2 translator: tool-raised permission asks (§4.7; capture 2, 3b)", () => {
  test("a single tool-raised ask maps to permission-asked, and its reply shows nothing", () => {
    // Capture 2 (`v2-capture-2/events.sse:65`, `:69`): `action` and `resources` become `permType` and `resources`.
    const t = new V2EventTranslator();
    const f = new Feed()
      .live("permission.asked", {
        id: "per_1352d0e21001NkUobNoMhpP9mw",
        action: "shell",
        resources: ["ls -la"],
        save: ["ls *"],
        source: { type: "tool", messageID: MSG, id: CALL },
      })
      .live("permission.replied", { requestID: "per_1352d0e21001NkUobNoMhpP9mw", reply: "once" });

    expect(run(t, f.frames)).toEqual([
      {
        kind: "permission-asked",
        permID: "per_1352d0e21001NkUobNoMhpP9mw",
        sessionID: SID,
        title: "shell: ls -la",
        permType: "shell",
        resources: ["ls -la"],
      },
    ]);
  });

  test("a compound command raises one ask with every resource listed (§4.7; capture 3b)", () => {
    // Capture 3b (`v2-capture-3b/events.sse:153`): `sleep 20 && echo finished` is one ask with two resources.
    const t = new V2EventTranslator();
    const f = new Feed().live("permission.asked", {
      id: "per_135b2bcfb001x0fCl5An4UeXsc",
      action: "shell",
      resources: ["sleep 20", "echo finished"],
      save: ["sleep *", "echo *"],
      source: { type: "tool", messageID: MSG, id: CALL },
    });

    expect(run(t, f.frames)).toEqual([
      {
        kind: "permission-asked",
        permID: "per_135b2bcfb001x0fCl5An4UeXsc",
        sessionID: SID,
        title: "shell: sleep 20, echo finished",
        permType: "shell",
        resources: ["sleep 20", "echo finished"],
      },
    ]);
  });

  test("a frame with no id, or no action, is dropped", () => {
    // Without an id the reply path has nothing to answer, so the ask is not shown.
    const t = new V2EventTranslator();
    const f = new Feed()
      .live("permission.asked", { action: "shell", resources: ["ls"] })
      .live("permission.asked", { id: "per_2", resources: ["ls"] });
    expect(run(t, f.frames)).toEqual([]);
  });

  test("an ask for a child session is shown when the translator is called with the child's id (descendant re-call)", () => {
    // Capture 2 (`v2-capture-2/events.sse:161`): the child's ask carries the child's sessionID. app.tsx re-calls
    // translateEvent with `ev.properties.sessionID` for a descendant, so the event must come out for that id.
    const t = new V2EventTranslator();
    const f = new Feed(CHILD).live("permission.asked", {
      id: "per_1352d21df001CQmsCnD8UnWVu8",
      action: "shell",
      resources: ["pwd"],
      save: ["pwd *"],
      source: { type: "tool", messageID: MSG, id: "call_vvtiggb7" },
    });

    expect(run(t, f.frames, CHILD)).toEqual([
      {
        kind: "permission-asked",
        permID: "per_1352d21df001CQmsCnD8UnWVu8",
        sessionID: CHILD,
        title: "shell: pwd",
        permType: "shell",
        resources: ["pwd"],
      },
    ]);
  });

  test("an ask for an unrelated session is dropped when the REPL shows another session", () => {
    const t = new V2EventTranslator();
    const f = new Feed("ses_unrelated").live("permission.asked", { id: "per_9", action: "shell", resources: ["ls"] });
    expect(run(t, f.frames, SID)).toEqual([]);
  });
});

describe("v2 translator: discovery input from app.tsx listPermissions (C2.4b contract)", () => {
  test("the v1-shaped discovery object maps to the same permission-asked event", () => {
    // `toV1PermissionShape` (src/backend/v2.ts) builds `{id, sessionID, permission, patterns}` from a v2 request.
    // app.tsx wraps it as `{type: "permission.asked", properties}`. The contract is documented in v2-events.ts.
    const t = new V2EventTranslator();
    const discovered = {
      type: "permission.asked",
      properties: { id: "per_135b2bcfb001x0fCl5An4UeXsc", sessionID: SID, permission: "shell", patterns: ["sleep 20", "echo finished"] },
    };
    expect(t.translate(discovered, SID)).toEqual({
      kind: "permission-asked",
      permID: "per_135b2bcfb001x0fCl5An4UeXsc",
      sessionID: SID,
      title: "shell: sleep 20, echo finished",
      permType: "shell",
      resources: ["sleep 20", "echo finished"],
    });
  });

  test("a discovery object with no patterns has the bare action as its title", () => {
    const t = new V2EventTranslator();
    const discovered = { type: "permission.asked", properties: { id: "per_3", sessionID: SID, permission: "bash", patterns: [] } };
    expect(t.translate(discovered, SID)).toEqual({
      kind: "permission-asked",
      permID: "per_3",
      sessionID: SID,
      title: "bash",
      permType: "bash",
      resources: [],
    });
  });

  test("a discovery object for a child is shown on the descendant re-call, and dropped for the parent's id", () => {
    // app.tsx calls discovery with `oldest.sessionID` for a descendant, so the same rule as a frame applies.
    const t = new V2EventTranslator();
    const discovered = { type: "permission.asked", properties: { id: "per_4", sessionID: CHILD, permission: "shell", patterns: ["pwd"] } };
    expect(t.translate(discovered, CHILD)).toMatchObject({ kind: "permission-asked", sessionID: CHILD });
    expect(t.translate(discovered, SID)).toBeNull();
  });
});

// ─── Forms (C2.4b, capture §4.6) ───

describe("v2 translator: forms (§4.6; capture 1, capture 3)", () => {
  test("form.created maps to form-asked, with fields mapped as toFormField maps them", () => {
    // Capture 1 (`v2-capture/form-1.json:2` to `:32`): a string field with options and `custom`, plus a boolean field
    // with no title (capture 3, `v2-capture-3/events-p2.sse:19`). The title falls back to the key.
    const t = new V2EventTranslator();
    const f = new Feed().live("form.created", {
      form: {
        id: "frm_1350d8f9e001n3E9p9dgUMz16U",
        sessionID: SID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: MSG, id: CALL } },
        fields: [
          {
            key: "q0",
            title: "Your choice",
            description: "Please choose 'A' or 'B'.",
            type: "string",
            options: [
              { value: "A", label: "A", description: "Choose option A" },
              { value: "B", label: "B", description: "Choose option B" },
            ],
            custom: true,
          },
          { key: "ok", type: "boolean" },
          { type: "string" }, // no key: dropped, since no answer can be given for it
        ],
      },
    });

    expect(run(t, f.frames)).toEqual([
      {
        kind: "form-asked",
        formID: "frm_1350d8f9e001n3E9p9dgUMz16U",
        sessionID: SID,
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Your choice",
            description: "Please choose 'A' or 'B'.",
            type: "string",
            options: [
              { value: "A", label: "A", description: "Choose option A" },
              { value: "B", label: "B", description: "Choose option B" },
            ],
            custom: true,
          },
          { key: "ok", title: "ok", type: "boolean" },
        ],
      },
    ]);
  });

  test("form.replied maps to form-replied with the answer keyed by field key", () => {
    // Capture 1 (`v2-capture/events.sse:59`): `answer` is `{q0: "A"}`. Capture 3 has a boolean answer.
    const t = new V2EventTranslator();
    const f = new Feed()
      .live("form.replied", { id: "frm_1350d8f9e001n3E9p9dgUMz16U", answer: { q0: "A" } })
      .live("form.replied", { id: "frm_2", answer: { ok: true } });
    expect(run(t, f.frames)).toEqual([
      { kind: "form-replied", formID: "frm_1350d8f9e001n3E9p9dgUMz16U", sessionID: SID, answer: { q0: "A" } },
      { kind: "form-replied", formID: "frm_2", sessionID: SID, answer: { ok: true } },
    ]);
  });

  test("form.cancelled (typed, never observed) closes the modal with an empty answer", () => {
    // Choice recorded in v2-events.ts: an empty `form-replied`, so the modal closes without a fake answer.
    const t = new V2EventTranslator();
    const f = new Feed().live("form.cancelled", { id: "frm_3" });
    expect(run(t, f.frames)).toEqual([{ kind: "form-replied", formID: "frm_3", sessionID: SID, answer: {} }]);
  });

  test("a form for another session is dropped", () => {
    // The attribution key is `data.form.sessionID` (§2c). Here it is another session, so nothing is shown.
    const t = new V2EventTranslator();
    const f = new Feed().live("form.created", { form: { id: "frm_4", sessionID: "ses_other", title: "x", fields: [] } });
    expect(run(t, f.frames)).toEqual([]);
  });
});

// ─── Subagent children (C2.4b, capture §4.9) ───

describe("v2 translator: a subagent call, full sequence (§4.9; capture 2 and 3b)", () => {
  test("detects the child once, shows only activity for it, and ends it once", () => {
    // Capture 2 order (`v2-capture-2/events.sse:125` to `:213`): input.started, called (input), child session.created,
    // parent tool.progress with the child id, child frames, child execution.succeeded, parent tool.success, parent idle.
    const DESC = "Run pwd and report output";
    const CHILD_MSG = "msg_child_1";
    const t = new V2EventTranslator();

    const parentBefore = new Feed(SID)
      .durable("session.execution.started", {}) // seq 0
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "subagent" }) // seq 1
      .durable("session.tool.called", {
        assistantMessageID: MSG,
        id: CALL,
        input: { agent: "general", description: DESC, prompt: "Run the shell command `pwd`." },
        executed: false,
      }); // seq 2
    // §4.9 "Child creation": `parentID` is the parent, `title` is the invocation's description, `agent` is `general`.
    const childCreated = new Feed(CHILD).durable("session.created", {
      parentID: SID,
      title: DESC,
      agent: "general",
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    });
    // §4.9 "Parent-side link": the child id is in `metadata.sessionID`.
    const parentProgress = new Feed(SID).live("session.tool.progress", {
      assistantMessageID: MSG,
      id: CALL,
      metadata: { sessionID: CHILD, status: "running" },
    });
    // The child's own turn (§4.9 "Child lifecycle"). Its text must never reach the parent.
    const childRest = new Feed(CHILD)
      .durable("session.execution.started", {})
      .durable("session.text.started", { assistantMessageID: CHILD_MSG, ordinal: 0 })
      .live("session.text.delta", { assistantMessageID: CHILD_MSG, ordinal: 0, delta: "/tmp/octmux-v2-capture-2" })
      .durable("session.text.ended", { assistantMessageID: CHILD_MSG, ordinal: 0, text: "/tmp/octmux-v2-capture-2" })
      .durable("session.execution.succeeded", {});
    // §4.9 "Parent completion": the result wraps the child's text, and `metadata.sessionID` names the child.
    const parentAfter = new Feed(SID, 3).durable("session.tool.success", {
      assistantMessageID: MSG,
      id: CALL,
      content: [{ type: "text", text: "<subagent sessionID=\"" + CHILD + "\" state=\"completed\">\n/tmp\n</subagent>" }],
      metadata: { sessionID: CHILD, status: "completed", truncated: false },
      executed: false,
    });

    const frames = [
      ...parentBefore.frames,
      ...childCreated.frames,
      ...parentProgress.frames,
      ...childRest.frames,
      ...parentAfter.frames,
    ];
    const events = run(t, frames);

    expect(events).toEqual([
      { kind: "generating" },
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "subagent" },
      { kind: "subagent-detected", sessionID: CHILD, agent: "general", model: "", description: DESC },
      // Each child frame gives activity. None gives a parent block (§4.9: child text is not rendered in the parent).
      { kind: "subagent-activity", sessionID: CHILD, ts: expect.any(Number) },
      { kind: "subagent-activity", sessionID: CHILD, ts: expect.any(Number) },
      { kind: "subagent-activity", sessionID: CHILD, ts: expect.any(Number) },
      { kind: "subagent-activity", sessionID: CHILD, ts: expect.any(Number) },
      // The child's terminal frame ends the row. The parent's later success does not end it again.
      { kind: "subagent-ended", sessionID: CHILD },
      { kind: "block-end", partID: CALL, role: "tool-call", status: "ok" },
      { kind: "block-start", partID: `${CALL}-result`, role: "tool-result" },
      { kind: "block-delta", partID: `${CALL}-result`, role: "tool-result", text: "<subagent sessionID=\"" + CHILD + "\" state=\"completed\">\n/tmp\n</subagent>" },
      { kind: "block-end", partID: `${CALL}-result`, role: "tool-result", status: "ok" },
    ]);
    expect(events.filter((e) => e.kind === "subagent-detected")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "subagent-ended")).toHaveLength(1);
    // The child's terminal frame did not close the turn. Nothing of the child is left open in the parent.
    expect(events.some((e) => e.kind === "session-idle")).toBe(false);
    expect(t.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });

  test("the parent's tool success ends the child when the child's own terminal frame never arrived", () => {
    const DESC = "Reply with pong";
    const t = new V2EventTranslator();
    const parentBefore = new Feed(SID)
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "subagent" })
      .durable("session.tool.called", { assistantMessageID: MSG, id: CALL, input: { agent: "general", description: DESC }, executed: false });
    const childCreated = new Feed(CHILD).durable("session.created", { parentID: SID, title: DESC, agent: "general" });
    const parentAfter = new Feed(SID, 2).durable("session.tool.success", {
      assistantMessageID: MSG,
      id: CALL,
      content: [{ type: "text", text: "pong" }],
      metadata: { sessionID: CHILD, status: "completed" },
      executed: false,
    });

    expect(run(t, [...parentBefore.frames, ...childCreated.frames, ...parentAfter.frames])).toEqual([
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "subagent" },
      { kind: "subagent-detected", sessionID: CHILD, agent: "general", model: "", description: DESC },
      { kind: "block-end", partID: CALL, role: "tool-call", status: "ok" },
      { kind: "block-start", partID: `${CALL}-result`, role: "tool-result" },
      { kind: "block-delta", partID: `${CALL}-result`, role: "tool-result", text: "pong" },
      { kind: "block-end", partID: `${CALL}-result`, role: "tool-result", status: "ok" },
      { kind: "subagent-ended", sessionID: CHILD },
    ]);
    // The child is untracked now, so its later frames give nothing.
    expect(t.translate({ type: "session.text.delta", data: { sessionID: CHILD, assistantMessageID: "msg_c", ordinal: 0, delta: "late" } }, SID)).toBeNull();
  });

  test("a failed subagent call (tool.failed) closes its block as error, then ends the child", () => {
    // Capture 3b shape for an interrupt (§4.4): the call fails with `aborted`, and the child is ended with it.
    const DESC = "Long task";
    const t = new V2EventTranslator();
    const parentBefore = new Feed(SID)
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "subagent" })
      .durable("session.tool.called", { assistantMessageID: MSG, id: CALL, input: { agent: "general", description: DESC }, executed: false });
    const childCreated = new Feed(CHILD).durable("session.created", { parentID: SID, title: DESC, agent: "general" });
    const parentAfter = new Feed(SID, 2).durable("session.tool.failed", {
      assistantMessageID: MSG,
      id: CALL,
      error: { type: "aborted", message: "Tool execution interrupted" },
      metadata: { sessionID: CHILD },
      executed: false,
    });

    expect(run(t, [...parentBefore.frames, ...childCreated.frames, ...parentAfter.frames])).toEqual([
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "subagent" },
      { kind: "subagent-detected", sessionID: CHILD, agent: "general", model: "", description: DESC },
      { kind: "block-end", partID: CALL, role: "tool-call", status: "error" },
      { kind: "subagent-ended", sessionID: CHILD },
    ]);
  });

  test("a child linked by progress before its session.created is paired by that link, not by title", () => {
    // The capture order is created first, then progress. A progress-first order must still pair the child directly.
    const t = new V2EventTranslator();
    const parentBefore = new Feed(SID)
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "subagent" })
      .durable("session.tool.called", { assistantMessageID: MSG, id: CALL, input: { description: "Desc from call" }, executed: false });
    const progress = new Feed(SID).live("session.tool.progress", { id: CALL, metadata: { sessionID: CHILD, status: "running" } });
    // The title does not match the call's description, so only the direct link can supply it.
    const childCreated = new Feed(CHILD).durable("session.created", { parentID: SID, title: "something else", agent: "general" });

    expect(run(t, [...parentBefore.frames, ...progress.frames, ...childCreated.frames])).toEqual([
      { kind: "block-start", partID: CALL, role: "tool-call", toolName: "subagent" },
      { kind: "subagent-detected", sessionID: CHILD, agent: "general", model: "", description: "Desc from call" },
    ]);
  });

  test("two calls pair each child with the call whose description equals its title", () => {
    // Title pairing (§4.9: child title equals the invocation's description) avoids a first-in-first-out mix-up.
    const CALL_B = "call_26cq43v3";
    const CHILD_B = "ses_child_b";
    const t = new V2EventTranslator();
    const f = new Feed(SID)
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL, name: "subagent" })
      .durable("session.tool.called", { assistantMessageID: MSG, id: CALL, input: { description: "first" }, executed: false })
      .durable("session.tool.input.started", { assistantMessageID: MSG, id: CALL_B, name: "subagent" })
      .durable("session.tool.called", { assistantMessageID: MSG, id: CALL_B, input: { description: "second" }, executed: false });
    const childB = new Feed(CHILD_B).durable("session.created", { parentID: SID, title: "second", agent: "general" });

    const events = run(t, [...f.frames, ...childB.frames]);
    expect(events).toContainEqual({ kind: "subagent-detected", sessionID: CHILD_B, agent: "general", model: "", description: "second" });
    // Call A has no child, so its success ends nothing.
    const successA = new Feed(SID, 4).durable("session.tool.success", { assistantMessageID: MSG, id: CALL, content: [], metadata: {}, executed: false });
    expect(run(t, successA.frames)).toEqual([{ kind: "block-end", partID: CALL, role: "tool-call", status: "ok" }]);
  });

  test("a second session.created for the same child gives no second detection", () => {
    const t = new V2EventTranslator();
    const f = new Feed(CHILD)
      .durable("session.created", { parentID: SID, title: "x", agent: "general" })
      .durable("session.created", { parentID: SID, title: "x", agent: "general" });
    expect(run(t, f.frames).filter((e) => e.kind === "subagent-detected")).toHaveLength(1);
  });

  test("a session created with another parent, or a child's terminal before any tracking, gives nothing", () => {
    const t = new V2EventTranslator();
    const f = new Feed("ses_other_child")
      .durable("session.created", { parentID: "ses_someone_else", title: "x", agent: "general" })
      .durable("session.execution.succeeded", {});
    expect(run(t, f.frames)).toEqual([]);
  });

  test("resetEventState forgets the children, so their frames stop and a new session.created detects again", () => {
    // P6: no state from before the reset affects translation.
    const t = new V2EventTranslator();
    const before = new Feed(CHILD).durable("session.created", { parentID: SID, title: "x", agent: "general" }, 0);
    expect(run(t, before.frames).map((e) => e.kind)).toEqual(["subagent-detected"]);

    t.resetEventState();

    // A child frame after the reset is no longer tracked, so it gives nothing.
    expect(t.translate({ type: "session.execution.started", data: { sessionID: CHILD } }, SID)).toBeNull();
    // The same child, created again after the reset, is detected again.
    const after = new Feed(CHILD).durable("session.created", { parentID: SID, title: "x", agent: "general" }, 0);
    expect(run(t, after.frames).map((e) => e.kind)).toEqual(["subagent-detected"]);
  });
});

// ─── Compaction (C2.4b, capture §4.12) ───

describe("v2 translator: compaction (§4.12; capture 3b success, capture 3 failure)", () => {
  test("started, summary deltas and ended map to compaction-* events, and the turn still ends normally", () => {
    // Capture 3b (`v2-capture-3b/events.sse:349` to `:589`): started, delta chunks, ended with `text`, then succeeded.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.compaction.started", { reason: "manual", recent: "" })
      .live("session.compaction.delta", { text: "## Objective" })
      .live("session.compaction.delta", { text: "" }) // empty chunk: dropped
      .live("session.compaction.delta", { text: " Keep going." })
      .durable("session.compaction.ended", {
        reason: "manual",
        model: { id: "glm-5.3-flash", providerID: "sohoai" },
        text: "## Objective Keep going.",
        recent: "",
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
        cost: 0,
      })
      .durable("session.execution.succeeded", {});

    expect(run(t, f.frames)).toEqual([
      { kind: "compaction-started", sessionID: SID, reason: "manual" },
      { kind: "compaction-progress", sessionID: SID, text: "## Objective" },
      { kind: "compaction-progress", sessionID: SID, text: " Keep going." },
      { kind: "compaction-ended", sessionID: SID, summary: "## Objective Keep going.", tokens: 17, cost: 0 },
      { kind: "parent-turn-end", reason: "idle" },
      { kind: "session-idle" },
    ]);
  });

  test("a plain numeric tokens value is used as the total, and missing tokens or cost are left out", () => {
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.compaction.ended", { text: "s", tokens: 42 })
      .durable("session.compaction.ended", { text: "t" }, 1);
    expect(run(t, f.frames)).toEqual([
      { kind: "compaction-ended", sessionID: SID, summary: "s", tokens: 42 },
      { kind: "compaction-ended", sessionID: SID, summary: "t" },
    ]);
  });

  test("a failed compaction maps to compaction-failed with the provider message, and the turn still succeeds", () => {
    // Capture 3 (`v2-capture-3/events.sse:477`, `:479`): compaction.failed, then execution.succeeded.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.compaction.started", { reason: "manual", recent: "" })
      .durable("session.compaction.failed", { error: { type: "provider.transport", message: "FailedToOpenSocket" } })
      .durable("session.execution.succeeded", {});
    expect(run(t, f.frames)).toEqual([
      { kind: "compaction-started", sessionID: SID, reason: "manual" },
      { kind: "compaction-failed", sessionID: SID, message: "FailedToOpenSocket" },
      { kind: "parent-turn-end", reason: "idle" },
      { kind: "session-idle" },
    ]);
  });

  test("a failed compaction with no error text falls back to 'no error detail from server'", () => {
    // The fallback is the translator's own text. The frame carries no `error.message`, so it is used.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.compaction.started", { reason: "manual", recent: "" })
      .durable("session.compaction.failed", {})
      .durable("session.execution.succeeded", {});
    expect(run(t, f.frames)).toEqual([
      { kind: "compaction-started", sessionID: SID, reason: "manual" },
      { kind: "compaction-failed", sessionID: SID, message: "no error detail from server" },
      { kind: "parent-turn-end", reason: "idle" },
      { kind: "session-idle" },
    ]);
  });
});

// ─── Model (C2.4b, capture §4.3) ───

describe("v2 translator: model selected (§4.3; capture 3)", () => {
  test("session.model.selected maps to model-selected, and a frame with no model is dropped", () => {
    // Capture 3 (`v2-capture-3/events.sse:365`): `data.model` holds `id` and `providerID`.
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.model.selected", { model: { id: "glm-5.3-flash", providerID: "sohoai" } }, 0)
      .durable("session.model.selected", {}, 1);
    expect(run(t, f.frames)).toEqual([{ kind: "model-selected", sessionID: SID, providerID: "sohoai", modelID: "glm-5.3-flash" }]);
  });
});

// ─── Unknown kinds after C2.4b ───

describe("v2 translator: frames that stay silent in C2.4b (§4.7, §2c)", () => {
  test("permission.replied and session.created for this session itself give nothing", () => {
    // `permission.replied` has no visible effect (v1 has no resolution frame either). A `session.created` with no
    // parent is the REPL's own session being created, so there is no child to track.
    const t = new V2EventTranslator();
    const f = new Feed()
      .live("permission.replied", { requestID: "per_1", reply: "once" })
      .durable("session.created", { title: "own session", agent: "build" }, 0);
    expect(run(t, f.frames)).toEqual([]);
    expect(t.hasOpenStreamingPart()).toBe(false);
  });
});

// ─── Rendered-message tracking (Stage 15.2, D-A fix): what the renderer already shows, for the missed-history resync ───

describe("v2 translator: rendered-message tracking (D-A fix)", () => {
  test("a live text turn marks its assistant message as rendered", () => {
    // Text start is the first frame that renders content of the message, so the message is recorded at that point.
    const t = new V2EventTranslator();
    expect(t.isRendered(MSG)).toBe(false);
    run(t, new Feed().durable("session.text.started", { assistantMessageID: MSG, ordinal: 0 }, 0).frames);
    expect(t.isRendered(MSG)).toBe(true);
  });

  test("a live tool start marks its assistant message as rendered", () => {
    const t = new V2EventTranslator();
    run(t, new Feed().durable("session.tool.input.started", { id: CALL, name: "shell", assistantMessageID: MSG }, 0).frames);
    expect(t.isRendered(MSG)).toBe(true);
  });

  test("a step end alone does not mark the message, because it shows no content", () => {
    // `session.step.ended` only records the completion. Nothing was rendered, so a resync still has to render the message.
    const t = new V2EventTranslator();
    run(t, new Feed().durable("session.step.ended", { assistantMessageID: MSG }, 0).frames);
    expect(t.isRendered(MSG)).toBe(false);
  });

  test("an own prompt is rendered, and so is a command's expanded text by prefix, even with no echo seen", () => {
    const t = new V2EventTranslator();
    t.recordOwnMessageID("msg_own_1");
    t.recordOwnCommandPrefix("# /brain-abandon");
    expect(t.isRendered("msg_own_1")).toBe(true);
    expect(t.isRendered("msg_cmd_1", "# /brain-abandon\n\nClean up.")).toBe(true);
    expect(t.isRendered("msg_cmd_1", "hello")).toBe(false);
    expect(t.isRendered("msg_cmd_1")).toBe(false);
  });

  test("an emitted foreign turn is rendered, and its second arrival (delivered) is then suppressed", () => {
    const t = new V2EventTranslator();
    const f = new Feed()
      .durable("session.inbox.enqueued", { inboxID: "msg_for_1", item: { type: "user", payload: { text: "hi" } } }, 0)
      .durable("session.inbox.delivered", { inboxID: "msg_for_1", item: { type: "user", payload: { text: "hi" } } }, 1);
    expect(run(t, f.frames)).toEqual([{ kind: "foreign-user-turn", messageID: "msg_for_1", text: "hi" }]);
    expect(t.isRendered("msg_for_1")).toBe(true);
  });

  test("markRendered from history suppresses a later live arrival of the same user turn", () => {
    // The history replay already shows this turn, so its live `delivered` frame must not render it a second time.
    const t = new V2EventTranslator();
    t.markRendered(["msg_hist_1"]);
    const f = new Feed().durable(
      "session.inbox.delivered",
      { inboxID: "msg_hist_1", item: { type: "user", payload: { text: "old" } } },
      0,
    );
    expect(run(t, f.frames)).toEqual([]);
    expect(t.isRendered("msg_hist_1")).toBe(true);
  });

  test("resetEventState clears the rendered set and the own ids", () => {
    const t = new V2EventTranslator();
    t.recordOwnMessageID("msg_own_1");
    t.markRendered([MSG]);
    t.resetEventState();
    expect(t.isRendered(MSG)).toBe(false);
    expect(t.isRendered("msg_own_1")).toBe(false);
  });
});
