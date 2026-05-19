import type {
  Event,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventSessionIdle,
  EventSessionError,
  EventSessionStatus,
  EventMessagePartRemoved,
} from "@opencode-ai/sdk";

// Normalised events the REPL cares about; all others are dropped.
export type ReplEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "session-idle" }
  | { kind: "error"; message: string }
  | { kind: "generating" }
  | { kind: "session-status"; status: "idle" | "busy" | "retry" }
  | { kind: "part-removed"; partId: string };

// Track user message IDs so we don't echo the user's own input back to them.
// opencode fires message.part.updated for user messages too — we skip them.
const userMessageIDs = new Set<string>();

// Track which part IDs we've already emitted a "generating" event for, so we
// don't re-emit it on subsequent message.part.updated events for the same part.
const seenPartIDs = new Set<string>();

// Filter a raw SDK GlobalEvent payload to one the REPL cares about.
// Returns null for sub-agent events, unrelated sessions, or event types we ignore.
export function filterEvent(event: Event, sessionID: string): ReplEvent | null {
  // Track user message IDs so we can skip their text parts below.
  if (event.type === "message.updated") {
    const info = (event as EventMessageUpdated).properties.info;
    if (info.sessionID === sessionID && info.role === "user") {
      userMessageIDs.add(info.id);
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
    if (e.properties.field !== "text") return null;
    if (!e.properties.delta) return null;
    return { kind: "text-delta", text: e.properties.delta };
  }

  // message.part.updated: only used to detect the creation (len=0) event and
  // emit the "generating" indicator. Text content now comes from part.delta above.
  if (event.type === "message.part.updated") {
    const e = event as EventMessagePartUpdated;
    const part = e.properties.part;
    if (part.type !== "text" || part.sessionID !== sessionID) return null;
    if (userMessageIDs.has(part.messageID)) return null;
    // Emit "generating" exactly once — on the len=0 creation event.
    if (part.text.length === 0 && !seenPartIDs.has(part.id)) {
      seenPartIDs.add(part.id);
      return { kind: "generating" };
    }
    return null;
  }

  if (event.type === "session.idle") {
    const e = event as EventSessionIdle;
    if (e.properties.sessionID !== sessionID) return null;
    seenPartIDs.clear(); // Reset per-turn tracking.
    return { kind: "session-idle" };
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
    seenPartIDs.delete(e.properties.partID);
    return { kind: "part-removed", partId: e.properties.partID };
  }

  return null;
}
