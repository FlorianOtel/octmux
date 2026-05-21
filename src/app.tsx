import { Box, Static, Text, useStdout, useInput } from "ink";
import { useState, useEffect, useRef, useCallback } from "react";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";
import { LineEditor } from "./editor.ts";
import { filterEvent, type ReplEvent } from "./events.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";
import { StatusLine } from "./components/StatusLine.tsx";
import { PermissionModal } from "./components/PermissionModal.tsx";
import { QuestionModal } from "./components/QuestionModal.tsx";

type QuestionType = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

type Client = ReturnType<typeof createOpencodeClient>;

type HistoryEntry = { id: number; role: "user" | "assistant" | "error"; text: string };

type AppProps = {
  client: Client;
  sessionID: string;
  sessionLabel: string;
  eventStream: AsyncIterable<{ payload: unknown }>;
  onExit: () => Promise<void>;
  baseUrl: string;
};

let nextId = 0;

export function App(props: AppProps) {
  const [editor] = useState(() => new LineEditor());
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [streamBuf, setStreamBuf] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [ctrlcPending, setCtrlcPending] = useState(false);
  const [permission, setPermission] = useState<{ permID: string; title: string } | null>(null);
  const [question, setQuestion] = useState<{ reqID: string; questions: QuestionType[] } | null>(null);
  const [lastSubmitted, setLastSubmitted] = useState<string>("");

  const streamBufRef = useRef("");
  const lastCtrlCRef = useRef<number>(0);
  const ctrlcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Batches setStreamBuf calls so Ink repaints at most ~20×/sec instead of
  // once per SSE chunk (which can be 20-50 chunks/sec → visible flicker).
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;

  // SSE loop: runs for the lifetime of the component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const globalEvent of props.eventStream) {
        if (cancelled) break;
        const evRaw = filterEvent(globalEvent.payload as unknown as Event, props.sessionID);
        if (!evRaw) continue;
        const evList: ReplEvent[] = Array.isArray(evRaw) ? evRaw : [evRaw];
        for (const ev of evList) {

        if (ev.kind === "text-delta") {
          // Accumulate via ref; flush to state at most once per 50 ms so Ink
          // doesn't repaint the whole screen on every incoming SSE chunk.
          streamBufRef.current += ev.text;
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              setStreamBuf(streamBufRef.current);
              flushTimerRef.current = null;
            }, 50);
          }

        } else if (ev.kind === "generating") {
          setIsGenerating(true);

        } else if (ev.kind === "session-idle") {
          // Turn complete: flush any pending debounce, commit text to history, reset.
          if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
          const text = streamBufRef.current;
          streamBufRef.current = "";
          setStreamBuf("");
          setIsGenerating(false);
          setLastSubmitted("");
          if (text.trim()) {
            setHistory(h => [...h, { id: nextId++, role: "assistant", text }]);
          }

        } else if (ev.kind === "error") {
          if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
          streamBufRef.current = "";
          setStreamBuf("");
          setIsGenerating(false);
          setHistory(h => [...h, { id: nextId++, role: "error", text: `[error] ${ev.message}` }]);

        } else if (ev.kind === "permission-asked") {
          setPermission({ permID: ev.permID, title: ev.title });

        } else if (ev.kind === "question-asked") {
          setQuestion({ reqID: ev.reqID, questions: ev.questions });
        }
        }
      }
    })();
    return () => {
      cancelled = true;
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    };
  }, [props.client, props.sessionID, props.eventStream]);

  // Ctrl-C: three cases.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isGenerating) {
        // Abort in-flight request; restore last prompt for editing.
        props.client.session.abort({ path: { id: props.sessionID } }).catch(() => {});
        editor.loadText(lastSubmitted);
        setIsGenerating(false);
        return;
      }
      if (editor.getText().trim()) {
        // Non-empty idle buffer: clear it (don't exit, don't prompt).
        editor.clearBuffer();
        return;
      }
      // Empty buffer: double-press to exit.
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
    setLastSubmitted(text);
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

  const handlePermission = useCallback(async (answer: "once" | "always" | "reject") => {
    if (!permission) return;
    await props.client.postSessionIdPermissionsPermissionId({
      path: { id: props.sessionID, permissionID: permission.permID },
      body: { response: answer },
    }).catch(() => {});
    setPermission(null);
  }, [permission, props.client, props.sessionID]);

  const handleQuestion = useCallback(async (answers: string[][]) => {
    if (!question) return;
    await fetch(`${props.baseUrl}/question/${question.reqID}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    }).catch(() => {});
    setQuestion(null);
  }, [question, props.baseUrl]);

  return (
    <>
      <Static items={history}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            <Text
              inverse={item.role === "user"}
              color={item.role === "error" ? "red" : undefined}>
              {item.role === "user" ? `> ${item.text}` : item.text}
            </Text>
            <Text>{" "}</Text>
            <Text>{" "}</Text>
          </Box>
        )}
      </Static>
      {isGenerating && !streamBuf && <Text dimColor>[generating…]</Text>}
      {streamBuf && <Text>{streamBuf}</Text>}
      {ctrlcPending && <Text color="yellow">Press Ctrl-C again to exit</Text>}
      {permission && <PermissionModal title={permission.title} onAnswer={handlePermission} />}
      {question && <QuestionModal questions={question.questions} onAnswer={handleQuestion} />}
      <Box flexDirection="column" marginBottom={3}>
        <Rule title={props.sessionLabel} width={w} align="right" />
        <PromptInput editor={editor} disabled={isGenerating || !!permission || !!question} onSubmit={handleSubmit} />
        <Rule width={w} />
        <StatusLine />
      </Box>
    </>
  );
}
