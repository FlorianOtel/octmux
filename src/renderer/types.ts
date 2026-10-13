import type { Block, Role } from "../blocks.ts";
import type { Visibility } from "./visibility.ts";

export type CommittedLine = { id: number; role: Role; ansi: string };

export interface Renderer {
  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void;
  appendToBlock(partID: string, text: string): void;
  // `exitCode` (Stage 15.2, C2.6b) is set only for a v2 shell tool that exited non-zero. The renderer shows
  // it as a marker line under the block. v1 never passes it, so v1 output is unchanged.
  endBlock(partID: string, status?: "ok" | "error", exitCode?: number): void;
  commitUserInput(text: string): void;
  commitSystemMessage(text: string): void;
  commitError(message: string): void;
  // Called by app.tsx on session-idle: flush open tail + push 2-blank turn separator.
   commitTurnEnd(): void;
   // Called during compaction to register a divider line; mutates committed buffer.
   commitCompactionDivider(auto: boolean): void;
   // Called during compaction to reassign a block's role; mutates committed buffer.
   retagBlock(partID: string, newRole: Role): void;
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
}
