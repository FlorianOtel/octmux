import { Box, Static, Text, useStdout, useInput } from "ink";
import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { LineEditor } from "./editor.ts";
import { filterEvent, type ReplEvent } from "./events.ts";
import { formatLine } from "./blocks.ts";
import { searchRag, formatBlockText, formatPromptPrefix, type RagHit } from "./rag.ts";
import { parseShowCommand, parseBlockOutputCommand, parseExitCommand, parseRenameCommand, parseModelCommand, parseHelpCommand, parseRagCommand } from "./commands.ts";
import type { Renderer } from "./renderer/types.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";
import { StatusLine } from "./components/StatusLine.tsx";
import { PermissionModal } from "./components/PermissionModal.tsx";
import { QuestionModal } from "./components/QuestionModal.tsx";
import { SubprocessStatus } from "./components/SubprocessStatus.tsx";
import { ModelPickerModal, type ModelPickerItem } from "./components/ModelPickerModal.tsx";
import { SlashCompletionOverlay } from "./components/SlashCompletionOverlay.tsx";
import { expandCommands } from "./command-registry.ts";
import { fetchGitBranch, getContextWindow, prettyModelName, contextLabel } from "./utils/formatters.ts";

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
  const [sessionLabel, setSessionLabel] = useState(props.sessionLabel);
  const [activeModel, setActiveModel] = useState<{ providerID: string; modelID: string } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ items: ModelPickerItem[]; idx: number } | null>(null);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [tokenUsage, setTokenUsage] = useState<{ used: number; contextWindow: number } | null>(null);
  const [slashCompletion, setSlashCompletion] = useState<{
    candidates: string[];
    selectedIdx: number;
  } | null>(null);
  const [ragMode, setRagMode] = useState<"on" | "only" | null>(null);

  const lastCtrlCRef = useRef<number>(0);
  const ctrlcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Project name: basename of current working directory
  const projectName = path.basename(process.cwd());

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

  // One-shot: fetch git branch at startup
  useEffect(() => {
    (async () => {
      const branch = await fetchGitBranch();
      setGitBranch(branch);
    })();
  }, []);

  // When model changes: refresh context window in status bar, preserving used tokens.
  // This fires on startup (when setActiveModel is called) and on /model switches.
  useEffect(() => {
    if (!activeModel) return;
    getContextWindow(props.client, activeModel.providerID, activeModel.modelID)
      .then(ctxWindow =>
        setTokenUsage(prev => ({ used: prev?.used ?? 0, contextWindow: ctxWindow }))
      );
  }, [props.client, activeModel]);

  // One-shot: fetch initial model from server and set activeModel.
  // tokenUsage.contextWindow is then set by the activeModel-change effect above.
  useEffect(() => {
    (async () => {
      try {
        const resp = await props.client.session.get({ path: { id: props.sessionID } });
        const sess = resp.data;
        if (sess?.model) {
          setActiveModel({ providerID: sess.model.providerID, modelID: sess.model.id });
        }
      } catch {
        // No model set on session yet; /model command will set activeModel
      }
    })();
  }, [props.client, props.sessionID]);

  // Slash-completion: subscribe to editor changes and recompute overlay state
  useEffect(() => {
    const recompute = () => {
      // Suppress the overlay while the user is scrolling through past history
      // entries. Otherwise reaching a past "/command" entry would auto-open the
      // overlay, the overlay would capture ↑/↓, and the user would be trapped
      // mid-scroll. Once they return to the present draft (↓ past last) or
      // clear/submit, histIdx resets to -1 and the overlay resumes normally.
      if (editor.isInHistoryNav()) {
        setSlashCompletion(null);
        return;
      }
      const lines = editor.getLines();
      const row = editor.getRow();
      const firstLine = lines[0] ?? "";
      // Open only after the operator has typed at least one character past
      // the leading "/" — listing every command on bare "/" is too noisy.
      if (row !== 0 || !firstLine.startsWith("/") || firstLine.length < 2) {
        setSlashCompletion(null);
        return;
      }
      const token = firstLine.split(/\s/)[0];
      const all = expandCommands();
      const filtered = all.filter(c => c.startsWith(token));
      if (firstLine.includes(" ") && filtered.length === 1 && filtered[0] === token) {
        setSlashCompletion(null);
        return;
      }
      setSlashCompletion(prev => ({
        candidates: filtered,
        selectedIdx: prev ? Math.min(prev.selectedIdx, Math.max(0, filtered.length - 1)) : 0,
      }));
    };
    editor.on("changed", recompute);
    recompute();
    return () => editor.off("changed", recompute);
  }, [editor]);

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
          try {
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
              // Async IIFE: fetch latest message tokens and update status bar
              (async () => {
                try {
                  const messagesResp = await props.client.session.messages({ path: { id: props.sessionID } });
                  const messages = messagesResp.data ?? [];
                  // Find latest assistant message
                  let latestAssistant: typeof messages[number] | null = null;
                  for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].info.role === "assistant") {
                      latestAssistant = messages[i];
                      break;
                    }
                  }
                  if (latestAssistant) {
                    const msg = latestAssistant.info;
                    if (msg.role === "assistant") {
                      const tokens = msg.tokens;
                      // Guard: non-Anthropic providers may not populate tokens
                      if (tokens) {
                        const used = tokens.input
                          + (tokens.cache?.read ?? 0)
                          + (tokens.cache?.write ?? 0);
                        // Use the model the server actually responded with, not activeModel state.
                        // Avoids stale-closure timing dependency and handles mid-session model switches.
                        const ctxWindow = await getContextWindow(
                          props.client,
                          msg.providerID,
                          msg.modelID,
                        );
                        setActiveModel({ providerID: msg.providerID, modelID: msg.modelID });
                        setTokenUsage({ used, contextWindow: ctxWindow });
                      }
                    }
                  }
                } catch {
                  // Silently swallow errors; bar stays at last value
                }
              })();
            }
            else if (ev.kind === "permission-asked") setPermission({ permID: ev.permID, title: ev.title });
            else if (ev.kind === "question-asked")   setQuestion({ reqID: ev.reqID, questions: ev.questions });
          } catch (err) {
            renderer.commitError(`[renderer error] ${err instanceof Error ? err.message : String(err)}`);
          }
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

  // Emit a RAG search block: fetch hits, render them, and return hits for reuse.
  async function emitRagBlock(query: string): Promise<RagHit[] | null> {
    const partID = "rag-" + randomUUID();
    renderer.beginBlock(partID, "rag");
    renderer.appendToBlock(partID, "searching…\n");

    const result = await searchRag(query);

    if ("error" in result) {
      renderer.appendToBlock(partID, "[error: " + result.error + "]\n");
      renderer.endBlock(partID, "error");
      return null;
    }

    renderer.appendToBlock(partID, formatBlockText(result.hits) + "\n");
    renderer.endBlock(partID, "ok");
    return result.hits;
  }

  const handleSubmit = useCallback(async (text: string) => {
    // /exit — clean shutdown
    const exitResult = parseExitCommand(text);
    if (exitResult.handled) {
      renderer.commitUserInput(text);
      renderer.commitSystemMessage("exiting…");
      await props.onExit();
      process.exit(0);
      return;
    }
    // /rename <name> — rename session in DB and tmux windows
    const renameResult = parseRenameCommand(text);
    if (renameResult.handled) {
      renderer.commitUserInput(text);
      if (!renameResult.newLabel) {
        renderer.commitSystemMessage("usage: /rename <name>");
      } else {
        try {
          await props.client.session.update({ path: { id: props.sessionID }, body: { title: renameResult.newLabel } });
          renderer.rename(renameResult.newLabel);
          setSessionLabel(renameResult.newLabel);
          renderer.commitSystemMessage(`session renamed to "${renameResult.newLabel}"`);
        } catch (err) {
          renderer.commitSystemMessage(`rename failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    // /model — display or set AI model
    const modelResult = parseModelCommand(text);
    if (modelResult.handled) {
      renderer.commitUserInput(text);
      if (modelResult.action === "list") {
        try {
          const [provResp, sessResp] = await Promise.all([
            // NOTE: provider.list() (GET /provider) returns OpenCode's MERGED view: it combines
            // the user's ~/.config/opencode/opencode.json with OpenCode's full upstream model
            // catalog. The merge happens server-side inside the OpenCode process — the user's
            // config entries take precedence (they can override names, limits, costs, etc.), but
            // every model in OpenCode's built-in registry is also included.
            //
            // "connected" means the provider has an API key available from any source: the user's
            // config file, an environment variable, or occasionally a provider with free/built-in
            // access. It does NOT mean "explicitly configured by the user in opencode.json".
            //
            // As a result, the picker shows more models than the user may have consciously set up
            // — any provider whose key happens to be present in the environment will appear.
            //
            // To show ONLY user-configured models:
            //   - Switch to client.config.providers() (GET /config/providers), which reads
            //     ~/.config/opencode/opencode.json directly and returns Provider[] with a
            //     `source` field: "config" | "env" | "custom" | "api".
            //   - Filter to source !== "api" to exclude upstream-catalog-only entries, or
            //     source === "config" to show only what is explicitly in opencode.json.
            //   - The Provider.models values there are the same Model type with limit.context
            //     guaranteed non-null, so the defensive optional-chaining below is not needed.
            props.client.provider.list(),
            props.client.session.get({ path: { id: props.sessionID } }),
          ]);
          const provData = provResp.data!;
          const sess = sessResp.data!;
          const curProvID  = activeModel?.providerID ?? sess.model?.providerID;
          const curModelID = activeModel?.modelID    ?? sess.model?.id;
          const items: ModelPickerItem[] = [];
          for (const p of provData.all) {
            if (!provData.connected.includes(p.id)) continue;
            for (const [mId, mInfo] of Object.entries(p.models)) {
              // Defensive: limit or limit.context may be absent for catalog-only entries.
              const rawCtx = (mInfo as { limit?: { context?: number } }).limit?.context;
              const ctxLabel = rawCtx
                ? (rawCtx >= 1000 ? `${Math.round(rawCtx / 1000)}k` : String(rawCtx))
                : "?";
              items.push({
                providerID: p.id,
                modelID: mId,
                name: mInfo.name,
                ctxLabel,
                isCurrent: p.id === curProvID && mId === curModelID,
              });
            }
          }
          if (items.length === 0) {
            renderer.commitSystemMessage("no connected providers found — check opencode configuration");
          } else {
            const initialIdx = Math.max(0, items.findIndex(it => it.isCurrent));
            setModelPicker({ items, idx: initialIdx });
          }
        } catch (err) {
          renderer.commitSystemMessage(`/model error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (modelResult.action === "set") {
        setActiveModel({ providerID: modelResult.providerID!, modelID: modelResult.modelID! });
        renderer.commitSystemMessage(`model set to ${modelResult.providerID}/${modelResult.modelID}`);
      } else {
        renderer.commitSystemMessage("usage: /model  or  /model <providerID>/<modelID>");
      }
      return;
    }
    // /help — list all known slash commands
    const helpResult = parseHelpCommand(text);
    if (helpResult.handled) {
      renderer.commitUserInput(text);
      const lines = (helpResult.reply ?? "").split("\n");
      for (const line of lines) renderer.commitSystemMessage(line);
      return;
    }
    // /show — output gate status
    const showResult = parseShowCommand(text, renderer);
    if (showResult.handled) {
      renderer.commitUserInput(text);
      renderer.commitSystemMessage(showResult.reply ?? "");
      return;
    }
    // /<key>-output [on|off] — output gate toggle/query
    const outputResult = parseBlockOutputCommand(text, renderer);
    if (outputResult.handled) {
      renderer.commitUserInput(text);
      renderer.commitSystemMessage(outputResult.reply ?? "");
      return;
    }
    // /rag <search <query> | on | off | only> — RAG mode control
    const ragResult = parseRagCommand(text);
    if (ragResult.handled) {
      renderer.commitUserInput(text);
      switch (ragResult.action) {
        case "search":
          if (!ragResult.query) {
            renderer.commitSystemMessage("usage: /rag search <query>");
            break;
          }
          await emitRagBlock(ragResult.query);
          break;
        case "on":
          setRagMode("on");
          renderer.commitSystemMessage("RAG mode ON — will search SoHoAI before each answer");
          break;
        case "only":
          setRagMode("only");
          renderer.commitSystemMessage("RAG-only mode ON — answers exclusively from retrieved documents");
          break;
        case "off":
          setRagMode(null);
          renderer.commitSystemMessage("RAG mode OFF — answering from training knowledge only");
          break;
        case "status":
        default:
          renderer.commitSystemMessage(
            `rag mode: ${ragMode ?? "off"}  (usage: /rag <search <q> | on | off | only>)`
          );
      }
      return;
    }
    // Default: send to OpenCode server
    setLastSubmitted(text);
    // Auto-search interception: if ragMode is active, emit rag block before the prompt
    if (ragMode !== null) {
      const hits = await emitRagBlock(text);
      const preamble = hits ? formatPromptPrefix(hits, ragMode) : "";
      // In "only" mode with no hits passing threshold: skip sending to OpenCode
      if (ragMode === "only" && !preamble) {
        renderer.commitUserInput(text);
        renderer.commitSystemMessage("no relevant documents found — answer skipped (rag mode = only)");
        return;
      }
      const effectiveText = preamble ? preamble + "\n\n" + text : text;
      renderer.commitUserInput(text);
      try {
        await props.client.session.promptAsync({
          path: { id: props.sessionID },
          body: {
            parts: [{ type: "text", text: effectiveText }],
            ...(activeModel ? { model: activeModel } : {}),
          },
        });
      } catch (err) {
        setIsGenerating(false);
        renderer.commitError(`[send error] ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // Standard path: no RAG mode active
    renderer.commitUserInput(text);
    try {
      await props.client.session.promptAsync({
        path: { id: props.sessionID },
        body: {
          parts: [{ type: "text", text }],
          ...(activeModel ? { model: activeModel } : {}),
        },
      });
    } catch (err) {
      setIsGenerating(false);
      renderer.commitError(`[send error] ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [props.client, props.sessionID, renderer, activeModel, ragMode]);

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

  const handleModelSelect = useCallback((item: ModelPickerItem) => {
    setActiveModel({ providerID: item.providerID, modelID: item.modelID });
    setModelPicker(null);
    renderer.commitSystemMessage(`model set to ${item.providerID}/${item.modelID}`);
  }, [renderer]);

  const handleModelCancel = useCallback(() => {
    setModelPicker(null);
  }, []);

  const handleSlashSelect = useCallback((candidate: string) => {
    editor.loadText(candidate + " ");
    setSlashCompletion(null);
  }, [editor]);

  const handleSlashCancel = useCallback(() => {
    setSlashCompletion(null);
  }, []);

  const handleSlashMoveUp = useCallback(() => {
    setSlashCompletion(prev => {
      if (!prev) return null;
      return {
        ...prev,
        selectedIdx: Math.max(0, prev.selectedIdx - 1),
      };
    });
  }, []);

  const handleSlashMoveDown = useCallback(() => {
    setSlashCompletion(prev => {
      if (!prev) return null;
      return {
        ...prev,
        selectedIdx: Math.min(prev.candidates.length - 1, prev.selectedIdx + 1),
      };
    });
  }, []);

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
      {modelPicker && (
        <ModelPickerModal
          items={modelPicker.items}
          initialIdx={modelPicker.idx}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
        />
      )}
      {slashCompletion && !permission && !question && !modelPicker && (
        <SlashCompletionOverlay
          candidates={slashCompletion.candidates}
          selectedIdx={slashCompletion.selectedIdx}
          onSelect={handleSlashSelect}
          onCancel={handleSlashCancel}
          onMoveUp={handleSlashMoveUp}
          onMoveDown={handleSlashMoveDown}
        />
      )}
      <Box flexDirection="column" marginBottom={2}>
        <SubprocessStatus thinking={procTimes.thinking} tools={procTimes.tools} />
        <Rule title={sessionLabel} width={w} align="right" />
        <PromptInput editor={editor} disabled={isGenerating || !!permission || !!question || !!modelPicker} overlayOpen={!!slashCompletion} onSubmit={handleSubmit} />
        <Rule width={w} />
        <StatusLine
          modelLabel={
            activeModel
              ? `${prettyModelName(activeModel.modelID)} (${contextLabel(tokenUsage?.contextWindow ?? 200_000)})`
              : sessionLabel
          }
          tokenUsage={tokenUsage}
          projectName={projectName}
          gitBranch={gitBranch}
          ragMode={ragMode}
        />
      </Box>
    </>
  );
}
