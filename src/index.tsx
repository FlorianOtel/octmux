import { render } from "ink";
// @ts-expect-error — reaching into Ink's internal instance map for the Ctrl-l repaint path.
// Package exports field doesn't expose this, so use a relative path to the file directly.
import inkInstancesMap from "../node_modules/ink/build/instances.js";
import { execFileSync } from "node:child_process";
import { setAuthPassword } from "./auth-headers.ts";
import { loadOctmuxConfig, mapServerDirectory, type OctmuxConfig } from "./octmux-config.ts";
import { detectProtocol, compareVersions, BUNDLED_OC_CLIENT_VERSION } from "./protocol-detect.ts";
import { redactUrl } from "./utils/redact-url.ts";
import { App } from "./app.tsx";
import { V2Backend, DEFAULT_CONFIG_HINT } from "./backend/v2.ts";
import type { Backend } from "./backend/types.ts";
import { Visibility } from "./renderer/visibility.ts";
import { BlockBufferRenderer } from "./renderer/block-buffer.ts";
import { TmuxWindowRenderer } from "./renderer/tmux-window.ts";
import type { Renderer } from "./renderer/types.ts";
import { createPasteFilter } from "./paste-filter.ts";
import { deriveWorktreeSlug, deriveWorktreePaths, createWorktree } from "./utils/worktree.ts";

// ─── Build-time constants (injected via bun --define in scripts/build.sh) ────
// These are replaced with string literals in the compiled binary.
// In dev mode (bun run src/index.tsx) they are undefined; version block falls back to 'dev'.
declare const BUILD_BRANCH: string | undefined;
declare const BUILD_COMMIT: string | undefined;
declare const BUILD_DATE:   string | undefined;

// ─── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const HELP = `octmux — text REPL UI for opencode

Display mode (required — select one):
  --single          single-pane mode: all output inline (works in tmux and plain terminal)
  --multi-window    side windows for thinking + tool output (requires active tmux pane)

Options:
  --endpoint <url>  endpoint of running opencode server (default: http://127.0.0.1:4096)
  --config <path>   path to octmux.json (default: ~/.config/octmux/octmux.json)
  --no-tmux-guard   skip tmux pane-context checks (for --multi-window in CI)
  --resume <id>     resume a past session by ID
  --resume-last     resume the most recently updated session
  --fork <id>       fork a past session by ID (creates a child, attaches to it)
  -w, --worktree [<name>]  create a git worktree on a new branch and start there
                    bare -w → auto slug wt-YYYYMMDD-HHMM; -w <name> → slug=name
                    worktree is a sibling dir <repoRoot>--<slug>; mutually exclusive
                    with --resume, --resume-last, --fork
  --help, -h        show this help
  --version         show version`;

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (args.includes("--version")) {
  const branch = typeof BUILD_BRANCH !== 'undefined' ? BUILD_BRANCH : 'dev';
  const commit = typeof BUILD_COMMIT !== 'undefined' ? BUILD_COMMIT : 'dev';
  const date   = typeof BUILD_DATE   !== 'undefined' ? BUILD_DATE   : 'dev';
  console.log(`octmux ${branch} branch, ${commit} commit, ${date} build`);
  process.exit(0);
}

const noTmuxGuard  = args.includes("--no-tmux-guard");
const endpointIdx  = args.indexOf("--endpoint");
const endpointArg  = endpointIdx !== -1 ? args[endpointIdx + 1] : undefined;
const single       = args.includes("--single");
const multiWindow  = args.includes("--multi-window");
const resumeIdx    = args.indexOf("--resume");
const resumeArg    = resumeIdx !== -1 && args[resumeIdx + 1] && !args[resumeIdx + 1].startsWith("--") ? args[resumeIdx + 1] : undefined;
const resumeLast   = args.includes("--resume-last");
const forkIdx      = args.indexOf("--fork");
const forkArg      = forkIdx !== -1 && args[forkIdx + 1] && !args[forkIdx + 1].startsWith("--") ? args[forkIdx + 1] : undefined;
const worktreeIdx  = args.findIndex(a => a === "-w" || a === "--worktree");
const worktreeFlag = worktreeIdx !== -1;
const worktreeArg  = worktreeFlag && args[worktreeIdx + 1] && !args[worktreeIdx + 1].startsWith("-") ? args[worktreeIdx + 1] : undefined;
// --config <path>: optional explicit config file. A missing value is a usage error (checked below).
const configIdx    = args.indexOf("--config");
const configPathArg = configIdx !== -1 && args[configIdx + 1] && !args[configIdx + 1].startsWith("--") ? args[configIdx + 1] : undefined;

// --resume, --resume-last, --fork are mutually exclusive (each picks a different initial session).
if ([resumeArg, resumeLast, forkArg].filter(Boolean).length > 1) {
  console.error("octmux: --resume, --resume-last, and --fork are mutually exclusive");
  process.exit(2);
}

// --worktree is mutually exclusive with --resume, --resume-last, and --fork.
if (worktreeFlag && (resumeArg || resumeLast || forkArg)) {
  console.error("octmux: --worktree is mutually exclusive with --resume, --resume-last, and --fork");
  process.exit(2);
}

// --config must be followed by a path. Same exit code as the other usage errors.
if (configIdx !== -1 && configPathArg === undefined) {
  console.error("octmux: --config requires a path argument");
  process.exit(2);
}

// ─── Config file + auth password (must run before any SDK client is built) ───
// Loaded here, BEFORE endpoint resolution and BEFORE the Backend is constructed.
// The @opencode/client SDK snapshots headers at client construction, so the password
// must already be stored by setAuthPassword() when the clients are constructed.
// Null means no config file at the default path, which is normal.
let loadedConfig: { config: OctmuxConfig; path: string } | null = null;
try {
  loadedConfig = loadOctmuxConfig(configPathArg);
} catch (err) {
  // Config errors are already self-describing and name the file, so only the prefix is added here.
  console.error(`octmux: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
setAuthPassword(loadedConfig?.config.server?.password);

// --worktree creates a directory on THIS machine and chdirs into it. server.directory names a
// path the server sees, which may be another host, so octmux cannot route the session to a local
// worktree. Refuse the combination instead of silently ignoring one of the two.
if (worktreeFlag && loadedConfig?.config.server?.directory !== undefined) {
  console.error(
    `octmux: --worktree cannot be combined with server.directory (set in ${loadedConfig.path}): ` +
    "the server cannot see a local worktree path. Remove server.directory, or drop --worktree.",
  );
  process.exit(2);
}

// ─── Endpoint resolution ─────────────────────────────────────────────────────
// Precedence: --endpoint flag > config server.url > DEFAULT_ENDPOINT.
// The flag and the config value go through the same URL validation and normalisation
// (new URL(), then strip the trailing slash).
const DEFAULT_ENDPOINT = "http://127.0.0.1:4096";
const configUrlRaw = loadedConfig?.config.server?.url;
let endpointUrl: string;
// Records where the endpoint came from, so the unreachable message can say so.
let endpointSource: "flag" | "config" | "default";
if (endpointArg !== undefined) {
  try {
    endpointUrl = new URL(endpointArg).toString().replace(/\/$/, "");
  } catch {
    // The value is deliberately not echoed: an unparseable string may still carry credentials.
    console.error("octmux: invalid --endpoint URL (not parseable)");
    process.exit(2);
  }
  endpointSource = "flag";
} else if (configUrlRaw !== undefined) {
  try {
    endpointUrl = new URL(configUrlRaw).toString().replace(/\/$/, "");
  } catch {
    // The value is deliberately not echoed: a URL can carry credentials.
    console.error(`octmux: invalid server.url in ${loadedConfig?.path}: not a valid URL`);
    process.exit(1);
  }
  endpointSource = "config";
} else {
  endpointUrl = DEFAULT_ENDPOINT;
  endpointSource = "default";
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
    // `tty` prints stdin's device path and works on Linux and macOS (/proc is Linux-only).
    const myTty   = execFileSync("tty", { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"] }).trim();
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

// ─── Worktree setup (-w / --worktree) ────────────────────────────────────────
// Module-scope variables for worktree path and branch (read by startup banner in STEP 5)
let worktreePath = "";
let worktreeBranch = "";

// Must run AFTER arg validation and BEFORE the protocol-detection block + the
// `const cwd = process.cwd()` capture (line ~199). chdir-before-capture makes the
// SDK client directory, session.create, fetchGitBranch, projectName, and
// orchestra-watch all target the worktree automatically.
if (worktreeFlag) {
  let repoRoot = "";
  try {
    // stdio: capture stdout (pipe), but silence git's own stderr ("fatal: not a
    // git repository …") — we print our own clean message in the catch below.
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.error("octmux: --worktree requires a git repository (git rev-parse --show-toplevel failed)");
    process.exit(1);
  }
  let slug: string;
  try {
    slug = deriveWorktreeSlug(worktreeArg);
  } catch (err) {
    console.error(`octmux: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const derived = deriveWorktreePaths(repoRoot, slug);
  worktreePath = derived.worktreePath;
  worktreeBranch = derived.branchName;
  try {
    createWorktree(repoRoot, worktreePath, worktreeBranch);
  } catch (err) {
    console.error(`octmux: failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  process.chdir(worktreePath);
  console.log(`worktree: ${worktreePath}  branch: ${worktreeBranch}`);
  process.on("exit", () => {
    try { process.stdout.write(`\n[octmux] worktree preserved at: ${worktreePath} (remove with: git worktree remove ${worktreePath})\n`); } catch {}
  });
}

// ─── Protocol detection ───────────────────────────────────────────────────────

// Connect to the endpoint from --endpoint, config server.url, or the default. The default is
// http://127.0.0.1:4096, the systemd user service.
const baseUrl = endpointUrl;

// Probe the endpoint and learn which protocol it speaks. octmux is a v2-only client. Each outcome
// below either continues (v2) or exits with a message that names the file and key to fix.
// Secrets are never printed.
const protocol = await detectProtocol(baseUrl);
const hasPassword = loadedConfig?.config.server?.password !== undefined;
// Every message below that shows the endpoint uses this credential-free form.
const displayUrl = redactUrl(baseUrl);
// Path shown in messages. When no config file exists, loadOctmuxConfig returns null
// and the path that was checked is the default location.
const configPathLabel = loadedConfig?.path ?? "~/.config/octmux/octmux.json";

if (protocol.kind === "v1") {
  // A v1 server is refused with the reason. octmux has no v1 backend (Stage 15.5).
  console.error(
    `octmux: OpenCode v1 server detected at ${displayUrl} — v1 is no longer supported.\n` +
    `octmux is a v2-only client (@opencode/client ${BUNDLED_OC_CLIENT_VERSION}). ` +
    "Point --endpoint at a v2 server, or upgrade this server to OpenCode v2.",
  );
  process.exit(1);
} else if (protocol.kind === "v2-unauthorized") {
  // The server answered 401, so it requires a password.
  if (!hasPassword) {
    console.error(`octmux: OpenCode v2 server at ${displayUrl} requires authentication — set server.password in ${configPathLabel}`);
  } else {
    // A password was sent and rejected. Name the file, never the value.
    console.error(`octmux: credentials from ${configPathLabel} (server.password) were rejected by ${displayUrl}`);
  }
  process.exit(1);
} else if (protocol.kind === "v2-authorized") {
  // A v2 server is reachable and auth works. Version gating runs first: a major mismatch
  // still refuses, and minor differences only print a warning before startup continues on v2.
  const { version } = protocol;
  const gate = compareVersions(version, BUNDLED_OC_CLIENT_VERSION);
  if (gate === "major-mismatch") {
    console.error(`octmux: OpenCode server ${version} major version differs from bundled client ${BUNDLED_OC_CLIENT_VERSION} — refusing`);
    process.exit(1);
  } else if (gate === "server-newer-minor") {
    console.error(`octmux: OpenCode server ${version} is newer than the bundled client ${BUNDLED_OC_CLIENT_VERSION} (same major version)`);
  } else if (gate === "server-older-minor") {
    console.warn(`⚠ octmux: OpenCode server ${version} is OLDER than the bundled client ${BUNDLED_OC_CLIENT_VERSION} — some requests may be rejected`);
  } else if (gate === "unparseable") {
    console.warn(`⚠ octmux: could not compare OpenCode server version ${version} with bundled client ${BUNDLED_OC_CLIENT_VERSION}`);
  }
  // gate === "exact" prints nothing extra. No success line: startup prints nothing new on v2.
} else {
  // "unreachable": no protocol identified at this endpoint. Keep the rich hints for the
  // default and config-sourced endpoints. An explicit --endpoint gets the short form.
  if (endpointSource !== "flag") {
    const origin = endpointSource === "config" ? `config ${loadedConfig?.path}` : "default";
    console.error(
      `✗  no opencode server at ${displayUrl} (${origin}).\n` +
      `\n` +
      `Start the server first, then retry:\n` +
      `  systemctl --user start opencode-server  # systemd user service\n` +
      `  opencode serve --port 4096             # or manually\n` +
      `\n` +
      `To connect to a different endpoint:\n` +
      `  octmux --endpoint <url>\n` +
      `\n` +
      `probe detail: ${protocol.detail}`
    );
  } else {
    console.error(`health: failed — no opencode server at ${displayUrl} (${protocol.detail})`);
  }
  process.exit(1);
}

process.on("SIGTERM", async () => { await renderer.dispose(); process.exit(0); });

// ─── SDK: client / session / event stream ────────────────────────────────────

// Capture the operator's working directory once. It stays LOCAL: the git branch probe, the
// worktree logic, the command registry, and the orchestra session files all use it.
const cwd = process.cwd();

// The directory octmux sends to the server as a session location (the v2 `location` parameter).
// It is a path AS THE SERVER SEES IT, chosen in this order (the config loader refuses both keys together and checks they are absolute):
//   1. server.directory: one fixed server path.
//   2. server.directoryMap: the local cwd with its longest matching prefix rewritten, for a server
//      that mounts the same storage elsewhere (e.g. "/mnt/nfs" here, "/Volumes/Disks" on a Mac).
//   3. The local cwd unchanged: correct when the server runs on this machine.
// Whether the server actually has the directory is checked below (checkServerLocation).
const configServerDirectory = loadedConfig?.config.server?.directory;
const directoryMap = loadedConfig?.config.server?.directoryMap;
const mappedDirectory = directoryMap !== undefined ? mapServerDirectory(cwd, directoryMap) : undefined;
const serverDirectory = configServerDirectory ?? mappedDirectory ?? cwd;
if (configServerDirectory !== undefined) {
  console.log(`octmux: using server directory ${serverDirectory} (from ${loadedConfig!.path})`);
} else if (mappedDirectory !== undefined) {
  console.log(`octmux: using server directory ${serverDirectory} (${cwd} mapped by server.directoryMap in ${loadedConfig!.path})`);
} else if (directoryMap !== undefined) {
  console.log(`octmux: no server.directoryMap prefix matches ${cwd}; sending it unchanged`);
}

// Startup session operations (get/list/fork/create below) go through the Backend seam.
// configHint names the config file in v2 LocationNotFoundError messages (the file that sets server.directory).
const bootstrapBackend: Backend = new V2Backend(baseUrl, serverDirectory, undefined, loadedConfig?.path ?? DEFAULT_CONFIG_HINT);

// Exits (code 1) unless the server can resolve `directory` as a location. Runs before octmux creates,
// forks or attaches to a session there, so octmux never makes the server record a project at a path it
// does not have. `what` says which directory is checked, e.g. "session ses_abc's directory".
async function checkServerLocation(directory: string, what: string): Promise<void> {
  try {
    await bootstrapBackend.checkLocation(directory);
  } catch (err) {
    console.error(`octmux: cannot use ${what} on the server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Every startup mode except --resume <id> works in serverDirectory: create and fork write there, and
// --resume-last lists the sessions there. --resume <id> only needs the resumed session's own directory,
// which is checked once the session is fetched.
if (!resumeArg) {
  await checkServerLocation(serverDirectory, `the server directory ${serverDirectory}`);
}

// Determine which session to use: resume by ID, resume last, fork, or create new.
// Capture both banner and sessionLabel: banner for startup confirmation, sessionLabel for chrome.
let sessionID: string;
let sessionLabel: string;
let startupBanner: string | null = null;
let resolvedDirectory: string | undefined;
if (resumeArg) {
  // --resume <id>: validate that the session exists
  try {
    const resumed = await bootstrapBackend.session.get(resumeArg);
    if (!resumed?.id) {
      console.error(`octmux: session not found: ${resumeArg}`);
      process.exit(1);
    }
    await checkServerLocation(resumed.directory, `session ${resumeArg}'s directory ${resumed.directory}`);
    sessionID = resumeArg;
    const title = resumed.title ?? "";
    sessionLabel = title || sessionID.slice(0, 8);
    startupBanner = `resumed session ${sessionID.slice(0, 8)}${title ? ` — "${title}"` : ""}`;
    resolvedDirectory = resumed.directory;
  } catch (err) {
    console.error(`octmux: failed to resume session ${resumeArg}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (resumeLast) {
  // --resume-last: find the most recently updated session
  try {
    const sessions = (await bootstrapBackend.session.list()) ?? [];
    if (sessions.length === 0) {
      console.error("octmux: no sessions found to resume");
      process.exit(1);
    }
    // Sort by time.updated descending
    sessions.sort((a, b) => b.time.updated - a.time.updated);
    if (sessions[0].directory !== serverDirectory) {
      await checkServerLocation(sessions[0].directory, `session ${sessions[0].id}'s directory ${sessions[0].directory}`);
    }
    sessionID = sessions[0].id;
    const title = sessions[0].title ?? "";
    sessionLabel = title || sessionID.slice(0, 8);
    startupBanner = `resumed session ${sessionID.slice(0, 8)}${title ? ` — "${title}"` : ""} (most recent)`;
    resolvedDirectory = sessions[0].directory;
  } catch (err) {
    console.error(`octmux: failed to list sessions: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (forkArg) {
  // --fork <id>: validate parent exists, then fork it and attach to the child.
  try {
    const parent = await bootstrapBackend.session.get(forkArg);
    if (!parent?.id) {
      console.error(`octmux: parent session not found: ${forkArg}`);
      process.exit(1);
    }
    // On v2 the fork ignores `directory` (v2 session.fork has no directory input); the child keeps the parent's
    // location. So check the parent's directory too, before the fork creates a child there.
    if (parent.directory !== serverDirectory) {
      await checkServerLocation(parent.directory, `session ${forkArg}'s directory ${parent.directory}`);
    }
    const child = await bootstrapBackend.session.fork(forkArg, { directory: serverDirectory });
    if (!child?.id) {
      console.error(`octmux: fork returned no child session for parent ${forkArg}`);
      process.exit(1);
    }
    sessionID = child.id;
    sessionLabel = sessionID.slice(0, 8);
    startupBanner = `forked from ${forkArg.slice(0, 8)} → ${sessionID.slice(0, 8)}`;
    resolvedDirectory = child.directory;
  } catch (err) {
    console.error(`octmux: failed to fork session ${forkArg}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else {
  // Default: create a new session anchored to the server directory (the launch directory unless
  // server.directory is set). Without this, OC inherits the daemon's cwd ($HOME) instead.
  // v2 write operations reject with a readable message (e.g. LocationNotFoundError); report it
  // like the resume/fork paths above do, without a stack.
  let session;
  try {
    session = await bootstrapBackend.session.create({ directory: serverDirectory });
  } catch (err) {
    console.error(`octmux: could not create a session: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  sessionID = session!.id;
  sessionLabel = sessionID.slice(0, 8);
}

// Rebind to the resolved session's own directory if it differs from the server directory.
// This ensures the SSE subscription subscribes to events in the correct project directory.
// resolvedDirectory is a server-side path, so it is compared with serverDirectory, not the local cwd.
const effectiveServerDirectory = resolvedDirectory && resolvedDirectory !== serverDirectory
  ? resolvedDirectory
  : serverDirectory;

// The REPL's Backend. v2 needs only baseUrl and effectiveServerDirectory. The initial SSE
// subscription goes through backend.subscribeEvents() so the event stream has a single owner behind the seam.
// configHint: see bootstrapBackend above.
const backend: Backend = new V2Backend(baseUrl, effectiveServerDirectory, undefined, loadedConfig?.path ?? DEFAULT_CONFIG_HINT);

const eventStream = await backend.subscribeEvents();

// ─── Terminal setup (alternate scroll mode + bracketed paste) ──

// Alternate scroll mode: wheel events arrive as ↑/↓ arrow keys.
// Does NOT intercept button clicks, so text selection keeps working.
process.stdout.write("\x1b[?1007h");
process.on("exit", () => { try { process.stdout.write("\x1b[?1007l"); } catch {} });

// Bracketed paste mode: allow detection of multi-line pastes
process.stdout.write("\x1b[?2004h");
process.on("exit", () => { try { process.stdout.write("\x1b[?2004l"); } catch {} });

// ─── Renderer construction ────────────────────────────────────────────────────────

const visibility = new Visibility();
  let renderer: Renderer;
  if (multiWindow) {
    const tmuxRenderer = new TmuxWindowRenderer(visibility);
    await tmuxRenderer.setup(sessionID.slice(0, 8));
    await new Promise(res => setImmediate(res));
    renderer = tmuxRenderer;
  } else {
    // Unconditionally use BlockBufferRenderer for --single mode
    renderer = new BlockBufferRenderer(visibility);
  }

// Emit the startup banner so it appears in the first Ink frame (via the
// renderer's committed lines). Only set for --resume / --resume-last / --fork.
if (startupBanner) {
  renderer.commitSystemMessage(startupBanner);
}

if (worktreeFlag) {
  renderer.commitSystemMessage(`worktree: ${worktreePath}  branch: ${worktreeBranch}  (orchestra: verify agent frontmatter — KP-2)`);
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

// Create the paste filter: transforms stdin to intercept bracketed-paste sequences.
// Ink reads from the stream's readable side; pastes are routed to a callback.
const pasteFilter = createPasteFilter(process.stdin);

// Stub-closure pattern: define a placeholder onRedraw function, then fill it in
// after render() returns. This breaks the circular dependency where <App> needs
// onRedraw (which needs the Ink instance) and the Ink instance needs <App>.
let onRedraw: () => void = () => {};
const appElement = (
  <App
    backend={backend}
    serverDirectory={serverDirectory}
    sessionID={sessionID}
    sessionLabel={sessionLabel}
    eventStream={eventStream.stream}
    onExit={async () => { await renderer.dispose(); }}
    renderer={renderer}
    onRedraw={() => onRedraw()}
    setPasteCallback={pasteFilter.setPasteCallback}
    singleMode={single}
  />
);
const inkInstance = render(appElement, { exitOnCtrlC: false, stdin: pasteFilter.stream as unknown as NodeJS.ReadStream });
// Ctrl-l repaint: bypass React entirely. inkInstance.rerender(appElement) goes
// through React's updateContainer; when the root element is reference-equal
// and no fibers have state changes, React skips the commit — so Ink's
// resetAfterCommit (which would fire onRender) never runs.
//
// render() returns a wrapper { rerender, unmount, ..., clear } — the real Ink
// instance with log / lastOutput / onRender lives in Ink's internal WeakMap
// keyed by stdout. Reach in there to drive a paint directly:
//   1. log.clear()       — wipe log-update's internal previousOutput + erase
//                          the dynamic region on screen
//   2. lastOutput = ""   — defeat Ink's onRender output-diff short-circuit
//                          (otherwise output === lastOutput → no write)
//   3. onRender()        — synchronously read the Yoga tree and re-emit to
//                          stdout, no React commit required
const inkRaw = (inkInstancesMap as WeakMap<NodeJS.WriteStream, {
  log: ((s: string) => void) & { clear: () => void };
  lastOutput: string;
  onRender: () => void;
}>).get(process.stdout);
onRedraw = () => {
  if (!inkRaw) return;
  inkRaw.log.clear();
  inkRaw.lastOutput = "";
  inkRaw.onRender();
};

// Stage 10.4 — SIGWINCH repaint hook. Terminal resize fires SIGWINCH; the
// bounded active region needs a fresh paint at the new width. The width
// change also flows through `useStdout().columns` → the `useEffect(...
// renderer.setWidth(w), [w, renderer])` in <App>, which re-renders the
// active block at the new width. We route through the same `onRedraw`
// closure as Ctrl-l: `inkRaw.log.clear()` + `lastOutput=""` + `onRender()`.
process.on("SIGWINCH", onRedraw);
process.on("exit", () => { try { process.off("SIGWINCH", onRedraw); } catch {} });
