import { Box, Static, Text, useStdout, useInput, useApp } from "ink";
import { useState, useEffect, useRef, useCallback } from "react";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";
import { LineEditor } from "./editor.ts";
import { filterEvent } from "./events.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";
import { StatusLine } from "./components/StatusLine.tsx";

type Client = ReturnType<typeof createOpencodeClient>;

type HistoryEntry = { id: number; role: "user" | "assistant" | "error"; text: string };

type AppProps = {
  client: Client;
  sessionID: string;
  sessionLabel: string;
  eventStream: AsyncIterable<{ payload: unknown }>;
  onExit: () => Promise<void>;
};

let nextId = 0;

export function App(props: AppProps) {
  const [editor] = useState(() => new LineEditor());
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [streamBuf, setStreamBuf] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [ctrlcPending, setCtrlcPending] = useState(false);

  const streamBufRef = useRef("");
  const lastCtrlCRef = useRef<number>(0);
  const ctrlcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;

  // SSE loop: runs for the lifetime of the component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const globalEvent of props.eventStream) {
        if (cancelled) break;
        const ev = filterEvent(globalEvent.payload as unknown as Event, props.sessionID);
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
          if (text.trim()) {
            setHistory(h => [...h, { id: nextId++, role: "assistant", text }]);
          }

        } else if (ev.kind === "error") {
          streamBufRef.current = "";
          setStreamBuf("");
          setIsGenerating(false);
          setHistory(h => [...h, { id: nextId++, role: "error", text: `[error] ${ev.message}` }]);

        } else if (ev.kind === "permission-asked") {
          // Auto-approve in the harness; a PermissionModal replaces this in 3E.4.
          await props.client.postSessionIdPermissionsPermissionId({
            path: { id: props.sessionID, permissionID: ev.permID },
            body: { response: "once" },
          }).catch(() => {});
        }
      }
    })();
    return () => { cancelled = true; };
  }, [props.client, props.sessionID, props.eventStream]);

  // Double-press Ctrl-C: first press shows a 500ms warning; second exits.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 500) {
        if (ctrlcTimerRef.current) clearTimeout(ctrlcTimerRef.current);
        (async () => { await props.onExit(); process.exit(0); })();
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
    setHistory(h => [...h, { id: nextId++, role: "user", text }]);
    try {
      await props.client.session.promptAsync({
        path: { id: props.sessionID },
        body: { parts: [{ type: "text", text }] },
      });
    } catch (err) {
      setIsGenerating(false);
      setHistory(h => [...h, {
        id: nextId++,
        role: "error",
        text: `[send error] ${err instanceof Error ? err.message : String(err)}`,
      }]);
    }
  }, [props.client, props.sessionID]);

  return (
    <>
      <Static items={history}>
        {(item) => (
          <Text key={item.id}
            inverse={item.role === "user"}
            color={item.role === "error" ? "red" : undefined}>
            {item.role === "user" ? `> ${item.text}` : item.text}
          </Text>
        )}
      </Static>
      {isGenerating && !streamBuf && <Text dimColor>[generating…]</Text>}
      {streamBuf && <Text>{streamBuf}</Text>}
      {ctrlcPending && <Text color="yellow">Press Ctrl-C again to exit</Text>}
      <Box flexDirection="column">
        <Rule title={props.sessionLabel} width={w} align="right" />
        <PromptInput editor={editor} disabled={isGenerating} onSubmit={handleSubmit} />
        <Rule width={w} />
        <StatusLine />
      </Box>
    </>
  );
}
