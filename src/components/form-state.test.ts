import { describe, test, expect } from "bun:test";
import type { FormField } from "../events.ts";
import { advanceForm, INITIAL_FORM_PROGRESS, type FormProgress } from "./form-state.ts";

// Fixtures modelled on docs/OpenCode-v2-protocol-capture.md §4.6 (choice field with custom text,
// plus a boolean field) so the two-field flow exercises both answer kinds.
const choice: FormField = {
  key: "q0",
  title: "Your choice",
  type: "string",
  options: [
    { value: "A", label: "A" },
    { value: "B", label: "B" },
  ],
  custom: true,
};
const confirm: FormField = { key: "q1", title: "Proceed?", type: "boolean" };

describe("INITIAL_FORM_PROGRESS", () => {
  test("starts on field 0 with an empty draft and no values", () => {
    expect(INITIAL_FORM_PROGRESS).toEqual({ fieldIdx: 0, draft: "", values: {} });
  });
});

describe("advanceForm — intermediate field", () => {
  test("accepted value moves to the next field with a cleared draft", () => {
    const progress: FormProgress = { fieldIdx: 0, draft: "2", values: {} };
    const step = advanceForm([choice, confirm], progress);
    expect(step).toEqual({
      kind: "next",
      progress: { fieldIdx: 1, draft: "", values: { q0: "B" } },
    });
  });

  test("custom free text on an option field is accepted as the value", () => {
    const progress: FormProgress = { fieldIdx: 0, draft: "maybe later", values: {} };
    const step = advanceForm([choice, confirm], progress);
    expect(step.kind).toBe("next");
    if (step.kind === "next") expect(step.progress.values).toEqual({ q0: "maybe later" });
  });

  test("does not mutate the input progress", () => {
    const values = { earlier: "kept" };
    const progress: FormProgress = { fieldIdx: 0, draft: "1", values };
    advanceForm([choice, confirm], progress);
    expect(progress).toEqual({ fieldIdx: 0, draft: "1", values: { earlier: "kept" } });
    expect(values).toEqual({ earlier: "kept" });
  });
});

describe("advanceForm — error keeps the field", () => {
  test("out-of-range digit on a non-custom option field returns an error and does not advance", () => {
    // `choice` accepts free text (custom: true), so use a strict copy: "9" must then be rejected.
    const strict: FormField = { ...choice, custom: false };
    const progress: FormProgress = { fieldIdx: 0, draft: "9", values: {} };
    const step = advanceForm([strict], progress);
    expect(step.kind).toBe("error");
    if (step.kind === "error") expect(step.message).toContain("Press 1");
  });

  test("boolean field rejects anything other than y/n", () => {
    const progress: FormProgress = { fieldIdx: 0, draft: "maybe", values: {} };
    const step = advanceForm([confirm], progress);
    expect(step).toEqual({ kind: "error", message: "Press y or n" });
  });

  test("empty free-text draft is an error", () => {
    const progress: FormProgress = { fieldIdx: 0, draft: "   ", values: {} };
    const step = advanceForm([{ key: "t", title: "Name", type: "string" }], progress);
    expect(step).toEqual({ kind: "error", message: "Type an answer first" });
  });
});

describe("advanceForm — last field completes", () => {
  test("last field returns the full answer keyed by field key, in field order", () => {
    const progress: FormProgress = { fieldIdx: 1, draft: "y", values: { q0: "A" } };
    const step = advanceForm([choice, confirm], progress);
    expect(step).toEqual({ kind: "complete", answer: { q0: "A", q1: true } });
  });

  test("single-field form completes on its only field", () => {
    const progress: FormProgress = { fieldIdx: 0, draft: "no", values: {} };
    const step = advanceForm([confirm], progress);
    expect(step).toEqual({ kind: "complete", answer: { q1: false } });
  });

  test("error on the last field does not complete the form", () => {
    const progress: FormProgress = { fieldIdx: 1, draft: "", values: { q0: "A" } };
    const step = advanceForm([choice, confirm], progress);
    expect(step.kind).toBe("error");
  });
});

describe("advanceForm — degenerate input", () => {
  test("a form with no fields returns an error instead of completing", () => {
    const step = advanceForm([], INITIAL_FORM_PROGRESS);
    expect(step.kind).toBe("error");
  });

  test("an out-of-range field index returns an error instead of throwing", () => {
    const progress: FormProgress = { fieldIdx: 5, draft: "y", values: {} };
    const step = advanceForm([confirm], progress);
    expect(step.kind).toBe("error");
  });
});
