import type {
  Event,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventSessionIdle,
  EventSessionError,
  EventSessionStatus,
  EventMessagePartRemoved,
  EventPermissionUpdated,
  EventSessionUpdated,
  EventSessionCompacted,
  EventSessionCreated,
  EventSessionDeleted,
} from "@opencode-ai/sdk";
import type { Role } from "./blocks.ts";

// Normalised events the REPL cares about; all others are dropped.
export type ReplEvent =
  | { kind: "block-start"; partID: string; role: Role; toolName?: string; messageID?: string }
  | { kind: "block-delta"; partID: string; role: Role; text: string }
  | { kind: "block-end";   partID: string; role: Role; status?: "ok" | "error" }
  | { kind: "session-idle" }
  | { kind: "error"; message: string }
  | { kind: "generating" }
  | { kind: "session-status"; status: "idle" | "busy" | "retry" }
  | { kind: "part-removed"; partId: string }
  | { kind: "permission-asked"; permID: string; sessionID: string; title: string; permType: string }
  | { kind: "question-asked"; reqID: string; sessionID: string; questions: Array<{
      question: string; header: string; options: Array<{ label: string; description: string }>;
      multiple?: boolean; custom?: boolean;
    }> }
  | { kind: "question-replied"; reqID: string; sessionID: string; answers: string[][] }
  | { kind: "question-rejected"; reqID: string; sessionID: string }
  | { kind: "question-tool-detected"; sessionID: string; callID: string }
  | { kind: "session-compacted"; sessionID: string }
  | { kind: "block-retag"; partID: string; newRole: "summary" }
  | { kind: "compaction-divider"; sessionID: string; auto: boolean }
  | { kind: "message-completed"; messageID: string }
  | { kind: "subagent-detected"; sessionID: string; agent: string; model: string; description?: string }
  | { kind: "subagent-ended"; sessionID: string }
  | { kind: "subagent-activity"; sessionID: string; ts: number }
  | { kind: "parent-turn-end"; reason: "idle" | "aborted" | "error" }
  | { kind: "foreign-user-turn"; messageID: string; text: string };

// Track user message IDs so we don't echo the user's own input back to them.
// opencode fires message.part.updated for user messages too — we skip them.
const userMessageIDs = new Set<string>();

// Mobile-Companion Part B: FIFO of locally-submitted user text. octmux always submits
// one text part per prompt; a foreign client MAY submit multiple. Consumed at the
// turn boundary to suppress our own turns before they reach the renderer.
const submittedUserTexts: string[] = [];
// Per-messageID arrival-order accumulator of user text parts (excludes parts where
// synthetic===true || ignored===true). Cleared on session switch and after flush.
const accumulatedUserTexts = new Map<string, string[]>();
// Guards against double-flush of the same user messageID.
const classifiedUserMessageIDs = new Set<string>();
// The single user-turn messageID currently accumulating text parts. Set on user
// message.updated; cleared on flush. At most one open turn at a time in the
// single-operator hand-off model; flush tolerates back-to-back foreign turns.
let openUserTurnMessageID: string | null = null;

// Maps partID → Role for currently-open (in-progress) blocks.
const openParts = new Map<string, Role>();
// Used only for "emit generating exactly once" logic.
const seenPartIDs = new Set<string>();

// Tracks callIDs of tool=question parts for which we've already emitted
// question-tool-detected. Prevents re-fire on repeated message.part.updated
// events with state.status=running (which OC sends as the question tool's
// input streams in). Cleared on session switch via resetEventState.
const detectedQuestionToolCallIDs = new Set<string>();

// Tracks assistant messageIDs for which we've already emitted message-completed.
// Prevents re-firing when OC broadcasts repeated message.updated events after
// time.completed is first set (e.g. follow-up metadata updates). Cleared on
// session switch via resetEventState().
const completedAssistantMessageIDs = new Set<string>();

// Tracks child session IDs for sessions whose parentID matches the harness session.
// Populated on session.created; cleared on session.deleted or when the paired
// parent Task tool transitions to completed/error.
const trackedChildSessions = new Set<string>();

// Task-tool partIDs first observed in pending/running state, not yet paired with
// a child session. JS Sets iterate in insertion order — FIFO-paired on the next
// session.created with matching parentID.
const openTaskPartIDs = new Set<string>();

// Paired Task-tool partID → child sessionID. Drained on Task tool completed/error
// to emit subagent-ended for the precise lifetime of one subagent dispatch.
// This is OC's protocol-precise "subagent task done" signal; session.idle is just
// "session paused awaiting input/turn" and fires repeatedly during a single task.
const taskToChild = new Map<string, string>();

// Child session IDs that arrived via session.created before any Task tool
// part was pending — they could not be paired at detection time. When the next
// task part goes pending, tryPair() drains this set first (FIFO within the
// insertion-ordered Set).
const unpairedChildren = new Set<string>();

// Summary message IDs: set of assistant message IDs whose info.summary === true.
// Used to tag text parts belonging to summary messages with role "summary"
// instead of "text", so the renderer can distinguish them visually.
const summaryMessageIDs = new Set<string>();

// Maps partID → messageID so that when a message.updated arrives with
// info.summary === true, we can retroactively retag any already-open part
// that belongs to that message (block-retag event).
const partIDToMessageID = new Map<string, string>();

// Reset event tracking state on session switch.
export function resetEventState(): void {
  userMessageIDs.clear();
  openParts.clear();
  seenPartIDs.clear();
  detectedQuestionToolCallIDs.clear();
  completedAssistantMessageIDs.clear();
  trackedChildSessions.clear();
  openTaskPartIDs.clear();
  taskToChild.clear();
  unpairedChildren.clear();
  summaryMessageIDs.clear();
  partIDToMessageID.clear();
  submittedUserTexts.length = 0;
  accumulatedUserTexts.clear();
  classifiedUserMessageIDs.clear();
  openUserTurnMessageID = null;
}

// Mobile-Companion Part B (FIFO dedup).
/**
 * Mobile-Companion Part B (FIFO dedup). Push the local user's submitted text so the
 * next foreign-user-turn flush at the turn boundary can recognise and suppress it.
 * Called from app.tsx at every prompt path that produces an SSE user message
 * (default promptAsync + /cmd session.command). Local-only commands MUST NOT call
 * this — they produce no user SSE event and pushing would corrupt the FIFO.
 */
export function recordSubmittedUserText(text: string): void {
  submittedUserTexts.push(text);
}

/**
 * Test-only peek of the FIFO head. Exported for src/events.test.ts to assert
 * "FIFO consumed". Returns undefined when the queue is empty.
 */
export function peekSubmittedUserText(): string | undefined {
  return submittedUserTexts[0];
}

/**
 * If the FIFO head equals candidate, shift it off and return true (local echo —
 * caller suppresses emission). Otherwise return false (foreign — caller emits
 * foreign-user-turn). Exact string equality; no trimming/normalisation: octmux
 * submits the literal buffer string verbatim.
 */
function consumeSubmittedUserText(candidate: string): boolean {
  if (submittedUserTexts.length > 0 && submittedUserTexts[0] === candidate) {
    submittedUserTexts.shift();
    return true;
  }
  return false;
}

/**
 * Flush the open user turn. Joins accumulated text parts with "\n" (Map insertion
 * order preserves text-part arrival order), classifies against the local FIFO, and
 * returns null (local echo suppressed; empty suppressed) or a foreign-user-turn
 * event. Clears per-messageID state and the open-turn pointer. No-op if nothing open.
 */
function flushOpenUserTurn(): ReplEvent | null {
  const openID = openUserTurnMessageID;
  if (openID === null) return null;
  openUserTurnMessageID = null;
  classifiedUserMessageIDs.add(openID);
  const parts = accumulatedUserTexts.get(openID);
  accumulatedUserTexts.delete(openID);
  const joined = (parts ?? []).join("\n");
  if (joined === "") return null;
  if (consumeSubmittedUserText(joined)) return null;
  return { kind: "foreign-user-turn", messageID: openID, text: joined };
}

// Attempt to pair pending task parts with unmatched children.
// Called whenever either unpairedChildren or openTaskPartIDs gains a new entry.
// Both Sets iterate in insertion order (JS spec), so pairing is FIFO:
// the oldest pending part pairs with the oldest unpaired child.
//
// Subagent row lifecycle — three-layer defense (Stage 8.1.6):
// Layer A = metadata-keyed pairing precedence: read state.metadata.sessionId from
// task tool parts and pair directly via taskToChild; FIFO tryPair is the fallback
// for children arriving before metadata is available. This prevents interrupted tasks
// (which enter openTaskPartIDs without pairing) from poison-fu FIFO-mispairing real children.
// Layer B = parent-turn-end sweep signal: emitted on parent session.idle, parent message abort,
// or parent session.error to clean up orphaned rows when operator interrupt occurs (MessageAbortedError).
// Layer C = age-based eviction in orchestra-watch.ts: sweepStaleSubagents() removes subagent rows
// that have been idle beyond the spinner-freeze threshold.
function tryPair(): void {
  const childIter = unpairedChildren.values();
  const partIter  = openTaskPartIDs.values();
  while (true) {
    const childStep = childIter.next();
    const partStep  = partIter.next();
    if (childStep.done || partStep.done) break;
    const childID = childStep.value;
    const partID  = partStep.value;
    taskToChild.set(partID, childID);
    openTaskPartIDs.delete(partID);
    unpairedChildren.delete(childID);
    if (process.env.OCTMUX_DEBUG_SSE === "1") {
      console.error(
        "[octmux-debug] tryPair paired taskPartID=" + partID + " childID=" + childID
      );
    }
  }
}

/**
 * Walk the module-scope openParts map and return the same ReplEvent[] the
 * SSE session.idle handler would produce. Used by the Stage 4.5.3 reconciler
 * to synthesise a session-idle when SSE missed the real event. Mutates
 * module state (clears openParts/seenPartIDs) — exactly matches the
 * session.idle handler at lines 188-200.
 *
 * CRITICAL for --multi-window safety (see docs/Stage4.md Stage 4.5.1/4.5.2):
 * the block-end events are necessary to flush TmuxWindowRenderer._lineBufs
 * and clear _openBlocks so the next real beginBlock starts from a clean
 * state. endBlock is idempotent on both renderers, so over-emission is
 * harmless; under-emission corrupts FIFO state.
 */
export function synthesizeSessionIdleEvents(): ReplEvent[] {
  const closeEvents: ReplEvent[] = [];
  for (const [partID, role] of openParts) {
    closeEvents.push({ kind: "block-end", partID, role });
  }
  openParts.clear();
  seenPartIDs.clear();
  return [{ kind: "session-idle" }, ...closeEvents];
}

/**
 * Returns true if openParts currently contains any part with role "text" or
 * "thinking" — i.e., a streaming text/reasoning block is in progress.
 * Pure read; does not mutate openParts or seenPartIDs.
 * Used by the Stage 4.5.3 redesigned reconciler (layer 3 guard) to refuse
 * idle synthesis while live text streaming is happening.
 */
export function hasOpenStreamingPart(): boolean {
  for (const role of openParts.values()) {
    if (role === "text" || role === "thinking") return true;
  }
  return false;
}

// SDK part-type → Role mapping (assumptions based on SDK type inspection; confirm via live run):
// | part.type    | message.part.delta field (assumed) | Role emitted    |
// |--------------|-----------------------------------|-----------------|
// | "text"       | "text"                            | "text"          |
// | "reasoning"  | "text" (assumed; same .text prop) | "thinking"      |
// | "tool"       | "raw"  (assumed; ToolStatePending.raw) | "tool-call" |
// | "tool"       | n/a (output arrives via part.updated) | "tool-result" |

// Filter a raw SDK GlobalEvent payload to one the REPL cares about.
// Returns null, a single ReplEvent, or an array of ReplEvents for events with side effects.
export function filterEvent(event: Event, sessionID: string): ReplEvent | ReplEvent[] | null {
  if (process.env.OCTMUX_DEBUG_SSE === "1") {
    console.error("[octmux-debug] filterEvent type=" + (event as any).type);
  }
  // Track user message IDs so we can skip their text parts below.
  if (event.type === "message.updated") {
    const info = (event as EventMessageUpdated).properties.info;
    if (info.sessionID === sessionID && info.role === "user") {
      userMessageIDs.add(info.id);
      // Mobile-Companion Part B: set the open user turn. Flush any prior still-open
      // one first (defensive: back-to-back foreign turns before an assistant reply).
      if (openUserTurnMessageID !== null && openUserTurnMessageID !== info.id) {
        flushOpenUserTurn();
      }
      if (!classifiedUserMessageIDs.has(info.id)) {
        openUserTurnMessageID = info.id;
      }
    }
    if (info.sessionID === sessionID && info.role === "assistant") {
      const events: ReplEvent[] = [];
      // Mobile-Companion Part B: assistant message.updated is the primary turn boundary.
      // Prepend the flushed foreign-user-turn (if any) so it renders before this assistant
      // turn's block-retag / parent-turn-end / message-completed events.
      const userTurnEvent = flushOpenUserTurn();
      if (userTurnEvent) events.push(userTurnEvent);
      // Summary detection: if this assistant message is marked summary=true,
      // retag any already-open text parts to role "summary".
      if (info.summary === true && !summaryMessageIDs.has(info.id)) {
        summaryMessageIDs.add(info.id);
        for (const [partID, msgID] of partIDToMessageID) {
          if (msgID === info.id && openParts.has(partID)) {
            events.push({ kind: "block-retag", partID, newRole: "summary" });
          }
        }
      }
      // Handle errors on assistant message (operator interrupt).
      const infoErr = (info as unknown as { error?: { name?: string; data?: { message?: string } } }).error;
      if (infoErr) {
        events.push({
          kind: "parent-turn-end",
          reason: infoErr.name === "MessageAbortedError" ? "aborted" : "error",
        });
      }
      // Existing message-completed logic.
      const completed = (info as { time?: { completed?: number | null } }).time?.completed;
      if (completed != null && !completedAssistantMessageIDs.has(info.id)) {
        completedAssistantMessageIDs.add(info.id);
        events.push({ kind: "message-completed", messageID: info.id });
      }
      if (events.length === 1) return events[0];
      if (events.length > 1) return events;
    }
    return null;
  }

  // Primary streaming path: message.part.delta fires once per chunk with the
  // incremental text. EventMessagePartDelta is defined in the v2 SDK types but
  // not in the v1 Event union — cast via unknown since the server emits it
  // regardless of which SDK version the client uses.
  // Role has been pre-selected at block-start time (see message.part.updated
  // text/reasoning/tool branches); this branch trusts openParts.get(partID)
  // without re-evaluating summary status.
  if (event.type === "message.part.delta") {
    const e = event as unknown as {
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
    };

    // Branch A: parent session — fall through to existing block-delta logic
    if (e.properties.sessionID === sessionID) {
      if (!e.properties.delta) return null;

      const role = openParts.get(e.properties.partID);
      if (!role) return null; // part not yet tracked (user part or unknown type)

      const blockDelta: ReplEvent = { kind: "block-delta", partID: e.properties.partID, role, text: e.properties.delta };
      return blockDelta;
    }

    // Branch B: tracked child session — emit subagent-activity and return immediately.
    // Reasoning models emit message.part.delta at high frequency during inference.
    // Each non-empty delta bump lets the spinner show activity. Throttling is
    // intentionally deferred per RESEARCH.md § Risks—Activity storm.
    if (trackedChildSessions.has(e.properties.sessionID) && e.properties.delta) {
      return { kind: "subagent-activity", sessionID: e.properties.sessionID, ts: Date.now() };
    }

    // Branch C: everything else — drop
    return null;
  }

  // message.part.updated: handles text, reasoning, and tool parts.
  if (event.type === "message.part.updated") {
    const e = event as EventMessagePartUpdated;
    const part = e.properties.part;

    // Branch A: parent session — fall through to existing per-type sub-handlers
    if (part.sessionID !== sessionID) {
      // Branch B: tracked child session — emit subagent-activity and return immediately.
      // Tool-call updates (message.part.updated with tool-part payload) carry callID
      // and state; any message activity from a tracked child counts as a spinner bump
      // regardless of part type. Throttling is intentionally deferred per RESEARCH.md §
      // Risks—Activity storm.
      if (trackedChildSessions.has(part.sessionID)) {
        return { kind: "subagent-activity", sessionID: part.sessionID, ts: Date.now() };
      }

      // Branch C: everything else — drop
      return null;
    }

    // --- compaction parts ---
    if (part.type === "compaction") {
      const compPart = part as unknown as { auto?: boolean };
      return { kind: "compaction-divider", sessionID, auto: !!compPart.auto };
    }

    // --- text parts ---
    if (part.type === "text") {
      if (userMessageIDs.has(part.messageID)) {
        // Mobile-Companion Part B: accumulate user text parts by messageID for
        // turn-boundary classification. Exclude server-synthetic and explicitly-ignored
        // parts. The block-start logic below is assistant-only, so return null after.
        if (part.synthetic === true || part.ignored === true) {
          return null;
        }
        const arr = accumulatedUserTexts.get(part.messageID) ?? [];
        arr.push(part.text);
        accumulatedUserTexts.set(part.messageID, arr);
        return null;
      }
      // First time (len=0 creation): open block and emit generating.
      if (part.text.length === 0 && !seenPartIDs.has(part.id)) {
        partIDToMessageID.set(part.id, part.messageID);
        seenPartIDs.add(part.id);
        // Text starting means reasoning is done — close any open thinking blocks first
        // so app.tsx clears the thinking timer before text streaming begins.
        const events: ReplEvent[] = [];
        for (const [thinkPartID, role] of openParts) {
          if (role === "thinking") {
            events.push({ kind: "block-end", partID: thinkPartID, role: "thinking" });
          }
        }
        for (const ev of events) openParts.delete(ev.partID);
        const role: Role = summaryMessageIDs.has(part.messageID) ? "summary" : "text";
        openParts.set(part.id, role);
        events.push(
          { kind: "block-start", partID: part.id, role, messageID: part.messageID },
          { kind: "generating" },
        );
        return events;
      }
      return null;
    }

    // --- reasoning parts ---
    if (part.type === "reasoning") {
      if (userMessageIDs.has(part.messageID)) return null;
      if (!openParts.has(part.id)) {
        partIDToMessageID.set(part.id, part.messageID);
        openParts.set(part.id, "thinking");
        return { kind: "block-start", partID: part.id, role: "thinking" };
      }
      return null;
    }

    // --- tool parts ---
    if (part.type === "tool") {
      const toolPart = part as unknown as {
        id: string; messageID: string; sessionID: string;
        type: "tool"; tool: string;
        callID: string;
        state: { status: string; input?: unknown; raw?: string; output?: string; error?: string; title?: string; metadata?: { sessionId?: string; interrupted?: boolean } };
      };
      if (userMessageIDs.has(toolPart.messageID)) return null;

      const state = toolPart.state;

      // First time (pending state): open tool-call block.
      if (state.status === "pending" && !openParts.has(toolPart.id)) {
        partIDToMessageID.set(toolPart.id, toolPart.messageID);
        openParts.set(toolPart.id, "tool-call");
        if (toolPart.tool === "task") {
          // Metadata-keyed pairing precedence: read sessionId from metadata first.
          // This takes precedence over FIFO pairing to prevent interrupted tasks
          // (which entered openTaskPartIDs without pairing) from poison-fu mispairing.
          const metaChild = toolPart.state.metadata?.sessionId;
          if (metaChild && metaChild !== "") {
            // Metadata-keyed pairing: direct pair via taskToChild.
            taskToChild.set(toolPart.id, metaChild);
            // Remove from unpairedChildren if present (it may have been left there
            // by a prior interrupted task with the same sessionId).
            if (unpairedChildren.has(metaChild)) {
              unpairedChildren.delete(metaChild);
            }
            if (process.env.OCTMUX_DEBUG_SSE === "1") {
              console.error("[octmux-debug] metadata-keyed pairing partID=" + toolPart.id + " childID=" + metaChild);
            }
            // Do NOT add to openTaskPartIDs and do NOT call tryPair — already paired.
          } else {
            // No metadata: fall back to existing FIFO pairing.
            openTaskPartIDs.add(toolPart.id);
            if (process.env.OCTMUX_DEBUG_SSE === "1") {
              console.error("[octmux-debug] task tool pending partID=" + toolPart.id);
            }
            tryPair();
          }
        }
        return { kind: "block-start", partID: toolPart.id, role: "tool-call", toolName: toolPart.tool };
      }

      // MCP-question side-channel: when a tool=question part transitions to running,
      // signal app.tsx to do a one-shot /question lookup.
      // We detect on "running" (not "pending") because the OC question registry is
      // only populated once the MCP handler receives the dispatched tool call —
      // before that, /question would return nothing. Returning this event has no
      // renderer side-effect by itself.
      // One-shot per callID: OC may emit multiple running updates as the tool's
      // JSON input streams in. detectedQuestionToolCallIDs prevents re-fire.
      if (state.status === "running" && toolPart.tool === "question"
          && !detectedQuestionToolCallIDs.has(toolPart.id)) {
        detectedQuestionToolCallIDs.add(toolPart.id);
        return {
          kind: "question-tool-detected",
          sessionID: toolPart.sessionID,
          callID: toolPart.callID,
        };
      }

      // Tool completed: end tool-call block; emit tool-result block.
      if (state.status === "completed" && openParts.get(toolPart.id) === "tool-call") {
        openParts.delete(toolPart.id);
        detectedQuestionToolCallIDs.delete(toolPart.id);
        const output = state.output ?? "";
        const events: ReplEvent[] = [
          { kind: "block-end", partID: toolPart.id, role: "tool-call", status: "ok" },
        ];
        if (output) {
          const resultPartID = `${toolPart.id}-result`;
          events.push(
            { kind: "block-start", partID: resultPartID, role: "tool-result" },
            { kind: "block-delta", partID: resultPartID, role: "tool-result", text: output },
            { kind: "block-end",   partID: resultPartID, role: "tool-result", status: "ok" },
          );
        }
        // Task tool finished → end the paired subagent's row. This is the
        // protocol-precise "subagent task done" signal (vs. session.idle which
        // is just "session paused awaiting input/turn").
        if (toolPart.tool === "task") {
          const pairedChildID = taskToChild.get(toolPart.id);
          if (pairedChildID) {
            if (process.env.OCTMUX_DEBUG_SSE === "1") {
              console.error("[octmux-debug] task tool completed, ending subagent partID=" + toolPart.id + " childID=" + pairedChildID);
            }
            taskToChild.delete(toolPart.id);
            trackedChildSessions.delete(pairedChildID);
            events.push({ kind: "subagent-ended", sessionID: pairedChildID });
          } else if (openTaskPartIDs.has(toolPart.id)) {
            // Task finished before a session.created paired it (race, or no child created).
            openTaskPartIDs.delete(toolPart.id);
          }
        }
        return events;
      }

      // Task tool errored (incl. operator interrupt / aborted task): close the tool-call
      // block if it was open, and remove the paired subagent row. Unconditional subagent
      // cleanup handles the error-without-pending case; block-end is conditional on the
      // block having been opened.
      if (state.status === "error" && toolPart.tool === "task") {
        const events: ReplEvent[] = [];
        const hadOpenBlock = openParts.get(toolPart.id) === "tool-call";
        if (hadOpenBlock) {
          openParts.delete(toolPart.id);
          detectedQuestionToolCallIDs.delete(toolPart.id);
          events.push({ kind: "block-end", partID: toolPart.id, role: "tool-call", status: "error" });
        }
        const pairedChildID = taskToChild.get(toolPart.id);
        if (pairedChildID) {
          if (process.env.OCTMUX_DEBUG_SSE === "1") {
            console.error("[octmux-debug] task tool errored, ending subagent partID=" + toolPart.id + " childID=" + pairedChildID);
          }
          taskToChild.delete(toolPart.id);
          trackedChildSessions.delete(pairedChildID);
          events.push({ kind: "subagent-ended", sessionID: pairedChildID });
          return events;
        } else if (openTaskPartIDs.has(toolPart.id)) {
          openTaskPartIDs.delete(toolPart.id);
        }
        return events.length > 0 ? events : null;
      }

      // Generic error branch: only for non-task parts, or task parts that weren't paired.
      if (state.status === "error" && openParts.get(toolPart.id) === "tool-call" && toolPart.tool !== "task") {
        openParts.delete(toolPart.id);
        detectedQuestionToolCallIDs.delete(toolPart.id);
        const events: ReplEvent[] = [
          { kind: "block-end", partID: toolPart.id, role: "tool-call", status: "error" },
        ];
        return events;
      }

      return null;
    }

    return null;
  }

  // Subagent dispatch is signalled by `session.created` whose `info.parentID`
  // matches the harness session. Track the child sessionID so subsequent
  // lifecycle events (idle / deleted / updated) can be routed to per-row
  // signals. `info.agent` and `info.model` are populated by the locally-built
  // OC daemon (FlorianOtel/opencode@98a4907c9, Stage 8.1.3) — the published
  // SDK Session type lags behind these additions, hence the `as any` access.
  if (event.type === "session.created") {
    const e = event as EventSessionCreated;
    const info = e.properties.info as unknown as {
      id: string;
      parentID?: string;
      agent?: string;
      model?: { id: string; providerID: string; variant?: string };
    };
    if (process.env.OCTMUX_DEBUG_SSE === "1") {
      console.error(
        "[octmux-debug] session.created id=" + info.id +
        " parentID=" + (info.parentID ?? "<undefined>") +
        " agent=" + (info.agent ?? "<undefined>") +
        " model=" + (info.model ? info.model.providerID + "/" + info.model.id : "<undefined>") +
        " harness=" + sessionID +
        " match=" + String(info.parentID === sessionID)
      );
    }
    if (info.parentID === sessionID && !trackedChildSessions.has(info.id)) {
      // Check if this child is already metadata-paired to a task part.
      const alreadyPaired = [...taskToChild.values()].includes(info.id);
      if (alreadyPaired) {
        // Child already paired via metadata-keyed logic — skip FIFO pairing.
        trackedChildSessions.add(info.id);
        return {
          kind: "subagent-detected",
          sessionID: info.id,
          agent: info.agent ?? "",
          model: info.model ? `${info.model.providerID}/${info.model.id}` : "",
        };
      }
      trackedChildSessions.add(info.id);
      // Park this child in unpairedChildren, then let tryPair() do both sides.
      unpairedChildren.add(info.id);
      if (process.env.OCTMUX_DEBUG_SSE === "1") {
        console.error(
          "[octmux-debug] session.created child added to unpairedChildren childID=" + info.id +
          " openTaskPartIDsSize=" + openTaskPartIDs.size
        );
      }
      tryPair();
      const modelStr = info.model
        ? `${info.model.providerID}/${info.model.id}`
        : "";
      return {
        kind: "subagent-detected",
        sessionID: info.id,
        agent: info.agent ?? "",
        model: modelStr,
      };
    }
    return null;
  }

  if (event.type === "session.deleted") {
    const e = event as EventSessionDeleted;
    const childID = e.properties.info.id;
    if (process.env.OCTMUX_DEBUG_SSE === "1") {
      console.error(
        "[octmux-debug] session.deleted sessionID=" + childID +
        " isTrackedChild=" + String(trackedChildSessions.has(childID))
      );
    }
    if (trackedChildSessions.has(childID)) {
      if (process.env.OCTMUX_DEBUG_SSE === "1") {
        console.error("[octmux-debug] emitting subagent-ended (via session.deleted) for sessionID=" + childID);
      }
      trackedChildSessions.delete(childID);
      return { kind: "subagent-ended", sessionID: childID };
    }
    return null;
  }

  if (event.type === "session.updated") {
    const e = event as EventSessionUpdated;
    const updatedID = e.properties.info.id;
    // Per-row activity for tracked children — drives the spinner-vs-frozen signal.
    if (trackedChildSessions.has(updatedID)) {
      return { kind: "subagent-activity", sessionID: updatedID, ts: Date.now() };
    }
    return null;
  }

  if (event.type === "session.compacted") {
    const e = event as EventSessionCompacted;
    if (e.properties.sessionID !== sessionID) return null;
    return { kind: "session-compacted", sessionID };
  }

  if (event.type === "session.idle") {
    const e = event as EventSessionIdle;
    const idleID = e.properties.sessionID;
    if (process.env.OCTMUX_DEBUG_SSE === "1") {
      console.error(
        "[octmux-debug] session.idle sessionID=" + idleID +
        " isTrackedChild=" + String(trackedChildSessions.has(idleID)) +
        " isHarnessParent=" + String(idleID === sessionID)
      );
    }

    // OC fires session.idle every time a session pauses awaiting input/turn.
    // For subagent sessions this fires repeatedly within a single dispatched task
    // (between LLM turns / tool calls). Row removal is driven instead by the
    // parent's Task tool transitioning to state=completed/error (see the tool
    // branch above). Stage 8.1.4 spinner-freeze (120s) provides the
    // inactivity-recent visual cue meanwhile.
    if (trackedChildSessions.has(idleID)) {
      return null;
    }

    if (idleID !== sessionID) return null;

    // Close any still-open blocks (text/reasoning parts that didn't get explicit end events).
    const closeEvents: ReplEvent[] = [];
    for (const [partID, role] of openParts) {
      closeEvents.push({ kind: "block-end", partID, role });
    }
    openParts.clear();
    seenPartIDs.clear();
    // Mobile-Companion Part B: backstop flush if a foreign turn arrived but no assistant
    // message.updated followed before idle.
    const userTurnEvent = flushOpenUserTurn();
    const userTurn = userTurnEvent ? [userTurnEvent] : [];
    return [...userTurn, { kind: "parent-turn-end", reason: "idle" }, { kind: "session-idle" }, ...closeEvents];
  }

  if (event.type === "session.error") {
    const e = event as EventSessionError;
    // sessionID is optional on EventSessionError; only show errors for ours.
    if (e.properties.sessionID !== sessionID) return null;
    const err = e.properties.error;
    const message = err && "data" in err ? err.data.message : "unknown server error";
    return [
      { kind: "parent-turn-end", reason: "error" },
      { kind: "error", message },
    ];
  }

  if (event.type === "session.status") {
    const e = event as EventSessionStatus;
    if (e.properties.sessionID !== sessionID) return null;
    return { kind: "session-status", status: e.properties.status.type };
  }

  if (event.type === "message.part.removed") {
    const e = event as EventMessagePartRemoved;
    if (e.properties.sessionID !== sessionID) return null;
    const partId = e.properties.partID;
    const events: ReplEvent[] = [{ kind: "part-removed", partId }];
    const role = openParts.get(partId);
    if (role) {
      events.push({ kind: "block-end", partID: partId, role });
      openParts.delete(partId);
    }
    seenPartIDs.delete(partId);
    return events;
  }

  // v1 event type: permission.updated
  if (event.type === "permission.updated") {
    const e = event as EventPermissionUpdated;
    if (e.properties.sessionID !== sessionID) return null;
    return {
      kind: "permission-asked",
      permID: e.properties.id,
      sessionID: e.properties.sessionID,
      title: e.properties.title,
      permType: e.properties.type,
    };
  }

  // v2 event type (not in v1 union): permission.asked
  // Property shape matches the live OC daemon (verified via OpenAPI and live curl).
  // The v1 SDK type union does NOT include this event, hence the `as unknown` cast;
  // the daemon emits it anyway. See Stage 4.5.3 reconciler (app.tsx) for REST fallback
  // that synthesises this event shape for missed-permission recovery.
  if (event.type === "permission.asked") {
    const e = event as unknown as { properties: {
      id: string; sessionID: string; permission: string; patterns: string[];
    }};
    if (e.properties.sessionID !== sessionID) return null;
    return {
      kind: "permission-asked",
      permID: e.properties.id,
      sessionID: e.properties.sessionID,
      title: e.properties.permission,
      permType: e.properties.permission,
    };
  }

  // v2 event type (not in v1 union): question.asked
  // Property shape matches the live OC daemon (verified via OpenAPI and live curl).
  // The v1 SDK type union does NOT include this event, hence the `as unknown` cast;
  // the daemon emits it anyway. See Stage 4.5.3 reconciler (app.tsx) for REST fallback
  // that synthesises this event shape for missed-question recovery.
  if (event.type === "question.asked") {
    const e = event as unknown as { properties: {
      id: string; sessionID: string;
      questions: Array<{
        question: string; header: string;
        options: Array<{ label: string; description: string }>;
        multiple?: boolean; custom?: boolean;
      }>;
    }};
    if (e.properties.sessionID !== sessionID) return null;
    return {
      kind: "question-asked",
      reqID: e.properties.id,
      sessionID: e.properties.sessionID,
      questions: e.properties.questions,
    };
  }

  // v2 event type (not in v1 union): question.replied
  // Emitted when a question is answered externally (e.g. via Pocket mobile app
  // POSTing /question/{id}/reply). Clears the pending modal in octmux.
  if (event.type === "question.replied") {
    const e = event as unknown as { properties: { sessionID: string; requestID: string; answers: string[][] } };
    if (e.properties.sessionID !== sessionID) return null;
    return {
      kind: "question-replied",
      reqID: e.properties.requestID,
      sessionID: e.properties.sessionID,
      answers: e.properties.answers,
    };
  }

  // v2 event type (not in v1 union): question.rejected
  // Emitted when a question is rejected externally (e.g. via Pocket mobile app
  // or Ctrl-C on another client). Clears the pending modal in octmux.
  if (event.type === "question.rejected") {
    const e = event as unknown as { properties: { sessionID: string; requestID: string } };
    if (e.properties.sessionID !== sessionID) return null;
    return {
      kind: "question-rejected",
      reqID: e.properties.requestID,
      sessionID: e.properties.sessionID,
    };
  }

  return null;
}
