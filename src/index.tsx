import { render } from "ink";
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { findFreePort, spawnOpencodeServer, type ServerHandle } from "./server-lifecycle.ts";
import { App } from "./app.tsx";
import { Visibility } from "./renderer/visibility.ts";
import { StdoutRenderer } from "./renderer/stdout.ts";
import { TmuxWindowRenderer } from "./renderer/tmux-window.ts";
import type { Renderer } from "./renderer/types.ts";
import { loadExternalCommands } from "./command-registry.ts";

// ─── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const HELP = `octmux — text REPL UI for opencode

Display mode (required — select one):
  --single          single-pane mode: all output inline (works in tmux and plain terminal)
  --multi-window    side windows for thinking + tool output (requires active tmux pane)

Options:
  --endpoint <url>  endpoint of running opencode server (default: http://127.0.0.1:4096)
  --auto-spawn      spawn a new opencode server automatically (⚠ see below)
  --no-tmux-guard   skip tmux pane-context checks (for --multi-window in CI)
  --resume <id>     resume a past session by ID
  --resume-last     resume the most recently updated session
  --fork <id>       fork a past session by ID (creates a child, attaches to it)
  --help, -h        show this help
  --version         show version

⚠ --auto-spawn warning:
  Running multiple opencode instances concurrently risks SQLite locking
  errors (second instance crashes) and memory bloat from duplicate MCP/LSP
  processes. Prefer a single persistent server (scripts/opencode-server.service).`;

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (args.includes("--version")) {
  console.log("0.0.0");
  process.exit(0);
}

const noTmuxGuard  = args.includes("--no-tmux-guard");
const endpointIdx  = args.indexOf("--endpoint");
const endpointArg  = endpointIdx !== -1 ? args[endpointIdx + 1] : undefined;
const single       = args.includes("--single");
const multiWindow  = args.includes("--multi-window");
const autoSpawn    = args.includes("--auto-spawn");
const resumeIdx    = args.indexOf("--resume");
const resumeArg    = resumeIdx !== -1 && args[resumeIdx + 1] && !args[resumeIdx + 1].startsWith("--") ? args[resumeIdx + 1] : undefined;
const resumeLast   = args.includes("--resume-last");
const forkIdx      = args.indexOf("--fork");
const forkArg      = forkIdx !== -1 && args[forkIdx + 1] && !args[forkIdx + 1].startsWith("--") ? args[forkIdx + 1] : undefined;

// --resume, --resume-last, --fork are mutually exclusive (each picks a different initial session).
if ([resumeArg, resumeLast, forkArg].filter(Boolean).length > 1) {
  console.error("octmux: --resume, --resume-last, and --fork are mutually exclusive");
  process.exit(2);
}

// Validate and normalise the --endpoint URL (strip trailing slash).
const DEFAULT_ENDPOINT = "http://127.0.0.1:4096";
let endpointUrl: string;
if (endpointArg !== undefined) {
  try {
    endpointUrl = new URL(endpointArg).toString().replace(/\/$/, "");
  } catch {
    console.error(`octmux: invalid --endpoint URL: ${endpointArg}`);
    process.exit(2);
  }
} else {
  endpointUrl = DEFAULT_ENDPOINT;
}

// No display mode selected — operator must choose explicitly.
if (!single && !multiWindow) {
  console.log(HELP);
  process.exit(0);
}

// --single and --multi-window are mutually exclusive.
if ([single, multiWindow].filter(Boolean).length > 1) {
  console.error("octmux: --single and --multi-window are mutually exclusive");
  process.exit(2);
}

// --single works outside tmux; multi-window requires an active tmux session.
if (!single && !process.env.TMUX && !noTmuxGuard) {
  console.error("octmux --multi-window must run inside tmux.\nStart a tmux session first, or pass --no-tmux-guard to override.");
  process.exit(1);
}

if (multiWindow) {
  if (!process.env.TMUX || !process.env.TMUX_PANE) {
    console.error("octmux --multi-window requires running inside a tmux pane (TMUX/TMUX_PANE not set).");
    process.exit(1);
  }
  try {
    const myTty   = readlinkSync("/proc/self/fd/0");
    const paneTty = execFileSync("tmux", [
      "display-message", "-p", "-t", process.env.TMUX_PANE, "#{pane_tty}",
    ], { encoding: "utf8" }).trim();
    if (myTty !== paneTty) {
      console.error(
        `octmux --multi-window: TMUX_PANE env is stale (inherited from tmux, not running inside it).\n` +
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

if (autoSpawn) {
  // Explicit opt-in: spawn a new opencode instance on any free port.
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
} else {
  // Default (no flags) or explicit --endpoint: connect to a running server.
  // Default endpoint is http://127.0.0.1:4096 — the systemd user service.
  baseUrl = endpointUrl;
  const isDefault = endpointArg === undefined;
  if (!(await isOpencodeHealthy(baseUrl))) {
    if (isDefault) {
      console.error(
        `✗  no opencode server at ${baseUrl} (default).\n` +
        `\n` +
        `Start the server first, then retry:\n` +
        `  systemctl --user start opencode-server  # systemd user service\n` +
        `  opencode serve --port 4096             # or manually\n` +
        `\n` +
        `To connect to a different endpoint:\n` +
        `  octmux --endpoint <url>\n` +
        `\n` +
        `--auto-spawn is available but use with caution:\n` +
        `  Multiple opencode instances risk SQLite locking errors and memory\n` +
        `  bloat from duplicate MCP/LSP processes. Prefer the systemd service.\n` +
        `  See scripts/opencode-server.service.`
      );
    } else {
      console.error(`health: failed — no opencode server at ${baseUrl}`);
    }
    process.exit(1);
  }
}

process.on("SIGTERM", async () => { await serverHandle?.dispose(); await renderer.dispose(); process.exit(0); });

// ─── SDK: client / session / event stream ────────────────────────────────────

// Capture the operator's working directory once — threaded to the SDK client and
// all raw fetch() calls so OC's directory-scoped endpoints return the right data.
const cwd = process.cwd();

const client    = createOpencodeClient({ baseUrl, directory: cwd });

// Determine which session to use: resume by ID, resume last, fork, or create new.
// Capture both banner and sessionLabel: banner for startup confirmation, sessionLabel for chrome.
let sessionID: string;
let sessionLabel: string;
let startupBanner: string | null = null;
if (resumeArg) {
  // --resume <id>: validate that the session exists
  try {
    const resp = await client.session.get({ path: { id: resumeArg } });
    if (!resp.data?.id) {
      console.error(`octmux: session not found: ${resumeArg}`);
      process.exit(1);
    }
    sessionID = resumeArg;
    const title = resp.data.title ?? "";
    sessionLabel = title || sessionID.slice(0, 8);
    startupBanner = `resumed session ${sessionID.slice(0, 8)}${title ? ` — "${title}"` : ""}`;
  } catch (err) {
    console.error(`octmux: failed to resume session ${resumeArg}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (resumeLast) {
  // --resume-last: find the most recently updated session
  try {
    const resp = await client.session.list();
    const sessions = resp.data ?? [];
    if (sessions.length === 0) {
      console.error("octmux: no sessions found to resume");
      process.exit(1);
    }
    // Sort by time.updated descending
    sessions.sort((a, b) => b.time.updated - a.time.updated);
    sessionID = sessions[0].id;
    const title = sessions[0].title ?? "";
    sessionLabel = title || sessionID.slice(0, 8);
    startupBanner = `resumed session ${sessionID.slice(0, 8)}${title ? ` — "${title}"` : ""} (most recent)`;
  } catch (err) {
    console.error(`octmux: failed to list sessions: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (forkArg) {
  // --fork <id>: validate parent exists, then fork it and attach to the child.
  try {
    const parent = await client.session.get({ path: { id: forkArg } });
    if (!parent.data?.id) {
      console.error(`octmux: parent session not found: ${forkArg}`);
      process.exit(1);
    }
    const child = await client.session.fork({ path: { id: forkArg } });
    if (!child.data?.id) {
      console.error(`octmux: fork returned no child session for parent ${forkArg}`);
      process.exit(1);
    }
    sessionID = child.data.id;
    sessionLabel = sessionID.slice(0, 8);
    startupBanner = `forked from ${forkArg.slice(0, 8)} → ${sessionID.slice(0, 8)}`;
  } catch (err) {
    console.error(`octmux: failed to fork session ${forkArg}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else {
  // Default: create a new session anchored to octmux's launch directory.
  // Without this, OC inherits the daemon's cwd ($HOME) instead of where octmux was invoked.
  const session = await client.session.create({ query: { directory: cwd } });
  sessionID = session.data!.id;
  sessionLabel = sessionID.slice(0, 8);
}

const eventStream = await client.global.event({});

// ─── Terminal setup (alternate scroll mode only — clear happens after renderer setup) ──

// Alternate scroll mode: wheel events arrive as ↑/↓ arrow keys.
// Does NOT intercept button clicks, so text selection keeps working.
process.stdout.write("\x1b[?1007h");
process.on("exit", () => { try { process.stdout.write("\x1b[?1007l"); } catch {} });

// ─── Renderer construction ────────────────────────────────────────────────────────

const visibility = new Visibility();
let renderer: Renderer;
if (multiWindow) {
  const tmuxRenderer = new TmuxWindowRenderer(visibility);
  await tmuxRenderer.setup(sessionID.slice(0, 8));
  await new Promise(res => setImmediate(res));
  renderer = tmuxRenderer;
} else {
  renderer = new StdoutRenderer(visibility);
}

// Emit the startup banner so it appears in the first Ink frame (via the
// renderer's committed lines). Only set for --resume / --resume-last / --fork.
if (startupBanner) {
  renderer.commitSystemMessage(startupBanner);
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

// Populate the command registry with external commands from
// ~/.config/opencode/commands/ so PromptInput highlighting and the slash
// completion overlay cover them from the very first frame.
loadExternalCommands();

// Stub-closure pattern: define a placeholder onRedraw function, then fill it in
// after render() returns. This breaks the circular dependency where <App> needs
// onRedraw (which needs the Ink instance) and the Ink instance needs <App>.
let onRedraw: () => void = () => {};
const appElement = (
  <App
    client={client}
    sessionID={sessionID}
    sessionLabel={sessionLabel}
    eventStream={eventStream.stream}
    onExit={async () => { await serverHandle?.dispose(); await renderer.dispose(); }}
    baseUrl={baseUrl}
    renderer={renderer}
    cwd={cwd}
    onRedraw={() => onRedraw()}
  />
);
const inkInstance = render(appElement, { exitOnCtrlC: false });
onRedraw = () => { inkInstance.clear(); inkInstance.rerender(appElement); };
