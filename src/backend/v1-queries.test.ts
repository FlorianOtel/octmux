/**
 * Pins the v1 session queries in `v1-queries.ts` to the ORIGINAL inline behaviour that
 * lived in `src/app.tsx` at HEAD (Stage 15.2 C2.1–2.2b). Each test name says which original
 * branch it pins. The fixtures are v1 message shapes (`{ info, parts }`).
 *
 * The fake session mirrors the style of `src/replay.test.ts`: a plain object cast to the
 * real type at the test seam. `getMessages` and `getChildren` return the bare arrays that
 * `V1Backend.session` returns (not `{ data }`), and an `Error` value makes the call reject.
 */
import { describe, expect, test } from "bun:test";
import {
  addAssistantCost,
  hasPendingToolCalls,
  queryHasPendingToolCalls,
  queryLatestAssistantActivity,
  queryTokenUsage,
  scanLatestAssistantActivity,
  pickPostSummaryAssistantTokenUsage,
  type QuerySession,
} from "./v1-queries.ts";

// ─── Fake session ───

/** A canned reply: a value, `undefined` (no data), or an `Error` (the call rejects). */
type Reply<T> = T | Error | undefined;

type FakeOptions = {
  /** Messages keyed by session ID. An unknown ID resolves to `undefined`. */
  messages?: Record<string, Reply<any[]>>;
  /** Reply of `getChildren`, for every session ID. */
  children?: Reply<any[]>;
};

/**
 * Builds a fake `QuerySession`. Returns the IDs passed to `getMessages` (in call order) and
 * the number of `getChildren` calls, so tests can assert which fetches happened.
 */
function fakeSession(opts: FakeOptions) {
  const fetched: string[] = [];
  let childrenCalls = 0;
  const session = {
    getMessages: async (id: string) => {
      fetched.push(id);
      const reply = opts.messages?.[id];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    getChildren: async (_id: string) => {
      childrenCalls++;
      if (opts.children instanceof Error) throw opts.children;
      return opts.children;
    },
  } as unknown as QuerySession;
  return { session, fetched, childrenCalls: () => childrenCalls };
}

// ─── Fixture helpers ───

/** Fixed clock for the stall-watchdog tests (ms). */
const NOW = 1_000_000;
/** Older than the 3-minute (180 000 ms) child staleness threshold. */
const STALE_AGE = 200_000;
/** Well inside the threshold. */
const FRESH_AGE = 10_000;

/** A `task` tool part that is still running and paired to `childSessionID`. */
function runningTaskPart(childSessionID: string, startedAt: number): any {
  return {
    type: "tool",
    tool: "task",
    state: { status: "running", metadata: { sessionId: childSessionID } },
    time: { start: startedAt },
  };
}

/** A plain text part whose only timestamp is `start`. */
function textPart(start: number): any {
  return { type: "text", text: "working", time: { start } };
}

/** A user message with one text part. */
function userMessage(text = "hello"): any {
  return { info: { role: "user" }, parts: [{ type: "text", text }] };
}

/** A token-bearing assistant message for the usage scan. */
function usageAssistant(opts: {
  input: number;
  cost?: number;
  summary?: boolean;
  cacheRead?: number;
  cacheWrite?: number;
  providerID?: string;
  modelID?: string;
}): any {
  return {
    info: {
      role: "assistant",
      summary: opts.summary,
      cost: opts.cost,
      providerID: opts.providerID ?? "anthropic",
      modelID: opts.modelID ?? "claude-sonnet",
      tokens: {
        input: opts.input,
        output: 0,
        cache: { read: opts.cacheRead ?? 0, write: opts.cacheWrite ?? 0 },
      },
    },
    parts: [],
  };
}

// ─── Reconciler Layer 4: pending tool calls ───

describe("hasPendingToolCalls (reconciler Layer 4 anyPending)", () => {
  test("no messages → no pending tool calls (original: msgs.some on [] is false)", () => {
    expect(hasPendingToolCalls([])).toBe(false);
  });

  test("only completed tool parts → no pending (original status check is pending|running only)", () => {
    const messages = [
      { parts: [{ type: "tool", state: { status: "completed" } }, { type: "text" }] },
    ];
    expect(hasPendingToolCalls(messages)).toBe(false);
  });

  test("error tool part → not pending (original does not count 'error' as pending)", () => {
    const messages = [{ parts: [{ type: "tool", state: { status: "error" } }] }];
    expect(hasPendingToolCalls(messages)).toBe(false);
  });

  test("a pending tool part → pending (original p.state.status === 'pending')", () => {
    const messages = [
      { parts: [{ type: "text" }] },
      { parts: [{ type: "tool", state: { status: "pending" } }] },
    ];
    expect(hasPendingToolCalls(messages)).toBe(true);
  });

  test("a running tool part → pending (original p.state.status === 'running')", () => {
    const messages = [{ parts: [{ type: "tool", state: { status: "running" } }] }];
    expect(hasPendingToolCalls(messages)).toBe(true);
  });

  test("message with no parts field → not pending (original m.parts ?? [])", () => {
    expect(hasPendingToolCalls([{}])).toBe(false);
  });

  test("tool part with no state → not pending (original p.state?.status optional chain)", () => {
    expect(hasPendingToolCalls([{ parts: [{ type: "tool" }] }])).toBe(false);
  });

  test("queryHasPendingToolCalls: getMessages undefined → not pending (original resp.data ?? [])", async () => {
    const { session, fetched } = fakeSession({ messages: { ses_a: undefined } });
    expect(await queryHasPendingToolCalls(session, "ses_a")).toBe(false);
    expect(fetched).toEqual(["ses_a"]);
  });

  test("queryHasPendingToolCalls: a running tool in the fetched messages → pending", async () => {
    const { session } = fakeSession({
      messages: { ses_a: [{ info: { role: "assistant" }, parts: [{ type: "tool", state: { status: "running" } }] }] },
    });
    expect(await queryHasPendingToolCalls(session, "ses_a")).toBe(true);
  });

  test("queryHasPendingToolCalls: getMessages rejects → rejects (original try/catch {} skips synthesis, so no pending verdict)", async () => {
    const { session } = fakeSession({ messages: { ses_a: new Error("network down") } });
    await expect(queryHasPendingToolCalls(session, "ses_a")).rejects.toThrow("network down");
  });
});

// ─── Running cost ───

describe("addAssistantCost (refreshTokenUsage running cost, per-message rule)", () => {
  test("sums only assistant messages onto the accumulator (original role === 'assistant' check)", () => {
    const messages = [
      { info: { role: "user", cost: 7 } },
      { info: { role: "assistant", cost: 2 } },
      { info: { role: "assistant", cost: 3 } },
    ];
    expect(addAssistantCost(0, messages)).toBe(5);
  });

  test("NaN, negative, zero and missing costs are ignored (original cost && !isNaN && cost >= 0)", () => {
    const messages = [
      { info: { role: "assistant", cost: 2 } },
      { info: { role: "assistant", cost: NaN } },
      { info: { role: "assistant", cost: -5 } },
      { info: { role: "assistant", cost: 0 } },
      { info: { role: "assistant" } },
      { info: { role: "assistant", cost: 3 } },
    ];
    expect(addAssistantCost(0, messages)).toBe(5);
  });

  test("adds onto a non-zero accumulator, preserving the original running total order", () => {
    expect(addAssistantCost(10, [{ info: { role: "assistant", cost: 4 } }])).toBe(14);
  });
});

// ─── Stall watchdog: newest assistant message ───

describe("scanLatestAssistantActivity (stall watchdog newest-assistant branches)", () => {
  test("no assistant message → null (original: assistants.length === 0 → return, no banner)", async () => {
    const result = await scanLatestAssistantActivity(
      [userMessage()],
      async () => {
        throw new Error("child fetch must not run");
      },
      NOW,
    );
    expect(result).toBeNull();
  });

  test("latest assistant completed → completed branch, no child lookup (original: completed != null → return)", async () => {
    const fetchCalls: string[] = [];
    // An earlier incomplete assistant carries a running task; only the newest assistant matters.
    const messages = [
      { info: { role: "assistant" }, parts: [textPart(NOW - STALE_AGE), runningTaskPart("ses_child", NOW - STALE_AGE)] },
      { info: { role: "assistant", time: { completed: NOW - 5 } }, parts: [textPart(NOW - 5)] },
    ];
    const result = await scanLatestAssistantActivity(
      messages,
      async (id) => {
        fetchCalls.push(id);
        return [];
      },
      NOW,
    );
    expect(result).toEqual({ hasContent: true, completedAt: NOW - 5, openChild: null });
    expect(fetchCalls).toEqual([]);
  });

  test("latest assistant with no parts and not completed → no-content branch (original: parts.length === 0 → banner)", async () => {
    const messages = [{ info: { role: "assistant" }, parts: [] }];
    const result = await scanLatestAssistantActivity(
      messages,
      async () => {
        throw new Error("child fetch must not run");
      },
      NOW,
    );
    expect(result).toEqual({ hasContent: false, completedAt: undefined, openChild: null });
  });

  test("latest assistant has content but last part is not a task call → no child lookup (original: findRunningTaskChildSessionID null → return)", async () => {
    const fetchCalls: string[] = [];
    const messages = [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW), textPart(NOW)] }];
    const result = await scanLatestAssistantActivity(
      messages,
      async (id) => {
        fetchCalls.push(id);
        return [];
      },
      NOW,
    );
    expect(result).toEqual({ hasContent: true, completedAt: undefined, openChild: null });
    expect(fetchCalls).toEqual([]);
  });

  test("running task whose child turn is stale → openChild.stale true (original isTurnStale on child newest)", async () => {
    const childMessages = [
      { info: { role: "assistant" }, parts: [textPart(NOW - STALE_AGE)] },
    ];
    const messages = [{ info: { role: "assistant" }, parts: [textPart(NOW - 1), runningTaskPart("ses_child", NOW - 1)] }];
    const result = await scanLatestAssistantActivity(messages, async () => childMessages, NOW);
    expect(result).toEqual({
      hasContent: true,
      completedAt: undefined,
      openChild: { sessionID: "ses_child", stale: true },
    });
  });

  test("running task whose child turn is fresh → openChild.stale false (original isTurnStale false → no banner)", async () => {
    const childMessages = [
      { info: { role: "assistant" }, parts: [textPart(NOW - FRESH_AGE)] },
    ];
    const messages = [{ info: { role: "assistant" }, parts: [textPart(NOW - 1), runningTaskPart("ses_child", NOW - 1)] }];
    const result = await scanLatestAssistantActivity(messages, async () => childMessages, NOW);
    expect(result).toEqual({
      hasContent: true,
      completedAt: undefined,
      openChild: { sessionID: "ses_child", stale: false },
    });
  });

  test("child newest exactly at the 180 000 ms threshold → stale (original isTurnStale uses now - newest >= threshold)", async () => {
    const childMessages = [{ info: { role: "assistant" }, parts: [textPart(NOW - 180_000)] }];
    const messages = [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }];
    const result = await scanLatestAssistantActivity(messages, async () => childMessages, NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: true });
  });

  test("child newest 1 ms inside the threshold → not stale (original isTurnStale boundary)", async () => {
    const childMessages = [{ info: { role: "assistant" }, parts: [textPart(NOW - 179_999)] }];
    const messages = [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }];
    const result = await scanLatestAssistantActivity(messages, async () => childMessages, NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });

  test("child has no assistant message → openChild with stale false (original childAssistants.length === 0 → return, no banner)", async () => {
    const childMessages = [userMessage("subagent prompt")];
    const messages = [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }];
    const result = await scanLatestAssistantActivity(messages, async () => childMessages, NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });

  test("child fetch resolves undefined → treated as no child messages, stale false (original resp.data ?? [])", async () => {
    const messages = [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }];
    const result = await scanLatestAssistantActivity(messages, async () => undefined, NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });
});

describe("queryLatestAssistantActivity (stall watchdog fetch wrapper)", () => {
  test("parent getMessages resolves undefined → null (original resp.data ?? [] then no assistant)", async () => {
    const { session } = fakeSession({ messages: { ses_parent: undefined } });
    expect(await queryLatestAssistantActivity(session, "ses_parent", NOW)).toBeNull();
  });

  test("running task with a stale child → fetches the child by its paired session ID and reports stale", async () => {
    const { session, fetched } = fakeSession({
      messages: {
        ses_parent: [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }],
        ses_child: [{ info: { role: "assistant" }, parts: [textPart(NOW - STALE_AGE)] }],
      },
    });
    const result = await queryLatestAssistantActivity(session, "ses_parent", NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: true });
    expect(fetched).toEqual(["ses_parent", "ses_child"]);
  });

  test("running task with a fresh child → openChild.stale false", async () => {
    const { session } = fakeSession({
      messages: {
        ses_parent: [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }],
        ses_child: [{ info: { role: "assistant" }, parts: [textPart(NOW - FRESH_AGE)] }],
      },
    });
    const result = await queryLatestAssistantActivity(session, "ses_parent", NOW);
    expect(result?.openChild).toEqual({ sessionID: "ses_child", stale: false });
  });

  test("child getMessages rejects → rejects, no banner decision (original outer catch { return } in the watchdog)", async () => {
    const { session } = fakeSession({
      messages: {
        ses_parent: [{ info: { role: "assistant" }, parts: [runningTaskPart("ses_child", NOW - 1)] }],
        ses_child: new Error("child gone"),
      },
    });
    await expect(queryLatestAssistantActivity(session, "ses_parent", NOW)).rejects.toThrow("child gone");
  });

  test("completed parent → child is never fetched (original: return before the child lookup)", async () => {
    const { session, fetched } = fakeSession({
      messages: {
        ses_parent: [
          { info: { role: "assistant", time: { completed: NOW - 1 } }, parts: [runningTaskPart("ses_child", NOW - 1)] },
        ],
      },
    });
    const result = await queryLatestAssistantActivity(session, "ses_parent", NOW);
    expect(result).toEqual({ hasContent: true, completedAt: NOW - 1, openChild: null });
    expect(fetched).toEqual(["ses_parent"]);
  });
});

// ─── refreshTokenUsage: token usage and running cost ───

describe("queryTokenUsage (refreshTokenUsage token usage and running cost)", () => {
  test("no post-summary assistant → null, and the children roll-up is skipped (original: result null → return before cost)", async () => {
    const { session, childrenCalls } = fakeSession({
      messages: {
        ses_parent: [usageAssistant({ input: 900, summary: true, cost: 9 })],
      },
      children: [{ id: "ses_child" }],
    });
    expect(await queryTokenUsage(session, "ses_parent")).toBeNull();
    expect(childrenCalls()).toBe(0);
  });

  test("token usage matches pickPostSummaryAssistantTokenUsage (summary boundary + cache tokens)", async () => {
    const messages = [
      usageAssistant({ input: 5000, summary: true, providerID: "old", modelID: "old-model" }),
      usageAssistant({ input: 1200, cacheRead: 300, cacheWrite: 50, providerID: "p", modelID: "m" }),
    ];
    const expected = pickPostSummaryAssistantTokenUsage(messages);
    const { session } = fakeSession({ messages: { ses_parent: messages }, children: [] });
    const result = await queryTokenUsage(session, "ses_parent");
    expect(result).toEqual({
      used: 1550,
      providerID: "p",
      modelID: "m",
      runningCost: 0,
    });
    expect(result).toMatchObject(expected as object);
  });

  test("parent-only cost sum: assistant costs summed, user cost ignored (original parent loop)", async () => {
    const messages = [
      { info: { role: "user", cost: 100 }, parts: [] },
      usageAssistant({ input: 10, cost: 0.5 }),
      usageAssistant({ input: 20, cost: 0.25 }),
    ];
    const { session } = fakeSession({ messages: { ses_parent: messages }, children: [] });
    const result = await queryTokenUsage(session, "ses_parent");
    expect(result?.runningCost).toBe(0.75);
  });

  test("parent + children sum: each child's assistant costs added after the parent's (original child loop)", async () => {
    const parent = [usageAssistant({ input: 10, cost: 1 })];
    const childA = [usageAssistant({ input: 1, cost: 2 })];
    const childB = [usageAssistant({ input: 1, cost: 4 })];
    const { session } = fakeSession({
      messages: { ses_parent: parent, ses_a: childA, ses_b: childB },
      children: [{ id: "ses_a" }, { id: "ses_b" }],
    });
    const result = await queryTokenUsage(session, "ses_parent");
    expect(result?.runningCost).toBe(7);
  });

  test("a child whose messages fetch rejects is skipped; other children still summed (original inner catch)", async () => {
    const { session } = fakeSession({
      messages: {
        ses_parent: [usageAssistant({ input: 10, cost: 1 })],
        ses_bad: new Error("child fetch failed"),
        ses_good: [usageAssistant({ input: 1, cost: 3 })],
      },
      children: [{ id: "ses_bad" }, { id: "ses_good" }],
    });
    const result = await queryTokenUsage(session, "ses_parent");
    expect(result?.runningCost).toBe(4);
  });

  test("children endpoint failing → parent-only cost, no throw (original outer catch)", async () => {
    const { session } = fakeSession({
      messages: { ses_parent: [usageAssistant({ input: 10, cost: 1.5 })] },
      children: new Error("children unavailable"),
    });
    const result = await queryTokenUsage(session, "ses_parent");
    expect(result).toEqual({ used: 10, providerID: "anthropic", modelID: "claude-sonnet", runningCost: 1.5 });
  });

  test("NaN, negative and zero costs are ignored in the parent and in children (original cost guard)", async () => {
    const { session } = fakeSession({
      messages: {
        ses_parent: [
          usageAssistant({ input: 10, cost: NaN }),
          usageAssistant({ input: 10, cost: -1 }),
          usageAssistant({ input: 10, cost: 0 }),
          usageAssistant({ input: 10, cost: 2 }),
        ],
        ses_child: [usageAssistant({ input: 1, cost: NaN }), usageAssistant({ input: 1, cost: 1 })],
      },
      children: [{ id: "ses_child" }],
    });
    const result = await queryTokenUsage(session, "ses_parent");
    expect(result?.runningCost).toBe(3);
  });

  test("parent getMessages rejects → rejects (original refreshTokenUsage outer catch swallows; query does not)", async () => {
    const { session } = fakeSession({ messages: { ses_parent: new Error("parent down") } });
    await expect(queryTokenUsage(session, "ses_parent")).rejects.toThrow("parent down");
  });
});

describe("addAssistantCost + queryTokenUsage ordering", () => {
  test("accumulator matches a single inline loop over parent then children (original float addition order)", () => {
    const parent = [{ info: { role: "assistant", cost: 0.1 } }];
    const child = [{ info: { role: "assistant", cost: 0.2 } }];
    // The original loop added 0.1 then 0.2 into one running total.
    let inline = 0;
    for (const m of [...parent, ...child]) {
      if (m.info.role === "assistant" && m.info.cost && !isNaN(m.info.cost) && m.info.cost >= 0) inline += m.info.cost;
    }
    expect(addAssistantCost(addAssistantCost(0, parent), child)).toBe(inline);
  });
});
