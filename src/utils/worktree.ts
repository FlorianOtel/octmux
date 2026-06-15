import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Derive a safe git worktree slug from a user-provided name.
 *
 * If `name` is undefined or empty-ish → return auto slug `wt-YYYYMMDD-HHMM` in LOCAL time
 * (zero-padded). The slug is built from `new Date()`.
 *
 * If `name` is given → sanitize to a safe git refname + path segment by:
 * 1. Replacing runs of whitespace with `-`
 * 2. Stripping git-refname-invalid chars: ~ ^ : ? * [ \ and control chars (0x00-0x1f, 0x7f)
 * 3. Stripping leading `-` characters
 *
 * If sanitization results in an empty string → throw Error.
 *
 * Examples:
 *   deriveWorktreeSlug() → "wt-20260615-1705"
 *   deriveWorktreeSlug("my feature") → "my-feature"
 *   deriveWorktreeSlug("hello~world") → "helloworld"
 *   deriveWorktreeSlug("-leading") → "leading"
 */
export function deriveWorktreeSlug(name?: string): string {
  if (!name || name.trim() === "") {
    // Auto slug: wt-YYYYMMDD-HHMM
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const date = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    return `wt-${year}${month}${date}-${hours}${minutes}`;
  }

  // Sanitize the provided name
  let sanitized = name
    // Replace runs of whitespace with `-`
    .replace(/\s+/g, "-")
    // Strip git-refname-invalid chars: ~ ^ : ? * [ \ and control chars (0x00-0x1f, 0x7f)
    .replace(/[~^:?*\[\\\x00-\x1f\x7f]/g, "")
    // Strip leading `-` characters
    .replace(/^-+/, "");

  if (sanitized === "") {
    throw new Error("--worktree name sanitizes to empty string");
  }

  return sanitized;
}

/**
 * Derive the worktree path and branch name from a repository root and slug.
 *
 * The worktree is created as a sibling directory: `<repoRoot's parent>/<repoRoot's basename>--<slug>`
 * The branch name is the slug itself.
 *
 * This function is PURE — it does not create or check anything.
 *
 * Examples:
 *   deriveWorktreePaths("/a/b/myrepo", "my-feat") →
 *     { worktreePath: "/a/b/myrepo--my-feat", branchName: "my-feat" }
 */
export function deriveWorktreePaths(
  repoRoot: string,
  slug: string,
): { worktreePath: string; branchName: string } {
  // Build sibling path: <parent>/<basename>--<slug>
  const parent = path.dirname(repoRoot);
  const basename = path.basename(repoRoot);
  const worktreePath = path.join(parent, `${basename}--${slug}`);
  const branchName = slug;

  return { worktreePath, branchName };
}

/**
 * Create a new git worktree with the given branch.
 *
 * Calls `git worktree add <worktreePath> -b <branchName>` in the repository root.
 * If the command fails, rethrows with a clean error message mentioning the
 * worktree path and branch name.
 *
 * Throws on error (e.g., branch already exists, path already exists, etc.).
 */
export function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): void {
  try {
    execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to create git worktree at ${worktreePath} (branch: ${branchName}): ${message}`,
    );
  }
}
