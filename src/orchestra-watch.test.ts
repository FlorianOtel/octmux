import { describe, expect, test, beforeEach } from "bun:test";
import { OrchestraWatcher, type OrchestraBadge } from "./orchestra-watch.ts";

// Minimal stub Backend — the watcher only stores `backend` on a private field;
// no method is invoked at runtime in these tests.
const stubBackend: any = {};

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
  return new OrchestraWatcher(stubBackend);
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

describe("OrchestraWatcher._badgeContentEquals timestamp exclusion", () => {
  let changed = 0;

  function attachCounter(w: OrchestraWatcher): void {
    changed = 0;
    w.on("changed", () => { changed += 1; });
  }

  test("same content with different lastActivityAt does not emit (seeded badge timestamp preserved)", () => {
    const w = freshWatcher();
    
    // Seed badge with lastActivityAt=1000
    const seedBadge = makeBadge({ lastActivityAt: 1000 });
    setBadge(w, seedBadge);
    attachCounter(w);
    
    // Call _updateBadge with same content but lastActivityAt=9999
    const newBadge = makeBadge({ lastActivityAt: 9999 });
    (w as any)._updateBadge(newBadge);
    
    // Assert NO emit (timestamp exclusion)
    expect(changed).toBe(0);
    // Assert badge.lastActivityAt still 1000 (untouched)
    expect(getBadge(w)!.lastActivityAt).toBe(1000);
  });

  test("real content change (different title) does emit", () => {
    const w = freshWatcher();
    
    const seedBadge = makeBadge({ lastActivityAt: 1000, title: "old title" });
    setBadge(w, seedBadge);
    attachCounter(w);
    
    const newBadge = makeBadge({ lastActivityAt: 1000, title: "new title" });
    (w as any)._updateBadge(newBadge);
    
    // Assert emit (content changed)
    expect(changed).toBe(1);
    // Assert new content is applied
    expect(getBadge(w)!.title).toBe("new title");
  });

  test("subagent row timestamp difference does not emit", () => {
    const w = freshWatcher();
    
    // Seed badge with subagent at lastActivityAt=100
    const seedBadge = makeBadge({
      subagents: [
        { sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 100 },
      ],
    });
    setBadge(w, seedBadge);
    attachCounter(w);
    
    // Call _updateBadge with same subagent content but lastActivityAt=9999
    const newBadge = makeBadge({
      subagents: [
        { sessionID: "ses_a", agent: "planner", model: "m1", lastActivityAt: 9999 },
      ],
    });
    (w as any)._updateBadge(newBadge);
    
    // Assert NO emit (timestamp exclusion)
    expect(changed).toBe(0);
    // Assert subagent lastActivityAt still 100 (untouched)
    expect(getBadge(w)!.subagents[0].lastActivityAt).toBe(100);
  });

  test("null badge comparison returns equality", () => {
    const w = freshWatcher();
    
    // Both null - no change
    const newBadge = null;
    (w as any)._updateBadge(newBadge);
    expect(getBadge(w)).toBeNull();
    expect(changed).toBe(0);
  });
});

describe("OrchestraWatcher.sweepStaleSubagents (Stage 8.1.6)", () => {
  let changed = 0;

  function attachCounter(w: OrchestraWatcher): void {
    changed = 0;
    w.on("changed", () => { changed += 1; });
  }

  test("drops only the stale row, emits changed once", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [
        { sessionID: "ses_fresh", agent: "planner", model: "m1", lastActivityAt: Date.now() - 5000 },
        { sessionID: "ses_stale", agent: "actor", model: "m2", lastActivityAt: Date.now() - 200000 },
      ],
    }));
    attachCounter(w);
    w.sweepStaleSubagents(120_000);
    const b = getBadge(w)!;
    // Fresh row remains, stale row dropped
    expect(b.subagents).toHaveLength(1);
    expect(b.subagents[0].sessionID).toBe("ses_fresh");
    // Changed listener fired
    expect(changed).toBe(1);
  });

  test("both fresh → no drop, no emit", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [
        { sessionID: "ses_fresh1", agent: "planner", model: "m1", lastActivityAt: Date.now() - 5000 },
        { sessionID: "ses_fresh2", agent: "actor", model: "m2", lastActivityAt: Date.now() - 5000 },
      ],
    }));
    attachCounter(w);
    w.sweepStaleSubagents(120_000);
    const b = getBadge(w)!;
    // Both rows remain
    expect(b.subagents).toHaveLength(2);
    expect(b.subagents[0].sessionID).toBe("ses_fresh1");
    expect(b.subagents[1].sessionID).toBe("ses_fresh2");
    // Changed listener NOT called
    expect(changed).toBe(0);
  });

  test("both stale → both dropped, subagents empty", () => {
    const w = freshWatcher();
    setBadge(w, makeBadge({
      subagents: [
        { sessionID: "ses_stale1", agent: "planner", model: "m1", lastActivityAt: Date.now() - 200000 },
        { sessionID: "ses_stale2", agent: "actor", model: "m2", lastActivityAt: Date.now() - 200000 },
      ],
    }));
    attachCounter(w);
    w.sweepStaleSubagents(120_000);
    const b = getBadge(w)!;
    // Both rows dropped
    expect(b.subagents).toEqual([]);
    expect(changed).toBe(1);
  });
});

// The watcher is protocol-neutral: the run state comes from Backend.getOrchestraState
// (API metadata on v2, legacy sidecar files on v1), the display names from listProviders.
describe("OrchestraWatcher.refresh (backend-driven state)", () => {
  type State = Awaited<ReturnType<import("./backend/types.ts").Backend["getOrchestraState"]>>;

  function backendWith(states: Record<string, State>): any {
    return {
      getOrchestraState: async (sessionID: string) => states[sessionID] ?? null,
      listProviders: async () => ({
        data: { all: [{ id: "sohoai", models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash" } } }], connected: ["sohoai"] },
      }),
    };
  }
  const STATE: State = {
    mode: "brain",
    title: "orchestra full - task",
    parserWarnings: [],
    model: { providerID: "sohoai", id: "glm-5.3-flash" },
  };

  test("builds the badge from the backend state, with the display name from listProviders", async () => {
    const w = new OrchestraWatcher(backendWith({ ses_a: STATE }));
    await (w as any).loadModelFriendlyNames();
    w.setOcSessionID("ses_a");
    await w.refresh();
    const b = getBadge(w)!;
    expect(b.mode).toBe("brain");
    expect(b.title).toBe("orchestra full - task");
    expect(b.parentModelRaw).toBe("sohoai/glm-5.3-flash");
    expect(b.parentModelLabel).toBe("[sohoai/GLM 5.3 Flash]");
  });

  test("without a display name the label falls back to the raw model id", async () => {
    const backend = backendWith({ ses_a: STATE });
    backend.listProviders = async () => { throw new Error("down"); };
    const w = new OrchestraWatcher(backend);
    await (w as any).loadModelFriendlyNames();
    w.setOcSessionID("ses_a");
    await w.refresh();
    expect(getBadge(w)!.parentModelLabel).toBe("[sohoai/glm-5.3-flash]");
  });

  test("a refresh keeps the subagent rows, and a null state clears the badge", async () => {
    const states: Record<string, State> = { ses_a: STATE };
    const w = new OrchestraWatcher(backendWith(states));
    w.setOcSessionID("ses_a");
    await w.refresh();
    w.notifySubagentStarted("ses_child", "general", "", "Run pwd");
    await w.refresh();
    expect(getBadge(w)!.subagents.map(s => s.sessionID)).toEqual(["ses_child"]);
    states.ses_a = null;
    await w.refresh();
    expect(getBadge(w)).toBeNull();
  });

  test("subagents queued before the badge exists are drained into it", async () => {
    const w = new OrchestraWatcher(backendWith({ ses_a: STATE }));
    w.notifySubagentStarted("ses_child", "general", "", undefined);
    w.setOcSessionID("ses_a");
    await w.refresh();
    expect(getBadge(w)!.subagents.map(s => s.sessionID)).toEqual(["ses_child"]);
  });

  test("a result for a session the REPL has left is dropped", async () => {
    let release!: (s: State) => void;
    const backend = backendWith({});
    backend.getOrchestraState = (sessionID: string) =>
      sessionID === "ses_old" ? new Promise<State>((r) => { release = r; }) : Promise.resolve(null);
    const w = new OrchestraWatcher(backend);
    w.setOcSessionID("ses_old");
    const pending = w.refresh();
    (w as any).refreshInFlight = false; // let the switch's own refresh run
    w.setOcSessionID("ses_new");
    release(STATE);
    await pending;
    expect(getBadge(w)).toBeNull();
  });
});
