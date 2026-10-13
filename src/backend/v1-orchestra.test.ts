import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { V1OrchestraFileReader } from "./v1-orchestra.ts";
import type { SessionRecord } from "./types.ts";

// Legacy v1 orchestra reader: oconona's sidecar files on octmux's own disk. Each test builds a
// scratch sessions directory and a fake session list whose harness lives in the process cwd.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "octmux-v1-orchestra-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const HARNESS = "ses_harness";
const MODEL = { providerID: "sohoai", id: "glm-5.3-flash" };

function harnessList(): () => Promise<SessionRecord[]> {
  return async () => [
    { id: "ses_other", directory: "/elsewhere", title: "", time: { updated: 500 } },
    { id: HARNESS, directory: process.cwd(), title: "", time: { updated: 100 }, model: MODEL },
    { id: "ses_child", parentID: HARNESS, directory: process.cwd(), title: "", time: { updated: 900 } },
  ];
}

/** Creates a session directory with the given sidecar files. */
function sessionDir(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

describe("V1OrchestraFileReader", () => {
  test("a brain run of the harness session gives the badge state with the harness model", async () => {
    sessionDir("run1", {
      ".oc-session-id": HARNESS + "\n",
      ".brain-inflight": "orchestra full - task\n",
      "telemetry.json": JSON.stringify({ parser_warnings: [{ code: "w", message: "m" }] }),
    });
    const reader = new V1OrchestraFileReader(harnessList(), root);
    expect(await reader.read("ses_repl")).toEqual({
      mode: "brain",
      title: "orchestra full - task",
      parserWarnings: [{ code: "w", message: "m" }],
      model: MODEL,
    });
  });

  test("no inflight marker, another session's run, or a missing directory gives null", async () => {
    sessionDir("done", { ".oc-session-id": HARNESS });
    sessionDir("foreign", { ".oc-session-id": "ses_other", ".brain-inflight": "x" });
    expect(await new V1OrchestraFileReader(harnessList(), root).read("ses_repl")).toBeNull();
    expect(await new V1OrchestraFileReader(harnessList(), path.join(root, "absent")).read("ses_repl")).toBeNull();
  });

  test("duo wins over brain, and two live runs show the count", async () => {
    sessionDir("a", { ".oc-session-id": HARNESS, ".brain-inflight": "orchestra full - a" });
    expect((await new V1OrchestraFileReader(harnessList(), root).read("ses_repl"))?.mode).toBe("brain");
    sessionDir("b", { ".oc-session-id": HARNESS, ".duo-inflight": "orchestra light - b" });
    const state = await new V1OrchestraFileReader(harnessList(), root).read("ses_repl");
    expect(state?.mode).toBe("duo");
    expect(state?.title).toBe("orchestra light - #2");
  });

  test("a session directory older than 24 h is ignored", async () => {
    const dir = sessionDir("old", { ".oc-session-id": HARNESS, ".brain-inflight": "x" });
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(dir, old, old);
    expect(await new V1OrchestraFileReader(harnessList(), root).read("ses_repl")).toBeNull();
  });

  test("no top-level session in the local cwd gives null", async () => {
    sessionDir("run", { ".oc-session-id": HARNESS, ".brain-inflight": "x" });
    const reader = new V1OrchestraFileReader(async () => [{ id: HARNESS, directory: "/elsewhere", title: "", time: { updated: 1 } }], root);
    expect(await reader.read("ses_repl")).toBeNull();
  });
});
