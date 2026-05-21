import { render } from "ink";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { findFreePort, spawnOpencodeServer, type ServerHandle } from "./server-lifecycle.ts";
import { App } from "./app.tsx";
import { Visibility } from "./renderer/visibility.ts";
import { StdoutRenderer } from "./renderer/stdout.ts";
import { TmuxPaneRenderer } from "./renderer/tmux-pane.ts";
import type { Renderer } from "./renderer/types.ts";

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
  --no-tmux-guard           allow running outside tmux (scripts / CI)
  --multi-pane              split into tmux panes (thinking + tool side panes)`);
  process.exit(0);
}

if (args.includes("--version")) {
  console.log("0.0.0");
  process.exit(0);
}

const noTmuxGuard = args.includes("--no-tmux-guard");
const attachIdx   = args.indexOf("--attach");
const attachPort  = attachIdx !== -1 ? parseInt(args[attachIdx + 1], 10) : NaN;
const multiPane   = args.includes("--multi-pane");
const originPaneId = process.env.TMUX_PANE ?? "";

if (!process.env.TMUX && !noTmuxGuard) {
  console.error("octmux must run inside tmux.\nStart a tmux session first, or pass --no-tmux-guard to override.");
  process.exit(1);
}

if (multiPane && !process.env.TMUX_PANE) {
  console.error("octmux --multi-pane requires running inside tmux (TMUX_PANE not set).");
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

process.on("SIGTERM", async () => { await serverHandle?.dispose(); await renderer.dispose(); process.exit(0); });

// ─── SDK: client / session / event stream ────────────────────────────────────

const client    = createOpencodeClient({ baseUrl });
const session   = await client.session.create({});
const sessionID = session.data!.id;
const eventStream = await client.global.event({});

// ─── Terminal setup ─────────────────────────────────────────────────────────

// Alternate scroll mode: wheel events arrive as ↑/↓ arrow keys.
// Does NOT intercept button clicks, so text selection keeps working.
process.stdout.write("\x1b[?1007h");
process.on("exit", () => { try { process.stdout.write("\x1b[?1007l"); } catch {} });

// Clear terminal and position cursor so the input area anchors at the bottom.
// Dynamic area minimum height:
//   Rule(1) + Input(1) + Rule(1) + StatusLine(1) + marginBottom(3) = 7 lines.
// The 4-line status area = StatusLine(1) + 3 reserved blank lines.
const _rows = process.stdout.rows ?? 24;
process.stdout.write('\x1b[2J\x1b[H'); // clear entire screen, cursor home
const _pad = Math.max(0, _rows - 7);
if (_pad > 0) process.stdout.write('\n'.repeat(_pad));

// ─── Render ───────────────────────────────────────────────────────────────────

const visibility = new Visibility();
let renderer: Renderer;
if (multiPane) {
  const tmuxRenderer = new TmuxPaneRenderer(visibility);
  await tmuxRenderer.setup(originPaneId);
  renderer = tmuxRenderer;
} else {
  renderer = new StdoutRenderer(visibility);
}

render(
  <App
    client={client}
    sessionID={sessionID}
    sessionLabel={sessionID.slice(0, 8)}
    eventStream={eventStream.stream}
    onExit={async () => { await serverHandle?.dispose(); await renderer.dispose(); }}
    baseUrl={baseUrl}
    renderer={renderer}
  />,
  { exitOnCtrlC: false }
);
