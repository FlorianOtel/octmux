/**
 * v2 session reads: pure translators and scans over a v2 message list, plus the thin async wrappers
 * `V2Backend.events` uses to fetch the messages first.
 *
 * Stage 15.2 (C2.3b). Each function mirrors the v1 behaviour named in its comment, and says where v2
 * differs and why.
 *
 * Message shapes come from the SDK types in `@opencode/client` (`SessionMessageInfo`) and from
 * `docs/OpenCode-v2-protocol-capture.md` §5a. Nothing in this file touches React, the renderer or the editor.
 * The fetch functions take narrow fetcher callbacks, so the tests can drive them with fakes.
 */

import type { SessionMessageInfo } from "@opencode/client";
import type { HistoryOp, LatestAssistantActivity, TokenUsageSummary } from "./types.ts";

// ─── Stall watchdog helpers ───

/** Minimal part shape the stall check reads: the activity timestamps and the completion state. */
type PartForStallCheck = {
  type?: string;
  tool?: string;
  state?: { status?: string; metadata?: { sessionId?: string } };
  time?: { start?: number; end?: number };
};

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

/** Threshold for judging a paired subagent's own turn stale (the watchdog's 3-minute window). */
export const CHILD_STALL_THRESHOLD_MS = 180_000;

// ─── Fetcher shapes ───

/**
 * Fetches one session's full message list, oldest first. Resolves `undefined` on an error status.
 * `V2Backend.fetchMessages` satisfies this.
 */
export type FetchMessagesV2 = (sessionID: string) => Promise<SessionMessageInfo[] | undefined>;

/**
 * Fetches a session's direct child sessions. Only `id` is read. Resolves `undefined` on an error status.
 * `V2Backend.fetchChildren` satisfies this.
 */
export type FetchChildrenV2 = (sessionID: string) => Promise<Array<{ id: string }> | undefined>;

// ─── Derived SDK types ───

/** The v2 assistant message: one per model step (capture §4.3, §5a). */
type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>;

/** One content item of an assistant message: `text`, `reasoning` or `tool` (capture §5a). */
type AssistantContentItem = AssistantMessage["content"][number];

/** A `tool` content item (capture §4.4, §5a). */
type ToolItem = Extract<AssistantContentItem, { type: "tool" }>;

/** The v2 compaction message in any status (capture §4.12). */
type CompactionMessage = Extract<SessionMessageInfo, { type: "compaction" }>;

/** A compaction message whose `status` is `completed`. Only this kind carries a usable summary. */
type CompletedCompaction = Extract<CompactionMessage, { status: "completed" }>;

/**
 * Structural shape of one tool-result content item. Only `text` items are read. v1 has a single
 * output string, so the text items are joined into one. File items are not rendered.
 */
type ToolContentLike = { type: string; text?: string };

// ─── Shared helpers ───

/** True for a compaction message that has finished and carries a summary (capture §4.12, §5a). */
function isCompletedCompaction(message: SessionMessageInfo): message is CompletedCompaction {
  return message.type === "compaction" && message.status === "completed";
}

/** Index of the first completed compaction, or -1. The history translator uses this (v1: first summary). */
function findFirstCompletedCompactionIdx(messages: SessionMessageInfo[]): number {
  return messages.findIndex(isCompletedCompaction);
}

/**
 * Index of the last completed compaction, or -1. The token scan uses this (v1: last summary, in
 * `pickPostSummaryAssistantTokenUsage`).
 */
function findLastCompletedCompactionIdx(messages: SessionMessageInfo[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompletedCompaction(messages[i])) return i;
  }
  return -1;
}

/** The newest assistant message (the list is oldest first), or `undefined` when there is none. */
function lastAssistant(messages: SessionMessageInfo[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "assistant") return message;
  }
  return undefined;
}

/**
 * The text of a tool's result content, joined in order. Non-text items are skipped.
 * The items are joined with no separator. Capture §4.4 shows a shell result as two text items:
 * the command output, which ends in a newline, then `Exited with code N`.
 */
function toolOutputText(content: ReadonlyArray<ToolContentLike> | undefined): string {
  return (content ?? []).flatMap((item) => (item.type === "text" && item.text ? [item.text] : [])).join("");
}

// ─── History translation ───

/**
 * Pure translation of a v2 message list into renderer/editor operations. The output has the same
 * `HistoryOp` kinds that v1 produces for the same kinds of content, and `applyHistory` consumes it unchanged.
 *
 * Item-by-item mapping (capture §5a, §4.4, §4.8, §4.12). Each rule notes the v1 branch it mirrors.
 *
 * - `user` (`text`): `user-input` when the text is non-empty. The text is also collected for `seed-history`.
 *   v1: user text parts.
 * - `assistant`: for each `content` item, in index order:
 *   - `text`: `block` role `text`, partID `${assistantID}:${index}`. Skipped when empty.
 *   - `reasoning`: `block` role `thinking`, same partID scheme. Skipped when empty.
 *   - `tool` `completed`: `block` role `tool-call` (partID = call `id`, `meta.toolName` = `name`, status ok),
 *     then `block` role `tool-result` (partID `${callID}-result`) when the joined text is non-empty.
 *   - `tool` `error`: `block` role `tool-call` with status `error`. No result block. Covers permission
 *     rejections and aborts (capture §4.4).
 *   - `tool` `streaming` or `running`: nothing. v1 skips non-completed, non-error tool parts too.
 *   - After the content items, one `turn-end`. v1 emits one `turn-end` per assistant message.
 * - `compaction`, `completed` only (capture §4.12):
 *   - The first completed compaction is the summary boundary, as v1's first summary message is. Assistant
 *     messages before it are not rendered. If there were any, a `system-message` with the same wording as v1
 *     ("[N earlier messages summarized — see compacted summary below]") comes first.
 *   - The boundary compaction gives a `block` role `summary` (partID `${compactionID}:summary`) when `summary`
 *     is non-empty. Later completed compactions give role `text`, as v1 renders a later summary message as
 *     normal text.
 *   - Then `compaction-divider` with `auto` set when `reason === "auto"`, then `turn-end`. v1's summary
 *     message does both.
 *   - `running` and `failed` compactions give nothing. v1 has no equivalent in the message list.
 * - `idle`: only `outcome` `interrupted` renders, as one `system-message` "Interrupted" after the turn's `turn-end`.
 *   The turn end is already marked by the assistant message, so the marker follows it. v1 writes the same marker in
 *   the normal-rendering branch of v1 when the assistant message's error is `MessageAbortedError`.
 *   `succeeded` and `failed` give nothing. An idle item is never selected by
 *   `translateMissedHistoryV2` (`isCompleteRenderable` is false for it), so the marker appears only on a full replay,
 *   not on a resync. That is a documented limit.
 * - `shell`, `model-switched`, `agent-switched`, `location-switched`, `system`, `skill`, `synthetic`: nothing.
 *   None of these has a v1 message-list equivalent, and v1's translator never renders them.
 *
 * Error behaviour: an error mid-translation keeps the operations produced so far and skips `seed-history`.
 *
 * ASSUMPTION (live check in C2): the block ids for text and reasoning use the content index as the ordinal,
 * `${assistantMessageID}:${index}`. The live translator (C2.4) must key its parts the same way, or a resync
 * replays blocks the live path cannot match.
 *
 * A completed shell tool with `metadata.exit` other than 0 is rendered `ok`, with `exitCode` set on its
 * tool-call block op (Stage 15.2, C2.6b). The `Exited with code N` text also stays in the result block.
 *
 * The `include` predicate (Stage 15.2, D-A fix) limits the output to some items. The boundary and the collapse count
 * are still worked out from the whole list, so a partial translation matches a full one. Items it rejects give no
 * operations and no `seed-history` text. `translateMissedHistoryV2` uses it. The default includes every item.
 *
 * @param messages The v2 message list, oldest first.
 * @param include  Which items to render. Defaults to all of them.
 * @returns The ordered operations. An empty message list gives `[]`.
 */
export function translateHistoryV2(
  messages: SessionMessageInfo[],
  include: (message: SessionMessageInfo) => boolean = () => true,
): HistoryOp[] {
  const ops: HistoryOp[] = [];

  // An empty or fresh session has no history to replay.
  if (messages.length === 0) return ops;

  try {
    // ─── Pass 1: find the summary boundary and count the assistant messages it collapses ───
    const boundaryIdx = findFirstCompletedCompactionIdx(messages);
    const preBoundaryAssistantCount =
      boundaryIdx === -1 ? 0 : messages.slice(0, boundaryIdx).filter((m) => m.type === "assistant").length;

    const userTexts: string[] = [];

    // ─── Pass 2: translate each item, in list order ───
    for (let idx = 0; idx < messages.length; idx++) {
      const message = messages[idx];

      // ─── User item: its text is a top-level field (capture §5a) ───
      if (message.type === "user") {
        if (!include(message)) continue;
        if (message.text) {
          ops.push({ op: "user-input", text: message.text });
          userTexts.push(message.text);
        }
        continue;
      }

      // ─── Assistant item ───
      if (message.type === "assistant") {
        // Collapsed by the summary boundary: nothing is rendered, and no turn-end is emitted (as in v1).
        if (boundaryIdx !== -1 && idx < boundaryIdx) continue;
        if (!include(message)) continue;

        appendAssistantOps(ops, message);
        ops.push({ op: "turn-end" });
        continue;
      }

      // ─── Completed compaction item (capture §4.12, §5a) ───
      if (isCompletedCompaction(message)) {
        if (!include(message)) continue;
        const isBoundary = idx === boundaryIdx;
        // The collapse indicator comes before the summary, and only at the boundary, as in v1.
        if (isBoundary && preBoundaryAssistantCount > 0) {
          const suffix = preBoundaryAssistantCount === 1 ? "" : "s";
          ops.push({
            op: "system-message",
            text: "[" + preBoundaryAssistantCount + " earlier message" + suffix + " summarized — see compacted summary below]",
          });
        }
        if (message.summary) {
          ops.push({
            op: "block",
            partID: `${message.id}:summary`,
            role: isBoundary ? "summary" : "text",
            text: message.summary,
            status: "ok",
          });
        }
        ops.push({ op: "compaction-divider", auto: message.reason === "auto" });
        ops.push({ op: "turn-end" });
        continue;
      }

      // ─── Idle item (capture §4.8): only an interrupted turn renders, as the "Interrupted" marker ───
      if (message.type === "idle") {
        // Collapsed by the summary boundary, as the assistant before it is. v1 skips a pre-summary message whole.
        if (boundaryIdx !== -1 && idx < boundaryIdx) continue;
        if (!include(message)) continue;
        if (message.outcome === "interrupted") ops.push({ op: "system-message", text: "Interrupted" });
        continue;
      }

      // Every other item type (running or failed compaction, shell, model-switched, and so on):
      // no operation. See the rules in the doc comment above.
    }

    // Seed the editor history from the collected user texts.
    if (userTexts.length > 0) {
      ops.push({ op: "seed-history", texts: userTexts });
    }
  } catch {
    // Swallow translation errors. The operations produced so far are kept.
  }

  return ops;
}

/**
 * Appends the operations for one assistant message's content items, in index order. The turn-end is
 * added by the caller, once for the whole message.
 *
 * @param ops     Operation list to append to.
 * @param message The assistant message to render.
 */
function appendAssistantOps(ops: HistoryOp[], message: AssistantMessage): void {
  for (let index = 0; index < message.content.length; index++) {
    const item = message.content[index];
    // Text and reasoning blocks are keyed by assistant message ID and content index (see the ASSUMPTION above).
    const partID = `${message.id}:${index}`;

    if (item.type === "text") {
      if (item.text) ops.push({ op: "block", partID, role: "text", text: item.text, status: "ok" });
    } else if (item.type === "reasoning") {
      if (item.text) ops.push({ op: "block", partID, role: "thinking", text: item.text, status: "ok" });
    } else if (item.type === "tool") {
      appendToolOps(ops, item);
    }
  }
}

/**
 * Appends the operations for one `tool` content item. Only the `completed` and `error` states render,
 * as in v1. A tool in `streaming` or `running` state renders nothing.
 *
 * @param ops  Operation list to append to.
 * @param item The tool content item.
 */
function appendToolOps(ops: HistoryOp[], item: ToolItem): void {
  if (item.state.status === "completed") {
    // Tool call block, then the tool result block when the output is non-empty. A non-zero shell exit
    // (`metadata.exit`) sets `exitCode` on the call block, as the live translator does (v2-events.ts succeedTool).
    const exit = item.state.metadata?.exit;
    const exitCode = typeof exit === "number" && exit !== 0 ? exit : undefined;
    ops.push({
      op: "block",
      partID: item.id,
      role: "tool-call",
      meta: { toolName: item.name },
      status: "ok",
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    const output = toolOutputText(item.state.content);
    if (output) {
      ops.push({ op: "block", partID: `${item.id}-result`, role: "tool-result", text: output, status: "ok" });
    }
  } else if (item.state.status === "error") {
    // Tool error: tool-call block with error status, no result. Covers rejection and abort (capture §4.4).
    ops.push({ op: "block", partID: item.id, role: "tool-call", meta: { toolName: item.name }, status: "error" });
  }
}

/**
 * Fetches a session's message list and translates it.
 * Errors are swallowed and yield `[]`, because replay is best-effort.
 *
 * @param fetchMessages Fetches the session's message list.
 * @param sessionID     Session to replay.
 * @param onFetched     Called with the list that was fetched, before it is translated. `V2Backend` uses it to record
 *                      every returned message as rendered (Stage 15.2, D-A fix). Not called when the fetch fails.
 */
export async function fetchHistoryV2(
  fetchMessages: FetchMessagesV2,
  sessionID: string,
  onFetched?: (messages: SessionMessageInfo[]) => void,
): Promise<HistoryOp[]> {
  try {
    const fetched = await fetchMessages(sessionID);
    // An error status resolves `undefined`. Nothing was fetched then, so `onFetched` is not called.
    if (fetched !== undefined) onFetched?.(fetched);
    return translateHistoryV2(fetched ?? []);
  } catch {
    return [];
  }
}

// ─── Missed history (Stage 15.2, D-A fix): the resync renders only what the live stream did not ───

/**
 * True when an assistant message has ended, for whatever reason. Three signals count (capture doc §4.3, §4.8, §5a):
 *
 * - `time.completed` is set. A normal finish, and also a step that failed or was aborted after it was written
 *   (capture §5a, the capture 3b aborted item and the capture 3 failed item both carry it).
 * - `finish` is set to a non-empty value. The step has a finish reason, so the model has stopped writing to it.
 * - `error` is set. A failed or aborted step always carries its error (capture §5a).
 *
 * The caller adds a fourth signal, `laterIdle`. An interrupted step can end with no `time.completed`, no `finish` and
 * no `error` (the capture 3 retry-loop interrupt, §5a). Its turn still ends with an `idle` item after it, and that
 * idle is the proof the message is over.
 *
 * An in-flight message has none of these signals, so it is still not complete, and its live frames render it.
 *
 * @param message   An assistant message from the list.
 * @param laterIdle True when an `idle` item comes after this message in the list.
 */
function isAssistantEnded(message: AssistantMessage, laterIdle: boolean): boolean {
  if (message.time.completed !== undefined) return true;
  if (message.finish) return true;
  if (message.error !== undefined && message.error !== null) return true;
  return laterIdle;
}

/**
 * True for the item kinds that can render, once they are complete. A user item renders at once. An assistant message
 * must have ended (`isAssistantEnded`), because an in-flight one is still being streamed, and its live frames render it.
 * A compaction renders only when `completed`, since `running` and `failed` give nothing (see `translateHistoryV2`).
 * Every other kind never renders, so it is never selected.
 *
 * @param message   One item of the message list.
 * @param laterIdle True when an `idle` item comes after this message in the list. Only assistant messages read it.
 */
function isCompleteRenderable(message: SessionMessageInfo, laterIdle: boolean): boolean {
  if (message.type === "user") return true;
  if (message.type === "assistant") return isAssistantEnded(message, laterIdle);
  if (message.type === "compaction") return message.status === "completed";
  return false;
}

/**
 * Translates only the messages the live stream missed. Pure. A message is selected when it is complete
 * (`isCompleteRenderable`) and `isRendered` says the renderer does not show it yet. The operations come from
 * `translateHistoryV2`, restricted to the selected items. `renderedIDs` lists the selected ids, so the caller can
 * record them as rendered.
 *
 * An in-flight assistant message is not selected and not recorded. Its live frames still render it, or, if the
 * frames were lost in the gap, a later resync renders it once it completes.
 *
 * @param messages   The v2 message list, oldest first.
 * @param isRendered True when the renderer already shows this item (see `V2EventTranslator.isRendered`).
 * @returns The operations for the missed items, and the ids of those items.
 */
export function translateMissedHistoryV2(
  messages: SessionMessageInfo[],
  isRendered: (message: SessionMessageInfo) => boolean,
): { ops: HistoryOp[]; renderedIDs: string[] } {
  // First, from the end: whether an `idle` item comes after each position. Then, in list order, the selection.
  // The list order matters, because `renderedIDs` keeps it.
  const idleAfter: boolean[] = new Array(messages.length).fill(false);
  let seenIdle = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    idleAfter[i] = seenIdle;
    if (messages[i].type === "idle") seenIdle = true;
  }

  const selected = new Set<SessionMessageInfo>();
  messages.forEach((message, i) => {
    if (isCompleteRenderable(message, idleAfter[i]) && !isRendered(message)) selected.add(message);
  });
  return {
    ops: translateHistoryV2(messages, (message) => selected.has(message)),
    renderedIDs: [...selected].map((message) => message.id),
  };
}

/**
 * Fetches a session's message list and translates the missed part of it. Errors are swallowed and yield no operations,
 * as `fetchHistoryV2` does. A failed fetch records nothing, so the next resync tries again.
 *
 * @param fetchMessages Fetches the session's message list.
 * @param sessionID     Session to resync.
 * @param isRendered    See `translateMissedHistoryV2`.
 */
export async function fetchMissedHistoryV2(
  fetchMessages: FetchMessagesV2,
  sessionID: string,
  isRendered: (message: SessionMessageInfo) => boolean,
): Promise<{ ops: HistoryOp[]; renderedIDs: string[] }> {
  try {
    return translateMissedHistoryV2((await fetchMessages(sessionID)) ?? [], isRendered);
  } catch {
    return { ops: [], renderedIDs: [] };
  }
}

// ─── Reconciler Layer 4: pending tool calls ───

/**
 * True if the latest assistant message has a `tool` content item that is neither `completed` nor `error`,
 * so it is `streaming` or `running` (capture §4.4).
 *
 * DIVERGENCE from v1: v1's pending-tool-call check scans every message. This scans only the latest
 * assistant message, as the brief for this step required. A v2 tool that never resolves in an earlier message
 * would hold v1's guard closed for ever, so v2 does not count it.
 *
 * @param messages The v2 message list, oldest first.
 */
export function hasPendingToolCallsV2(messages: SessionMessageInfo[]): boolean {
  const latest = lastAssistant(messages);
  if (!latest) return false;
  return latest.content.some(
    (item) => item.type === "tool" && item.state.status !== "completed" && item.state.status !== "error",
  );
}

/** Fetch wrapper: reads the messages, then runs `hasPendingToolCallsV2`. */
export async function queryHasPendingToolCallsV2(fetchMessages: FetchMessagesV2, sessionID: string): Promise<boolean> {
  return hasPendingToolCallsV2((await fetchMessages(sessionID)) ?? []);
}

// ─── Stall watchdog: newest assistant message ───

/**
 * The newest `subagent` tool call that is still `running` and carries a child session ID in its metadata,
 * or `null` (capture §4.9: the parent-side link is `metadata.sessionID` on the running call).
 *
 * This searches from the end of the content list, so that a parallel call (capture §4.4) is found even
 * when another tool comes after it. v1 checks only the last part (`findRunningTaskChildSessionID`).
 *
 * ASSUMPTION (live check in C2): the running state of a stored `subagent` item keeps `metadata.sessionID`.
 * The captured stored items were all completed (capture §4.9).
 */
function findRunningSubagentSessionID(content: AssistantContentItem[]): string | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const item = content[i];
    if (item.type !== "tool" || item.name !== "subagent" || item.state.status !== "running") continue;
    const sessionID = item.state.metadata?.sessionID;
    if (typeof sessionID === "string") return sessionID;
  }
  return null;
}

/**
 * True if a child session's newest assistant turn has shown no progress for `CHILD_STALL_THRESHOLD_MS`.
 *
 * The "latest activity" time is the newest of the message's own timestamps and the timestamps of its content
 * items. v2 `text` items carry no time (capture §5a), so the message timestamps are needed to avoid judging a
 * text-only turn stale too early. An empty content list is stale, as in v1 (`isTurnStale` with no parts).
 */
function isChildTurnStale(child: AssistantMessage, now: number): boolean {
  const timestamps: Array<number | undefined> = [child.time.created, child.time.streamed, child.time.completed];
  for (const item of child.content) {
    if (item.type === "tool") {
      timestamps.push(item.time.created, item.time.ran, item.time.completed);
    } else if (item.type === "reasoning") {
      timestamps.push(item.time?.created, item.time?.completed);
    }
  }
  let newest = 0;
  for (const value of timestamps) {
    if (value !== undefined && value > newest) newest = value;
  }
  const parts = child.content.length === 0 ? [] : [{ time: { start: newest } }];
  return isTurnStale(parts, child.time.completed, now, CHILD_STALL_THRESHOLD_MS);
}

/**
 * Describes the newest assistant message for the stall watchdog. The v2 counterpart of v1's
 * `scanLatestAssistantActivity`, with the same branch order:
 *
 * - No assistant message gives `null`.
 * - A completed message, or one with no content, returns at once. No child lookup is made.
 * - Otherwise a running `subagent` call with a child session ID sets `openChild`. Its `stale` flag comes from
 *   the child's newest assistant message. A child with no assistant message is not stale, as in v1.
 *
 * @param messages           The session's message list, oldest first.
 * @param fetchChildMessages Fetches a child session's message list (`undefined` means no data).
 * @param now                Current time in ms, used for the child staleness check.
 */
export async function scanLatestAssistantActivityV2(
  messages: SessionMessageInfo[],
  fetchChildMessages: (childSessionID: string) => Promise<SessionMessageInfo[] | undefined>,
  now: number,
): Promise<LatestAssistantActivity> {
  const newest = lastAssistant(messages);
  if (!newest) return null;

  const hasContent = newest.content.length > 0;
  const completedAt = newest.time.completed;

  // Completed, or no content yet: no child lookup is needed.
  if (completedAt != null || !hasContent) {
    return { hasContent, completedAt, openChild: null };
  }

  const childSessionID = findRunningSubagentSessionID(newest.content);
  if (!childSessionID) {
    return { hasContent, completedAt, openChild: null };
  }

  const childMessages = (await fetchChildMessages(childSessionID)) ?? [];
  const childNewest = lastAssistant(childMessages);
  const stale = childNewest ? isChildTurnStale(childNewest, now) : false;
  return { hasContent, completedAt, openChild: { sessionID: childSessionID, stale } };
}

/** Stall-watchdog fetch wrapper: reads the messages, then runs `scanLatestAssistantActivityV2`. */
export async function queryLatestAssistantActivityV2(
  fetchMessages: FetchMessagesV2,
  sessionID: string,
  now: number,
): Promise<LatestAssistantActivity> {
  const messages = (await fetchMessages(sessionID)) ?? [];
  return scanLatestAssistantActivityV2(messages, fetchMessages, now);
}

// ─── Token usage and running cost ───

/** The context size one assistant message reports: input plus cache read plus cache write. Mirrors v1. */
function usedTokensOf(tokens: { input: number; cache: { read: number; write: number } }): number {
  return tokens.input + tokens.cache.read + tokens.cache.write;
}

/**
 * The context size of the newest assistant message after the summary boundary, with its model.
 * The v2 counterpart of v1's `pickPostSummaryAssistantTokenUsage`.
 *
 * The boundary is the LAST completed compaction (capture §4.12), as v1's last summary is. With no boundary,
 * the whole list counts. The newest assistant after the boundary is used. If its usage is zero, the most recent
 * earlier assistant after the boundary with non-zero usage is used. The model always comes from the newest
 * assistant, as in v1.
 *
 * Returns `null` when no assistant follows the boundary, or when the newest one has no `tokens` (a failed
 * step has `tokens: null`, capture §5a).
 *
 * @param messages The v2 message list, oldest first.
 */
export function pickPostCompactionAssistantTokenUsageV2(
  messages: SessionMessageInfo[],
): { used: number; providerID: string | undefined; modelID: string | undefined } | null {
  const boundaryIdx = findLastCompletedCompactionIdx(messages);
  const region = messages
    .slice(boundaryIdx + 1)
    .filter((m): m is AssistantMessage => m.type === "assistant");
  if (region.length === 0) return null;

  const latest = region[region.length - 1];
  if (!latest.tokens) return null;

  let used = usedTokensOf(latest.tokens);
  // A zero-usage newest assistant falls back to the most recent earlier non-zero one, as in v1.
  if (used === 0) {
    for (let j = region.length - 2; j >= 0; j--) {
      const tokens = region[j].tokens;
      if (!tokens) continue;
      const fallbackUsed = usedTokensOf(tokens);
      if (fallbackUsed > 0) {
        used = fallbackUsed;
        break;
      }
    }
  }

  return { used, providerID: latest.model.providerID, modelID: latest.model.id };
}

/**
 * Adds the cost of every assistant message in `messages` onto `total`, in list order. Missing, NaN and
 * negative costs are skipped, as in v1's `addAssistantCost`. The check `cost &&` also skips zero. The
 * accumulator form keeps the floating-point order the same as v1.
 *
 * Compaction items are not counted. v1 counts its summary message, which is an assistant, but the v2 compaction
 * item is not one. Capture §4.3 and §4.12 saw cost 0 everywhere, so this has not been checked against a live
 * non-zero cost. Flagged in the C2 report.
 */
export function addAssistantCostV2(total: number, messages: SessionMessageInfo[]): number {
  let sum = total;
  for (const message of messages) {
    if (message.type === "assistant") {
      const cost = message.cost;
      if (cost && !isNaN(cost) && cost >= 0) sum += cost;
    }
  }
  return sum;
}

/**
 * Token usage plus the running cost of the session and its direct children. The v2 counterpart of
 * v1's `queryTokenUsage`, with the same rules:
 *
 * - No post-boundary usage gives `null`, and the cost roll-up is skipped.
 * - The parent's assistant costs come first, then each direct child's, one level deep (P3, capture §4.9).
 * - A child whose messages cannot be fetched is skipped. A children listing that fails leaves the parent's
 *   cost on its own. Only the child-level failures are swallowed here, as in v1.
 *
 * @param fetchMessages Fetches a session's message list.
 * @param fetchChildren Fetches a session's direct children.
 * @param sessionID     The session to report on.
 */
export async function queryTokenUsageV2(
  fetchMessages: FetchMessagesV2,
  fetchChildren: FetchChildrenV2,
  sessionID: string,
): Promise<TokenUsageSummary | null> {
  const messages = (await fetchMessages(sessionID)) ?? [];

  const result = pickPostCompactionAssistantTokenUsageV2(messages);
  if (!result) return null;

  // Sum parent assistant messages, then child sessions (one level deep).
  let runningCost = addAssistantCostV2(0, messages);
  try {
    const children = (await fetchChildren(sessionID)) ?? [];
    for (const child of children) {
      try {
        const childMessages = (await fetchMessages(child.id)) ?? [];
        runningCost = addAssistantCostV2(runningCost, childMessages);
      } catch {
        // Silently skip failed child session fetches, as v1 does.
      }
    }
  } catch {
    // Silently skip if the children endpoint is unavailable, as v1 does.
  }

  return { used: result.used, providerID: result.providerID, modelID: result.modelID, runningCost };
}
