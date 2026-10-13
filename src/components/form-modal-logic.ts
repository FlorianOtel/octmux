// Pure helpers for FormModal (Stage 15.2, C2.7). No Ink or React imports, so the
// input handling in app.tsx (C2.6) and the unit tests can use them directly.
//
// Input model assumed by these helpers: app.tsx keeps a text draft for the current
// field, and on Enter passes the whole draft to `answerForKey`. A digit draft selects
// a numbered option; a `y`/`n` draft answers a boolean field; any other draft is the
// free-text (or custom) answer.

import type { FormField } from "../events.ts";
import type { FormAnswer } from "../backend/types.ts";

/** One answer value, as accepted by `FormAnswer` in `src/backend/types.ts`. */
export type FormAnswerValue = FormAnswer[string];

/** Result of parsing one field's input. `ok: false` carries a message for the footer. */
export type AnswerResult =
  | { ok: true; value: FormAnswerValue }
  | { ok: false; error: string };

/**
 * Returns the 0-based index of the option picked by a digit draft such as "2",
 * or `undefined` if the draft is not a digit within `1..count`.
 */
function pickChoiceIndex(text: string, count: number): number | undefined {
  // Only plain digits count as a choice number; "2a" or "-1" are not choices.
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  if (n < 1 || n > count) return undefined;
  return n - 1;
}

/** Parses a boolean field's draft: y/yes → true, n/no → false, anything else is an error. */
function answerBoolean(text: string): AnswerResult {
  const lower = text.toLowerCase();
  if (lower === "y" || lower === "yes") return { ok: true, value: true };
  if (lower === "n" || lower === "no") return { ok: true, value: false };
  return { ok: false, error: "Press y or n" };
}

/**
 * Converts the chosen raw string to the field's declared type. A `number` field
 * becomes a finite JS number; every other type (including `string`) stays a string.
 */
function coerceToType(field: FormField, raw: string): AnswerResult {
  if (field.type === "number") {
    // Number("") and Number("  ") are 0, so reject blank input explicitly.
    if (raw.trim() === "") return { ok: false, error: "Enter a number" };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "Enter a number" };
    return { ok: true, value: n };
  }
  return { ok: true, value: raw };
}

/**
 * Parses the draft typed for one field into the value that goes into the reply.
 *
 * - `boolean` fields: y/n (see `answerBoolean`); options are ignored.
 * - Fields with `options`: a digit in `1..N` selects `options[N-1].value`. If the
 *   field also has `custom`, any other non-empty text is accepted as the answer.
 * - Fields without `options`: the draft is the answer (blank drafts are rejected).
 * - `number` fields are then converted with `Number`.
 */
export function answerForKey(field: FormField, input: string): AnswerResult {
  const text = input.trim();

  if (field.type === "boolean") return answerBoolean(text);

  const options = field.options ?? [];
  if (options.length > 0) {
    const choiceIdx = pickChoiceIndex(text, options.length);
    if (choiceIdx !== undefined) {
      return coerceToType(field, options[choiceIdx]!.value);
    }
    if (field.custom && text !== "") {
      // Custom text is kept as typed (not trimmed), matching the free-text branch.
      return coerceToType(field, input);
    }
    const hint = field.custom ? " or type a custom answer" : "";
    return { ok: false, error: `Press 1–${options.length}${hint}` };
  }

  // Free text: keep the draft as typed, but a blank draft is not an answer.
  if (text === "") return { ok: false, error: "Type an answer first" };
  return coerceToType(field, input);
}

/**
 * Footer instruction telling the operator how to answer the current field. Phrased per field
 * type, matching the input rules in `answerForKey`: boolean fields take y/n, option fields take
 * their numbers (plus free text when `custom`), and any other field takes typed text.
 */
export function answerInstruction(field: FormField): string {
  if (field.type === "boolean") return "Press y / n";
  const options = field.options ?? [];
  if (options.length > 0) {
    const hint = field.custom ? " or type a custom answer" : "";
    return `Press 1–${options.length}${hint}`;
  }
  return "Type your answer";
}

/** True when `idx` is the final field, so Enter should submit the whole form. */
export function isLastField(idx: number, fields: readonly FormField[]): boolean {
  return idx >= fields.length - 1;
}

/**
 * Builds the `answer` object for `replyForm` from per-field values, in field order.
 * Values for keys that are not in `fields` are dropped.
 *
 * Throws if any field has no value: a partial answer must never reach the server.
 * Callers should only invoke this after the last field has been answered.
 */
export function buildAnswer(
  fields: readonly FormField[],
  values: Readonly<Record<string, FormAnswerValue>>,
): FormAnswer {
  const answer: FormAnswer = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined) {
      missing.push(field.key);
      continue;
    }
    answer[field.key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`buildAnswer: no value for field(s) ${missing.join(", ")}`);
  }
  return answer;
}
