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
  | { kind: "block-start"; partID: string; role: Role; toolName?: string }
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
  | { kind: "question-tool-detected"; sessionID: string; callID: string }
  | { kind: "session-compacting"; sessionID: string; compacting: boolean }
  | { kind: "session-compacted"; sessionID: string }
  | { kind: "message-completed"; messageID: string }
  | { kind: "subagent-detected"; sessionID: string; agent: string; model: string; description?: string }
  | { kind: "subagent-ended"; sessionID: string }
  | { kind: "subagent-activity"; sessionID: string; ts: number };

// Track user message IDs so we don't echo the user's own input back to them.
// opencode fires message.part.updated for user messages too — we skip them.
const userMessageIDs = new Set<string>();

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
// Populated on session.created; cleared on session.deleted / session.idle for the
// child, or session switch.
const trackedChildSessions = new Set<string>();

// Reset event tracking state on session switch.
export function resetEventState(): void {
  userMessageIDs.clear();
  openParts.clear();
  seenPartIDs.clear();
  detectedQuestionToolCallIDs.clear();
  completedAssistantMessageIDs.clear();
  trackedChildSessions.clear();
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
    }
    if (info.sessionID === sessionID && info.role === "assistant") {
      const completed = (info as { time?: { completed?: number | null } }).time?.completed;
      if (completed != null && !completedAssistantMessageIDs.has(info.id)) {
        completedAssistantMessageIDs.add(info.id);
        return { kind: "message-completed", messageID: info.id };
      }
    }
    return null;
  }

  // Primary streaming path: message.part.delta fires once per chunk with the
  // incremental text. EventMessagePartDelta is defined in the v2 SDK types but
  // not in the v1 Event union — cast via unknown since the server emits it
  // regardless of which SDK version the client uses.
  if (event.type === "message.part.delta") {
    const e = event as unknown as {
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
    };
    if (e.properties.sessionID !== sessionID) return null;
    if (!e.properties.delta) return null;

    const role = openParts.get(e.properties.partID);
    if (!role) return null; // part not yet tracked (user part or unknown type)

    const blockDelta: ReplEvent = { kind: "block-delta", partID: e.properties.partID, role, text: e.properties.delta };
    return blockDelta;
  }

  // message.part.updated: handles text, reasoning, and tool parts.
  if (event.type === "message.part.updated") {
    const e = event as EventMessagePartUpdated;
    const part = e.properties.part;
    if (part.sessionID !== sessionID) return null;

    // --- text parts ---
    if (part.type === "text") {
      if (userMessageIDs.has(part.messageID)) return null;
      // First time (len=0 creation): open block and emit generating.
      if (part.text.length === 0 && !seenPartIDs.has(part.id)) {
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
        openParts.set(part.id, "text");
        events.push(
          { kind: "block-start", partID: part.id, role: "text" },
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
        state: { status: string; input?: unknown; raw?: string; output?: string; error?: string; title?: string };
      };
      if (userMessageIDs.has(toolPart.messageID)) return null;

      const state = toolPart.state;

      // First time (pending state): open tool-call block.
      if (state.status === "pending" && !openParts.has(toolPart.id)) {
        openParts.set(toolPart.id, "tool-call");
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
        return events;
      }

      // Tool errored: end tool-call block with error.
      if (state.status === "error" && openParts.get(toolPart.id) === "tool-call") {
        openParts.delete(toolPart.id);
        detectedQuestionToolCallIDs.delete(toolPart.id);
        return { kind: "block-end", partID: toolPart.id, role: "tool-call", status: "error" };
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
      trackedChildSessions.add(info.id);
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
    if (updatedID !== sessionID) return null;
    const compacting = typeof e.properties.info.time.compacting === "number";
    return { kind: "session-compacting", sessionID, compacting };
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

    // A tracked child going idle ends its row.
    if (trackedChildSessions.has(idleID)) {
      if (process.env.OCTMUX_DEBUG_SSE === "1") {
        console.error("[octmux-debug] emitting subagent-ended (via session.idle) for sessionID=" + idleID);
      }
      trackedChildSessions.delete(idleID);
      return { kind: "subagent-ended", sessionID: idleID };
    }

    if (idleID !== sessionID) return null;

    // Close any still-open blocks (text/reasoning parts that didn't get explicit end events).
    const closeEvents: ReplEvent[] = [];
    for (const [partID, role] of openParts) {
      closeEvents.push({ kind: "block-end", partID, role });
    }
    openParts.clear();
    seenPartIDs.clear();
    return [{ kind: "session-idle" }, ...closeEvents];
  }

  if (event.type === "session.error") {
    const e = event as EventSessionError;
    // sessionID is optional on EventSessionError; only show errors for ours.
    if (e.properties.sessionID !== sessionID) return null;
    const err = e.properties.error;
    const message = err && "data" in err ? err.data.message : "unknown server error";
    return { kind: "error", message };
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

  return null;
}
