import { Box, Static, Text, useStdout, useInput } from "ink";
import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";
import { LineEditor } from "./editor.ts";
import { filterEvent, type ReplEvent } from "./events.ts";
import { formatLine } from "./blocks.ts";
import { parseShowCommand } from "./renderer/visibility.ts";
import type { Renderer } from "./renderer/types.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";
import { StatusLine } from "./components/StatusLine.tsx";
import { PermissionModal } from "./components/PermissionModal.tsx";
import { QuestionModal } from "./components/QuestionModal.tsx";
import { SubprocessStatus } from "./components/SubprocessStatus.tsx";

type QuestionType = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

type Client = ReturnType<typeof createOpencodeClient>;

type AppProps = {
  client: Client;
  sessionID: string;
  sessionLabel: string;
  eventStream: AsyncIterable<{ payload: unknown }>;
  onExit: () => Promise<void>;
  baseUrl: string;
  renderer: Renderer;
};

export function App(props: AppProps) {
  const { renderer } = props;
  const [editor] = useState(() => new LineEditor());
  const [isGenerating, setIsGenerating] = useState(false);
  const [ctrlcPending, setCtrlcPending] = useState(false);
  const [permission, setPermission] = useState<{ permID: string; title: string } | null>(null);
  const [question, setQuestion] = useState<{ reqID: string; questions: QuestionType[] } | null>(null);
  const [lastSubmitted, setLastSubmitted] = useState<string>("");
  const [procTimes, setProcTimes] = useState<{ thinking: number | null; tools: number | null }>({ thinking: null, tools: null });

  const lastCtrlCRef = useRef<number>(0);
  const ctrlcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;

  // Subscribe to renderer state — new array reference on every commit means React detects changes.
  const committed = useSyncExternalStore(
    (cb) => { renderer.on("changed", cb); return () => renderer.off("changed", cb); },
    () => renderer.getCommitted(),
  );
  const tail = useSyncExternalStore(
    (cb) => { renderer.on("changed", cb); return () => renderer.off("changed", cb); },
    () => renderer.getTail(),
  );

  // SSE loop: thin translation layer — all rendering delegated to renderer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const globalEvent of props.eventStream) {
        if (cancelled) break;
        const evRaw = filterEvent(globalEvent.payload as unknown as Event, props.sessionID);
        if (!evRaw) continue;
        const evList: ReplEvent[] = Array.isArray(evRaw) ? evRaw : [evRaw];
        for (const ev of evList) {
          if (ev.kind === "block-start") {
            renderer.beginBlock(ev.partID, ev.role, { toolName: ev.toolName });
            if (ev.role === "thinking")
              setProcTimes(p => p.thinking === null ? { ...p, thinking: Date.now() } : p);
            else if (ev.role === "tool-call" || ev.role === "tool-result")
              setProcTimes(p => p.tools === null ? { ...p, tools: Date.now() } : p);
          }
          else if (ev.kind === "block-delta")  renderer.appendToBlock(ev.partID, ev.text);
          else if (ev.kind === "block-end") {
            renderer.endBlock(ev.partID, ev.status);
            if (ev.role === "thinking") setProcTimes(p => ({ ...p, thinking: null }));
            // Clear tools on tool-result end (normal path) or tool-call error (no result follows).
            else if (ev.role === "tool-result" || (ev.role === "tool-call" && ev.status === "error"))
              setProcTimes(p => ({ ...p, tools: null }));
          }
          else if (ev.kind === "error")        { renderer.commitError(ev.message); setIsGenerating(false); }
          else if (ev.kind === "generating")   setIsGenerating(true);
          else if (ev.kind === "session-idle") {
            renderer.commitTurnEnd();
            setIsGenerating(false);
            setLastSubmitted("");
            setProcTimes({ thinking: null, tools: null });
          }
          else if (ev.kind === "permission-asked") setPermission({ permID: ev.permID, title: ev.title });
          else if (ev.kind === "question-asked")   setQuestion({ reqID: ev.reqID, questions: ev.questions });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [props.client, props.sessionID, props.eventStream, renderer]);

  // Ctrl-C: three cases.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isGenerating) {
        props.client.session.abort({ path: { id: props.sessionID } }).catch(() => {});
        editor.loadText(lastSubmitted);
        setIsGenerating(false);
        return;
      }
      if (editor.getText().trim()) {
        editor.clearBuffer();
        return;
      }
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

  const handleSubmit = useCallback(async (text: string) => {
    const showResult = parseShowCommand(text, renderer.visibility);
    if (showResult.handled) {
      renderer.commitUserInput(text);
      renderer.commitSystemMessage(showResult.reply ?? "");
      return;
    }
    setLastSubmitted(text);
    renderer.commitUserInput(text);
    try {
      await props.client.session.promptAsync({
        path: { id: props.sessionID },
        body: { parts: [{ type: "text", text }] },
      });
    } catch (err) {
      setIsGenerating(false);
      renderer.commitError(`[send error] ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [props.client, props.sessionID, renderer]);

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
      <Static items={committed}>
        {(item) => <Text key={item.id}>{item.ansi}</Text>}
      </Static>
      {tail && <Text>{formatLine(tail.role, tail.text, false)}</Text>}
      {isGenerating && !tail && <Text dimColor>[generating…]</Text>}
      {ctrlcPending && <Text color="yellow">Press Ctrl-C again to exit</Text>}
      {permission && <PermissionModal title={permission.title} onAnswer={handlePermission} />}
      {question && <QuestionModal questions={question.questions} onAnswer={handleQuestion} />}
      <Box flexDirection="column" marginBottom={2}>
        <SubprocessStatus thinking={procTimes.thinking} tools={procTimes.tools} />
        <Rule title={props.sessionLabel} width={w} align="right" />
        <PromptInput editor={editor} disabled={isGenerating || !!permission || !!question} onSubmit={handleSubmit} />
        <Rule width={w} />
        <StatusLine vis={renderer.visibility} />
      </Box>
    </>
  );
}
