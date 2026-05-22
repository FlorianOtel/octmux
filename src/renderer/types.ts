import type { Block, Role } from "../blocks.ts";
import type { Visibility } from "./visibility.ts";

export interface Renderer {
  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void;
  appendToBlock(partID: string, text: string): void;
  endBlock(partID: string, status?: "ok" | "error"): void;
  commitUserInput(text: string): void;
  commitSystemMessage(text: string): void;
  commitError(message: string): void;
  // Called by app.tsx on session-idle: flush open tail + push 2-blank turn separator.
  commitTurnEnd(): void;
  dispose(): Promise<void>;
  rename(newLabel: string): void;
  readonly kind: "stdout" | "tmux-pane" | "tmux-window";
  readonly visibility: Visibility;
}
