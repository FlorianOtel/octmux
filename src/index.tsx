import { render } from "ink";
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { findFreePort, spawnOpencodeServer, type ServerHandle } from "./server-lifecycle.ts";
import { App } from "./app.tsx";
import { Visibility } from "./renderer/visibility.ts";
import { StdoutRenderer } from "./renderer/stdout.ts";
import { TmuxPaneRenderer } from "./renderer/tmux-pane.ts";
import { TmuxWindowRenderer } from "./renderer/tmux-window.ts";
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
  --multi-pane              split into tmux panes (thinking + tool side panes)
  --multi-window            split into tmux windows (thinking + tool side windows)`);
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
const multiWindow = args.includes("--multi-window");
const originPaneId = process.env.TMUX_PANE ?? "";

if (!process.env.TMUX && !noTmuxGuard) {
  console.error("octmux must run inside tmux.\nStart a tmux session first, or pass --no-tmux-guard to override.");
  process.exit(1);
}

if (multiPane && multiWindow) {
  console.error("octmux: --multi-pane and --multi-window are mutually exclusive");
  process.exit(2);
}
if (multiPane || multiWindow) {
  if (!process.env.TMUX || !process.env.TMUX_PANE) {
    console.error("octmux --multi-pane/--multi-window requires running inside a tmux pane (TMUX/TMUX_PANE not set).");
    process.exit(1);
  }
  try {
    const myTty   = readlinkSync("/proc/self/fd/0");
    const paneTty = execFileSync("tmux", [
      "display-message", "-p", "-t", process.env.TMUX_PANE, "#{pane_tty}",
    ], { encoding: "utf8" }).trim();
    if (myTty !== paneTty) {
      console.error(
        `octmux --multi-pane/--multi-window: TMUX_PANE env is stale (inherited from tmux, not running inside it).\n` +
        `  This process stdin: ${myTty}\n` +
        `  Pane ${process.env.TMUX_PANE} PTY:  ${paneTty}\n` +
        `Run octmux from inside an actual tmux pane.`
      );
      process.exit(1);
    }
  } catch {
    console.error("octmux: could not verify tmux pane context. Run from inside a tmux pane.");
    process.exit(1);
  }
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

// ─── Terminal setup (alternate scroll mode only — clear happens after renderer setup) ──

// Alternate scroll mode: wheel events arrive as ↑/↓ arrow keys.
// Does NOT intercept button clicks, so text selection keeps working.
process.stdout.write("\x1b[?1007h");
process.on("exit", () => { try { process.stdout.write("\x1b[?1007l"); } catch {} });

// ─── Renderer construction (must come before terminal clear for multi-pane) ──────────
// In --multi-pane mode, setup() calls tmux split-window which sends SIGWINCH and resizes
// the main pane. The terminal clear + cursor positioning must happen AFTER the resize so
// process.stdout.rows/columns reflect the actual (narrower) pane dimensions.

const visibility = new Visibility();
let renderer: Renderer;
if (multiWindow) {
  const tmuxRenderer = new TmuxWindowRenderer(visibility);
  await tmuxRenderer.setup();
  await new Promise(res => setImmediate(res));
  renderer = tmuxRenderer;
} else if (multiPane) {
  const tmuxRenderer = new TmuxPaneRenderer(visibility);
  await tmuxRenderer.setup(originPaneId);
  // Yield to the event loop so SIGWINCH from pane splits updates stdout.rows/columns.
  await new Promise(res => setImmediate(res));
  renderer = tmuxRenderer;
} else {
  renderer = new StdoutRenderer(visibility);
}

// ─── Terminal clear + cursor anchor ──────────────────────────────────────────────────
// Chrome height: Rule(1) + Input(1) + Rule(1) + StatusLine(1) + marginBottom(2) = 6 lines.
// Use tmux to get the accurate pane height — process.stdout.rows may lag SIGWINCH
// from pane splits and pane-border-status title bars.
let _rows: number;
if (process.env.TMUX) {
  try {
    _rows = parseInt(
      execFileSync("tmux", ["display-message", "-p", "#{pane_height}"]).toString().trim(), 10,
    );
  } catch { _rows = process.stdout.rows ?? 24; }
} else {
  _rows = process.stdout.rows ?? 24;
}
process.stdout.write('\x1b[2J\x1b[H'); // clear entire screen, cursor home
const _pad = Math.max(0, _rows - 6);
if (_pad > 0) process.stdout.write('\n'.repeat(_pad));

// ─── Render ───────────────────────────────────────────────────────────────────

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
