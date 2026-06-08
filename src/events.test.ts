import { describe, expect, test, beforeEach } from "bun:test";
import { filterEvent, resetEventState } from "./events.ts";

const PARENT_SID = "ses_parent_harness";
const CHILD_SID  = "ses_child_planner";
const OTHER_SID  = "ses_unrelated";

// Minimal Session-info factory matching the locally-built daemon shape.
// SDK published types lag behind these fields; the daemon emits them since
// FlorianOtel/opencode@98a4907c9.
function sessionInfo(opts: {
  id: string;
  parentID?: string;
  agent?: string;
  model?: { id: string; providerID: string };
}) {
  return {
    id: opts.id,
    projectID: "proj_1",
    directory: "/tmp",
    parentID: opts.parentID,
    title: opts.id,
    version: "1.0",
    time: { created: 1, updated: 2 },
    agent: opts.agent,
    model: opts.model,
  };
}

beforeEach(() => {
  resetEventState();
});

describe("filterEvent — session.created subagent detection", () => {
  test("session.created with parentID === harness returns subagent-detected with sessionID, agent, model", () => {
    const ev = {
      type: "session.created",
      properties: {
        info: sessionInfo({
          id: CHILD_SID,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        }),
      },
    } as any;
    const out = filterEvent(ev, PARENT_SID);
    expect(out).toEqual({
      kind: "subagent-detected",
      sessionID: CHILD_SID,
      agent: "planner",
      model: "sohoai/minimax-m3",
    });
  });

  test("session.created with no parentID returns null (top-level user session)", () => {
    const ev = {
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_top" }) },
    } as any;
    expect(filterEvent(ev, PARENT_SID)).toBeNull();
  });

  test("session.created with parentID for a different session returns null", () => {
    const ev = {
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_other_child", parentID: OTHER_SID }) },
    } as any;
    expect(filterEvent(ev, PARENT_SID)).toBeNull();
  });

  test("duplicate session.created for the same child returns null (dedup via trackedChildSessions)", () => {
    const ev = {
      type: "session.created",
      properties: {
        info: sessionInfo({
          id: CHILD_SID,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        }),
      },
    } as any;
    const first = filterEvent(ev, PARENT_SID);
    expect(first).not.toBeNull();
    const second = filterEvent(ev, PARENT_SID);
    expect(second).toBeNull();
  });

  test("session.created with no agent/model emits empty strings (graceful degradation)", () => {
    const ev = {
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID }) },
    } as any;
    expect(filterEvent(ev, PARENT_SID)).toEqual({
      kind: "subagent-detected",
      sessionID: CHILD_SID,
      agent: "",
      model: "",
    });
  });
});

describe("filterEvent — lifecycle end signals for tracked children", () => {
  function trackChild() {
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);
  }

  test("session.idle for tracked child returns null (NOT subagent-ended)", () => {
    // OC fires session.idle on every turn pause within a subagent's life.
    // Row removal is driven by the parent's Task tool transitioning to
    // completed/error (see Task-tool tracking tests below).
    trackChild();
    const out = filterEvent({
      type: "session.idle",
      properties: { sessionID: CHILD_SID },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });

  test("session.idle for the parent (harness) session does NOT match the subagent-end branch", () => {
    trackChild();
    const out = filterEvent({
      type: "session.idle",
      properties: { sessionID: PARENT_SID },
    } as any, PARENT_SID);
    // Parent-idle returns an array containing session-idle (plus any open-block close events).
    expect(Array.isArray(out)).toBe(true);
    expect((out as any[]).some(e => e.kind === "session-idle")).toBe(true);
    expect((out as any[]).every(e => e.kind !== "subagent-ended")).toBe(true);
  });

  test("session.idle for an unrelated sessionID returns null", () => {
    trackChild();
    const out = filterEvent({
      type: "session.idle",
      properties: { sessionID: OTHER_SID },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });

  test("session.deleted for tracked child returns subagent-ended", () => {
    trackChild();
    const out = filterEvent({
      type: "session.deleted",
      properties: { info: sessionInfo({ id: CHILD_SID }) },
    } as any, PARENT_SID);
    expect(out).toEqual({ kind: "subagent-ended", sessionID: CHILD_SID });
  });

  test("session.deleted for an untracked session returns null", () => {
    const out = filterEvent({
      type: "session.deleted",
      properties: { info: sessionInfo({ id: OTHER_SID }) },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });

  test("after subagent-ended via session.deleted, a subsequent session.created for the same id re-tracks (no stale dedup)", () => {
    trackChild();
    filterEvent({
      type: "session.deleted",
      properties: { info: sessionInfo({ id: CHILD_SID }) },
    } as any, PARENT_SID);
    const re = filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);
    expect(re).not.toBeNull();
  });
});

// Helpers for Task-tool tracking tests
function taskPart(partID: string, status: "pending" | "running" | "completed" | "error", output?: string) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partID,
        sessionID: PARENT_SID,
        messageID: "msg_1",
        type: "tool",
        tool: "task",
        callID: "call_" + partID,
        state: { status, output },
      },
    },
  } as any;
}

describe("filterEvent — Task tool tracking (protocol-precise end signal)", () => {
  test("Task tool state=pending registers partID in openTaskPartIDs (returns block-start tool-call)", () => {
    const out = filterEvent(taskPart("prt_task_a", "pending"), PARENT_SID);
    expect(out).not.toBeNull();
    expect((out as any).kind).toBe("block-start");
    expect((out as any).role).toBe("tool-call");
    expect((out as any).toolName).toBe("task");
  });

  test("session.created arriving after a pending Task tool is paired with that partID", () => {
    filterEvent(taskPart("prt_task_a", "pending"), PARENT_SID);
    const created = filterEvent({
      type: "session.created",
      properties: {
        info: sessionInfo({
          id: CHILD_SID,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        }),
      },
    } as any, PARENT_SID);
    expect(created).not.toBeNull();
    expect((created as any).kind).toBe("subagent-detected");
    // Now complete the task — should emit subagent-ended for the paired child
    const completed = filterEvent(taskPart("prt_task_a", "completed", "result"), PARENT_SID);
    expect(Array.isArray(completed)).toBe(true);
    expect((completed as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === CHILD_SID)).toBe(true);
  });

  test("Task tool state=completed for an UNPAIRED partID just cleans up (no subagent-ended)", () => {
    filterEvent(taskPart("prt_task_orphan", "pending"), PARENT_SID);
    // No session.created arrives → never paired
    const completed = filterEvent(taskPart("prt_task_orphan", "completed", ""), PARENT_SID);
    expect(Array.isArray(completed)).toBe(true);
    expect((completed as any[]).every(e => e.kind !== "subagent-ended")).toBe(true);
  });

  test("Task tool state=error for paired partID emits subagent-ended", () => {
    filterEvent(taskPart("prt_task_b", "pending"), PARENT_SID);
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_b", parentID: PARENT_SID }) },
    } as any, PARENT_SID);
    const errored = filterEvent(taskPart("prt_task_b", "error"), PARENT_SID);
    expect(Array.isArray(errored)).toBe(true);
    expect((errored as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_b")).toBe(true);
  });

  test("FIFO pairing: two pending tasks then two session.created — oldest task pairs with first session", () => {
    filterEvent(taskPart("prt_task_1", "pending"), PARENT_SID);
    filterEvent(taskPart("prt_task_2", "pending"), PARENT_SID);
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_1", parentID: PARENT_SID }) },
    } as any, PARENT_SID);
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_2", parentID: PARENT_SID }) },
    } as any, PARENT_SID);
    // Complete task_1 — should end ses_child_1 (oldest pairing)
    const out1 = filterEvent(taskPart("prt_task_1", "completed", ""), PARENT_SID);
    expect((out1 as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_1")).toBe(true);
    // Complete task_2 — should end ses_child_2
    const out2 = filterEvent(taskPart("prt_task_2", "completed", ""), PARENT_SID);
    expect((out2 as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_2")).toBe(true);
  });

  test("session.created with no preceding Task tool still emits subagent-detected (unpaired; ends via badge → null)", () => {
    const out = filterEvent({
      type: "session.created",
      properties: {
        info: sessionInfo({ id: "ses_unpaired", parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }),
      },
    } as any, PARENT_SID);
    expect(out).toEqual({
      kind: "subagent-detected",
      sessionID: "ses_unpaired",
      agent: "planner",
      model: "sohoai/minimax-m3",
    });
  });
});

describe("filterEvent — session.updated activity routing", () => {
  function trackChild() {
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);
  }

  test("session.updated for tracked child returns subagent-activity (not session-compacting)", () => {
    trackChild();
    const out = filterEvent({
      type: "session.updated",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID }) },
    } as any, PARENT_SID);
    expect(out).not.toBeNull();
    expect((out as any).kind).toBe("subagent-activity");
    expect((out as any).sessionID).toBe(CHILD_SID);
    expect(typeof (out as any).ts).toBe("number");
  });

  test("session.updated for parent (harness) returns session-compacting", () => {
    const out = filterEvent({
      type: "session.updated",
      properties: {
        info: { ...sessionInfo({ id: PARENT_SID }), time: { created: 1, updated: 2, compacting: 100 } },
      },
    } as any, PARENT_SID);
    expect(out).not.toBeNull();
    expect((out as any).kind).toBe("session-compacting");
  });

  test("session.updated for unrelated session returns null", () => {
    const out = filterEvent({
      type: "session.updated",
      properties: { info: sessionInfo({ id: OTHER_SID }) },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });
});

describe("filterEvent — Task/session.created ordering: session.created BEFORE pending", () => {
  test("session.created arrives first (no pending part yet) → emits subagent-detected; then task tool pending → tryPair() runs; then task tool completed → emits subagent-ended for the child", () => {
    // Child arrives first
    const detected = filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);
    expect(detected).not.toBeNull();
    expect((detected as any).kind).toBe("subagent-detected");

    // Task part pending arrives next
    const pending = filterEvent(taskPart("prt_task_a", "pending"), PARENT_SID);
    expect(pending).not.toBeNull();
    expect((pending as any).kind).toBe("block-start");

    // Task completes → should emit subagent-ended for the child
    const completed = filterEvent(taskPart("prt_task_a", "completed", "result"), PARENT_SID);
    expect(Array.isArray(completed)).toBe(true);
    expect((completed as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === CHILD_SID)).toBe(true);
  });

  test("session.created arrives first, then task tool pending, then task tool errors → still emits subagent-ended", () => {
    // Child arrives first
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);

    // Task part pending
    filterEvent(taskPart("prt_task_b", "pending"), PARENT_SID);

    // Task errors
    const errored = filterEvent(taskPart("prt_task_b", "error"), PARENT_SID);
    expect(Array.isArray(errored)).toBe(true);
    expect((errored as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === CHILD_SID)).toBe(true);
  });
});

describe("filterEvent — parallel multi-task dispatch out-of-order", () => {
  test("two session.created both arrive before any pending parts → both added to unpairedChildren; then two task tool pending arrive → tryPair() pairs FIFO; then both complete → each emits subagent-ended for its paired child", () => {
    // Both children arrive before any pending parts
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_a", parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_b", parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);

    // Two pending parts arrive
    filterEvent(taskPart("prt_task_1", "pending"), PARENT_SID);
    filterEvent(taskPart("prt_task_2", "pending"), PARENT_SID);

    // Complete task_1 — should end ses_child_a (oldest pairing)
    const out1 = filterEvent(taskPart("prt_task_1", "completed", ""), PARENT_SID);
    expect((out1 as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_a")).toBe(true);

    // Complete task_2 — should end ses_child_b
    const out2 = filterEvent(taskPart("prt_task_2", "completed", ""), PARENT_SID);
    expect((out2 as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_b")).toBe(true);
  });

  test("interleaved: session.created child_1, then pending part_1 (immediate pair), then session.created child_2, then pending part_2 (immediate pair) → verify FIFO preserved and both complete correctly", () => {
    // Child_1 arrives
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_x", parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);

    // Part_1 pending — should pair with child_1 immediately
    filterEvent(taskPart("prt_task_x", "pending"), PARENT_SID);

    // Child_2 arrives
    filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_child_y", parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);

    // Part_2 pending — should pair with child_2 immediately
    filterEvent(taskPart("prt_task_y", "pending"), PARENT_SID);

    // Complete task_x — should end child_x
    const out_x = filterEvent(taskPart("prt_task_x", "completed", ""), PARENT_SID);
    expect((out_x as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_x")).toBe(true);

    // Complete task_y — should end child_y
    const out_y = filterEvent(taskPart("prt_task_y", "completed", ""), PARENT_SID);
    expect((out_y as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === "ses_child_y")).toBe(true);
  });
});

// Stage 10.7 — text PartUpdated reconcile path. OC always emits a final
// message.part.updated with the complete accumulated text at text-end
// (processor.ts:826). Without this handler we silently lost any tail bytes
// that SSE deltas failed to deliver.
function textPartUpdated(partID: string, fullText: string, messageID = "msg_1") {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partID,
        sessionID: PARENT_SID,
        messageID,
        type: "text",
        text: fullText,
      },
    },
  } as any;
}

describe("filterEvent — text PartUpdated reconcile (Stage 10.7)", () => {
  test("first PartUpdated with text.length === 0 emits block-start + generating (unchanged from prior behaviour)", () => {
    const out = filterEvent(textPartUpdated("prt_text_a", ""), PARENT_SID);
    expect(Array.isArray(out)).toBe(true);
    const evs = out as any[];
    expect(evs.some(e => e.kind === "block-start" && e.role === "text")).toBe(true);
    expect(evs.some(e => e.kind === "generating")).toBe(true);
  });

  test("subsequent PartUpdated with text.length > 0 emits block-reconcile (Stage 10.7 NEW)", () => {
    // First: register the part via len=0 PartUpdated.
    filterEvent(textPartUpdated("prt_text_b", ""), PARENT_SID);
    // Then: a final state push with the complete text.
    const out = filterEvent(textPartUpdated("prt_text_b", "the full accumulated text"), PARENT_SID);
    expect(out).not.toBeNull();
    expect((out as any).kind).toBe("block-reconcile");
    expect((out as any).partID).toBe("prt_text_b");
    expect((out as any).text).toBe("the full accumulated text");
  });

  test("PartUpdated for an untracked partID (no prior len=0 init) is dropped", () => {
    // No block-start registration first → openParts.get(part.id) is undefined.
    const out = filterEvent(textPartUpdated("prt_text_orphan", "stray content"), PARENT_SID);
    expect(out).toBeNull();
  });

  test("PartUpdated for a user-message part is dropped (user messages are never reconciled)", () => {
    // Mark this messageID as a user message via message.updated.
    filterEvent({
      type: "message.updated",
      properties: { info: { sessionID: PARENT_SID, id: "msg_user_1", role: "user", time: {} } },
    } as any, PARENT_SID);
    const out = filterEvent(textPartUpdated("prt_user_x", "user echo", "msg_user_1"), PARENT_SID);
    expect(out).toBeNull();
  });
});
