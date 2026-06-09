import type { createOpencodeClient } from "@opencode-ai/sdk/client";
import type { Renderer } from "./renderer/types.ts";
import { LineEditor } from "./editor.ts";

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * Replay the full message history of a session into the renderer and editor.
 *
 * On attach (--resume, --resume-last, --fork, /sessions picker, /fork), this
 * synthesises the prior conversation: text blocks + thinking blocks + tool blocks
 * become visible scrollback; the session title shows in the chrome label; user
 * prompts seed the LineEditor history for up-arrow recall.
 *
 * When a session has been compacted (contains a summary message), pre-summary
 * assistant messages are collapsed and replaced by a single indicator line plus
 * the summary block. User prompts are always visible (they seed the LLM via the
 * prompt template, not the message log).
 *
 * For fresh sessions or empty compacted message lists, this is a no-op (returns
 * immediately with zero side effects).
 */
export async function replaySession(
  client: Client,
  renderer: Renderer,
  sessionID: string,
  editor: LineEditor,
): Promise<void> {
  try {
    const resp = await client.session.messages({ path: { id: sessionID } });
    const messages = resp.data ?? [];

    if (messages.length === 0) {
      // Fresh session or empty — no history to replay
      return;
    }

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

    // ─── Pass 2: render with compaction awareness ───
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      const info = msg.info;

      // ─── User message: extract text and emit user-input block ───
      if (info.role === "user") {
        const parts = msg.parts ?? [];
        const textParts: string[] = [];
        for (const p of parts) {
          if (p.type === "text" && p.text) {
            textParts.push(p.text);
          }
        }
        const text = textParts.join("\n");
        if (text) {
          renderer.commitUserInput(text);
          userTexts.push(text);
        }
        continue;
      }

      // ─── Assistant message ───
      if (info.role === "assistant") {
        const parts = msg.parts ?? [];

        // Pre-summary assistant message: skip rendering (collapsed)
        if (firstSummaryIdx !== -1 && idx < firstSummaryIdx) {
          // Already counted in preSummaryAssistantCount; skip parts rendering.
          // The summary message replaces these collapsed messages.
          continue;
        }

        // The first summary message: render via streaming pipeline (matches live path)
        if (firstSummaryIdx !== -1 && idx === firstSummaryIdx) {
          // Emit collapse indicator if there were collapsed messages
          if (preSummaryAssistantCount > 0) {
            const suffix = preSummaryAssistantCount === 1 ? "" : "s";
            renderer.commitSystemMessage(
              "[" + preSummaryAssistantCount + " earlier message" + suffix + " summarized — see compacted summary below]",
            );
          }

          // Render summary text parts and compaction parts
          for (const p of parts) {
            if (p.type === "text" && p.text) {
              renderer.beginBlock(p.id, "summary");
              renderer.appendToBlock(p.id, p.text);
              renderer.endBlock(p.id, "ok");
            } else if (p.type === "compaction") {
              const compPart = p as unknown as { type: "compaction"; auto?: boolean };
              renderer.commitCompactionDivider(!!compPart.auto);
            }
          }
          renderer.commitTurnEnd();
          continue;
        }

        // Post-summary or no-compaction: normal rendering
        for (const p of parts) {
          // ─── Text part ───
          if (p.type === "text" && p.text) {
            renderer.beginBlock(p.id, "text");
            renderer.appendToBlock(p.id, p.text);
            renderer.endBlock(p.id, "ok");
          }

          // ─── Reasoning (thinking) part ───
          else if (p.type === "reasoning" && p.text) {
            renderer.beginBlock(p.id, "thinking");
            renderer.appendToBlock(p.id, p.text);
            renderer.endBlock(p.id, "ok");
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
              // Tool call block
              renderer.beginBlock(toolPart.id, "tool-call", {
                toolName: toolPart.tool,
              });
              renderer.endBlock(toolPart.id, "ok");

              // Tool result block (if output exists)
              const output = toolPart.state.output ?? "";
              if (output) {
                const resultPartID = toolPart.id + "-result";
                renderer.beginBlock(resultPartID, "tool-result");
                renderer.appendToBlock(resultPartID, output);
                renderer.endBlock(resultPartID, "ok");
              }
            } else if (toolPart.state.status === "error") {
              // Tool error: emit tool-call block with error status, no result
              renderer.beginBlock(toolPart.id, "tool-call", {
                toolName: toolPart.tool,
              });
              renderer.endBlock(toolPart.id, "error");
            }
          }

          // ─── Compaction part (post-summary) ───
          else if (p.type === "compaction") {
            const compPart = p as unknown as { type: "compaction"; auto?: boolean };
            renderer.commitCompactionDivider(!!compPart.auto);
          }

          // ─── Other part types (step-*, snapshot, patch, agent, retry, subtask, file) ───
          // Skip these entirely — out of scope for Stage 5.2
        }

        // End turn after all parts
        renderer.commitTurnEnd();
      }
    }

    // Seed the editor history from collected user texts
    if (userTexts.length > 0) {
      editor.seedHistory(userTexts);
    }
  } catch (err) {
    // Silently swallow errors — replay is best-effort, not critical to startup
  }
}
