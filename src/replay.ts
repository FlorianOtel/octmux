import type { Renderer } from "./renderer/types.ts";
import type { Role } from "./blocks.ts";
import { LineEditor } from "./editor.ts";

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
 * Stage 15.2 (C2.1–2.2b): produced by `translateHistoryV2` (`src/backend/v2-queries.ts`, pure)
 * and consumed by `applyHistory`
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
 * Performs history operations against the renderer and editor, in order. This is the only
 * place that calls the renderer or editor for history replay.
 *
 * An error thrown by the renderer propagates to the caller, as before.
 *
 * @param renderer Renderer to drive.
 * @param editor   Editor whose up-arrow history is seeded.
 * @param ops      Operations from `translateHistoryV2` (`src/backend/v2-queries.ts`).
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
