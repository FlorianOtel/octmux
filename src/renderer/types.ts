import type { Block, Role } from "../blocks.ts";
import type { Visibility } from "./visibility.ts";

export type CommittedLine = { id: number; role: Role; ansi: string };

export interface Renderer {
  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void;
  appendToBlock(partID: string, text: string): void;
  endBlock(partID: string, status?: "ok" | "error"): void;
  // Stage 10.7 — Sync the active text buffer with OC's authoritative full-text
  // state push (message.part.updated for a text part with text.length > 0).
  // No-op when partID isn't the current active text block, or when active buf
  // already matches `fullText`, or when `fullText` is shorter (defensive). Fixes
  // intermittent SSE delta loss where the final part.updated event is the only
  // source of truth for the tail. See docs/Stage10.md Stage 10.7 entry.
  reconcileActiveText(partID: string, fullText: string): void;
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
}
