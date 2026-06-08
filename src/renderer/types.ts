import type { Block, Role } from "../blocks.ts";
import type { Visibility } from "./visibility.ts";

export type CommittedLine = { id: number; role: Role; ansi: string };

export interface Renderer {
  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void;
  appendToBlock(partID: string, text: string): void;
  endBlock(partID: string, status?: "ok" | "error"): void;
  commitUserInput(text: string): void;
  commitSystemMessage(text: string): void;
  commitError(message: string): void;
  // Called by app.tsx on session-idle: flush open tail + push 2-blank turn separator.
  commitTurnEnd(): void;
  // Clear all committed lines and the active tail. Used on session switch.
  clearAll(): void;
  dispose(): Promise<void>;
  rename(newLabel: string): void;
  isOutputEnabled(key: string): boolean;
  setOutputEnabled(key: string, on: boolean): void;
  readonly kind: "stdout" | "tmux-window" | "block-buffer";
  readonly visibility: Visibility;
  // Multi-line active block accessors (renamed from getTail for BlockBufferRenderer)
  getCommitted(): CommittedLine[];
  getActiveBlock(): { role: Role; text: string } | null;
  getActiveBlockAnsi(): string;
  setWidth(width: number): void;
  setAvailableRows(rows: number): void;
}
