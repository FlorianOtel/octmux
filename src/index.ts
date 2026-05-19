import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createInterface } from "node:readline";
import { filterEvent } from "./events.ts";

// ---------------------------------------------------------------------------
// Arg parsing — only --attach <port> for Phase 0
// ---------------------------------------------------------------------------

const attachIdx = process.argv.indexOf("--attach");
const port = attachIdx !== -1 ? parseInt(process.argv[attachIdx + 1], 10) : NaN;

if (isNaN(port)) {
  console.error("Usage: octmux --attach <port>");
  process.exit(1);
}

const baseUrl = `http://127.0.0.1:${port}`;

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

if (!(await isOpencodeHealthy(baseUrl))) {
  console.error(`health: failed — no opencode server responding on port ${port}`);
  process.exit(1);
}

console.log("health: ok");

// ---------------------------------------------------------------------------
// SDK smoke test — list sessions and print the count
// ---------------------------------------------------------------------------

const client = createOpencodeClient({ baseUrl });
const result = await client.session.list({});

// The SDK uses a fields-style result; data may be undefined on error.
const sessions = result.data ?? [];
console.log(`sessions: ${sessions.length}`);

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
      process.stdout.write("\n");
      resolveIdle?.();
      resolveIdle = null;
    } else if (replEvent.kind === "part-removed") {
      // buffer already invalidated in filterEvent(); no display change
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

// EOF (Ctrl-D)
rl.on("close", async () => {
  process.stdout.write("\n");
  process.exit(0);
});

// Ctrl-C: abort generation if active, else exit
rl.on("SIGINT", async () => {
  if (isGenerating) {
    process.stdout.write("\n[aborted]\n");
    isGenerating = false;
    await client.session.abort({ path: { id: sessionID } });
    // session.idle will fire after abort and resolve idlePromise
  } else {
    process.stdout.write("\n");
    process.exit(0);
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
