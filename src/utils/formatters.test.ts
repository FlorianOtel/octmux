import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fetchGitBranch runs while Ink is mounted. Any stderr the git child writes
// reaches the real terminal, so the contract is: no stderr output at all.
//
// The check runs in a child bun process whose cwd is a fresh non-git temp dir.
// The child's stderr is a pipe owned by this test, so git's "fatal: not a git
// repository" line (if it were leaked) is captured here instead of the runner's
// terminal. The child gets an isolated HOME and a GIT_CEILING_DIRECTORIES that
// stops git searching above the temp dir, so no real repo or $HOME config leaks in.

const formattersPath = join(import.meta.dir, "formatters.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("fetchGitBranch", () => {
  test("outside a git repo returns empty string and writes nothing to stderr", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "octmux-fetchgitbranch-"));
    tempDirs.push(tmpRoot);
    const nonGitDir = join(tmpRoot, "not-a-repo");
    const isolatedHome = join(tmpRoot, "home");
    // mkdtemp above creates tmpRoot; create the two subdirs the child uses.
    await Bun.write(join(nonGitDir, ".keep"), "");
    await Bun.write(join(isolatedHome, ".keep"), "");

    const script =
      `import { fetchGitBranch } from ${JSON.stringify(formattersPath)};` +
      `const branch = await fetchGitBranch();` +
      `process.stdout.write(JSON.stringify(branch));`;

    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: nonGitDir,
      env: {
        ...process.env,
        HOME: isolatedHome,
        GIT_CEILING_DIRECTORIES: tmpRoot,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('""');
    expect(stderr).toBe("");
  });
});
