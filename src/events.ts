import type { Role } from "./blocks.ts";

/**
 * One field of a v2 form (`form.created` → `data.form.fields[]`).
 * Shape taken from `docs/OpenCode-v2-protocol-capture.md` §4.6. The field `type` is
 * a plain string because only `"string"` and `"boolean"` have been observed; no
 * other values are assumed. v1 never produces forms, so only the v2 translator
 * (Stage 15.2, C2.4) builds these.
 */
export type FormField = {
  /** Answer key. The reply body is `{ answer: { [key]: value } }`. */
  key: string;
  title: string;
  description?: string;
  /** Observed values: `"string"` and `"boolean"`. */
  type: string;
  /** Choice options for a string field; each option's `value` is the answer value. */
  options?: Array<{ value: string; label: string; description?: string }>;
  /** True when the field also accepts free text beyond the listed options. */
  custom?: boolean;
};

// Normalised events the REPL cares about; all others are dropped.
export type ReplEvent =
  | { kind: "block-start"; partID: string; role: Role; toolName?: string; messageID?: string }
  | { kind: "block-delta"; partID: string; role: Role; text: string }
  // `exitCode` is v2-only (Stage 15.2): a non-zero shell exit is a *completed* tool in v2, so the
  // renderer needs the exit code to show "(exit N)". v1 never sets it.
  | { kind: "block-end";   partID: string; role: Role; status?: "ok" | "error"; exitCode?: number }
  | { kind: "session-idle" }
  | { kind: "error"; message: string }
  | { kind: "generating" }
  | { kind: "session-status"; status: "idle" | "busy" | "retry" }
  | { kind: "part-removed"; partId: string }
  // `resources` is the list of resources the permission request covers. v2 can raise one ask
  // covering several resources (compound commands). v1 always sets it to `[title]`.
  | { kind: "permission-asked"; permID: string; sessionID: string; title: string; permType: string; resources: string[] }
  | { kind: "question-asked"; reqID: string; sessionID: string; questions: Array<{
      question: string; header: string; options: Array<{ label: string; description: string }>;
      multiple?: boolean; custom?: boolean;
    }> }
  | { kind: "question-replied"; reqID: string; sessionID: string; answers: string[][] }
  | { kind: "question-rejected"; reqID: string; sessionID: string }
  | { kind: "question-tool-detected"; sessionID: string; callID: string }
  | { kind: "session-compacted"; sessionID: string }
  | { kind: "block-retag"; partID: string; newRole: "summary" }
  | { kind: "compaction-divider"; sessionID: string; auto: boolean }
  | { kind: "message-completed"; messageID: string }
  | { kind: "subagent-detected"; sessionID: string; agent: string; model: string; description?: string }
  | { kind: "subagent-ended"; sessionID: string }
  | { kind: "subagent-activity"; sessionID: string; ts: number }
  | { kind: "parent-turn-end"; reason: "idle" | "aborted" | "error" }
  | { kind: "foreign-user-turn"; messageID: string; text: string }
  | { kind: "model-switched"; sessionID: string; providerID: string; modelID: string }
  // ─── Kinds emitted by the v2 translator (`src/backend/v2-events.ts`); `app.tsx` handles them.
  // app.tsx also builds `form-asked`
  // itself in its missed-form discovery pass. Plan reference: PLAN-C2C3.md §B.1.
  // Form (v2 `form.created` / `form.replied`, capture doc §4.6).
  | { kind: "form-asked"; formID: string; sessionID: string; title: string; fields: FormField[] }
  | { kind: "form-replied"; formID: string; sessionID: string; answer: Record<string, unknown> }
  // Non-terminal retry (v2 `session.retry.scheduled`, capture doc §4.3). Does not flip isGenerating.
  | { kind: "turn-retry"; sessionID: string; attempt: number; message: string }
  // Compaction (v2 `session.compaction.*`, capture doc §4.12).
  | { kind: "compaction-started"; sessionID: string; reason: string }
  | { kind: "compaction-progress"; sessionID: string; text: string }
  | { kind: "compaction-ended"; sessionID: string; summary: string; tokens?: number; cost?: number }
  | { kind: "compaction-failed"; sessionID: string; message: string }
  // Model bound to the session (v2 `session.model.selected`, capture doc §4.3). Kept distinct from
  // the v1 foreign-client `model-switched` kind on purpose (PLAN-C2C3.md §B.1).
  | { kind: "model-selected"; sessionID: string; providerID: string; modelID: string }
  // Internal (v2 translator): a durable `seq` gap was detected, so app.tsx runs an incremental resync
  // (getMissedHistory) that renders only the missed messages and clears nothing (§4.11).
  | { kind: "resync-needed"; sessionID: string };

