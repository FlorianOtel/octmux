import { describe, expect, test, beforeEach } from "bun:test";
import { filterEvent, resetEventState, recordSubmittedUserText, peekSubmittedUserText } from "./events.ts";

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

function userMsgUpdated(messageID: string) {
  return {
    type: "message.updated",
    properties: { info: { id: messageID, sessionID: PARENT_SID, role: "user", time: { created: 1, updated: 2 } } },
  } as any;
}
function assistantMsgUpdated(messageID: string) {
  return {
    type: "message.updated",
    properties: { info: { id: messageID, sessionID: PARENT_SID, role: "assistant", time: { created: 1, updated: 2 } } },
  } as any;
}
function userTextPart(messageID: string, partID: string, text: string, opts?: { synthetic?: boolean; ignored?: boolean }) {
  return {
    type: "message.part.updated",
    properties: { part: {
      id: partID, sessionID: PARENT_SID, messageID, type: "text", text,
      ...(opts?.synthetic !== undefined ? { synthetic: opts.synthetic } : {}),
      ...(opts?.ignored !== undefined ? { ignored: opts.ignored } : {}),
    } },
  } as any;
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
function taskPart(partID: string, status: "pending" | "running" | "completed" | "error", output?: string, metadata?: { sessionId?: string; interrupted?: boolean }) {
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
        state: {
          status,
          output,
          metadata: metadata ?? { },
        },
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

describe("filterEvent — Layer A: metadata-keyed pairing (Stage 8.1.6)", () => {
  const PARENT_SID = "ses_parent_harness";
  const CHILD_REAL = "ses_real_child";
  const CHILD_INT = "ses_interrupted_child";
  const PRT_INTERRUPTED = "prt_interrupted";
  const PRT_REAL = "prt_real";

  beforeEach(() => {
    resetEventState();
  });

  test("interrupted task partID never pairs to a subsequent real child (behavioral guard)", () => {
    // Step 1: task pending partID="prt_interrupted" (no metadata) → openTaskPartIDs
    filterEvent(taskPart(PRT_INTERRUPTED, "pending"), PARENT_SID);

    // Step 2: task error partID="prt_interrupted" (status "error", optionally metadata.interrupted=true)
    // Cleanup; the stale entry is removed; no subagent-ended (no child was paired)
    filterEvent(taskPart(PRT_INTERRUPTED, "error", "", { interrupted: true }), PARENT_SID);

    // Step 3: session.created CHILD_REAL (parentID=PARENT_SID) → subagent-detected; child parked in unpairedChildren
    filterEvent({
      type: "session.created",
      properties: {
        info: {
          id: CHILD_REAL,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        },
      },
    } as any, PARENT_SID);

    // Step 4: task completed partID="prt_real" WITH metadata.sessionId=CHILD_REAL AFTER the session.created
    // metadata pairing should pair and pull CHILD_REAL out of unpairedChildren
    filterEvent(taskPart(PRT_REAL, "pending", "result", { sessionId: CHILD_REAL }), PARENT_SID);

    // MUST emit subagent-ended for CHILD_REAL
    const completed = filterEvent(taskPart(PRT_REAL, "completed", "result", { sessionId: CHILD_REAL }), PARENT_SID);
    expect(Array.isArray(completed)).toBe(true);
    expect((completed as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === CHILD_REAL)).toBe(true);
    // Behavioral guard: CHILD_INT was never paired to CHILD_REAL. Since CHILD_INT's part was
    // removed during the error (step 2), it's no longer in openTaskPartIDs. CHILD_REAL was
    // then paired directly via metadata (sessionId=CHILD_REAL), not via FIFO to CHILD_INT.
    // This test verifies that an interrupted task part doesn't leave a residue that could
    // mispair a subsequent real child.
  });

  test("metadata-keyed pairing wins; stale openTaskPartIDs entry does not mispair the real child", () => {
    // Step 1: Feed a task pending part with NO metadata.sessionId → goes into openTaskPartIDs (FIFO fallback)
    filterEvent(taskPart(PRT_INTERRUPTED, "pending"), PARENT_SID);

    // Step 2: Feed a task pending part WITH metadata.sessionId = CHILD_REAL
    // Metadata-keyed pairing should pair prt_real↔CHILD_REAL directly (NOT FIFO)
    filterEvent(taskPart(PRT_REAL, "pending", undefined, { sessionId: CHILD_REAL }), PARENT_SID);

    // Step 3: Feed session.created for CHILD_REAL with parentID=PARENT_SID
    // Should emit subagent-detected; must NOT re-pair (alreadyPaired path)
    filterEvent({
      type: "session.created",
      properties: {
        info: {
          id: CHILD_REAL,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        },
      },
    } as any, PARENT_SID);

    // Step 4: Feed task completed part for prt_real with metadata.sessionId=CHILD_REAL
    // MUST emit a subagent-ended event for CHILD_REAL
    const completed = filterEvent(taskPart(PRT_REAL, "completed", "result", { sessionId: CHILD_REAL }), PARENT_SID);
    expect(Array.isArray(completed)).toBe(true);
    expect((completed as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === CHILD_REAL)).toBe(true);
  });

  test("interrupted task then real subagent → real subagent's row is removed (no orphan)", () => {
    // Step 1: task pending partID="prt_interrupted" (no metadata) → openTaskPartIDs
    filterEvent(taskPart(PRT_INTERRUPTED, "pending"), PARENT_SID);

    // Step 2: task error partID="prt_interrupted" (status "error", optionally metadata.interrupted=true)
    // Cleanup; the stale entry is removed; no subagent-ended (no child was paired)
    filterEvent(taskPart(PRT_INTERRUPTED, "error", "", { interrupted: true }), PARENT_SID);

    // Step 3: session.created CHILD_REAL (parentID=PARENT_SID) → subagent-detected; child parked in unpairedChildren
    filterEvent({
      type: "session.created",
      properties: {
        info: {
          id: CHILD_REAL,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        },
      },
    } as any, PARENT_SID);

    // Step 4: task completed partID="prt_real" WITH metadata.sessionId=CHILD_REAL AFTER the session.created
    // metadata pairing should pair and pull CHILD_REAL out of unpairedChildren
    filterEvent(taskPart(PRT_REAL, "pending", "result", { sessionId: CHILD_REAL }), PARENT_SID);

    // MUST emit subagent-ended for CHILD_REAL
    const completed = filterEvent(taskPart(PRT_REAL, "completed", "result", { sessionId: CHILD_REAL }), PARENT_SID);
    expect(Array.isArray(completed)).toBe(true);
    expect((completed as any[]).some(e => e.kind === "subagent-ended" && e.sessionID === CHILD_REAL)).toBe(true);
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

  test("session.updated for parent (harness) returns null (time.compacting was removed in step 8)", () => {
    const out = filterEvent({
      type: "session.updated",
      properties: {
        info: { ...sessionInfo({ id: PARENT_SID }), time: { created: 1, updated: 2 } },
      },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });

  test("session.updated for unrelated session returns null", () => {
    const out = filterEvent({
      type: "session.updated",
      properties: { info: sessionInfo({ id: OTHER_SID }) },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });

  describe("message.updated / message.part.updated routing (Step 15 regression tests)", () => {
    test("message.updated with info.summary === true emits block-retag for already-open parts", () => {
      // Set up: create a text part first (populates openParts and partIDToMessageID)
      const partID = "prt_text_1";
      filterEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: partID,
            sessionID: PARENT_SID,
            messageID: "msg_1",
            type: "text",
            text: "",
          },
        },
      } as any, PARENT_SID);

      // Now send message.updated with info.summary === true
      const msgUpdated = {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: PARENT_SID,
            role: "assistant",
            summary: true,
            time: { created: 1, updated: 2 },
          },
        },
      } as any;

      const out = filterEvent(msgUpdated, PARENT_SID);
      expect(out).not.toBeNull();
      expect((out as any).kind).toBe("block-retag");
      expect((out as any).partID).toBe(partID);
      expect((out as any).newRole).toBe("summary");
    });

    test("message.part.updated text part for already-known summary message gets role summary", () => {
      // Set up: message.updated with info.summary === true records messageID in summaryMessageIDs
      filterEvent({
        type: "message.updated",
        properties: {
          info: {
            id: "msg_2",
            sessionID: PARENT_SID,
            role: "assistant",
            summary: true,
            time: { created: 1, updated: 2 },
          },
        },
      } as any, PARENT_SID);

      // Now send message.part.updated for a text part with the same messageID, length 0 (creation)
      const partID = "prt_text_2";
      const out = filterEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: partID,
            sessionID: PARENT_SID,
            messageID: "msg_2",
            type: "text",
            text: "",
          },
        },
      } as any, PARENT_SID);

      expect(out).not.toBeNull();
      expect(Array.isArray(out)).toBe(true);
      const blockStart = (out as any[]).find((e: any) => e.kind === "block-start");
      expect(blockStart).not.toBeNull();
      expect(blockStart.role).toBe("summary");
    });

    test("message.part.updated with part.type === compaction emits compaction-divider", () => {
      // Test auto: true
      const autoTrue = filterEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_comp_1",
            sessionID: PARENT_SID,
            messageID: "msg_3",
            type: "compaction",
            auto: true,
          },
        },
      } as any, PARENT_SID);
      expect(autoTrue).not.toBeNull();
      expect((autoTrue as any).kind).toBe("compaction-divider");
      expect((autoTrue as any).auto).toBe(true);

      // Test auto: false (explicit)
      const autoFalse = filterEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_comp_2",
            sessionID: PARENT_SID,
            messageID: "msg_4",
            type: "compaction",
            auto: false,
          },
        },
      } as any, PARENT_SID);
      expect(autoFalse).not.toBeNull();
      expect((autoFalse as any).kind).toBe("compaction-divider");
      expect((autoFalse as any).auto).toBe(false);

      // Test auto: undefined (defaults to false)
      const autoUnset = filterEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_comp_3",
            sessionID: PARENT_SID,
            messageID: "msg_5",
            type: "compaction",
          },
        },
      } as any, PARENT_SID);
      expect(autoUnset).not.toBeNull();
      expect((autoUnset as any).kind).toBe("compaction-divider");
      expect((autoUnset as any).auto).toBe(false);
    });
  });
});

describe("filterEvent — Layer B: parent-turn-end sweep signal (Stage 8.1.6)", () => {
  const PARENT_SID = "ses_parent_harness";
  const CHILD_SID = "ses_child_planner";
  const CHILD_REAL = "ses_real_child";

  beforeEach(() => {
    resetEventState();
  });

  function trackChild() {
    filterEvent({
      type: "session.created",
      properties: {
        info: {
          id: CHILD_SID,
          parentID: PARENT_SID,
          agent: "planner",
          model: { providerID: "sohoai", id: "minimax-m3" },
        },
      },
    } as any, PARENT_SID);
  }

  // (a) Test "parent session.idle emits parent-turn-end(idle)"
  test("parent session.idle emits parent-turn-end(idle)", () => {
    const out = filterEvent({
      type: "session.idle",
      properties: { sessionID: PARENT_SID },
    } as any, PARENT_SID);
    expect(Array.isArray(out)).toBe(true);
    expect((out as any[])[0]).toEqual({ kind: "parent-turn-end", reason: "idle" });
    expect((out as any[])[1]).toEqual({ kind: "session-idle" });
  });

  // (b) Test "child session.idle does NOT emit parent-turn-end"
  test("child session.idle does NOT emit parent-turn-end (child-idle regression guard)", () => {
    trackChild();
    const out = filterEvent({
      type: "session.idle",
      properties: { sessionID: CHILD_SID },
    } as any, PARENT_SID);
    expect(out).toBeNull();
  });

  // (c) Test "parent assistant message abort emits parent-turn-end(aborted)"
  test("parent assistant message abort emits parent-turn-end(aborted)", () => {
    const msgUpdated = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: PARENT_SID,
          role: "assistant",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          time: { created: 1, updated: 2 },
        },
      },
    } as any;
    const out = filterEvent(msgUpdated, PARENT_SID);
    // Normalize to array and search
    const arr = Array.isArray(out) ? out : [out];
    expect(arr.some(e => e.kind === "parent-turn-end" && e.reason === "aborted")).toBe(true);
  });

  // (d) Test "parent assistant message with other error emits parent-turn-end(error)"
  test("parent assistant message with other error emits parent-turn-end(error)", () => {
    const msgUpdated = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_2",
          sessionID: PARENT_SID,
          role: "assistant",
          error: { name: "SomeServerError", data: { message: "boom" } },
          time: { created: 1, updated: 2 },
        },
      },
    } as any;
    const out = filterEvent(msgUpdated, PARENT_SID);
    // Normalize to array and search
    const arr = Array.isArray(out) ? out : [out];
    expect(arr.some(e => e.kind === "parent-turn-end" && e.reason === "error")).toBe(true);
  });

  // (e) Test "parent assistant message with NO error does not emit parent-turn-end"
  test("parent assistant message with NO error does not emit parent-turn-end", () => {
    const msgUpdated = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_3",
          sessionID: PARENT_SID,
          role: "assistant",
          time: { created: 1, updated: 2 },
        },
      },
    } as any;
    const out = filterEvent(msgUpdated, PARENT_SID);
    // message.updated with no error returns null, not parent-turn-end
    expect(out).toBeNull();
  });

  // (f) Test "parent session.error emits both parent-turn-end(error) and error"
  test("parent session.error emits both parent-turn-end(error) and error", () => {
    const out = filterEvent({
      type: "session.error",
      properties: {
        sessionID: PARENT_SID,
        error: { data: { message: "server error" } },
      },
    } as any, PARENT_SID);
    expect(Array.isArray(out)).toBe(true);
    expect((out as any[]).some(e => e.kind === "parent-turn-end" && e.reason === "error")).toBe(true);
    expect((out as any[]).some(e => e.kind === "error")).toBe(true);
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

describe("filterEvent — Mobile-Companion Part B: foreign-user-turn detection", () => {
  const asArray = (out: any) => Array.isArray(out) ? out : (out ? [out] : []);

  // (a) Local single-part turn → no foreign-user-turn; FIFO consumed
  test("local single-part turn → no foreign-user-turn; FIFO consumed", () => {
    recordSubmittedUserText("hello world");
    filterEvent(userMsgUpdated("msg_local"), PARENT_SID);
    filterEvent(userTextPart("msg_local", "p1", "hello world"), PARENT_SID);
    const out = filterEvent(assistantMsgUpdated("msg_asst_a"), PARENT_SID);
    expect(asArray(out).some((e: any) => e.kind === "foreign-user-turn")).toBe(false);
    expect(peekSubmittedUserText()).toBeUndefined();  // FIFO consumed
  });

  // (b) Foreign single-part turn → foreign-user-turn emitted with reconstructed text
  test("foreign single-part turn → foreign-user-turn emitted with reconstructed text", () => {
    // no recordSubmittedUserText
    filterEvent(userMsgUpdated("msg_f"), PARENT_SID);
    filterEvent(userTextPart("msg_f", "pf1", "from phone"), PARENT_SID);
    const out = filterEvent(assistantMsgUpdated("msg_asst_b"), PARENT_SID);
    const evt = asArray(out).find((e: any) => e.kind === "foreign-user-turn");
    expect(evt).toBeTruthy();
    expect(evt.messageID).toBe("msg_f");
    expect(evt.text).toBe("from phone");
  });

  // (c) Foreign multi-part: synthetic/ignored excluded, order preserved, joined with newline
  test("foreign multi-part: synthetic/ignored excluded, order preserved, joined with newline", () => {
    filterEvent(userMsgUpdated("msg_multi"), PARENT_SID);
    filterEvent(userTextPart("msg_multi", "p1", "line 1"), PARENT_SID);
    filterEvent(userTextPart("msg_multi", "p2", "[reminder]", { synthetic: true }), PARENT_SID);
    filterEvent(userTextPart("msg_multi", "p3", "line 2"), PARENT_SID);
    filterEvent(userTextPart("msg_multi", "p4", "[noise]", { ignored: true }), PARENT_SID);
    const out = filterEvent(assistantMsgUpdated("msg_asst_c"), PARENT_SID);
    const evt = asArray(out).find((e: any) => e.kind === "foreign-user-turn");
    expect(evt).toBeTruthy();
    expect(evt.text).toBe("line 1\nline 2");
  });

  // (d) User message with only synthetic/ignored parts → no foreign-user-turn
  test("user message with only synthetic/ignored parts → no foreign-user-turn", () => {
    filterEvent(userMsgUpdated("msg_syn"), PARENT_SID);
    filterEvent(userTextPart("msg_syn", "p1", "[a]", { synthetic: true }), PARENT_SID);
    filterEvent(userTextPart("msg_syn", "p2", "[b]", { ignored: true }), PARENT_SID);
    const out = filterEvent(assistantMsgUpdated("msg_asst_d"), PARENT_SID);
    expect(asArray(out).some((e: any) => e.kind === "foreign-user-turn")).toBe(false);
  });

  // (e) session.idle backstop flush → foreign-user-turn present alongside idle close events
  test("session.idle backstop flush → foreign-user-turn present alongside idle close events", () => {
    filterEvent(userMsgUpdated("msg_idle"), PARENT_SID);
    filterEvent(userTextPart("msg_idle", "p1", "from idle path"), PARENT_SID);
    const out = filterEvent({ type: "session.idle", properties: { sessionID: PARENT_SID } } as any, PARENT_SID);
    expect(Array.isArray(out)).toBe(true);
    const arr = out as any[];
    const evt = arr.find((e: any) => e.kind === "foreign-user-turn");
    expect(evt).toBeTruthy();
    expect(evt.text).toBe("from idle path");
    expect(arr.some((e: any) => e.kind === "parent-turn-end" && e.reason === "idle")).toBe(true);
    expect(arr.some((e: any) => e.kind === "session-idle")).toBe(true);
  });

  // (f) resetEventState clears FIFO + accumulator; fresh foreign turn emits after reset
  test("resetEventState clears FIFO + accumulator; fresh foreign turn emits after reset", () => {
    recordSubmittedUserText("stale");
    expect(peekSubmittedUserText()).toBe("stale");
    resetEventState();
    expect(peekSubmittedUserText()).toBeUndefined();
    filterEvent(userMsgUpdated("msg_after"), PARENT_SID);
    filterEvent(userTextPart("msg_after", "p1", "fresh foreign"), PARENT_SID);
    const out = filterEvent(assistantMsgUpdated("msg_asst_f"), PARENT_SID);
    const evt = asArray(out).find((e: any) => e.kind === "foreign-user-turn");
    expect(evt).toBeTruthy();
    expect(evt.text).toBe("fresh foreign");
  });
});
