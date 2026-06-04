import { describe, expect, test, beforeEach } from "bun:test";
import { OrchestraWatcher, type OrchestraBadge } from "./orchestra-watch.ts";

// Minimal stub client — the watcher only stores `client` on a private field;
// no method is invoked at runtime in these tests.
const stubClient: any = {};

function makeBadge(overrides: Partial<NonNullable<OrchestraBadge>> = {}): NonNullable<OrchestraBadge> {
  return {
    mode: "brain",
    title: "noop",
    lastActivityAt: 1000,
    subagents: [],
    ...overrides,
  };
}

function freshWatcher(): OrchestraWatcher {
  return new OrchestraWatcher(stubClient);
}

// Helper to directly seed/inspect the private badge state via cast.
function setBadge(w: OrchestraWatcher, b: OrchestraBadge): void {
  (w as any).badge = b;
}
function getBadge(w: OrchestraWatcher): OrchestraBadge {
  return (w as any).badge;
}
function getQueue(w: OrchestraWatcher): Array<{ sessionID: string; agent: string; model: string; description?: string }> {
  return (w as any)._pendingSubagentQueue;
}

let changed = 0;
function attachCounter(w: OrchestraWatcher): void {
  changed = 0;
  w.on("changed", () => { changed += 1; });
}

beforeEach(() => {
  changed = 0;
});

describe("OrchestraWatcher.notifySubagentStarted", () => {
  test("with badge=null queues to _pendingSubagentQueue and does not emit 'changed'", () => {
    const w = freshWatcher();
    attachCounter(w);
    w.notifySubagentStarted("ses_child", "planner", "sohoai/minimax-m3", "design plan");
    expect(getBadge(w)).toBeNull();
    expect(getQueue(w)).toHaveLength(1);
    expect(getQueue(w)[0]).toEqual({
      sessionID: "ses_child",
      agent: "planner",
      model: "sohoai/minimax-m3",
      description: "design plan",
    });
    expect(changed).toBe(0);
  });

  test("with badge present pushes to badge.subagents and emits 'changed' exactly once", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge());
    attachCounter(w);
    w.notifySubagentStarted("ses_child", "planner", "sohoai/minimax-m3");
    const b = getBadge(w)!;
    expect(b.subagents).toHaveLength(1);
    expect(b.subagents[0].sessionID).toBe("ses_child");
    expect(b.subagents[0].agent).toBe("planner");
    expect(b.subagents[0].model).toBe("sohoai/minimax-m3");
    expect(b.subagents[0].lastActivityAt).toBeGreaterThan(0);
    expect(changed).toBe(1);
  });

  test("dedup: pushing the same sessionID twice yields only one row", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge());
    w.notifySubagentStarted("ses_child", "planner", "sohoai/minimax-m3");
    w.notifySubagentStarted("ses_child", "planner", "sohoai/minimax-m3");
    expect(getBadge(w)!.subagents).toHaveLength(1);
  });
});

describe("OrchestraWatcher._updateBadge drain semantics", () => {
  test("drains pending queue into the newly-set non-null badge", () => {
    const w = freshWatcher();
    w.notifySubagentStarted("ses_a", "planner", "sohoai/minimax-m3");
    w.notifySubagentStarted("ses_b", "actor",   "sohoai/glm-5.1");
    expect(getBadge(w)).toBeNull();
    expect(getQueue(w)).toHaveLength(2);

    attachCounter(w);
    (w as any)._updateBadge(makeBadge());
    const b = getBadge(w)!;
    expect(b.subagents).toHaveLength(2);
    expect(b.subagents.map(s => s.sessionID).sort()).toEqual(["ses_a", "ses_b"]);
    expect(getQueue(w)).toHaveLength(0);
  });

  test("drain dedups: a queued sessionID already present on the new badge is skipped", () => {
    const w = freshWatcher();
    w.notifySubagentStarted("ses_a", "planner", "sohoai/minimax-m3");
    const seeded = makeBadge({
      subagents: [{ sessionID: "ses_a", agent: "planner", model: "sohoai/minimax-m3", lastActivityAt: 500 }],
    });
    (w as any)._updateBadge(seeded);
    expect(getBadge(w)!.subagents).toHaveLength(1);
  });
});

describe("OrchestraWatcher.notifySubagentEnded", () => {
  test("removes the matching row by sessionID and emits 'changed'", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [
        { sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 1 },
        { sessionID: "ses_b", agent: "actor",   model: "m2", lastActivityAt: 1 },
      ],
    }));
    attachCounter(w);
    w.notifySubagentEnded("ses_a");
    const b = getBadge(w)!;
    expect(b.subagents).toHaveLength(1);
    expect(b.subagents[0].sessionID).toBe("ses_b");
    expect(changed).toBe(1);
  });

  test("non-matching sessionID is a no-op (no throw, no row drop)", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [{ sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 1 }],
    }));
    w.notifySubagentEnded("ses_other");
    expect(getBadge(w)!.subagents).toHaveLength(1);
  });

  test("with badge=null is a no-op (no throw)", () => {
    const w = freshWatcher();
    expect(() => w.notifySubagentEnded("ses_any")).not.toThrow();
  });
});

describe("OrchestraWatcher.notifyAllSubagentsEnded", () => {
  test("clears badge.subagents and emits 'changed'", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [
        { sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 1 },
        { sessionID: "ses_b", agent: "actor",   model: "m2", lastActivityAt: 1 },
      ],
    }));
    attachCounter(w);
    w.notifyAllSubagentsEnded();
    expect(getBadge(w)!.subagents).toEqual([]);
    expect(changed).toBe(1);
  });

  test("with badge=null is a no-op", () => {
    const w = freshWatcher();
    expect(() => w.notifyAllSubagentsEnded()).not.toThrow();
  });
});

describe("OrchestraWatcher.notifySubagentActivity", () => {
  test("bumps lastActivityAt on the matching row only and emits 'changed'", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [
        { sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 100 },
        { sessionID: "ses_b", agent: "actor",   model: "m2", lastActivityAt: 100 },
      ],
    }));
    attachCounter(w);
    w.notifySubagentActivity("ses_a", 999);
    const b = getBadge(w)!;
    expect(b.subagents[0].lastActivityAt).toBe(999);
    expect(b.subagents[1].lastActivityAt).toBe(100);
    expect(changed).toBe(1);
  });

  test("unknown sessionID is a no-op (no throw, no emit)", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [{ sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 100 }],
    }));
    attachCounter(w);
    w.notifySubagentActivity("ses_unknown", 999);
    expect(getBadge(w)!.subagents[0].lastActivityAt).toBe(100);
    expect(changed).toBe(0);
  });

  test("with badge=null is a no-op", () => {
    const w = freshWatcher();
    expect(() => w.notifySubagentActivity("ses_any", 999)).not.toThrow();
  });
});

describe("OrchestraWatcher.notifyParentActivity (unchanged from Stage 8.1.4, regression guard)", () => {
  test("bumps badge.lastActivityAt and emits 'changed'", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({ lastActivityAt: 100 }));
    attachCounter(w);
    w.notifyParentActivity(999);
    expect(getBadge(w)!.lastActivityAt).toBe(999);
    expect(changed).toBe(1);
  });
});

describe("OrchestraWatcher emit identity (React same-reference bailout defeat)", () => {
  // React's setState bails out when newValue is Object.is to the current value.
  // The watcher mutates this.badge in place; without a new top-level reference
  // on each emit, setOrchestraBadge would bail and React would not re-render
  // until an unrelated state change (e.g. spinner tick). Each notify* method
  // must emit a DIFFERENT object reference than the previous emit.
  test("notifySubagentStarted emits a new badge object reference (not Object.is to previous)", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge());
    const beforeRef = getBadge(w);
    w.notifySubagentStarted("ses_child", "planner", "sohoai/minimax-m3");
    const afterRef = getBadge(w);
    expect(Object.is(beforeRef, afterRef)).toBe(false);
  });

  test("notifySubagentActivity emits a new badge object reference", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [{ sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 100 }],
    }));
    const beforeRef = getBadge(w);
    w.notifySubagentActivity("ses_a", 999);
    const afterRef = getBadge(w);
    expect(Object.is(beforeRef, afterRef)).toBe(false);
  });

  test("notifyParentActivity emits a new badge object reference", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge());
    const beforeRef = getBadge(w);
    w.notifyParentActivity(999);
    const afterRef = getBadge(w);
    expect(Object.is(beforeRef, afterRef)).toBe(false);
  });

  test("notifySubagentEnded emits a new badge object reference", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [{ sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 100 }],
    }));
    const beforeRef = getBadge(w);
    w.notifySubagentEnded("ses_a");
    const afterRef = getBadge(w);
    expect(Object.is(beforeRef, afterRef)).toBe(false);
  });
});
