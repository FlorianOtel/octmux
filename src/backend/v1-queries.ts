/**
 * v1 session queries: pure scans over a session's message list, plus the thin
 * async wrappers `V1Backend.events` uses to fetch the messages first.
 *
 * Stage 15.2 (C2.1–2.2b): these scans used to be inline in `src/app.tsx`
 * (reconciler Layer 4, stall watchdog, `refreshTokenUsage`). They moved here
 * unchanged, so that the v2 backend can supply its own implementations behind
 * the same `BackendEvents` methods (PLAN-C2C3.md §B.3).
 *
 * Nothing in this file touches React, the renderer or the editor. The fetch
 * functions take a narrow `QuerySession` so they can be exercised with a fake.
 */

import type { BackendSession, LatestAssistantActivity, TokenUsageSummary } from "./types.ts";

/** The two session reads the queries need. `V1Backend.session` satisfies this. */
export type QuerySession = Pick<BackendSession, "getMessages" | "getChildren">;

type MessageForUsageScan = {
  info: {
    role?: string;
    summary?: boolean | unknown;
    providerID?: string;
    modelID?: string;
    tokens?: {
      input: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
};

/**
 * Stage 5.7.2: Pure helper for token usage scanning with forward-from-summary semantics.
 * Finds the last assistant message with info.summary === true, then scans forward
 * from that boundary for the latest non-summary assistant message with non-zero tokens.
 * If no post-summary assistant exists, falls back to the latest non-summary assistant
 * (mirroring pre-summary backward-walk behavior).
 *
 * @param messages Flat message list shaped after OC SDK Message type
 * @returns { used, providerID, modelID } | null
 */
export function pickPostSummaryAssistantTokenUsage(messages: MessageForUsageScan[]): { used: number; providerID: string | undefined; modelID: string | undefined } | null {
  const assistantMessages = messages.filter(m => m.info.role === "assistant");
  if (assistantMessages.length === 0) return null;

  // Find the last assistant message with summary === true
  let summaryIdx = -1;
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const info = assistantMessages[i].info;
    if (info.summary === true) {
      summaryIdx = i;
      break;
    }
  }

  // No summary exists — use backward-walk semantics (existing behavior)
  if (summaryIdx === -1) {
    // Find latest non-summary assistant message
    let latestIdx = -1;
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      if (assistantMessages[i].info.summary !== true) {
        latestIdx = i;
        break;
      }
    }

    if (latestIdx === -1) {
      // All assistants are summaries — return null
      return null;
    }

    // Get tokens from latest non-summary assistant
    const msg = assistantMessages[latestIdx];
    const tokens = msg.info.tokens;
    if (!tokens) return null;

    let used = tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
    // If zero tokens, scan backwards for most recent non-zero non-summary assistant
    if (used === 0) {
      for (let j = latestIdx - 1; j >= 0; j--) {
        const fallback = assistantMessages[j];
        if (fallback.info.summary === true) continue;
        const ft = fallback.info.tokens;
        if (!ft) continue;
        const fallbackUsed = ft.input + (ft.cache?.read ?? 0) + (ft.cache?.write ?? 0);
        if (fallbackUsed > 0) {
          used = fallbackUsed;
          break;
        }
      }
    }

    const fallbackModel = assistantMessages[latestIdx].info;
    return { used, providerID: fallbackModel.providerID, modelID: fallbackModel.modelID };
  }

  // Summary exists — scan forward from summaryIdx + 1
  const postSummaryMessages = assistantMessages.slice(summaryIdx + 1);
  if (postSummaryMessages.length === 0) return null;

  // Find the latest non-summary assistant in post-summary region
  let latestIdx = -1;
  for (let i = postSummaryMessages.length - 1; i >= 0; i--) {
    if (postSummaryMessages[i].info.summary !== true) {
      latestIdx = i;
      break;
    }
  }

  if (latestIdx === -1) {
    // All post-summary assistants are summaries — return null
    return null;
  }

  // Found a non-zero post-summary assistant
  const msg = postSummaryMessages[latestIdx];
  const tokens = msg.info.tokens;
  if (!tokens) return null;

  let used = tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  // If zero tokens, fall forward to most recent non-zero post-summary assistant
  if (used === 0) {
    for (let j = latestIdx - 1; j >= 0; j--) {
      if (postSummaryMessages[j].info.summary === true) continue;
      const ft = postSummaryMessages[j].info.tokens;
      if (!ft) continue;
      const fallbackUsed = ft.input + (ft.cache?.read ?? 0) + (ft.cache?.write ?? 0);
      if (fallbackUsed > 0) {
        used = fallbackUsed;
        break;
      }
    }
  }

  const postSummaryModel = postSummaryMessages[latestIdx].info;
  return { used, providerID: postSummaryModel.providerID, modelID: postSummaryModel.modelID };
}

type PartForStallCheck = {
  type?: string;
  tool?: string;
  state?: { status?: string; metadata?: { sessionId?: string } };
  time?: { start?: number; end?: number };
};

/**
 * Pure helper for the stall watchdog (2026-09-11 incident, see docs/StageN.md):
 * a harness turn can have non-empty `parts` (its own text plus the `task`
 * tool-call part itself) yet still be genuinely stalled, because a `task`
 * tool call stays `status: "running"` until the dispatched subagent's own
 * model stream produces a result — and that stream can go silent forever
 * with no further SSE event on the harness session (the subagent's session
 * is a separate SSE-event source). The plain "does the newest message have
 * any parts yet" check is blind to this case.
 *
 * Returns the subagent's session ID if the newest assistant message's LAST
 * part is a `task` tool call still in `running` state and already paired to
 * a child session, else null (not a task dispatch, already resolved, or not
 * paired yet — too early to judge).
 */
export function findRunningTaskChildSessionID(parts: PartForStallCheck[]): string | null {
  const last = parts[parts.length - 1];
  if (!last || last.type !== "tool" || last.tool !== "task") return null;
  if (last.state?.status !== "running") return null;
  return last.state.metadata?.sessionId ?? null;
}

/**
 * True if a turn shows no forward progress within `thresholdMs`: either it
 * has no parts at all, or the newest timestamp across all parts (`time.start`
 * / `time.end`, whichever is latest) is older than `now - thresholdMs`. A
 * `completed` turn is never stale.
 */
export function isTurnStale(
  parts: PartForStallCheck[],
  completedAt: number | null | undefined,
  now: number,
  thresholdMs: number,
): boolean {
  if (completedAt != null) return false;
  if (parts.length === 0) return true;
  let newest = 0;
  for (const p of parts) {
    if (p.time?.start) newest = Math.max(newest, p.time.start);
    if (p.time?.end) newest = Math.max(newest, p.time.end);
  }
  if (newest === 0) return true;
  return now - newest >= thresholdMs;
}

// ─── Reconciler Layer 4: pending tool calls ───

/** Minimal message shape for the pending-tool scan. */
type PendingScanMessage = {
  parts?: Array<{ type?: string; state?: { status?: string } }>;
};

/**
 * True if any message has a `tool` part still `pending` or `running`.
 * Moved verbatim from the reconciler's Layer 4 `anyPending` check in app.tsx.
 */
export function hasPendingToolCalls(messages: PendingScanMessage[]): boolean {
  return messages.some(m =>
    (m.parts ?? []).some(p =>
      p.type === "tool" &&
      (p.state?.status === "pending" || p.state?.status === "running")
    )
  );
}

/** Reconciler Layer 4 fetch wrapper: reads the messages, then runs `hasPendingToolCalls`. */
export async function queryHasPendingToolCalls(session: QuerySession, sessionID: string): Promise<boolean> {
  return hasPendingToolCalls((await session.getMessages(sessionID)) ?? []);
}

// ─── Running cost ───

/** Minimal message shape for the cost sum. */
type CostScanMessage = { info: { role?: string; cost?: number } };

/**
 * Adds the cost of every assistant message in `messages` onto `total`, in list order.
 * Missing, NaN and negative costs are skipped, as `refreshTokenUsage` did.
 *
 * `total` is an accumulator, not a fresh sum, so the floating-point addition order
 * matches the old inline loop (parent messages first, then each child in turn).
 */
export function addAssistantCost(total: number, messages: CostScanMessage[]): number {
  let sum = total;
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const cost = msg.info.cost;
      if (cost && !isNaN(cost) && cost >= 0) {
        sum += cost;
      }
    }
  }
  return sum;
}

/**
 * Token usage plus the running cost of the session and its direct children.
 * Moved from `refreshTokenUsage` in app.tsx.
 *
 * Returns `null` when there is no post-summary assistant usage. In that case the old code
 * skipped the cost roll-up entirely, and so does this. Child lookups are best-effort, as
 * before: a failed child listing or child fetch is skipped, and the parent's cost still counts.
 */
export async function queryTokenUsage(session: QuerySession, sessionID: string): Promise<TokenUsageSummary | null> {
  const messages = (await session.getMessages(sessionID)) ?? [];

  const result = pickPostSummaryAssistantTokenUsage(messages as MessageForUsageScan[]);
  if (!result) return null;

  // Sum parent assistant messages, then child sessions (one level deep).
  let runningCost = addAssistantCost(0, messages);
  try {
    const children = (await session.getChildren(sessionID)) ?? [];
    for (const child of children) {
      try {
        const childMessages = (await session.getMessages(child.id)) ?? [];
        runningCost = addAssistantCost(runningCost, childMessages);
      } catch {
        // Silently skip failed child session fetches
      }
    }
  } catch {
    // Silently skip if children endpoint is unavailable
  }

  return { used: result.used, providerID: result.providerID, modelID: result.modelID, runningCost };
}

// ─── Stall watchdog: newest assistant message ───

/** Minimal message shape for the stall scan. */
type StallScanMessage = {
  info: { role?: string; time?: { completed?: number | null } };
  parts?: PartForStallCheck[];
};

/** Threshold for judging a paired subagent's own turn stale (the watchdog's 3-minute window). */
const CHILD_STALL_THRESHOLD_MS = 180_000;

/**
 * Describes the newest assistant message for the stall watchdog.
 *
 * Moved from the watchdog effect in app.tsx. The branch order matches the old code: a
 * completed turn returns before any child lookup, so `openChild` is only set for an
 * incomplete turn that has content. The child fetch happens only in that case.
 *
 * @param messages          The session's message list.
 * @param fetchChildMessages Fetches a paired child session's messages (`undefined` means no data).
 * @param now               Current time in ms, used for the child staleness check.
 * @returns `null` if there is no assistant message. Otherwise the activity record.
 */
export async function scanLatestAssistantActivity(
  messages: StallScanMessage[],
  fetchChildMessages: (childSessionID: string) => Promise<StallScanMessage[] | undefined>,
  now: number,
): Promise<LatestAssistantActivity> {
  const assistants = messages.filter(m => m.info.role === "assistant");
  if (assistants.length === 0) return null;

  const newest = assistants[assistants.length - 1];
  const parts = newest.parts ?? [];
  const completedAt = newest.info.time?.completed;
  const hasContent = parts.length > 0;

  // Completed, or no parts yet: no child lookup is needed.
  if (completedAt != null || !hasContent) {
    return { hasContent, completedAt, openChild: null };
  }

  // Layer 2: the newest turn's last part may be a `task` call still blocking on a subagent.
  const childSessionID = findRunningTaskChildSessionID(parts);
  if (!childSessionID) {
    return { hasContent, completedAt, openChild: null };
  }

  const childMessages = (await fetchChildMessages(childSessionID)) ?? [];
  const childAssistants = childMessages.filter(m => m.info.role === "assistant");
  let stale = false;
  if (childAssistants.length > 0) {
    const childNewest = childAssistants[childAssistants.length - 1];
    const childCompleted = childNewest.info.time?.completed;
    stale = isTurnStale((childNewest.parts ?? []), childCompleted, now, CHILD_STALL_THRESHOLD_MS);
  }

  return { hasContent, completedAt, openChild: { sessionID: childSessionID, stale } };
}

/** Stall-watchdog fetch wrapper: reads the session's messages, then runs `scanLatestAssistantActivity`. */
export async function queryLatestAssistantActivity(
  session: QuerySession,
  sessionID: string,
  now: number,
): Promise<LatestAssistantActivity> {
  const messages = (await session.getMessages(sessionID)) ?? [];
  return scanLatestAssistantActivity(
    messages as StallScanMessage[],
    (childSessionID) => session.getMessages(childSessionID) as Promise<StallScanMessage[] | undefined>,
    now,
  );
}
