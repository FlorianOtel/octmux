// Pure form-progress transitions for the v2 form modal (Stage 15.2, C2.6a).
// No Ink or React imports: app.tsx owns the refs/state and calls `advanceForm` on Enter,
// and the unit tests drive it directly.
//
// app.tsx keeps one `FormProgress` per open form: which field is being answered, the
// text typed so far for that field, and the values already accepted for earlier fields.

import type { FormField } from "../events.ts";
import type { FormAnswer } from "../backend/types.ts";
import { answerForKey, buildAnswer, isLastField, type FormAnswerValue } from "./form-modal-logic.ts";

/** Input progress through one open form. */
export type FormProgress = {
  /** 0-based index of the field currently being answered. */
  fieldIdx: number;
  /** Text typed so far for the current field. */
  draft: string;
  /** Accepted values for the fields answered so far, keyed by `FormField.key`. */
  values: Record<string, FormAnswerValue>;
};

/** Progress at the start of a form: first field, empty draft, no values. */
export const INITIAL_FORM_PROGRESS: FormProgress = { fieldIdx: 0, draft: "", values: {} };

/**
 * Outcome of pressing Enter on the current field.
 * - `error`: the draft is not a valid answer; `message` is shown and the field is kept.
 * - `next`: the value was accepted and there are more fields; `progress` moves to the next field.
 * - `complete`: the last field was accepted; `answer` is the full body for `replyForm`.
 */
export type FormStep =
  | { kind: "error"; message: string }
  | { kind: "next"; progress: FormProgress }
  | { kind: "complete"; answer: FormAnswer };

/**
 * Applies Enter on the current field. Parsing is delegated to `answerForKey`; this function
 * only decides what happens next. It never returns a partial answer: `complete` is returned
 * only after every field has a value.
 */
export function advanceForm(fields: readonly FormField[], progress: FormProgress): FormStep {
  const field = fields[progress.fieldIdx];
  // A form with no fields has nothing to answer. Esc still closes it.
  if (!field) return { kind: "error", message: "This form has no fields. Press Esc to close it." };

  const parsed = answerForKey(field, progress.draft);
  if (!parsed.ok) return { kind: "error", message: parsed.error };

  // Build the next values object instead of mutating `progress.values`, so the previous
  // progress stays intact if the caller discards the result.
  const values = { ...progress.values, [field.key]: parsed.value };
  if (isLastField(progress.fieldIdx, fields)) {
    return { kind: "complete", answer: buildAnswer(fields, values) };
  }
  return { kind: "next", progress: { fieldIdx: progress.fieldIdx + 1, draft: "", values } };
}
