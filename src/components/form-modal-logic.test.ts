import { describe, test, expect } from "bun:test";
import type { FormField } from "../events.ts";
import { answerForKey, answerInstruction, buildAnswer, isLastField } from "./form-modal-logic.ts";

// Fixture: the capture-1 choice field (docs/OpenCode-v2-protocol-capture.md §4.6), custom: true.
const choiceCustom: FormField = {
  key: "q0",
  title: "Your choice",
  description: "Please choose 'A' or 'B'.",
  type: "string",
  options: [
    { value: "A", label: "A", description: "Choose option A" },
    { value: "B", label: "B", description: "Choose option B" },
  ],
  custom: true,
};

// Same options without custom: only the numbers are accepted.
const choiceStrict: FormField = { ...choiceCustom, key: "q1", custom: false };

// Capture-3 boolean field (§4.6, API-created form).
const boolField: FormField = { key: "ok", title: "OK?", type: "boolean" };

const freeText: FormField = { key: "name", title: "Name", type: "string" };

const numberField: FormField = { key: "n", title: "Count", type: "number" };

const numberWithOptions: FormField = {
  key: "size",
  title: "Size",
  type: "number",
  options: [
    { value: "7", label: "Seven" },
    { value: "9", label: "Nine" },
  ],
};

describe("answerForKey: boolean fields", () => {
  test("y and yes (any case) answer true", () => {
    expect(answerForKey(boolField, "y")).toEqual({ ok: true, value: true });
    expect(answerForKey(boolField, "Y")).toEqual({ ok: true, value: true });
    expect(answerForKey(boolField, "yes")).toEqual({ ok: true, value: true });
  });

  test("n and no (any case) answer false", () => {
    expect(answerForKey(boolField, "n")).toEqual({ ok: true, value: false });
    expect(answerForKey(boolField, "NO")).toEqual({ ok: true, value: false });
  });

  test("anything else is an error, including a blank draft", () => {
    expect(answerForKey(boolField, "maybe")).toEqual({ ok: false, error: "Press y or n" });
    expect(answerForKey(boolField, "")).toEqual({ ok: false, error: "Press y or n" });
    expect(answerForKey(boolField, "1")).toEqual({ ok: false, error: "Press y or n" });
  });
});

describe("answerForKey: fields with options", () => {
  test("a digit in range selects that option's value", () => {
    expect(answerForKey(choiceCustom, "1")).toEqual({ ok: true, value: "A" });
    expect(answerForKey(choiceCustom, "2")).toEqual({ ok: true, value: "B" });
    expect(answerForKey(choiceStrict, " 2 ")).toEqual({ ok: true, value: "B" });
  });

  test("an out-of-range digit is an error when custom is off", () => {
    expect(answerForKey(choiceStrict, "0")).toEqual({ ok: false, error: "Press 1–2" });
    expect(answerForKey(choiceStrict, "3")).toEqual({ ok: false, error: "Press 1–2" });
  });

  test("non-digit text is an error when custom is off", () => {
    expect(answerForKey(choiceStrict, "A")).toEqual({ ok: false, error: "Press 1–2" });
    expect(answerForKey(choiceStrict, "2a")).toEqual({ ok: false, error: "Press 1–2" });
    expect(answerForKey(choiceStrict, "-1")).toEqual({ ok: false, error: "Press 1–2" });
  });

  test("custom text is accepted as typed when custom is on", () => {
    expect(answerForKey(choiceCustom, "maybe later")).toEqual({ ok: true, value: "maybe later" });
    // Not trimmed, matching the free-text branch.
    expect(answerForKey(choiceCustom, "  padded  ")).toEqual({ ok: true, value: "  padded  " });
  });

  test("an out-of-range digit with custom on is custom text, not an error", () => {
    expect(answerForKey(choiceCustom, "7")).toEqual({ ok: true, value: "7" });
  });

  test("a blank draft is an error even when custom is on", () => {
    expect(answerForKey(choiceCustom, "")).toEqual({
      ok: false,
      error: "Press 1–2 or type a custom answer",
    });
    expect(answerForKey(choiceCustom, "   ")).toEqual({
      ok: false,
      error: "Press 1–2 or type a custom answer",
    });
  });

  test("number type converts the chosen option value", () => {
    expect(answerForKey(numberWithOptions, "2")).toEqual({ ok: true, value: 9 });
  });
});

describe("answerForKey: free-text fields", () => {
  test("text is kept as typed", () => {
    expect(answerForKey(freeText, "hello world")).toEqual({ ok: true, value: "hello world" });
    expect(answerForKey(freeText, "  spaced  ")).toEqual({ ok: true, value: "  spaced  " });
  });

  test("a digit is plain text on a string field with no options", () => {
    expect(answerForKey(freeText, "2")).toEqual({ ok: true, value: "2" });
  });

  test("a blank draft is an error", () => {
    expect(answerForKey(freeText, "")).toEqual({ ok: false, error: "Type an answer first" });
    expect(answerForKey(freeText, "   ")).toEqual({ ok: false, error: "Type an answer first" });
  });

  test("an unknown field type is treated as a string", () => {
    const odd: FormField = { key: "x", title: "X", type: "date" };
    expect(answerForKey(odd, "2026-10-13")).toEqual({ ok: true, value: "2026-10-13" });
  });
});

describe("answerForKey: number fields", () => {
  test("a numeric draft becomes a number", () => {
    expect(answerForKey(numberField, "42")).toEqual({ ok: true, value: 42 });
    expect(answerForKey(numberField, " -3.5 ")).toEqual({ ok: true, value: -3.5 });
  });

  test("non-numeric text is an error", () => {
    expect(answerForKey(numberField, "abc")).toEqual({ ok: false, error: "Enter a number" });
    expect(answerForKey(numberField, "1e999")).toEqual({ ok: false, error: "Enter a number" });
  });

  test("a blank draft is an error, not zero", () => {
    expect(answerForKey(numberField, "")).toEqual({ ok: false, error: "Type an answer first" });
    expect(answerForKey(numberField, "   ")).toEqual({ ok: false, error: "Type an answer first" });
  });
});

describe("isLastField", () => {
  test("the final index is last; earlier indices are not", () => {
    const fields = [freeText, boolField, choiceCustom];
    expect(isLastField(0, fields)).toBe(false);
    expect(isLastField(1, fields)).toBe(false);
    expect(isLastField(2, fields)).toBe(true);
  });

  test("a single-field form is last at index 0", () => {
    expect(isLastField(0, [freeText])).toBe(true);
  });

  test("an empty form counts index 0 as last", () => {
    expect(isLastField(0, [])).toBe(true);
  });
});

describe("buildAnswer", () => {
  test("builds the answer in field order from per-field values", () => {
    const fields = [choiceCustom, boolField];
    const answer = buildAnswer(fields, { ok: true, q0: "A" });
    expect(answer).toEqual({ q0: "A", ok: true });
    expect(Object.keys(answer)).toEqual(["q0", "ok"]);
  });

  test("drops values whose keys are not in the form", () => {
    const answer = buildAnswer([freeText], { name: "x", stray: 1 });
    expect(answer).toEqual({ name: "x" });
  });

  test("keeps number and boolean values unchanged", () => {
    const answer = buildAnswer([numberField, boolField], { n: 0, ok: false });
    expect(answer).toEqual({ n: 0, ok: false });
  });

  test("throws naming every missing field rather than sending a partial answer", () => {
    expect(() => buildAnswer([choiceCustom, boolField, freeText], { ok: true })).toThrow(
      "buildAnswer: no value for field(s) q0, name",
    );
  });

  test("an empty form yields an empty answer", () => {
    expect(buildAnswer([], {})).toEqual({});
  });
});

describe("answerInstruction: footer wording per field type", () => {
  test("a boolean field names y / n", () => {
    expect(answerInstruction(boolField)).toBe("Press y / n");
  });

  test("an option field names its numbers", () => {
    expect(answerInstruction(choiceStrict)).toBe("Press 1–2");
  });

  test("an option field with custom also allows typed text", () => {
    expect(answerInstruction(choiceCustom)).toBe("Press 1–2 or type a custom answer");
  });

  test("a free-text field asks for typed text, not a key press", () => {
    expect(answerInstruction(freeText)).toBe("Type your answer");
  });

  test("boolean wins over options, matching answerForKey", () => {
    const boolWithOptions: FormField = {
      key: "b",
      title: "B",
      type: "boolean",
      options: [{ value: "x", label: "X" }],
    };
    expect(answerInstruction(boolWithOptions)).toBe("Press y / n");
  });
});
