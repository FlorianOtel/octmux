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

  test("session.idle for tracked child returns subagent-ended", () => {
    trackChild();
    const out = filterEvent({
      type: "session.idle",
      properties: { sessionID: CHILD_SID },
    } as any, PARENT_SID);
    expect(out).toEqual({ kind: "subagent-ended", sessionID: CHILD_SID });
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

  test("after subagent-ended via session.idle, a subsequent session.created for the same id re-tracks (no stale dedup)", () => {
    trackChild();
    filterEvent({ type: "session.idle", properties: { sessionID: CHILD_SID } } as any, PARENT_SID);
    const re = filterEvent({
      type: "session.created",
      properties: { info: sessionInfo({ id: CHILD_SID, parentID: PARENT_SID, agent: "planner", model: { providerID: "sohoai", id: "minimax-m3" } }) },
    } as any, PARENT_SID);
    expect(re).not.toBeNull();
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
