import { describe, expect, test } from "bun:test";
import { deriveWorktreeSlug, deriveWorktreePaths } from "./worktree";

describe("deriveWorktreeSlug", () => {
  test("no args generates auto slug matching wt-YYYYMMDD-HHMM pattern", () => {
    const slug = deriveWorktreeSlug();
    expect(slug).toMatch(/^wt-\d{8}-\d{4}$/);
  });

  test("empty string generates auto slug matching wt-YYYYMMDD-HHMM pattern", () => {
    const slug = deriveWorktreeSlug("");
    expect(slug).toMatch(/^wt-\d{8}-\d{4}$/);
  });

  test("whitespace-only string generates auto slug matching wt-YYYYMMDD-HHMM pattern", () => {
    const slug = deriveWorktreeSlug("   ");
    expect(slug).toMatch(/^wt-\d{8}-\d{4}$/);
  });

  test("replaces whitespace runs with single dash", () => {
    const slug = deriveWorktreeSlug("my feature");
    expect(slug).toBe("my-feature");
  });

  test("replaces tilde with empty string", () => {
    const slug = deriveWorktreeSlug("hello~world");
    expect(slug).toBe("helloworld");
  });

  test("strips leading dashes", () => {
    const slug = deriveWorktreeSlug("-leading");
    expect(slug).toBe("leading");
  });

  test("strips multiple leading dashes", () => {
    const slug = deriveWorktreeSlug("---multi-dash");
    expect(slug).toBe("multi-dash");
  });

  test("throws when name sanitizes to empty string", () => {
    expect(() => deriveWorktreeSlug("~~~")).toThrow(
      "--worktree name sanitizes to empty string",
    );
  });

  test("throws when name is only dashes and invalid chars", () => {
    expect(() => deriveWorktreeSlug("-^:?*")).toThrow(
      "--worktree name sanitizes to empty string",
    );
  });

  test("preserves alphanumeric and underscore", () => {
    const slug = deriveWorktreeSlug("feat_123-abc");
    expect(slug).toBe("feat_123-abc");
  });
});

describe("deriveWorktreePaths", () => {
  test("creates sibling path with double-dash separator", () => {
    const { worktreePath, branchName } = deriveWorktreePaths(
      "/a/b/myrepo",
      "my-feat",
    );
    expect(worktreePath).toBe("/a/b/myrepo--my-feat");
    expect(branchName).toBe("my-feat");
  });

  test("handles auto-generated slug", () => {
    const { worktreePath, branchName } = deriveWorktreePaths(
      "/a/b/myrepo",
      "wt-20260615-1705",
    );
    expect(worktreePath).toBe("/a/b/myrepo--wt-20260615-1705");
    expect(branchName).toBe("wt-20260615-1705");
  });

  test("handles nested repo paths", () => {
    const { worktreePath, branchName } = deriveWorktreePaths(
      "/home/user/projects/octmux",
      "feature",
    );
    expect(worktreePath).toBe("/home/user/projects/octmux--feature");
    expect(branchName).toBe("feature");
  });
});
