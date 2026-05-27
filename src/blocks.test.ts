import { test, expect, describe } from "bun:test";
import { renderInlineMarkdown } from "./blocks";

describe("renderInlineMarkdown", () => {
  // Simple constructs
  test("bold **text**", () => {
    const result = renderInlineMarkdown("**Rank 1**");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("Rank 1");
    expect(result).not.toContain("**");
  });

  test("italic *word*", () => {
    const result = renderInlineMarkdown("*word*");
    expect(result).toContain("\x1b[3m");
    expect(result).not.toContain("*");
  });

  test("italic _word_", () => {
    const result = renderInlineMarkdown("_word_");
    expect(result).toContain("\x1b[3m");
    expect(result).not.toContain("_");
  });

  test("inline code `name`", () => {
    const result = renderInlineMarkdown("`name`");
    expect(result).toContain("\x1b[2;36m");
    expect(result).not.toContain("`");
  });

  // Word-boundary enforcement on _word_
  test("snake_case remains unchanged", () => {
    const result = renderInlineMarkdown("snake_case");
    expect(result).toBe("snake_case");
  });

  test("_word_ with boundary markers is italic", () => {
    const result = renderInlineMarkdown("prefix _word_ suffix");
    expect(result).toContain("\x1b[3m");
    expect(result).toContain("word");
    expect(result).not.toContain("_word_");
  });

  test("pre_word_post unchanged (underscores flanked by word chars)", () => {
    const result = renderInlineMarkdown("pre_word_post");
    expect(result).toBe("pre_word_post");
  });

  test("__dunder__ unchanged", () => {
    const result = renderInlineMarkdown("__dunder__");
    expect(result).toBe("__dunder__");
  });

  test("x__dunder__x unchanged", () => {
    const result = renderInlineMarkdown("x__dunder__x");
    expect(result).toBe("x__dunder__x");
  });

  // Code-span protects interior
  test("`**not bold**` — interior bold not applied", () => {
    const result = renderInlineMarkdown("`**not bold**`");
    expect(result).toContain("\x1b[2;36m");
    // Should have code styling but NOT bold codes inside
    expect(result.includes("\x1b[2;36m**not bold**")).toBe(true);
  });

  test("`_not_italic_` — interior italic not applied", () => {
    const result = renderInlineMarkdown("`_not_italic_`");
    expect(result).toContain("\x1b[2;36m");
    expect(result.includes("\x1b[2;36m_not_italic_")).toBe(true);
  });

  // Unbalanced markers pass through unchanged
  test("**foo (unbalanced)", () => {
    const result = renderInlineMarkdown("**foo");
    expect(result).toBe("**foo");
  });

  test("foo** (unbalanced)", () => {
    const result = renderInlineMarkdown("foo**");
    expect(result).toBe("foo**");
  });

  test("_foo (unbalanced)", () => {
    const result = renderInlineMarkdown("_foo");
    expect(result).toBe("_foo");
  });

  test("*foo (unbalanced)", () => {
    const result = renderInlineMarkdown("*foo");
    expect(result).toBe("*foo");
  });

  // Empty-marker edge cases
  test("**** (empty bold)", () => {
    const result = renderInlineMarkdown("****");
    expect(result).toBe("****");
  });

  test("__ (empty underscores)", () => {
    const result = renderInlineMarkdown("__");
    expect(result).toBe("__");
  });

  test("`` (empty backticks)", () => {
    const result = renderInlineMarkdown("``");
    expect(result).toBe("``");
  });

  // Mixed constructs
  test("**bold** and _italic_ and `code`", () => {
    const result = renderInlineMarkdown("**bold** and _italic_ and `code`");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("\x1b[3m");
    expect(result).toContain("\x1b[2;36m");
    expect(result).toContain("bold");
    expect(result).toContain("italic");
    expect(result).toContain("code");
  });

  test("**bold** with `**not bold**`", () => {
    const result = renderInlineMarkdown("**bold** with `**not bold**`");
    // Outer bold applied
    expect(result).toContain("\x1b[1m");
    // Code span present
    expect(result).toContain("\x1b[2;36m");
    // Interior ** is inside code span (not transformed)
    expect(result.includes("\x1b[2;36m**not bold**")).toBe(true);
  });
});
