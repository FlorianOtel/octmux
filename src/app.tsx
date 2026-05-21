import { Box, Static, Text, useStdout, useInput } from "ink";
import { useState, useEffect, useRef, useCallback } from "react";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";
import { LineEditor } from "./editor.ts";
import { filterEvent, type ReplEvent } from "./events.ts";
import { formatLine, type Role } from "./blocks.ts";
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

type CommittedLine = { id: number; role: Role; ansi: string };

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
  const [committed, setCommitted] = useState<CommittedLine[]>([]);
  const [tail, setTail] = useState<{ role: Role; text: string } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [ctrlcPending, setCtrlcPending] = useState(false);
  const [permission, setPermission] = useState<{ permID: string; title: string } | null>(null);
  const [question, setQuestion] = useState<{ reqID: string; questions: QuestionType[] } | null>(null);
  const [lastSubmitted, setLastSubmitted] = useState<string>("");

  const tailBufRef = useRef<string>("");
  const activeBlockRef = useRef<{ partID: string; role: Role } | null>(null);
  const lastCtrlCRef = useRef<number>(0);
  const ctrlcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;

  function flushTail() {
    if (tailBufRef.current && activeBlockRef.current) {
      const role = activeBlockRef.current.role;
      setCommitted(prev => [...prev, {
        id: nextId++,
        role,
        ansi: formatLine(role, tailBufRef.current, false),
      }]);
      tailBufRef.current = "";
    }
    setTail(null);
    activeBlockRef.current = null;
  }

  function handleBlockDelta(ev: { partID: string; role: Role; text: string }) {
    // Switching blocks: flush the prior tail first.
    if (activeBlockRef.current && activeBlockRef.current.partID !== ev.partID) {
      flushTail();
    }
    activeBlockRef.current = { partID: ev.partID, role: ev.role };
    tailBufRef.current += ev.text;

    // Split off complete lines and commit them to Static.
    let buf = tailBufRef.current;
    let nl = buf.indexOf("\n");
    const newCommits: CommittedLine[] = [];
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      newCommits.push({ id: nextId++, role: ev.role, ansi: formatLine(ev.role, line, false) });
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
    tailBufRef.current = buf;

    if (newCommits.length > 0) setCommitted(prev => [...prev, ...newCommits]);
    setTail(buf ? { role: ev.role, text: buf } : null);
  }

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

        if (ev.kind === "block-delta") {
          handleBlockDelta(ev);

        } else if (ev.kind === "block-end") {
          flushTail();

        } else if (ev.kind === "generating") {
          setIsGenerating(true);

        } else if (ev.kind === "session-idle") {
          flushTail();
          // Blank separator between turns (" " not "" — Ink gives empty string zero height).
          setCommitted(prev => [...prev, { id: nextId++, role: "text", ansi: " " }]);
          setIsGenerating(false);
          setLastSubmitted("");

        } else if (ev.kind === "error") {
          flushTail();
          setIsGenerating(false);
          setCommitted(prev => [...prev, {
            id: nextId++,
            role: "error",
            ansi: formatLine("error", ev.message, true),
          }]);

        } else if (ev.kind === "permission-asked") {
          setPermission({ permID: ev.permID, title: ev.title });

        } else if (ev.kind === "question-asked") {
          setQuestion({ reqID: ev.reqID, questions: ev.questions });
        }
        }
      }
    })();
    return () => { cancelled = true; };
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

  // Send submitted text to the LLM; add to committed immediately so the UI
  // doesn't feel laggy while waiting for the first SSE event.
  const handleSubmit = useCallback(async (text: string) => {
    setLastSubmitted(text);
    setCommitted(prev => [...prev, {
      id: nextId++,
      role: "user",
      ansi: formatLine("user", text, true),
    }]);
    try {
      await props.client.session.promptAsync({
        path: { id: props.sessionID },
        body: { parts: [{ type: "text", text }] },
      });
    } catch (err) {
      setIsGenerating(false);
      setCommitted(prev => [...prev, {
        id: nextId++,
        role: "error",
        ansi: formatLine("error", `[send error] ${err instanceof Error ? err.message : String(err)}`, true),
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
      <Static items={committed}>
        {(item) => <Text key={item.id}>{item.ansi}</Text>}
      </Static>
      {tail && <Text>{formatLine(tail.role, tail.text, false)}</Text>}
      {isGenerating && !tail && <Text dimColor>[generating…]</Text>}
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
