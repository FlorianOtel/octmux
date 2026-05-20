import { render, Box, Text, useStdout, useInput, useApp } from "ink";
import { useState, useEffect, useRef, useCallback } from "react";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { LineEditor } from "./editor.ts";
import { filterEvent } from "./events.ts";
import { findFreePort, spawnOpencodeServer, type ServerHandle } from "./server-lifecycle.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";

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

// ─── React App ────────────────────────────────────────────────────────────────

type HistoryEntry = { role: "user" | "assistant" | "error"; text: string };

function App() {
  const [editor]       = useState(() => new LineEditor());
  const [history,      setHistory]      = useState<HistoryEntry[]>([]);
  const [streamBuf,    setStreamBuf]    = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [ctrlcPending, setCtrlcPending] = useState(false);

  const streamBufRef   = useRef("");
  const lastCtrlCRef   = useRef<number>(0);
  const ctrlcTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;

  // SSE loop: runs for the lifetime of the component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const globalEvent of eventStream.stream) {
        if (cancelled) break;
        const ev = filterEvent(globalEvent.payload, sessionID);
        if (!ev) continue;

        if (ev.kind === "text-delta") {
          // Accumulate via ref (no re-render per chunk) then flush to state.
          streamBufRef.current += ev.text;
          setStreamBuf(streamBufRef.current);

        } else if (ev.kind === "generating") {
          setIsGenerating(true);

        } else if (ev.kind === "session-idle") {
          // Turn complete: commit the streamed text to history and reset.
          const text = streamBufRef.current;
          streamBufRef.current = "";
          setStreamBuf("");
          setIsGenerating(false);
          if (text.trim()) setHistory(h => [...h, { role: "assistant", text }]);

        } else if (ev.kind === "error") {
          streamBufRef.current = "";
          setStreamBuf("");
          setIsGenerating(false);
          setHistory(h => [...h, { role: "error", text: `[error] ${ev.message}` }]);

        } else if (ev.kind === "permission-asked") {
          // Auto-approve in the harness; a PermissionModal replaces this in 3E.4.
          await client.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID: ev.permID },
            body: { response: "once" },
          }).catch(() => {});
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Double-press Ctrl-C: first press shows a 500ms warning; second exits.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 500) {
        if (ctrlcTimerRef.current) clearTimeout(ctrlcTimerRef.current);
        (async () => { await serverHandle?.dispose(); process.exit(0); })();
      } else {
        setCtrlcPending(true);
        if (ctrlcTimerRef.current) clearTimeout(ctrlcTimerRef.current);
        ctrlcTimerRef.current = setTimeout(() => setCtrlcPending(false), 500);
      }
      lastCtrlCRef.current = now;
    }
  });

  // Send submitted text to the LLM; add to history immediately so the UI
  // doesn't feel laggy while waiting for the first SSE event.
  const handleSubmit = useCallback(async (text: string) => {
    setHistory(h => [...h, { role: "user", text }]);
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      });
    } catch (err) {
      setIsGenerating(false);
      setHistory(h => [...h, {
        role: "error",
        text: `[send error] ${err instanceof Error ? err.message : String(err)}`,
      }]);
    }
  }, []);

  return (
    <>
      {/* Completed exchanges: user lines inverted, assistant lines plain */}
      {history.map((h, i) => (
        <Text key={i} inverse={h.role === "user"} color={h.role === "error" ? "red" : undefined}>
          {h.role === "user" ? `> ${h.text}` : h.text}
        </Text>
      ))}

      {/* Live streaming area */}
      {isGenerating && !streamBuf && <Text dimColor>[generating…]</Text>}
      {streamBuf && <Text>{streamBuf}</Text>}

      {/* Ctrl-C first-press warning */}
      {ctrlcPending && <Text color="yellow">Press Ctrl-C again to exit</Text>}

      {/* Prompt box — 4 lines from terminal bottom via marginBottom */}
      <Box flexDirection="column" marginBottom={4}>
        <Rule title="harness" width={w} align="right" />
        <PromptInput editor={editor} disabled={isGenerating} onSubmit={handleSubmit} />
        <Rule width={w} />
      </Box>
    </>
  );
}

render(<App />, { exitOnCtrlC: false });
