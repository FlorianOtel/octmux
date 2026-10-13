import type { createOpencodeClient, SessionMessagesResponses } from "@opencode-ai/sdk/client";
import type { Renderer } from "./renderer/types.ts";
import type { Role } from "./blocks.ts";
import { LineEditor } from "./editor.ts";

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * One renderer or editor operation produced by translating a session's history.
 *
 * Why a dedicated union rather than `ReplEvent`: replay needs operations that `ReplEvent`
 * cannot express without distorting its meaning. Examples are committing a user-input line
 * (`ReplEvent` only has `foreign-user-turn`, which carries a messageID the history path
 * does not have), a turn-end commit (no `ReplEvent` equivalent), and seeding the editor's
 * up-arrow history. Each variant mirrors one renderer or editor call made by the old
 * `replaySession` body, so `applyHistory` can reproduce that call sequence exactly.
 *
 * Stage 15.2 (C2.1–2.2b): produced by `translateHistory` (pure) and consumed by `applyHistory`
 * (the only code here that touches the renderer or editor).
 */
export type HistoryOp =
  /** `renderer.commitUserInput(text)`. */
  | { op: "user-input"; text: string }
  /** `renderer.commitSystemMessage(text)`. Used for the "N earlier messages summarized" line. */
  | { op: "system-message"; text: string }
  /**
   * One complete block: `beginBlock`, then `appendToBlock` when `text` is present, then `endBlock`.
   * `meta` is passed to `beginBlock` only when present (a tool-call's `{ toolName }`); otherwise
   * `beginBlock` is called with two arguments, as before.
   */
  | {
      op: "block";
      partID: string;
      role: Role;
      meta?: { toolName: string };
      text?: string;
      status: "ok" | "error";
      /** Stage 15.2 (C2.6b): a non-zero shell exit, passed to `endBlock`. Set only by the v2 translator. */
      exitCode?: number;
    }
  /** `renderer.commitCompactionDivider(auto)`. */
  | { op: "compaction-divider"; auto: boolean }
  /** `renderer.commitTurnEnd()`, once per rendered assistant message. */
  | { op: "turn-end" }
  /** `editor.seedHistory(texts)`. Emitted last, and only when the translation completed without error. */
  | { op: "seed-history"; texts: string[] };

/**
 * Pure translation of a session's v1 message list into renderer/editor operations.
 *
 * This is the message→renderer logic that used to live inline in `replaySession`. The
 * branch order and every filter are unchanged, so the operations come out in the same
 * order the old code made its calls.
 *
 * Compaction awareness: when a summary message exists, pre-summary assistant messages are
 * collapsed into one indicator line, and the first summary message is rendered as a summary block.
 *
 * Error behaviour: the old code swallowed errors mid-loop, keeping whatever it had already
 * rendered, and skipped the final editor seed. This function does the same. On an error it
 * returns the operations produced so far, without a `seed-history` op.
 *
 * @param messages The v1 `session.messages` response data (`{ info, parts }[]`).
 * @returns The ordered operations. An empty message list gives `[]`.
 */
export function translateHistory(messages: SessionMessagesResponses[200]): HistoryOp[] {
  const ops: HistoryOp[] = [];

  // An empty or fresh session has no history to replay.
  if (messages.length === 0) return ops;

  try {
    // ─── Pass 1: find the first summary message and count pre-summary assistant messages ───
    let firstSummaryIdx = -1;
    let preSummaryAssistantCount = 0;
    for (let i = 0; i < messages.length; i++) {
      const info = messages[i].info;
      if (info.role === "assistant" && info.summary === true) {
        firstSummaryIdx = i;
        break;
      }
      if (info.role === "assistant") {
        preSummaryAssistantCount++;
      }
    }

    const userTexts: string[] = [];

    // ─── Pass 2: translate with compaction awareness ───
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      const info = msg.info;

      // ─── User message: extract text and emit user-input op ───
      if (info.role === "user") {
        const parts = msg.parts ?? [];
        const textParts: string[] = [];
        for (const p of parts) {
          // Filter synthetic/ignored parts to prevent system-reminder parts from
          // appearing in scrollback on session resume (mirrors guard in events.ts
          // for live SSE user message handling).
          if (p.type === "text" && p.text && p.synthetic !== true && p.ignored !== true) {
            textParts.push(p.text);
          }
        }
        const text = textParts.join("\n");
        if (text) {
          ops.push({ op: "user-input", text });
          userTexts.push(text);
        }
        continue;
      }

      // ─── Assistant message ───
      if (info.role === "assistant") {
        const parts = msg.parts ?? [];

        // Pre-summary assistant message: skip rendering (collapsed).
        // The summary message replaces these collapsed messages.
        if (firstSummaryIdx !== -1 && idx < firstSummaryIdx) {
          continue;
        }

        // The first summary message: rendered via the streaming pipeline (matches the live path).
        if (firstSummaryIdx !== -1 && idx === firstSummaryIdx) {
          // Emit collapse indicator if there were collapsed messages
          if (preSummaryAssistantCount > 0) {
            const suffix = preSummaryAssistantCount === 1 ? "" : "s";
            ops.push({
              op: "system-message",
              text: "[" + preSummaryAssistantCount + " earlier message" + suffix + " summarized — see compacted summary below]",
            });
          }

          // Summary text parts and compaction parts
          for (const p of parts) {
            if (p.type === "text" && p.text) {
              ops.push({ op: "block", partID: p.id, role: "summary", text: p.text, status: "ok" });
            } else if (p.type === "compaction") {
              const compPart = p as unknown as { type: "compaction"; auto?: boolean };
              ops.push({ op: "compaction-divider", auto: !!compPart.auto });
            }
          }
          ops.push({ op: "turn-end" });
          continue;
        }

        // Post-summary or no-compaction: normal rendering
        for (const p of parts) {
          // ─── Text part ───
          if (p.type === "text" && p.text) {
            ops.push({ op: "block", partID: p.id, role: "text", text: p.text, status: "ok" });
          }

          // ─── Reasoning (thinking) part ───
          else if (p.type === "reasoning" && p.text) {
            ops.push({ op: "block", partID: p.id, role: "thinking", text: p.text, status: "ok" });
          }

          // ─── Tool part ───
          else if (p.type === "tool") {
            // Use discriminated narrowing to access tool-specific fields
            const toolPart = p as unknown as {
              id: string;
              type: "tool";
              tool: string;
              state: { status: string; output?: string };
            };

            if (toolPart.state.status === "completed") {
              // Tool call block, then the tool result block when output exists
              ops.push({
                op: "block",
                partID: toolPart.id,
                role: "tool-call",
                meta: { toolName: toolPart.tool },
                status: "ok",
              });

              const output = toolPart.state.output ?? "";
              if (output) {
                ops.push({
                  op: "block",
                  partID: toolPart.id + "-result",
                  role: "tool-result",
                  text: output,
                  status: "ok",
                });
              }
            } else if (toolPart.state.status === "error") {
              // Tool error: tool-call block with error status, no result
              ops.push({
                op: "block",
                partID: toolPart.id,
                role: "tool-call",
                meta: { toolName: toolPart.tool },
                status: "error",
              });
            }
          }

          // ─── Compaction part (post-summary) ───
          else if (p.type === "compaction") {
            const compPart = p as unknown as { type: "compaction"; auto?: boolean };
            ops.push({ op: "compaction-divider", auto: !!compPart.auto });
          }

          // ─── Other part types (step-*, snapshot, patch, agent, retry, subtask, file) ───
          // Skipped entirely, as before.
        }

        // End turn after all parts
        ops.push({ op: "turn-end" });

        // An operator interrupt (Ctrl-C) aborts the message with this error name. The marker goes right after the
        // turn-end, and the check matches the live path (`src/events.ts`, the `parent-turn-end` reason "aborted").
        const infoErr = (info as unknown as { error?: { name?: string } }).error;
        if (infoErr?.name === "MessageAbortedError") {
          ops.push({ op: "system-message", text: "Interrupted" });
        }
      }
    }

    // Seed the editor history from the collected user texts
    if (userTexts.length > 0) {
      ops.push({ op: "seed-history", texts: userTexts });
    }
  } catch {
    // Silently swallow translation errors: replay is best-effort. The ops produced
    // before the error are kept; no seed-history op is added.
  }

  return ops;
}

/**
 * Fetches a session's message list and translates it into history operations.
 * Errors are swallowed and yield `[]`: replay is best-effort, not critical to startup.
 *
 * @param client    v1 SDK client.
 * @param sessionID Session to replay.
 */
export async function fetchHistory(client: Client, sessionID: string): Promise<HistoryOp[]> {
  try {
    const resp = await client.session.messages({ path: { id: sessionID } });
    return translateHistory(resp.data ?? []);
  } catch {
    return [];
  }
}

/**
 * Performs history operations against the renderer and editor, in order. This is the only
 * place that calls the renderer or editor for history replay.
 *
 * An error thrown by the renderer propagates to the caller, as before.
 *
 * @param renderer Renderer to drive.
 * @param editor   Editor whose up-arrow history is seeded.
 * @param ops      Operations from `translateHistory` or `fetchHistory`.
 */
export function applyHistory(
  renderer: Renderer,
  editor: Pick<LineEditor, "seedHistory">,
  ops: HistoryOp[],
): void {
  for (const op of ops) {
    switch (op.op) {
      case "user-input":
        renderer.commitUserInput(op.text);
        break;
      case "system-message":
        renderer.commitSystemMessage(op.text);
        break;
      case "block":
        // Two-argument beginBlock unless meta is present, matching the old call shapes exactly.
        if (op.meta !== undefined) {
          renderer.beginBlock(op.partID, op.role, op.meta);
        } else {
          renderer.beginBlock(op.partID, op.role);
        }
        if (op.text !== undefined) {
          renderer.appendToBlock(op.partID, op.text);
        }
        // Two-argument endBlock unless an exit code is present, so v1 history keeps the old call shape.
        if (op.exitCode !== undefined) {
          renderer.endBlock(op.partID, op.status, op.exitCode);
        } else {
          renderer.endBlock(op.partID, op.status);
        }
        break;
      case "compaction-divider":
        renderer.commitCompactionDivider(op.auto);
        break;
      case "turn-end":
        renderer.commitTurnEnd();
        break;
      case "seed-history":
        editor.seedHistory(op.texts);
        break;
    }
  }
}
