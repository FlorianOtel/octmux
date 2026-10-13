import { Box, Static, Text, useStdout, useInput, measureElement } from "ink";
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } from "react";
import type { Command as OcCommand } from "@opencode-ai/sdk/client";
import type { Backend } from "./backend/types.ts";
import * as path from "path";
import { LineEditor } from "./editor.ts";
import { UserTurnDebouncer } from "./user-turn-debouncer.ts";
import { OrchestraWatcher, type OrchestraBadge } from "./orchestra-watch.ts";
import type { ReplEvent } from "./events.ts";
import { mintUserMessageID } from "./message-id.ts";
import { formatLine } from "./blocks.ts";
import { parseShowCommand, parseBlockOutputCommand, parseExitCommand, parseRenameCommand, parseModelCommand, parseHelpCommand, parseNewCommand, parseCompactCommand, parseSessionsCommand, parseForkCommand, parseResyncCommand } from "./commands.ts";
import type { Renderer } from "./renderer/types.ts";
import { loadTogglesConfig, getToggleDefaults, rendererGateKey, type ToggleBinding } from "./config.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";
import { ActiveBlock } from "./components/ActiveBlock.tsx";
import { StatusLine } from "./components/StatusLine.tsx";
import { PermissionModal } from "./components/PermissionModal.tsx";
import { PermissionStatusLine } from "./components/PermissionStatusLine.tsx";
import { QuestionModal } from "./components/QuestionModal.tsx";
import { SubprocessStatus } from "./components/SubprocessStatus.tsx";
import { ModelPickerModal, type ModelPickerItem } from "./components/ModelPickerModal.tsx";
import { CompactingModal } from "./components/CompactingModal.tsx";
import { SessionPickerModal, type SessionPickerItem } from "./components/SessionPickerModal.tsx";
import { SlashCompletionOverlay } from "./components/SlashCompletionOverlay.tsx";
import { ToggleStatusLine } from "./components/ToggleStatusLine.tsx";
import { expandCommands } from "./command-registry.ts";
import { fetchGitBranch, getContextWindow, getToolCallSupport, getDefaultModel, prettyModelName, contextLabel, validateModel } from "./utils/formatters.ts";

const TOGGLES_CONFIG = loadTogglesConfig();

type MessageForUsageScan = {
  info: {
    role?: string;
    summary?: boolean | unknown;
    providerID?: string;
    modelID?: string;
    tokens?: {
      input: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
};

type QuestionType = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

/**
 * Stage 5.7.2: Pure helper for token usage scanning with forward-from-summary semantics.
 * Finds the last assistant message with info.summary === true, then scans forward
 * from that boundary for the latest non-summary assistant message with non-zero tokens.
 * If no post-summary assistant exists, falls back to the latest non-summary assistant
 * (mirroring pre-summary backward-walk behavior).
 *
 * @param messages Flat message list shaped after OC SDK Message type
 * @returns { used, providerID, modelID } | null
 */
export function pickPostSummaryAssistantTokenUsage(messages: MessageForUsageScan[]): { used: number; providerID: string | undefined; modelID: string | undefined } | null {
  const assistantMessages = messages.filter(m => m.info.role === "assistant");
  if (assistantMessages.length === 0) return null;

  // Find the last assistant message with summary === true
  let summaryIdx = -1;
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const info = assistantMessages[i].info;
    if (info.summary === true) {
      summaryIdx = i;
      break;
    }
  }

  // No summary exists — use backward-walk semantics (existing behavior)
  if (summaryIdx === -1) {
    // Find latest non-summary assistant message
    let latestIdx = -1;
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      if (assistantMessages[i].info.summary !== true) {
        latestIdx = i;
        break;
      }
    }

    if (latestIdx === -1) {
      // All assistants are summaries — return null
      return null;
    }

    // Get tokens from latest non-summary assistant
    const msg = assistantMessages[latestIdx];
    const tokens = msg.info.tokens;
    if (!tokens) return null;

    let used = tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
    // If zero tokens, scan backwards for most recent non-zero non-summary assistant
    if (used === 0) {
      for (let j = latestIdx - 1; j >= 0; j--) {
        const fallback = assistantMessages[j];
        if (fallback.info.summary === true) continue;
        const ft = fallback.info.tokens;
        if (!ft) continue;
        const fallbackUsed = ft.input + (ft.cache?.read ?? 0) + (ft.cache?.write ?? 0);
        if (fallbackUsed > 0) {
          used = fallbackUsed;
          break;
        }
      }
    }

    const fallbackModel = assistantMessages[latestIdx].info;
    return { used, providerID: fallbackModel.providerID, modelID: fallbackModel.modelID };
  }

  // Summary exists — scan forward from summaryIdx + 1
  const postSummaryMessages = assistantMessages.slice(summaryIdx + 1);
  if (postSummaryMessages.length === 0) return null;

  // Find the latest non-summary assistant in post-summary region
  let latestIdx = -1;
  for (let i = postSummaryMessages.length - 1; i >= 0; i--) {
    if (postSummaryMessages[i].info.summary !== true) {
      latestIdx = i;
      break;
    }
  }

  if (latestIdx === -1) {
    // All post-summary assistants are summaries — return null
    return null;
  }

  // Found a non-zero post-summary assistant
  const msg = postSummaryMessages[latestIdx];
  const tokens = msg.info.tokens;
  if (!tokens) return null;

  let used = tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  // If zero tokens, fall forward to most recent non-zero post-summary assistant
  if (used === 0) {
    for (let j = latestIdx - 1; j >= 0; j--) {
      if (postSummaryMessages[j].info.summary === true) continue;
      const ft = postSummaryMessages[j].info.tokens;
      if (!ft) continue;
      const fallbackUsed = ft.input + (ft.cache?.read ?? 0) + (ft.cache?.write ?? 0);
      if (fallbackUsed > 0) {
        used = fallbackUsed;
        break;
      }
    }
  }

  const postSummaryModel = postSummaryMessages[latestIdx].info;
  return { used, providerID: postSummaryModel.providerID, modelID: postSummaryModel.modelID };
}

type PartForStallCheck = {
  type?: string;
  tool?: string;
  state?: { status?: string; metadata?: { sessionId?: string } };
  time?: { start?: number; end?: number };
};

/**
 * Pure helper for the stall watchdog (2026-09-11 incident, see docs/StageN.md):
 * a harness turn can have non-empty `parts` (its own text plus the `task`
 * tool-call part itself) yet still be genuinely stalled, because a `task`
 * tool call stays `status: "running"` until the dispatched subagent's own
 * model stream produces a result — and that stream can go silent forever
 * with no further SSE event on the harness session (the subagent's session
 * is a separate SSE-event source). The plain "does the newest message have
 * any parts yet" check is blind to this case.
 *
 * Returns the subagent's session ID if the newest assistant message's LAST
 * part is a `task` tool call still in `running` state and already paired to
 * a child session, else null (not a task dispatch, already resolved, or not
 * paired yet — too early to judge).
 */
export function findRunningTaskChildSessionID(parts: PartForStallCheck[]): string | null {
  const last = parts[parts.length - 1];
  if (!last || last.type !== "tool" || last.tool !== "task") return null;
  if (last.state?.status !== "running") return null;
  return last.state.metadata?.sessionId ?? null;
}

/**
 * True if a turn shows no forward progress within `thresholdMs`: either it
 * has no parts at all, or the newest timestamp across all parts (`time.start`
 * / `time.end`, whichever is latest) is older than `now - thresholdMs`. A
 * `completed` turn is never stale.
 */
export function isTurnStale(
  parts: PartForStallCheck[],
  completedAt: number | null | undefined,
  now: number,
  thresholdMs: number,
): boolean {
  if (completedAt != null) return false;
  if (parts.length === 0) return true;
  let newest = 0;
  for (const p of parts) {
    if (p.time?.start) newest = Math.max(newest, p.time.start);
    if (p.time?.end) newest = Math.max(newest, p.time.end);
  }
  if (newest === 0) return true;
  return now - newest >= thresholdMs;
}

function formatOptionsBlock(qs: QuestionType[]): string {
  return qs.map((q, qi) => {
    const opts = q.options
      .map((o, i) => `  ${i + 1}. ${o.label} — ${o.description}`)
      .join("\n");
    return `▷ Question ${qi + 1}/${qs.length}${q.header ? ` — ${q.header}` : ""}\n${q.question}\n${opts}`;
  }).join("\n\n");
}

function formatAnswerSummary(
  q: QuestionType,
  subIdx: number,
  total: number,
  rawText: string,
): string {
  const trimmed = rawText.trim();
  const prefix = `▶ Answered Q${subIdx + 1}/${total}${q.header ? ` — ${q.header}` : ""}`;

  const digitMatch = /^\d+$/.test(trimmed);
  if (digitMatch) {
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= q.options.length) {
      const opt = q.options[n - 1];
      return `${prefix}: ${n}. ${opt.label} — ${opt.description}`;
    }
  }

  // Prose: put on its own line in inverted video so it's visually distinct from system narration
  // (\x1b[7m = ANSI.invert from blocks.ts, not exported hence inlined)
  const invertedProse = trimmed.split("\n").map((l) => `\x1b[7m${l}\x1b[0m`).join("\n");
  return `${prefix}:\n${invertedProse}`;
}

function commitOptionsBlock(renderer: Renderer, reqID: string, qs: QuestionType[], seen: Set<string>): void {
  if (seen.has(reqID)) return;
  seen.add(reqID);
  renderer.commitSystemMessage(formatOptionsBlock(qs));
}

type AppProps = {
  backend: Backend;
  sessionID: string;
  sessionLabel: string;
  eventStream: AsyncIterable<{ payload: unknown }>;
  onExit: () => Promise<void>;
  renderer: Renderer;
  onRedraw?: () => void;
  setPasteCallback?: (cb: (text: string) => void) => void;
  singleMode: boolean;
};

/**
 * Subscribes to terminal resize events and returns live terminal dimensions
 * as React state. Each resize calls setSize with the current stdout.rows/columns,
 * forcing a re-render that recomputes maxActiveRows and w — making geometry live
 * in ALL states (streaming, paused, idle). Without this, geometry only refreshes
 * on re-renders from other causes (deltas, input) and goes stale during pauses,
 * which can push the dynamic region over stdout.rows (Ink's overflow flash).
 * The re-render is cheap: <Static> is index-tracked, so unchanged history is not
 * re-emitted — cost ≈ one streaming delta frame.
 */
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ rows: stdout.rows, columns: stdout.columns });
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

export function App(props: AppProps) {
  const { renderer } = props;
  const [editor] = useState(() => new LineEditor());
  const [isGenerating, setIsGenerating] = useState(false);
  const [ctrlcPending, setCtrlcPending] = useState(false);
  const [permission, setPermission] = useState<{ permID: string; title: string; sessionID: string } | null>(null);
  const [question, setQuestion] = useState<{ reqID: string; questions: QuestionType[] } | null>(null);
  // Ref mirror of `question` state for use inside applyReplEvents (avoids deps churn).
  // Always holds the current value; the useEffect below keeps it in sync.
  const questionRef = useRef<{ reqID: string; questions: QuestionType[] } | null>(null);
  useEffect(() => {
    questionRef.current = question;
  }, [question]);
  const [lastSubmitted, setLastSubmitted] = useState<string>("");
  const [procTimes, setProcTimes] = useState<{ thinking: number | null; tools: number | null; generating: number | null }>({ thinking: null, tools: null, generating: null });
  const [sessionID, setSessionID] = useState(props.sessionID);
  const [sessionLabel, setSessionLabel] = useState(props.sessionLabel);
  const [activeModel, setActiveModel] = useState<{ providerID: string; modelID: string } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ items: ModelPickerItem[]; idx: number } | null>(null);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [tokenUsage, setTokenUsage] = useState<{ used: number; contextWindow: number } | null>(null);
  const [slashCompletion, setSlashCompletion] = useState<{
    candidates: string[];
    selectedIdx: number;
  } | null>(null);
  const [opencodeCommands, setOpencodeCommands] = useState<Map<string, OcCommand>>(new Map());
  const [isCompacting, setIsCompacting] = useState(false);
  const [sessionPicker, setSessionPicker] = useState<{ items: SessionPickerItem[]; idx: number } | null>(null);
  // Stage 9.1 (Piece 2B, revised): current sub-question index, owned by app.tsx
  // so handleSubmit can track the current sub-question index during multi-Q collection.
  const [currentSubIdx, setCurrentSubIdx] = useState<number>(0);
  // Stage 9.4: accumulator for per-sub-Q answers; only POSTed after the last sub-Q.
  const questionAnswersRef = useRef<string[][]>([]);
  useEffect(() => {
    setCurrentSubIdx(0);
    questionAnswersRef.current = [];
  }, [question?.reqID]);
  const [permMode, setPermMode] = useState<"ask" | "allow" | "deny">(props.singleMode ? "allow" : "ask");
  const [runningCost, setRunningCost] = useState<number>(0);
  const [orchestraBadge, setOrchestraBadge] = useState<OrchestraBadge>(null);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [gateStates, setGateStates] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(TOGGLES_CONFIG.bindings.map(b => [b.gate, props.singleMode ? false : b.default]))
  );
  const [pendingQueue, setPendingQueue] = useState<string[]>([]);
  const pendingQueueRef = useRef<string[]>([]);
  pendingQueueRef.current = pendingQueue;
  const isGeneratingRef = useRef(false);
  isGeneratingRef.current = isGenerating;
  const handleSubmitRef = useRef<((text: string) => Promise<void>) | null>(null);

  const lastCtrlCRef = useRef<number>(0);
  const ctrlcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIDRef = useRef(sessionID);
  const watcherRef = useRef<InstanceType<typeof OrchestraWatcher> | null>(null);
  // Ref mirror of `activeModel` state for use inside applyReplEvents (avoids deps churn).
  const activeModelRef = useRef<{ providerID: string; modelID: string } | null>(null);
  useEffect(() => {
    activeModelRef.current = activeModel;
  }, [activeModel]);

  // Stage 4.5.3: SSE health tracking and reconciliation
  const [sseHealth, setSseHealth] = useState<"ok" | "reconnecting" | "silent">("ok");
  const lastSseEventTimeRef = useRef<number>(Date.now());
  const stallBannerShownRef = useRef<boolean>(false);

  const cyclePermMode = useCallback(() => {
    setPermMode(prev =>
      prev === "ask" ? "allow" : prev === "allow" ? "deny" : "ask"
    );
  }, []);

  const triggerHelp = useCallback(() => { handleSubmitRef.current?.("/help"); }, []);

  const toggleGate = useCallback((gate: string) => {
    // Step 1: mutate renderer first — renderer is authoritative for gate state.
    // This mirrors the slash-command path at lines 650-654 where parseBlockOutputCommand
    // mutates the renderer before setGateStates reads back renderer.isOutputEnabled().
    const next = !renderer.isOutputEnabled(rendererGateKey(gate));
    renderer.setOutputEnabled(rendererGateKey(gate), next);

    // Step 2: derive React state from renderer (pure read-back, no side effects).
    setGateStates(prev => {
      const updated = { ...prev };
      for (const g of Object.keys(prev)) updated[g] = renderer.isOutputEnabled(rendererGateKey(g));
      return updated;
    });
  }, [renderer]);

  // Project name: basename of current working directory
  const projectName = path.basename(process.cwd());

  const { rows, columns } = useTerminalSize();
  // A.3: measure the actual non-ActiveBlock dynamic region (chrome + any mounted modal).
  // restRows starts at 10 (conservative fallback ~ old CHROME_ROWS) to cover the one-frame
  // lag before the first measureElement; the no-deps useLayoutEffect keeps it live every render.
  const restRef = useRef<any>(null);
  const [restRows, setRestRows] = useState(10);
  useLayoutEffect(() => {
    if (restRef.current) {
      const { height } = measureElement(restRef.current);
      if (height > 0 && height !== restRows) setRestRows(height); // guard: avoid render thrash
    }
  });
  const w = Math.max(80, columns ?? 80);
  // Exact headroom: rows (live from A.2) − measured rest − 1 (closes Ink's >= boundary).
  // max(1,…) replaces the old max(16,…) floor (which could itself force overflow on small panes).
  const maxActiveRows = Math.max(1, rows - restRows - 1);

  // Thread column width into the renderer for markdown wrap
  useEffect(() => {
    renderer.setWidth(columns ?? 80);
  }, [columns, renderer]);

  // Subscribe to renderer state — new array reference on every commit means React detects changes.
  const committed = useSyncExternalStore(
    (cb) => { renderer.on("changed", cb); return () => renderer.off("changed", cb); },
    () => renderer.getCommitted(),
  );
  const activeBlock = useSyncExternalStore(
    (cb) => { renderer.on("changed", cb); return () => renderer.off("changed", cb); },
    () => renderer.getActiveBlock(),
  );
  const activeBlockAnsi = useSyncExternalStore(
    (cb) => { renderer.on("changed", cb); return () => renderer.off("changed", cb); },
    () => renderer.getActiveBlockAnsi(),
  );

  // Track the current permission mode in a ref so the SSE effect can read it without re-running.
  const permModeRef = useRef<"ask" | "allow" | "deny">("ask");
  useEffect(() => {
    permModeRef.current = permMode;
  }, [permMode]);

  // Track the current session ID in a ref so the SSE effect can read it without re-running.
  useEffect(() => {
    sessionIDRef.current = sessionID;
  }, [sessionID]);

  // Stage 4.5.3: dedupe question and permission IDs for reconciler missed-event detection
  const questionIDRef = useRef<string | null>(null);
  const permissionIDRef = useRef<string | null>(null);
  useEffect(() => {
    questionIDRef.current = question?.reqID ?? null;
  }, [question]);
  useEffect(() => {
    permissionIDRef.current = permission?.permID ?? null;
  }, [permission]);

  // Stage 9.0 (Piece 2A): dedupe options-commit across SSE + 2 discovery paths
  const committedOptionsReqIDsRef = useRef<Set<string>>(new Set());

  // Fetch git branch at startup AND on every turn boundary (operator may have
  // checked out a different branch between turns). isGenerating going true→false
  // is the canonical "turn just ended" signal. The mount fire (isGenerating
  // initially false) handles the startup case; subsequent fires keep the
  // status-line branch label in sync with the actual repository state.
  useEffect(() => {
    if (isGenerating) return; // only refresh when idle / after a turn ends
    (async () => {
      const branch = await fetchGitBranch();
      setGitBranch(branch);
    })();
  }, [isGenerating]);

  // Stage 4.5.3: Reconciler pass ref — stored on ref so polling effect and SSE-reconnect path
  // both invoke the current closure (captures latest refs/state).
  const runReconcilerPassRef = useRef<(() => Promise<void>) | null>(null);

  // Stage 4.5.4.2: Discovery pass ref — separate from reconciler, runs unconditionally.
  const runDiscoveryPassRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    runReconcilerPassRef.current = async () => {
      // Stage 4.5.3 redesigned reconciler: four-layer guard on idle synthesis.
      // Layer 1 (trigger gate) + Layer 2 (recency) + Layer 3 (openParts) guard
      // the idle synthesis path. Question/permission discovery runs separately via runDiscoveryPassRef.
      // SSE silence detection (sseHealth "ok" -> "silent") runs separately too, on its own
      // unconditional interval below (Stage 4.5.3.1) — it used to live here, but this whole
      // pass is itself gated on `sseHealth !== "ok"` (see the polling effect below), which
      // made the "ok" -> "silent" transition structurally unreachable: you needed to
      // already be unhealthy to detect you'd gone unhealthy.

      // Idle synthesis path: guarded by layers 1–4
      // Layer 1: skip if SSE is healthy
      if (sseHealth !== "ok") {
        // Layer 2: skip if an SSE event arrived recently (within 5 s)
        if (Date.now() - lastSseEventTimeRef.current >= 5000) {
          // Layer 3: skip if a streaming text/reasoning part is open
          if (!props.backend.events.hasOpenStreamingPart()) {
            // Layer 4: REST confirmation — original anyPending + isGenerating check
            try {
              const resp = await props.backend.session.getMessages({ path: { id: sessionIDRef.current } });
              const msgs = resp.data ?? [];
              const anyPending = msgs.some(m =>
                (m.parts ?? []).some(p =>
                  p.type === "tool" &&
                  (p.state?.status === "pending" || p.state?.status === "running")
                )
              );
              if (!anyPending && isGeneratingRef.current) {
                applyReplEvents(props.backend.events.synthesizeSessionIdleEvents());
              }
            } catch {}
          }
        }
      }

      // Discovery happens separately via unconditional runDiscoveryPassRef
      await runDiscoveryPassRef.current?.();
    };
  });  // re-assign every render so closure captures current refs/state

  // Stage 4.5.4.2: Discovery pass — question/permission lookup (idempotent, runs unconditionally)
  useEffect(() => {
    runDiscoveryPassRef.current = async () => {
      // Question/permission discovery: run unconditionally (safe modal recovery, no stream mutation)
      // 1. Missed question discovery
      try {
        const r = await props.backend.listQuestions();
        if (r.ok) {
          const list = await r.json() as Array<{
            id: string; sessionID: string;
            questions: Array<{
              question: string; header: string;
              options: Array<{ label: string; description: string }>;
              multiple?: boolean; custom?: boolean;
            }>;
          }>;
          const flags = await Promise.all(
            list.map(q =>
              q.sessionID === sessionIDRef.current
                ? Promise.resolve(true)
                : props.backend.isSessionDescendant(q.sessionID, sessionIDRef.current)
            )
          );
          const ours = list.filter((_, i) => flags[i]).sort((a, b) => a.id.localeCompare(b.id));
          const oldest = ours[0];
          if (oldest && oldest.id !== questionIDRef.current) {
            const evRaw = props.backend.events.translateEvent({
              type: "question.asked",
              properties: { id: oldest.id, sessionID: oldest.sessionID, questions: oldest.questions },
            } as unknown as Event, oldest.sessionID);
            if (evRaw) {
              commitOptionsBlock(renderer, oldest.id, oldest.questions, committedOptionsReqIDsRef.current);
              applyReplEvents(Array.isArray(evRaw) ? evRaw : [evRaw]);
            }
          }
        }
      } catch {}

      // 2. Missed permission discovery
      try {
        const r = await props.backend.listPermissions();
        if (r.ok) {
          const list = await r.json() as Array<{
            id: string; sessionID: string; permission: string; patterns?: string[];
          }>;
          const flags = await Promise.all(
            list.map(p =>
              p.sessionID === sessionIDRef.current
                ? Promise.resolve(true)
                : props.backend.isSessionDescendant(p.sessionID, sessionIDRef.current)
            )
          );
          const ours = list.filter((_, i) => flags[i]).sort((a, b) => a.id.localeCompare(b.id));
          const oldest = ours[0];
          if (oldest && oldest.id !== permissionIDRef.current) {
            const evRaw = props.backend.events.translateEvent({
              type: "permission.asked",
              properties: { id: oldest.id, sessionID: oldest.sessionID, permission: oldest.permission, patterns: oldest.patterns ?? [] },
            } as unknown as Event, oldest.sessionID);
            if (evRaw) applyReplEvents(Array.isArray(evRaw) ? evRaw : [evRaw]);
          }
        }
      } catch {}
    };
  });  // re-assign every render so closure captures current refs/state

  // Stage 4.5.3.1: SSE silence detection — unconditional, fires every 3s regardless of
  // sseHealth. Bug fix: this check used to live inside runReconcilerPassRef (above),
  // which is itself only armed once sseHealth !== "ok" (the polling effect right below,
  // introduced in the same Stage 4.5.3 this is a point-fix to). That made the
  // "ok" -> "silent" transition dead code: the only way sseHealth could ever be
  // non-"ok" here was via a genuine transport break (setSseHealth("reconnecting") in
  // the SSE loop), at which point this check's ternary explicitly declined to
  // overwrite "reconnecting" with "silent" anyway — so "silent" could never actually be
  // displayed. Mirrors the Stage 4.5.4.2 fix applied to discovery for the same root cause
  // (a check nested inside a conditionally-armed pass can't detect the condition that
  // would arm it). This does NOT affect the earlier, separate SoHoAI/opencode timeout
  // work (docs/Stage8.md Stage 8.1.7) — this is the octmux<->opencode SSE transport
  // link, several hops upstream of where that incident's stall actually occurred.
  useEffect(() => {
    const t = setInterval(() => {
      if (isGeneratingRef.current && Date.now() - lastSseEventTimeRef.current > 8000) {
        setSseHealth(prev => (prev === "ok" ? "silent" : prev));
      }
    }, 3000);
    return () => clearInterval(t);
  }, []);

  // Stage 4.5.3 redesign: Idle-synthesis polling — arms ONLY when SSE is degraded.
  // In steady-state SSE, NO polling. Belt-and-suspenders:
  // even when armed, the reconciler pass has its own recency + openParts guards.
  useEffect(() => {
    if (!isGenerating || sseHealth === "ok") return;
    const t = setInterval(() => { runReconcilerPassRef.current?.(); }, 3000);
    return () => clearInterval(t);
  }, [isGenerating, sseHealth]);

  // Stage 4.5.4.2: Discovery loop — unconditional, fires at mount and every 5s.
  // Safe: discovery is idempotent via questionIDRef/permissionIDRef guards.
  useEffect(() => {
    runDiscoveryPassRef.current?.();
    const t = setInterval(() => { runDiscoveryPassRef.current?.(); }, 5000);
    return () => clearInterval(t);
  }, []);

  // Sync procTimes.generating with isGenerating state for SubprocessStatus rendering
  useEffect(() => {
    if (isGenerating) {
      setProcTimes(p => p.generating === null ? { ...p, generating: Date.now() } : p);
    } else {
      setProcTimes(p => p.generating === null ? p : { ...p, generating: null });
    }
  }, [isGenerating]);

  // Stall watchdog: detect when generation stalls (SSE silent for 3 min, but async generation ongoing).
  // 2026-09-11 incident: a Task-tool dispatch to a subagent left the harness's newest
  // assistant message with non-empty parts (its own text + the running `task` tool
  // call), so the original zero-parts check below never fires — even though the
  // subagent's own session had gone silent for 11+ hours. Layer 2 below closes that
  // gap by checking the paired child session's own staleness independently.
  useEffect(() => {
    if (!isGenerating) {
      stallBannerShownRef.current = false;
      return;
    }
    const t = setInterval(async () => {
      if (Date.now() - lastSseEventTimeRef.current < 180_000) return;
      if (stallBannerShownRef.current) return;
      try {
        const resp = await props.backend.session.getMessages({ path: { id: sessionIDRef.current } });
        const msgs = resp.data ?? [];
        const assistants = msgs.filter(m => m.info.role === "assistant");
        if (assistants.length === 0) return;
        const newest = assistants[assistants.length - 1];
        const parts = newest.parts ?? [];
        const completed = (newest.info as { time?: { completed?: number | null } }).time?.completed;
        if (completed != null) return;

        if (parts.length === 0) {
          stallBannerShownRef.current = true;
          renderer.commitSystemMessage("Generation stalled — press Ctrl-C to abort");
          return;
        }

        // Layer 2: harness turn has content, but its last part may be a `task`
        // tool call blocking on a subagent that has itself gone silent.
        const childSessionID = findRunningTaskChildSessionID(parts as PartForStallCheck[]);
        if (!childSessionID) return;
        const childResp = await props.backend.session.getMessages({ path: { id: childSessionID } });
        const childMsgs = childResp.data ?? [];
        const childAssistants = childMsgs.filter(m => m.info.role === "assistant");
        if (childAssistants.length === 0) return;
        const childNewest = childAssistants[childAssistants.length - 1];
        const childCompleted = (childNewest.info as { time?: { completed?: number | null } }).time?.completed;
        if (!isTurnStale((childNewest.parts ?? []) as PartForStallCheck[], childCompleted, Date.now(), 180_000)) return;

        stallBannerShownRef.current = true;
        renderer.commitSystemMessage(
          `Subagent stalled (session ${childSessionID.slice(0, 12)}…) — no response for 3+ min. Press Ctrl-C to abort.`
        );
      } catch {
        return;
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [isGenerating, props.backend, renderer]);

  // One-shot: set up orchestra badge watcher. Must be declared BEFORE any effect that
  // references orchestraBadge (TDZ guard per feedback-react-effect-tdz.md).
  useEffect(() => {
    const watcher = new OrchestraWatcher(props.backend);
    watcherRef.current = watcher;
    watcher.on("changed", setOrchestraBadge);
    watcher.start();
    watcher.setOcSessionID(sessionID);
    return () => {
      watcher.dispose();
      watcherRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props.backend is module-level singleton; watcher initialises once
  }, []);

  // Update watcher with new session ID when it changes
  useEffect(() => {
    watcherRef.current?.setOcSessionID(sessionID);
  }, [sessionID]);

  // Spinner tick: advance frame every 250 ms
  useEffect(() => {
    const handle = setInterval(() => setSpinnerFrame(f => (f + 1) % 4), 250);
    return () => clearInterval(handle);
  }, []);

  // One-shot: discover opencode commands at startup
  useEffect(() => {
    (async () => {
      try {
        const resp = await props.backend.listCommands();
        const cmds = resp.data ?? [];
        const map = new Map<string, OcCommand>();
        for (const cmd of cmds) map.set(cmd.name, cmd);
        setOpencodeCommands(map);
      } catch (err) {
        renderer.commitSystemMessage(
          `[opencode commands] discovery failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }, [props.backend, renderer]);

  // When model changes: refresh context window in status bar, preserving used tokens.
  // This fires on startup (when setActiveModel is called) and on /model switches.
  useEffect(() => {
    if (!activeModel) return;
    getContextWindow(props.backend, activeModel.providerID, activeModel.modelID)
      .then(ctxWindow =>
        setTokenUsage(prev => ({ used: prev?.used ?? 0, contextWindow: ctxWindow }))
      );
  }, [props.backend, activeModel]);

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
      // Coerce firstLine to string, since lines[0] may be a PastedBlock.
      const firstLine = typeof lines[0] === "string" ? lines[0] : "";
      // Open only after the operator has typed at least one character past
      // the leading "/" — listing every command on bare "/" is too noisy.
      if (row !== 0 || !firstLine.startsWith("/") || firstLine.length < 2) {
        setSlashCompletion(null);
        return;
      }
      const token = firstLine.split(/\s/)[0];
      const all = expandCommands([...opencodeCommands.keys()].map(n => "/" + n));
      const filtered = all.filter(c => c.startsWith(token));
      if (firstLine.includes(" ")) {
        setSlashCompletion(null);
        return;
      }
      // Sort: exact token match first, then alphabetical — ensures /brain beats /brain-abandon on TAB
      const sorted = [...filtered].sort((a, b) => {
        if (a === token) return -1;
        if (b === token) return 1;
        return a.localeCompare(b);
      });
      setSlashCompletion(prev => ({
        candidates: sorted,
        selectedIdx: prev ? Math.min(prev.selectedIdx, Math.max(0, sorted.length - 1)) : 0,
      }));
    };
    editor.on("changed", recompute);
    recompute();
    return () => editor.off("changed", recompute);
  }, [editor, opencodeCommands, isCompacting, sessionPicker]);

  // Fetch and update token usage from the latest assistant message in a session,
  // and sum running cost from all assistant messages in the session + child sessions.
  // Uses forward-from-summary scan: finds last assistant with info.summary === true,
  // then scans forward from that boundary for the latest non-summary assistant
  // with non-zero tokens. If no post-summary assistant exists, falls back to
  // the latest non-summary assistant (mirroring pre-summary backward-walk behavior).
  const refreshTokenUsage = useCallback(async (sid: string) => {
    try {
      const messagesResp = await props.backend.session.getMessages({ path: { id: sid } });
      const messages = messagesResp.data ?? [];

      // Use the pure helper for token usage scanning
      const result = pickPostSummaryAssistantTokenUsage(messages as MessageForUsageScan[]);
      if (!result) {
        // No post-summary assistant messages (e.g. immediately after /compact).
        // Preserve the known context window so the bar shows "0K/200K" rather
        // than "0K/?". If there was no prior value, fall through to null.
        setTokenUsage(prev => prev ? { used: 0, contextWindow: prev.contextWindow } : null);
        return;
      }

      // Get context window and set token usage.
      // Note: We do NOT call setActiveModel here. In a shared OpenCode session,
      // foreign (mobile-app) turns may become the latest assistant message,
      // which would hijack activeModel via this code path. The mount effect
      // (lines 902-925) and session-switch effect (lines 1078-1090) already
      // seed activeModel from session.get().data.model, so refreshTokenUsage
      // only needs to update display-only values (token bar and running cost).
      const ctxWindow = await getContextWindow(
        props.backend,
        result.providerID ?? "",
        result.modelID ?? "",
      );
      setTokenUsage({ used: result.used, contextWindow: ctxWindow });

      // Compute running cost: sum all assistant messages in parent + children
      let totalCost = 0;
      for (const msg of messages) {
        if (msg.info.role === "assistant") {
          const cost = msg.info.cost;
          if (cost && !isNaN(cost) && cost >= 0) {
            totalCost += cost;
          }
        }
      }

      // Sum child sessions (one level deep)
      try {
        const childrenResp = await props.backend.session.getChildren({ path: { id: sid } });
        const children = childrenResp.data ?? [];
        for (const child of children) {
          try {
            const childMessagesResp = await props.backend.session.getMessages({ path: { id: child.id } });
            const childMessages = childMessagesResp.data ?? [];
            for (const msg of childMessages) {
              if (msg.info.role === "assistant") {
                const cost = msg.info.cost;
                if (cost && !isNaN(cost) && cost >= 0) {
                  totalCost += cost;
                }
              }
            }
          } catch {
            // Silently skip failed child session fetches
          }
        }
      } catch {
        // Silently skip if children endpoint is unavailable
      }

      setRunningCost(totalCost);
    } catch {
      // Silently swallow errors; bar stays at last value
    }
  }, [props.backend]);

  // Stable replay callback: emit prior session history to renderer and seed editor.
  // Declared BEFORE the one-shot session.get effect (critical for TDZ).
  const runReplay = useCallback(async (sid: string) => {
    await props.backend.replaySession(renderer, sid, editor);
  }, [props.backend, renderer, editor]);

  // Per-messageID debouncer for foreign user turns (Stage 13.x).
  const userTurnDebouncerRef = useRef<UserTurnDebouncer | null>(null);
  if (!userTurnDebouncerRef.current) userTurnDebouncerRef.current = new UserTurnDebouncer();

  // Stage 4.5.3: Shared helper for processing ReplEvents from both live SSE and reconciler.
  // Routes all event mutations through a single code path to guarantee multi-window FIFO safety.
  // Permission responses are fired in background without awaiting (mirrors original code).
  const applyReplEvents = useCallback((evList: ReplEvent[]) => {
    for (const ev of evList) {
      try {
        if (ev.kind === "block-start") {
          renderer.beginBlock(ev.partID, ev.role, { toolName: ev.toolName, messageID: ev.messageID });
          // Notify parent activity on parent session blocks (text, thinking, tool-call, tool-result)
          if (ev.role === "text" || ev.role === "thinking" || ev.role === "tool-call" || ev.role === "tool-result") {
            watcherRef.current?.notifyParentActivity(Date.now());
          }
          if (ev.role === "thinking")
            setProcTimes(p => p.thinking === null ? { ...p, thinking: Date.now() } : p);
          else if (ev.role === "tool-call" || ev.role === "tool-result")
            setProcTimes(p => p.tools === null ? { ...p, tools: Date.now() } : p);
        }
        else if (ev.kind === "block-delta") {
          renderer.appendToBlock(ev.partID, ev.text);
          // Notify parent activity on parent session delta (text, thinking, tool-call, tool-result)
          if (ev.role === "text" || ev.role === "thinking" || ev.role === "tool-call" || ev.role === "tool-result") {
            watcherRef.current?.notifyParentActivity(Date.now());
          }
        }
        else if (ev.kind === "block-end") {
          renderer.endBlock(ev.partID, ev.status);
          if (ev.role === "thinking") setProcTimes(p => ({ ...p, thinking: null }));
          else if (ev.role === "tool-result" || (ev.role === "tool-call" && ev.status === "error"))
            setProcTimes(p => ({ ...p, tools: null }));
        }
        else if (ev.kind === "error") {
          // Append operator guidance so the user knows the next action to take.
          // Brain timeouts may be transient; we don't auto-abandon — that's
          // the operator's decision.
          renderer.commitError(ev.message + " — run /brain-abandon to clean up the session");
          setIsGenerating(false);
          // Clear any orphaned subagent rows that may have been left open if the
          // brain session errored mid-pipeline (e.g. provider timeout during Phase 2).
          // notifyAllSubagentsEnded is a safe no-op when badge.subagents is empty.
          watcherRef.current?.notifyAllSubagentsEnded();
        }
        else if (ev.kind === "parent-turn-end") {
          // Parent harness turn ended (idle / operator abort / server error). Any subagent
          // rows still present are orphans — the parent cannot be turn-ended while a child
          // Task is running. Sweep them. Do NOT call renderer.commitError: a routine operator
          // interrupt (reason "aborted") is not a server error and must not show error copy.
          watcherRef.current?.notifyAllSubagentsEnded();
          setIsGenerating(false);
        }
        else if (ev.kind === "generating")   setIsGenerating(true);
        else if (ev.kind === "session-idle") {
          renderer.commitTurnEnd();
          setIsGenerating(false);
          setLastSubmitted("");
          setProcTimes({ thinking: null, tools: null, generating: null });
          refreshTokenUsage(sessionIDRef.current);
        }
        else if (ev.kind === "session-compacted") {
          if (ev.sessionID === sessionIDRef.current) {
            setIsCompacting(false);
            setIsGenerating(false);
            refreshTokenUsage(sessionIDRef.current);
          }
        }
        else if (ev.kind === "block-retag") {
          renderer.retagBlock(ev.partID, ev.newRole);
        }
        else if (ev.kind === "compaction-divider") {
          renderer.commitCompactionDivider(ev.auto);
        }
        else if (ev.kind === "message-completed") {
          // One assistant message has fully completed. Refresh cost display so Σ$
          // updates incrementally during a long pipeline rather than only at
          // session-idle. Also reset the "generating" elapsed-time ticker so the
          // display counts up from zero for the next logical turn.
          // isGenerating is intentionally left true — the OC pipeline is still
          // running; only the display timer resets.
          refreshTokenUsage(sessionIDRef.current);
          setProcTimes(p => ({ ...p, generating: Date.now() }));
        }
        else if (ev.kind === "permission-asked") {
          if (permModeRef.current === "ask") {
            setPermission({ permID: ev.permID, title: ev.title, sessionID: ev.sessionID });
          } else if (permModeRef.current === "allow") {
            // Fire in background without awaiting
            props.backend.replyPermission({
              path: { id: ev.sessionID, permissionID: ev.permID },
              body: { response: "always" },
            }).catch(() => {
              // Silently swallow errors; permission will be retried or escalated by the server
            });
          } else if (permModeRef.current === "deny") {
            // Fire in background without awaiting
            props.backend.replyPermission({
              path: { id: ev.sessionID, permissionID: ev.permID },
              body: { response: "reject" },
            }).catch(() => {
              // Silently swallow errors
            });
          }
        }
        else if (ev.kind === "question-asked") {
          commitOptionsBlock(renderer, ev.reqID, ev.questions, committedOptionsReqIDsRef.current);
          setQuestion({ reqID: ev.reqID, questions: ev.questions });
        }
        else if (ev.kind === "question-tool-detected") {
          // One-shot lookup: OC's question registry should now contain the MCP
          // question that triggered this tool=question part. Match by
          // (sessionID, callID) to avoid cross-session or stale-event contamination.
          // Fire in background — do not block the event-application loop.
          (async () => {
            try {
              const r = await props.backend.listQuestions();
              if (!r.ok) return;
              const all = await r.json() as Array<{
                id: string; sessionID: string;
                questions: Array<{
                  question: string; header: string;
                  options: Array<{ label: string; description: string }>;
                  multiple?: boolean; custom?: boolean;
                }>;
                tool?: { messageID: string; callID: string };
              }>;
              const match = all.find(q =>
                q.sessionID === ev.sessionID &&
                q.tool?.callID === ev.callID
              );
              if (match && match.id !== questionIDRef.current) {
                commitOptionsBlock(renderer, match.id, match.questions, committedOptionsReqIDsRef.current);
                setQuestion({ reqID: match.id, questions: match.questions });
              }
            } catch {
              // Silent — operator can Ctrl-C (now safe under Bug 1 fix) and retry.
            }
          })();
        }
        else if (ev.kind === "question-replied") {
          const q = questionRef.current;
          if (q && ev.reqID === q.reqID) {
            questionAnswersRef.current = [];
            setCurrentSubIdx(0);
            setQuestion(null);
            const summary = ev.answers.map((ansArr, i) => {
              const qi = (q.questions[i] ?? q.questions[0])!;
              const labels = ansArr.length > 0 ? ansArr.join(", ") : "(no answer)";
              return `▶ Externally answered Q${i + 1}/${q.questions.length}${qi.header ? ` — ${qi.header}` : ""}: ${labels}`;
            }).join("\n");
            renderer.commitSystemMessage(summary);
          }
        }
        else if (ev.kind === "question-rejected") {
          const q = questionRef.current;
          if (q && ev.reqID === q.reqID) {
            questionAnswersRef.current = [];
            setCurrentSubIdx(0);
            setQuestion(null);
            renderer.commitSystemMessage("▶ Question rejected externally");
          }
        }
        else if (ev.kind === "subagent-detected") {
          watcherRef.current?.notifySubagentStarted(ev.sessionID, ev.agent, ev.model, ev.description);
        }
        else if (ev.kind === "subagent-ended") {
          watcherRef.current?.notifySubagentEnded(ev.sessionID);
        }
        else if (ev.kind === "subagent-activity") {
          watcherRef.current?.notifySubagentActivity(ev.sessionID, ev.ts);
        }
        else if (ev.kind === "model-switched") {
          // A foreign client (e.g. P4OC mobile app) switched the model on a shared session.
          // Adopt the new model only if it's available locally (validated via validateModel).
          if (ev.sessionID === sessionIDRef.current) {
            (async () => {
              const valid = await validateModel(props.backend, ev.providerID, ev.modelID);
              if (valid) {
                setActiveModel({ providerID: valid.providerID, modelID: valid.modelID });
              } else {
                renderer.commitSystemMessage(
                  `session model switched to ${ev.providerID}/${ev.modelID} (not available here — keeping ${activeModelRef.current?.modelID ?? "current"})`
                );
              }
            })();
          }
        }
        else if (ev.kind === "foreign-user-turn") {
          // Mobile-Companion Part B: a foreign client (mobile companion) submitted a user
          // prompt on this same session. Render it as a user-input block so the operator
          // sees the prompt in context. Do NOT setIsGenerating — the assistant fires its
          // own generating event in normal order.
          renderer.commitUserInput(ev.text);
        }
        else if (ev.kind === "foreign-user-part") {
          userTurnDebouncerRef.current?.arm(ev.messageID);
        }
      } catch (err) {
        renderer.commitError(`[renderer error] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [props.backend, renderer, refreshTokenUsage]);

  // Reassign every render — same pattern as runReconcilerPassRef (~:411-455) —
  // so onFire always calls the CURRENT applyReplEvents/isGeneratingRef closures.
  useEffect(() => {
    userTurnDebouncerRef.current?.setCallbacks({
      isHeld: () => isGeneratingRef.current,
      onFire: (messageID) => {
        const events = props.backend.events.classifyUserTurn(messageID);
        if (events.length > 0) applyReplEvents(events);
      },
    });
  });

  // Release anything that elapsed while isGenerating was true — keyed on STATE,
  // not on a single event kind, so it fires uniformly whichever path ended the
  // turn (session-idle, parent-turn-end/abort/error, Ctrl-C, switchSession,
  // session-compacted — all flip isGenerating false).
  useEffect(() => {
    if (!isGenerating) userTurnDebouncerRef.current?.flushHeld();
  }, [isGenerating]);

  // One-shot: fetch initial model from server and seed token-usage from the
  // latest assistant message. Fires on mount and on session switch (sessionID
  // state change). Critical for --resume / --resume-last / --fork startup:
  // without the refreshTokenUsage call, the status bar would stay at 0%
  // until the next session-idle event, hiding the resumed session's real
  // token usage. refreshTokenUsage is a no-op for fresh sessions (no
  // assistant messages yet). MUST be declared AFTER refreshTokenUsage and
  // runReplay to avoid TDZ on the deps array.
  useEffect(() => {
    (async () => {
      try {
        const resp = await props.backend.session.get({ path: { id: sessionID } });
        const sess = resp.data;
        if (sess?.model) {
          setActiveModel({ providerID: sess.model.providerID, modelID: sess.model.id });
        } else {
          // No model bound to session yet — seed from server config default
          const defaultModel = await getDefaultModel(props.backend);
          if (defaultModel) {
            setActiveModel(defaultModel);
          }
        }
      } catch {
        // No model set on session yet; /model command will set activeModel
      }
      for (const [gate, val] of getToggleDefaults(TOGGLES_CONFIG)) {
        renderer.setOutputEnabled(gate, props.singleMode ? false : val);
      }
      await refreshTokenUsage(sessionID);
      await runReplay(sessionID);
    })();
  }, [props.backend, sessionID, refreshTokenUsage, runReplay, renderer]);

  // SSE loop with reconnect: thin translation layer — all rendering delegated to renderer.
  // Stage 4.5.3: wrapped in try/catch with exponential backoff reconnect (1s → 30s cap).
  // On reconnect, runs one reconciliation pass before resuming event loop.
  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;
    (async () => {
      let stream: AsyncIterable<{ payload: unknown }> = props.eventStream;
      while (!cancelled) {
        try {
          for await (const globalEvent of stream) {
            if (cancelled) break;
            if (process.env.OCTMUX_DEBUG_SSE === "1") {
              const wrapperKeys = Object.keys(globalEvent as object).join(",");
              if (!(globalThis as any).__octmuxDebugWrapperLogged) {
                (globalThis as any).__octmuxDebugWrapperLogged = true;
                console.error("[octmux-debug] SSE wrapper keys=" + wrapperKeys);
              }
              const pl = (globalEvent as any).payload;
              console.error(
                "[octmux-debug] payload type=" + (pl?.type ?? "<undefined>") +
                " directory=" + ((globalEvent as any).directory ?? "<undefined>") +
                " harness=" + sessionIDRef.current
              );
            }
            lastSseEventTimeRef.current = Date.now();
            setSseHealth("ok");
            backoff = 1000;
            const evRaw = props.backend.events.translateEvent(globalEvent.payload as unknown as Event, sessionIDRef.current);
            if (!evRaw) {
              // For permission/question events from descendant sessions, filterEvent returns null
              // because it only accepts events from sessionIDRef.current. Re-check those event types
              // with a descendant walk.
              const ev = globalEvent.payload as unknown as { type: string; properties?: { sessionID?: string } };
              if (
                (ev.type === "permission.asked" || ev.type === "permission.updated" || ev.type === "question.asked") &&
                ev.properties?.sessionID &&
                ev.properties.sessionID !== sessionIDRef.current
              ) {
                const isDesc = await props.backend.isSessionDescendant(ev.properties.sessionID, sessionIDRef.current);
                if (isDesc) {
                  const childEvRaw = props.backend.events.translateEvent(globalEvent.payload as unknown as Event, ev.properties.sessionID);
                  if (childEvRaw) applyReplEvents(Array.isArray(childEvRaw) ? childEvRaw : [childEvRaw]);
                }
              }
              continue;
            }
            applyReplEvents(Array.isArray(evRaw) ? evRaw : [evRaw]);
          }
        } catch {
          // stream errored; fall through to reconnect
        }
        if (cancelled) break;
        setSseHealth("reconnecting");
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
        try {
          const fresh = await props.backend.subscribeEvents();
          stream = fresh.stream;
          // One-shot reconciliation pass after reconnect
          await runReconcilerPassRef.current?.();
          // Stage 10.4 — SSE-reconnect repaint hook. The reconciler may have
          // mutated `_committed` (via clearAll + replay) and the active region
          // needs a re-render at the new state. Closes the C1.9 SSE-reconnect
          // repaint gap.
          props.onRedraw?.();
        } catch {
          // retry after backoff
        }
      }
    })();
    return () => { cancelled = true; };
  }, [props.backend, props.eventStream, applyReplEvents]);

  // Sync queue mode; auto-submit pending queue when model goes idle
  useEffect(() => {
    editor.setQueueMode(isGenerating);
    if (!isGenerating && !question && !permission && pendingQueueRef.current.length > 0) {
      const merged = pendingQueueRef.current.join("\n\n");
      setPendingQueue([]);
      handleSubmitRef.current?.(merged);
    }
  }, [isGenerating, question, permission, editor]);

  // Keep editor virtual pending-entry in sync with the queue
  useEffect(() => {
    editor.setPendingEntry(pendingQueue.length > 0 ? pendingQueue.join("\n\n") : null);
  }, [pendingQueue, editor]);

  // Ctrl-C: three cases.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isGenerating) {
        const q = question;
        props.backend.session.abort({ path: { id: sessionID } }).catch(() => {});
        setIsGenerating(false);
        setLastSubmitted("");
        if (q) {
          props.backend.rejectQuestion(q.reqID).catch(() => {});
        }
        // Defensive: ensure PromptInput cannot be left disabled by a stale modal
        // or stray session.updated event. Ctrl-C-during-generation explicitly
        // means "bail to a fresh prompt"; any modal in flight is intentionally
        // dismissed. The non-isGenerating Ctrl-C branches below stay unchanged.
        // The reject + setPendingQueue([]) + editor.clearBuffer() prevent the
        // queue-flush effect from POSTing the operator's typed text as the
        // question's default answer (bug analysis session 20260615T130815Z-161369).
        setPendingQueue([]);
        editor.clearBuffer();
        setPermission(null);
        setQuestion(null);
        // Stage 9.4: reset per-question accumulator on Ctrl-C abort
        questionAnswersRef.current = [];
        setCurrentSubIdx(0);
        setModelPicker(null);
        setSessionPicker(null);
        setIsCompacting(false);
        renderer.commitSystemMessage("Interrupted: What next?");
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

  const switchSession = useCallback(async (newID: string, banner: string) => {
    if (isGenerating) {
      props.backend.session.abort({ path: { id: sessionID } }).catch(() => {});
      setIsGenerating(false);
    }
    props.backend.events.resetEventState();
    userTurnDebouncerRef.current?.reset();
    renderer.clearAll();
    setProcTimes({ thinking: null, tools: null, generating: null });
    setLastSubmitted("");
    setIsCompacting(false);
    setTokenUsage(null);
    setRunningCost(0);
    setSessionID(newID);
    try {
      const resp = await props.backend.session.get({ path: { id: newID } });
      const sess = resp.data;
      if (sess?.model) {
        setActiveModel({ providerID: sess.model.providerID, modelID: sess.model.id });
      } else {
        // No model bound to session yet — seed from server config default
        const defaultModel = await getDefaultModel(props.backend);
        if (defaultModel) {
          setActiveModel(defaultModel);
        }
      }
      setSessionLabel(sess?.title || newID.slice(0, 8));
    } catch { /* leave activeModel as-is */ }
    renderer.commitSystemMessage(banner);
    await refreshTokenUsage(newID);
    await runReplay(newID);
  }, [isGenerating, sessionID, props.backend, renderer, refreshTokenUsage, runReplay]);

  const handleResync = useCallback(async () => {
    // Ctrl-R / /resync triggers the guarded reconciler (see lines 166–244).
    // Even if the user presses Ctrl-R during streaming, the reconciler's
    // layer 2 and 3 guards prevent idle synthesis (recency + openParts check).
    await runReconcilerPassRef.current?.();
    await refreshTokenUsage(sessionIDRef.current);
  }, [refreshTokenUsage]);

  const handleQuestion = useCallback(async (answers: string[][]) => {
    if (!question) return;
    await props.backend.replyQuestion(question.reqID, answers).catch(() => {});
    setQuestion(null);
  }, [question, props.backend]);

  const handleSubmit = useCallback(async (text: string) => {
    // Stage 9.4: per-question collection. Collect one sub-Q answer at a time,
    // advancing currentSubIdx; POST only after the LAST sub-Q.
    if (question) {
      // Early-return on empty buffer — don't advance or submit garbage.
      if (text.trim() === "") return;
      const currentQ = question.questions[currentSubIdx] ?? question.questions[0];
      if (currentQ) {
        const trimmed = text.trim();
        const digitMatch = /^\d+$/.test(trimmed);
        let chosen: string;
        if (digitMatch) {
          const n = parseInt(trimmed, 10);
          if (n >= 1 && n <= currentQ.options.length) {
            chosen = currentQ.options[n - 1].label;
          } else {
            chosen = trimmed;
          }
        } else {
          chosen = trimmed;
        }
        // Store answer for this sub-question
        questionAnswersRef.current[currentSubIdx] = [chosen];
        // Echo per-sub-Q summary to scrollback
        renderer.commitSystemMessage(
          formatAnswerSummary(currentQ, currentSubIdx, question.questions.length, text)
        );
        // If NOT the last sub-question, advance the index and wait for the next answer
        if (currentSubIdx < question.questions.length - 1) {
          setCurrentSubIdx(currentSubIdx + 1);
          return;
        }
        // LAST sub-question — POST the collected answers
        handleQuestion(questionAnswersRef.current);
        return;
      }
    }
    // /exit — clean shutdown
    const exitResult = parseExitCommand(text);
    if (exitResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      renderer.commitSystemMessage("exiting…");
      await props.onExit();
      process.exit(0);
      return;
    }
    // /new / /clear — create a new session
    const newResult = parseNewCommand(text);
    if (newResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      try {
        const resp = await props.backend.session.create({ query: { directory: process.cwd() } });
        const newID = resp.data!.id;
        await switchSession(newID, `new session started (${newID.slice(0, 8)})`);
      } catch (err) {
        renderer.commitSystemMessage(`/new failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // /compact / /summarize — compact the current session
    const compactResult = parseCompactCommand(text);
    if (compactResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      if (!activeModel) {
        renderer.commitSystemMessage("/compact requires an active model — use /model first");
        return;
      }
      setIsCompacting(true);
      try {
        await props.backend.session.compact({
          path: { id: sessionID },
          body: { providerID: activeModel.providerID, modelID: activeModel.modelID },
        });
      } catch (err) {
        setIsCompacting(false);
        renderer.commitSystemMessage(`/compact failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // /sessions / /resume — pick a past session to resume
    const sessionsResult = parseSessionsCommand(text);
    if (sessionsResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      try {
        const resp = await props.backend.session.list();
        const all = (resp.data ?? []).sort((a, b) => b.time.updated - a.time.updated);
        if (all.length === 0) { renderer.commitSystemMessage("no sessions found"); return; }
        const items: SessionPickerItem[] = all.map(s => ({
          id: s.id, title: s.title ?? "", parentID: s.parentID,
          updatedAt: s.time.updated, isCurrent: s.id === sessionID,
        }));
        const initialIdx = Math.max(0, items.findIndex(it => it.isCurrent));
        setSessionPicker({ items, idx: initialIdx });
      } catch (err) {
        renderer.commitSystemMessage(`/sessions error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // /fork — fork the current session into a child
    const forkResult = parseForkCommand(text);
    if (forkResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      try {
        const resp = await props.backend.session.fork({ path: { id: sessionID } });
        const childID = resp.data!.id;
        await switchSession(childID, `forked session (child: ${childID.slice(0, 8)}, parent: ${sessionID.slice(0, 8)})`);
      } catch (err) {
        renderer.commitSystemMessage(`/fork failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // /resync — force a full re-fetch of session state (Stage 4.5.3)
    const resyncResult = parseResyncCommand(text);
    if (resyncResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      await handleResync();
      return;
    }
    // /rename <name> — rename session in DB and tmux windows
    const renameResult = parseRenameCommand(text);
    if (renameResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      if (!renameResult.newLabel) {
        renderer.commitSystemMessage("usage: /rename <name>");
      } else {
        try {
          await props.backend.session.update({ path: { id: sessionID }, body: { title: renameResult.newLabel } });
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
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
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
            props.backend.listProviders(),
            props.backend.session.get({ path: { id: sessionID } }),
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
    const helpResult = parseHelpCommand(text, opencodeCommands);
    if (helpResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      const lines = (helpResult.reply ?? "").split("\n");
      for (const line of lines) renderer.commitSystemMessage(line);
      return;
    }
    // /show — output gate status
    const showResult = parseShowCommand(text, renderer);
    if (showResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      renderer.commitSystemMessage(showResult.reply ?? "");
      return;
    }
    // /<key>-output [on|off] — output gate toggle/query
    const outputResult = parseBlockOutputCommand(text, renderer);
    if (outputResult.handled) {
      // Mobile-Companion Part B: local-only command — no SSE user message emitted; do NOT mint/record (no SSE user message emitted).
      renderer.commitUserInput(text);
      renderer.commitSystemMessage(outputResult.reply ?? "");
      setGateStates(prev => {
        const updated = { ...prev };
        for (const gate of Object.keys(prev)) updated[gate] = renderer.isOutputEnabled(rendererGateKey(gate));
        return updated;
      });
      return;
    }
    // Forward unknown /cmd to opencode
    if (text.startsWith("/")) {
      const parts = text.trim().split(/\s+/);
      const cmdName = parts[0].slice(1);
      if (opencodeCommands.has(cmdName)) {
        const args = parts.slice(1).join(" ");
        // Mobile-Companion Part B: /cmd forwards produce a user SSE message on the server
        // (via session.command below), which produces an SSE user message on the server. We mint
        // and record an own messageID so that SSE echo is recognised and suppressed. The local-only
        // commands above (/exit, /new, etc.) emit no SSE user message and must not mint/record.
        renderer.commitUserInput(text);
        const ownID = mintUserMessageID();
        props.backend.events.recordOwnMessageID(ownID);
        setLastSubmitted(text);
        if (activeModel) {
          const supportsTools = await getToolCallSupport(
            props.backend,
            activeModel.providerID,
            activeModel.modelID,
          );
          if (supportsTools === false) {
            renderer.commitSystemMessage(
              `⚠ ${activeModel.modelID} has tool_call=false — /${cmdName} output may be unreliable (model cannot invoke tools structurally; expect text-mode improvisation).`,
            );
          }
        }

        // Defense-in-depth: validate activeModel against connected providers.
        // In a shared session, foreign turns may have set activeModel to an
        // unsupported model (e.g. from mobile app). This check prevents the
        // server from rejecting the request.
        if (activeModel) {
          const validModel = await validateModel(props.backend, activeModel.providerID, activeModel.modelID);
          if (!validModel) {
            renderer.commitSystemMessage(
              `active model ${activeModel.providerID}/${activeModel.modelID} not available — falling back to default`,
            );
            const fallback = await getDefaultModel(props.backend);
            if (fallback) {
              setActiveModel(fallback);
            }
          }
        }

        // Mobile-Companion Part B: backstop for custom commands whose .md content
        // begins with "# /cmdname". OpenCode injects this heading as the first H1
        // of the system-reminder. When classifyOpenUserTurns detects a user turn
        // starting with this prefix, it suppresses the foreign-user-turn event,
        // preventing the full .md command from being rendered as user input.
        props.backend.events.recordOwnCommandPrefix("# /" + cmdName);

        setIsGenerating(true);
        try {
          await props.backend.session.sendCommand({
            path: { id: sessionID },
            body: {
              command: cmdName,
              arguments: args,
              messageID: ownID,
              ...(activeModel ? { model: `${activeModel.providerID}/${activeModel.modelID}` } : {}),
            },
          });
        } catch (err) {
          setIsGenerating(false);
          renderer.commitError(`[command error] ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }
    // Default: send to OpenCode server
    // Queue for later if model is currently generating
    if (isGeneratingRef.current) {
      if (editor.isViewingPending()) {
        // User edited the queued message — replace queue instead of appending
        setPendingQueue([text]);
      } else {
        setPendingQueue(prev => [...prev, text]);
      }
      return;
    }
    editor.addToHistory(text);
    setLastSubmitted(text);
    // Mobile-Companion Part B: record this locally-submitted text so the SSE echo of
    // our own turn is recognised and suppressed (not re-rendered as a foreign turn).
    const ownID = mintUserMessageID();
    props.backend.events.recordOwnMessageID(ownID);
    renderer.commitUserInput(text);
    setIsGenerating(true);

    // Defense-in-depth: validate activeModel against connected providers before send.
    // In a shared session, foreign turns may have set activeModel to an unsupported
    // model (e.g. from mobile app). This check prevents the server from rejecting
    // the prompt request.
    if (activeModel) {
      const validModel = await validateModel(props.backend, activeModel.providerID, activeModel.modelID);
      if (!validModel) {
        renderer.commitSystemMessage(
          `active model ${activeModel.providerID}/${activeModel.modelID} not available — falling back to default`,
        );
        const fallback = await getDefaultModel(props.backend);
        if (fallback) {
          setActiveModel(fallback);
        }
      }
    }

    try {
      await props.backend.session.sendPrompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text }],
          messageID: ownID,
          ...(activeModel ? { model: activeModel } : {}),
        },
      });
    } catch (err) {
      setIsGenerating(false);
      renderer.commitError(`[send error] ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [props.backend, sessionID, renderer, activeModel, opencodeCommands, switchSession, editor, question, currentSubIdx, handleQuestion]);

  handleSubmitRef.current = handleSubmit;

  const handlePermission = useCallback(async (answer: "once" | "always" | "reject") => {
    if (!permission) return;
    await props.backend.replyPermission({
      path: { id: permission.sessionID, permissionID: permission.permID },
      body: { response: answer },
    }).catch(() => {});
    setPermission(null);
  }, [permission, props.backend]);

 

  const handleModelSelect = useCallback((item: ModelPickerItem) => {
    setActiveModel({ providerID: item.providerID, modelID: item.modelID });
    setModelPicker(null);
    renderer.commitSystemMessage(`model set to ${item.providerID}/${item.modelID}`);
  }, [renderer]);

  const handleModelCancel = useCallback(() => {
    setModelPicker(null);
  }, []);

  const handleSessionSelect = useCallback(async (item: SessionPickerItem) => {
    setSessionPicker(null);
    if (item.id === sessionID) {
      renderer.commitSystemMessage(`already on session ${item.id.slice(0, 8)}`);
      return;
    }
    await switchSession(item.id, `resumed session ${item.id.slice(0, 8)}${item.title ? ` — "${item.title}"` : ""}`);
  }, [sessionID, switchSession, renderer]);

  const handleSessionCancel = useCallback(() => { setSessionPicker(null); }, []);

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
        {(item) => (
          // Stage 10.8.1 — wrap each Static item in <Box> so Yoga lays each
          // out as its own row regardless of whether the CommittedLine came
          // in via a multi-line batch (within-message blank from
          // _commitActiveText splitting on \n) or a single-item push
          // (inter-message blank inject from beginBlock messageID transition).
          // OCTMUX_DEBUG_RENDER=1 instrumentation confirmed the inject fires
          // 7 times for 8 consecutive text parts in a brain pipeline, but
          // the <Text>{" "}</Text> rows were not visible in the operator's
          // render — Ink collapsed them when they arrived as separate
          // single-item Static appends. The Box forces the row even then,
          // mirroring the workaround already in src/components/ActiveBlock.tsx.
          <Box key={item.id}>
            <Text>{item.ansi.length === 0 ? " " : item.ansi}</Text>
          </Box>
        )}
      </Static>
      {activeBlock && <ActiveBlock role={activeBlock.role} ansi={activeBlockAnsi} width={w} maxRows={maxActiveRows} />}
      <Box ref={restRef} flexDirection="column">
      {ctrlcPending && <Text color="yellow">Press Ctrl-C again to exit</Text>}
      {/* Modal-bearing events (permission, question) bypass the renderer's output
          gates by design — interactive prompts must always surface to the operator
          regardless of /tools-output or /thinking-output toggle state. */}
      {permission && <PermissionModal title={permission.title} onAnswer={handlePermission} />}
      {question && <QuestionModal questions={question.questions} currentSubIdx={currentSubIdx} />}
      {isCompacting && <CompactingModal />}
      {modelPicker && (
        <ModelPickerModal
          items={modelPicker.items}
          initialIdx={modelPicker.idx}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
        />
      )}
      {sessionPicker && !isCompacting && (
        <SessionPickerModal
          items={sessionPicker.items}
          initialIdx={sessionPicker.idx}
          onSelect={handleSessionSelect}
          onCancel={handleSessionCancel}
        />
      )}
      {slashCompletion && !permission && !question && !modelPicker && !isCompacting && !sessionPicker && (
        <SlashCompletionOverlay
          candidates={slashCompletion.candidates}
          selectedIdx={slashCompletion.selectedIdx}
          onSelect={handleSlashSelect}
          onCancel={handleSlashCancel}
          onMoveUp={handleSlashMoveUp}
          onMoveDown={handleSlashMoveDown}
        />
      )}
      <Box flexDirection="column" marginBottom={0}>
        <SubprocessStatus thinking={procTimes.thinking} tools={procTimes.tools} generating={procTimes.generating} />
        {pendingQueue.length > 0 && (
          <Text color="yellow" dimColor>
            {pendingQueue.length} message{pendingQueue.length !== 1 ? "s" : ""} queued — will send when done
          </Text>
        )}
        <Rule title={sessionLabel} width={w} align="right" />
        <PromptInput editor={editor} disabled={!!permission || !!modelPicker || isCompacting || !!sessionPicker} overlayOpen={!!slashCompletion} onSubmit={handleSubmit} onCyclePermMode={cyclePermMode} onHelp={triggerHelp} onToggleTools={() => toggleGate("tools-output")} onToggleThinking={() => toggleGate("thinking-output")} onResync={handleResync} onRedraw={props.onRedraw} setPasteCallback={props.setPasteCallback} />
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
          isCompacting={isCompacting}
          runningCost={runningCost}
          orchestraBadge={orchestraBadge}
          sseHealth={sseHealth}
          spinnerFrame={spinnerFrame}
        />
        <PermissionStatusLine permMode={permMode} />
        <ToggleStatusLine bindings={TOGGLES_CONFIG.bindings} gateStates={gateStates} />
      </Box>
      </Box>
    </>
  );
}
