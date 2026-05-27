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

    const userTexts: string[] = [];

    // Iterate chronologically through all messages
    for (const msg of messages) {
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

      // ─── Assistant message: iterate parts ───
      if (info.role === "assistant") {
        const parts = msg.parts ?? [];

        // Compacted summary: emit system messages with [compacted summary] prefix
        if (info.summary === true) {
          const textParts: string[] = [];
          for (const p of parts) {
            if (p.type === "text" && p.text) {
              textParts.push(p.text);
            }
          }
          const fullText = textParts.join("\n");
          if (fullText) {
            const lines = fullText.split("\n");
            for (const line of lines) {
              renderer.commitSystemMessage("[compacted summary] " + line);
            }
          }
          renderer.commitTurnEnd();
          continue;
        }

        // Normal (non-compacted) message: iterate parts
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

          // ─── Other part types (step-*, snapshot, patch, agent, retry, compaction, subtask, file) ───
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
