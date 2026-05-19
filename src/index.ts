import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createInterface } from "node:readline";
import { filterEvent } from "./events.ts";
import { findFreePort, spawnOpencodeServer, type ServerHandle } from "./server-lifecycle.ts";

// ---------------------------------------------------------------------------
// Arg parsing — Phase 2: help, version, attach vs auto-spawn, tmux guard
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`octmux — text REPL UI for opencode

Usage:
  octmux                    auto-spawn opencode server, enter REPL
  octmux --attach <port>    attach to a running server on <port>
  octmux --help             show this help
  octmux --version          show version

Flags:
  --no-tmux-guard           allow running outside tmux (scripts / CI)`);
  process.exit(0);
}

if (args.includes("--version")) {
  console.log("0.0.0");
  process.exit(0);
}

const noTmuxGuard = args.includes("--no-tmux-guard");
const attachIdx = args.indexOf("--attach");
const attachPort = attachIdx !== -1 ? parseInt(args[attachIdx + 1], 10) : NaN;

if (!process.env.TMUX && !noTmuxGuard) {
  console.error("octmux must run inside tmux.\nStart a tmux session first, or pass --no-tmux-guard to override.");
  process.exit(1);
}

let baseUrl: string;
let serverHandle: ServerHandle | null = null;

// ---------------------------------------------------------------------------
// Health probe — mirrors opentmux isOpencodeHealthy pattern
// (opentmux/src/bin/opentmux.ts:122)
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 3_000;

async function isOpencodeHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/health`, { signal: controller.signal }).catch(() => null);
    return resp?.ok ?? false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (!isNaN(attachPort)) {
  // Attach mode: connect to an existing server
  baseUrl = `http://127.0.0.1:${attachPort}`;
  if (!(await isOpencodeHealthy(baseUrl))) {
    console.error(`health: failed — no opencode server responding on port ${attachPort}`);
    process.exit(1);
  }
} else {
  // Auto-spawn mode: find a free port and start the server
  const port = await findFreePort(4096, 4106);
  if (port === null) {
    console.error("no free port available in [4096, 4106]");
    process.exit(1);
  }
  console.log(`spawning opencode server on port ${port}…`);
  try {
    serverHandle = await spawnOpencodeServer(port);
  } catch (err) {
    console.error(`failed to spawn opencode server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  baseUrl = serverHandle.url;
  console.log(`opencode server ready on port ${port}`);
}

const client = createOpencodeClient({ baseUrl });

// Graceful shutdown on external SIGTERM (e.g. systemd / tmux kill-pane)
process.on("SIGTERM", async () => {
  await serverHandle?.dispose();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Session setup — create a new session for this REPL invocation
// ---------------------------------------------------------------------------

const session = await client.session.create({});
const sessionID = session.data!.id;

// ---------------------------------------------------------------------------
// SSE event loop (background)
//
// client.global.event() subscribes to ALL server events; filterEvent() narrows
// to our sessionID and the two event kinds the REPL cares about.
// ---------------------------------------------------------------------------

// Resolved by the SSE loop when session.idle fires for our session.
// Re-set before each session.promptAsync() call.
let resolveIdle: (() => void) | null = null;

// Track if we're currently generating (for Ctrl-C handling).
let isGenerating = false;

// Double-Ctrl-C exit guard: first Ctrl-C warns, second exits within 3s.
let pendingExit = false;
let pendingExitTimer: ReturnType<typeof setTimeout> | null = null;

const eventStream = await client.global.event({});

const sseLoop = (async () => {
  for await (const globalEvent of eventStream.stream) {
    const replEvent = filterEvent(globalEvent.payload, sessionID);
    if (!replEvent) continue;

    if (replEvent.kind === "text-delta") {
      process.stdout.write(replEvent.text);
    } else if (replEvent.kind === "error") {
      process.stderr.write(`\n[error] ${replEvent.message}\n`);
    } else if (replEvent.kind === "generating") {
      if (!isGenerating) {
        process.stdout.write("[generating…]\n");
        isGenerating = true;
      }
    } else if (replEvent.kind === "session-idle") {
      // End of assistant turn: newline + unblock the REPL.
      isGenerating = false;
      pendingExit = false;
      if (pendingExitTimer) { clearTimeout(pendingExitTimer); pendingExitTimer = null; }
      process.stdout.write("\n");
      resolveIdle?.();
      resolveIdle = null;
    } else if (replEvent.kind === "part-removed") {
      // buffer already invalidated in filterEvent(); no display change
    } else if (replEvent.kind === "session-status") {
      if (replEvent.status === "retry") {
        process.stdout.write("[retrying…]\n");
      }
      // busy and idle are covered by "generating" and "session-idle"
    } else if (replEvent.kind === "permission-asked") {
      await respondPermission(replEvent.permID, replEvent.title);
    } else if (replEvent.kind === "question-asked") {
      await respondQuestion(replEvent.reqID, replEvent.questions);
    }
  }
})();

// ---------------------------------------------------------------------------
// readline REPL
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

function askUser(): Promise<string> {
  return new Promise((resolve) => rl.question("> ", resolve));
}

// Returns a promise that resolves when session.idle fires for our session.
// The idle promise is set up before promptAsync() so we never miss the event.
function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    resolveIdle = resolve;
  });
}

async function respondPermission(permID: string, title: string): Promise<void> {
  return new Promise((resolve) => {
    rl.question(`? Allow: ${title}\n  y=once  a=always  n=reject: `, async (ans) => {
      const response =
        ans.trim().toLowerCase() === "a" ? "always" :
        ans.trim().toLowerCase() === "n" ? "reject" :
        "once";
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID: permID },
        body: { response },
      });
      resolve();
    });
  });
}

async function respondQuestion(
  reqID: string,
  questions: Array<{
    question: string; options: Array<{ label: string; description: string }>;
    multiple?: boolean; custom?: boolean;
  }>
): Promise<void> {
  const answers: string[][] = [];
  for (const q of questions) {
    process.stdout.write(`\n? ${q.question}\n`);
    q.options.forEach((opt, i) => {
      process.stdout.write(`  ${i + 1}. ${opt.label} — ${opt.description}\n`);
    });
    const ans = await new Promise<string>((resolve) =>
      rl.question(q.multiple ? "  Enter numbers (comma-separated): " : "  Enter number: ", resolve)
    );
    const picked = ans.split(",").map((s) => {
      const n = parseInt(s.trim(), 10);
      return isNaN(n) || n < 1 || n > q.options.length
        ? q.options[0].label
        : q.options[n - 1].label;
    });
    answers.push(picked);
  }
  const resp = await fetch(`${baseUrl}/question/${reqID}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!resp.ok) {
    process.stderr.write(`[question reply failed: ${resp.statusText}]\n`);
  }
}

// EOF (Ctrl-D)
rl.on("close", async () => {
  process.stdout.write("\n");
  await serverHandle?.dispose();
  process.exit(0);
});

// Ctrl-C: abort generation if active; otherwise warn on first press, exit on second within 3s.
rl.on("SIGINT", async () => {
  if (isGenerating) {
    // During generation: abort only, never exit.
    process.stdout.write("\n[aborted]\n");
    isGenerating = false;
    pendingExit = false;
    if (pendingExitTimer) { clearTimeout(pendingExitTimer); pendingExitTimer = null; }
    await client.session.abort({ path: { id: sessionID } });
    // session.idle will fire after abort and resolve idlePromise
  } else if (pendingExit) {
    // Second Ctrl-C within 3s: exit.
    if (pendingExitTimer) { clearTimeout(pendingExitTimer); pendingExitTimer = null; }
    process.stdout.write("\n");
    await serverHandle?.dispose();
    process.exit(0);
  } else {
    // First Ctrl-C when idle: warn and arm 3s reset timer.
    pendingExit = true;
    process.stdout.write("\n(Press Ctrl-C again to exit)\n");
    pendingExitTimer = setTimeout(() => {
      pendingExit = false;
      pendingExitTimer = null;
    }, 3000);
  }
});

// REPL loop
while (true) {
  const input = await askUser();
  if (!input.trim()) continue;

  // Set up idle listener BEFORE calling promptAsync(), so we never miss the event.
  const idlePromise = waitForIdle();

  await client.session.promptAsync({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: input }] },
  });

  // Wait for session.idle to confirm the assistant turn is complete.
  await idlePromise;
}

// Suppress unhandled-rejection on SSE loop teardown.
sseLoop.catch(() => {});
