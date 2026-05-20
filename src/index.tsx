import { render } from "ink";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { findFreePort, spawnOpencodeServer, type ServerHandle } from "./server-lifecycle.ts";
import { App } from "./app.tsx";

// ─── Arg parsing ─────────────────────────────────────────────────────────────

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
const attachIdx   = args.indexOf("--attach");
const attachPort  = attachIdx !== -1 ? parseInt(args[attachIdx + 1], 10) : NaN;

if (!process.env.TMUX && !noTmuxGuard) {
  console.error("octmux must run inside tmux.\nStart a tmux session first, or pass --no-tmux-guard to override.");
  process.exit(1);
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

async function isOpencodeHealthy(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const resp = await fetch(`${url}/health`, { signal: ctrl.signal }).catch(() => null);
    return resp?.ok ?? false;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

let baseUrl: string;
let serverHandle: ServerHandle | null = null;

if (!isNaN(attachPort)) {
  baseUrl = `http://127.0.0.1:${attachPort}`;
  if (!(await isOpencodeHealthy(baseUrl))) {
    console.error(`health: failed — no opencode server on port ${attachPort}`);
    process.exit(1);
  }
} else {
  const port = await findFreePort(4096, 4106);
  if (port === null) { console.error("no free port in [4096, 4106]"); process.exit(1); }
  console.log(`spawning opencode server on port ${port}…`);
  try {
    serverHandle = await spawnOpencodeServer(port);
  } catch (err) {
    console.error(`failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  baseUrl = serverHandle.url;
}

process.on("SIGTERM", async () => { await serverHandle?.dispose(); process.exit(0); });

// ─── SDK: client / session / event stream ────────────────────────────────────

const client    = createOpencodeClient({ baseUrl });
const session   = await client.session.create({});
const sessionID = session.data!.id;
const eventStream = await client.global.event({});

// ─── Render ───────────────────────────────────────────────────────────────────

render(
  <App
    client={client}
    sessionID={sessionID}
    sessionLabel={sessionID.slice(0, 8)}
    eventStream={eventStream.stream}
    onExit={async () => { await serverHandle?.dispose(); }}
  />,
  { exitOnCtrlC: false }
);
