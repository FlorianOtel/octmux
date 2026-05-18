import type {
  Event,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventSessionIdle,
  EventSessionError,
} from "@opencode-ai/sdk";

// Normalised events the REPL cares about; all others are dropped.
export type ReplEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "session-idle" }
  | { kind: "error"; message: string };

// Track user message IDs so we don't echo the user's own input back to them.
// opencode fires message.part.updated for user messages too — we skip them.
const userMessageIDs = new Set<string>();

// Track how much text we've already written for each part (keyed by partID).
// opencode sends accumulated text in part.text, not incremental deltas — the
// delta field is defined in the SDK types but absent in real events.
const seenPartLength = new Map<string, number>();

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

  if (event.type === "message.part.updated") {
    const e = event as EventMessagePartUpdated;
    const part = e.properties.part;
    if (part.type !== "text" || part.sessionID !== sessionID) return null;
    // Skip user message parts — readline already echoed what the user typed.
    if (userMessageIDs.has(part.messageID)) return null;
    // Compute the new slice of text since last event for this part.
    const prev = seenPartLength.get(part.id) ?? 0;
    const newText = part.text.slice(prev);
    if (!newText) return null;
    seenPartLength.set(part.id, part.text.length);
    return { kind: "text-delta", text: newText };
  }

  if (event.type === "session.idle") {
    const e = event as EventSessionIdle;
    if (e.properties.sessionID !== sessionID) return null;
    seenPartLength.clear(); // Reset per-turn accumulation.
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

  return null;
}
