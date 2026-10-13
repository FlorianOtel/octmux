/**
 * v2 event translator (Stage 15.2, C2.4a, "core streaming").
 *
 * Turns raw OpenCode v2 SSE frames into the same `ReplEvent` vocabulary that the v1 translator
 * (`filterEvent` in `src/events.ts`) produces. `app.tsx` consumes the result unchanged, so it needs no
 * protocol branch. Each mapping names the v1 branch it mirrors. The full table is in the C2.4a report and
 * in the comments on each handler below.
 *
 * Covered in C2.4a: turn start and end, text and reasoning blocks, the tool lifecycle, retries, errors,
 * own-echo and foreign user turns, and durable-seq gap detection.
 * Covered in C2.4b: permission asks (tool-raised and discovered), forms, subagent child sessions, compaction
 * and `model-selected`. The subagent and permission rules are in the section comments below.
 *
 * Frame envelope and attribution follow `docs/OpenCode-v2-protocol-capture.md` §2a to §2c. Event shapes
 * follow §3 and §4.
 *
 * State lives on an instance, `V2EventTranslator`. `V2Backend` creates one per backend, so nothing leaks
 * across backends. `resetEventState()` clears all of it (PLAN-C2C3.md §C step 4, BRAIN-AMENDMENTS-C2C3.md P6).
 */

import type { Role } from "../blocks.ts";
import type { FormField, ReplEvent } from "../events.ts";

// ─── Frame reading (tolerant) ───

/** A plain JSON object, as opposed to `null`, an array or a primitive. */
type Json = Record<string, unknown>;

/** True for a plain JSON object. */
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value if it is a string, otherwise `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The value if it is a finite number, otherwise `undefined`. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The fields of a frame this translator reads. `seq` is set only on durable frames (capture §2b).
 * `data` is `{}` when the frame has none, so readers never have to check for it.
 */
type ParsedFrame = { type: string; data: Json; seq: number | undefined };

/**
 * Reads the envelope `{type, data, durable?}` (capture §2a). Returns `null` when the value is not an
 * envelope at all, for example a v1-shaped `{type, properties}` object from the discovery pass.
 */
function parseFrame(frame: unknown): ParsedFrame | null {
  if (!isRecord(frame)) return null;
  const type = asString(frame.type);
  if (type === undefined) return null;
  const data = isRecord(frame.data) ? frame.data : {};
  const durable = isRecord(frame.durable) ? frame.durable : {};
  return { type, data, seq: asNumber(durable.seq) };
}

/**
 * The text of a v2 tool `content` array: its `text` items joined in order, with no separator.
 * File items are not rendered, as in v1 (capture §4.4, §5a). Capture 3b's two-item content
 * ends its first item with "\n", so the join needs no separator.
 */
function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (isRecord(item) && item.type === "text") {
      const text = asString(item.text);
      if (text) out += text;
    }
  }
  return out;
}

/**
 * The sessionID a frame belongs to, per capture §2c. `shell.exited` and `shell.deleted` carry no session
 * key and are handled before this is called. Returns `undefined` for global frames (for example
 * `server.connected` and `*.updated`).
 */
function attributedSessionID(type: string, data: Json): string | undefined {
  // Capture §2c: a shell's session is in `data.info.metadata.sessionID`.
  if (type === "shell.created") {
    const info = isRecord(data.info) ? data.info : {};
    const metadata = isRecord(info.metadata) ? info.metadata : {};
    return asString(metadata.sessionID);
  }
  // Capture §2c: a form created by a tool carries its session at `data.form.sessionID`.
  if (type === "form.created") {
    const form = isRecord(data.form) ? data.form : {};
    return asString(form.sessionID) ?? asString(data.sessionID);
  }
  // Everything else carries `data.sessionID` (capture §2c).
  return asString(data.sessionID);
}

/**
 * The error message of a failed frame (`data.error.message`, capture §4.3, §4.8). Falls back to
 * `fallback` when the message is absent.
 */
function errorMessage(data: Json, fallback: string): string {
  const error = isRecord(data.error) ? data.error : {};
  return asString(error.message) ?? fallback;
}

/**
 * Logs the frame type under `OCTMUX_DEBUG_SSE`. Only the type name is logged, never payload values, which
 * could hold secrets (for example `settings.apiKey` in §5).
 */
function debugLog(message: string): void {
  if (process.env.OCTMUX_DEBUG_SSE === "1") {
    console.error("[octmux-debug] v2 " + message);
  }
}

// ─── Permissions and forms (C2.4b) ───

/**
 * Builds a `permission-asked` event from a request's fields. Used by both input shapes:
 *
 * - The live v2 frame `permission.asked` (capture §4.7): `data.id`, `data.action`, `data.resources[]`.
 * - The discovery input from `src/app.tsx` (see `discoveredPermission`): `properties.id`, `properties.permission`,
 *   `properties.patterns[]`. The field names come from `toV1PermissionShape` in `src/backend/v2.ts`.
 *
 * `permType` is the action (v2 `action`, v1 `permission`). `resources` lists every resource of a compound command
 * (capture §4.7). The `title` is `action: resource, resource`, so a compound ask reads as one line. With no resources
 * the title is the action alone. v1 sets the title to the bare permission name, which is the same for a
 * resource-less ask.
 *
 * @param id        The request id (`per_…`). Required, since the reply path needs it.
 * @param sessionID The session the ask belongs to. The caller has already checked it against the REPL's session.
 * @param action    The permission action (`shell`, `bash`, and so on). Required.
 * @param resources The resource list. Non-string entries are dropped. Anything else gives an empty list.
 */
function permissionAsked(id: string | undefined, sessionID: string, action: string | undefined, resources: unknown): ReplEvent | null {
  if (id === undefined || action === undefined) return null;
  const list = stringList(resources);
  const title = list.length > 0 ? `${action}: ${list.join(", ")}` : action;
  return { kind: "permission-asked", permID: id, sessionID, title, permType: action, resources: list };
}

/**
 * The discovery input contract. `src/app.tsx` (the "missed permission discovery" pass) calls `translateEvent` with
 * a v1-shaped object, not a v2 frame. It is built from `V2Backend.listPermissions()` items (`toV1PermissionShape`):
 *
 *   { type: "permission.asked", properties: { id, sessionID, permission, patterns } }
 *
 * There is no `data` key, so `parseFrame` would read it as an envelope with no fields. This function recognises it
 * first. It returns the `properties` object, or `undefined` when the value is not that shape.
 *
 * @param frame The value passed to `translate`.
 */
function discoveredPermission(frame: unknown): Json | undefined {
  if (!isRecord(frame) || frame.type !== "permission.asked" || !isRecord(frame.properties)) return undefined;
  return frame.properties;
}

/** The string entries of a JSON array, in order. Any other value gives an empty list. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Maps one v2 form field onto `FormField` (`src/events.ts`). This is the same mapping `toFormField` applies in
 * `src/backend/v2.ts` to the SDK's `listForms` result, so a field reads the same whether it arrives by frame
 * (`form.created`, capture §4.6) or by list. `title` falls back to the key. `options` and `custom` are copied only
 * when present. A field without a `key` or a `type` is dropped, since no answer can be given for it.
 *
 * @param raw One entry of `form.fields`.
 */
function formField(raw: unknown): FormField | null {
  if (!isRecord(raw)) return null;
  const key = asString(raw.key);
  const type = asString(raw.type);
  if (key === undefined || type === undefined) return null;

  const description = asString(raw.description);
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option): Array<{ value: string; label: string; description?: string }> => {
        if (!isRecord(option)) return [];
        const value = asString(option.value);
        const label = asString(option.label);
        if (value === undefined || label === undefined) return [];
        const optionDescription = asString(option.description);
        return [{ value, label, ...(optionDescription !== undefined ? { description: optionDescription } : {}) }];
      })
    : undefined;

  return {
    key,
    title: asString(raw.title) ?? key,
    type,
    ...(description !== undefined ? { description } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(typeof raw.custom === "boolean" ? { custom: raw.custom } : {}),
  };
}

/**
 * The token total for `compaction-ended`. The capture records `tokens` on `session.compaction.ended` (§4.12) but
 * does not show its shape, so both forms are accepted. A plain number is the total. An object with the §4.8 keys
 * (`input`, `output`, `reasoning`, `cache`) gives the sum of its numeric `input`, `output` and `reasoning`, without
 * `cache`. Anything else gives `undefined`, and the key is left out.
 *
 * @param value The `tokens` value of the frame.
 */
function compactionTokens(value: unknown): number | undefined {
  const plain = asNumber(value);
  if (plain !== undefined) return plain;
  if (!isRecord(value)) return undefined;
  const parts = [asNumber(value.input), asNumber(value.output), asNumber(value.reasoning)];
  const known = parts.filter((part): part is number => part !== undefined);
  return known.length > 0 ? known.reduce((sum, part) => sum + part, 0) : undefined;
}

// ─── Translator state ───

/** An open block: its renderer role and the session that owns it. */
type OpenPart = { role: Role; sessionID: string };

/**
 * A shell's owner. Set by `shell.created` (capture §2c). `callID` is added by `session.tool.progress`
 * (capture §4.5). No `ReplEvent` reads it. The exit code comes from the tool's `metadata.exit`
 * (see `succeedTool`), not from this link.
 */
type ShellLink = { sessionID: string; callID?: string };

/**
 * A parent `subagent` tool call in flight (capture §4.9). `description` comes from the call's input
 * (`session.tool.called`). `childID` is set when the child is paired: first by `session.created` (its `title` equals
 * the description) and otherwise by `session.tool.progress` (`metadata.sessionID`, a direct link).
 */
type SubagentCall = { description?: string; childID?: string };

/** The result of checking a durable `seq` against the last one seen for its session (capture §2b). */
type SeqCheck = "ok" | "duplicate" | "gap";

/**
 * Builds the identity of a text or reasoning part from its stream fields. The stream's `ordinal` is
 * per kind (see the key note on `V2EventTranslator`). So `kind` is part of the identity, and reasoning
 * and text with the same ordinal do not collide.
 */
function streamIdentity(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return `${messageID}|${kind}|${ordinal}`;
}

/**
 * Translates v2 frames into `ReplEvent`s. One instance per `V2Backend`.
 *
 * Block keys. The stream's `ordinal` is per kind, not per message. Capture 3b message
 * `msg_135b1a12a001mm6SYWlF9m5ILI` has reasoning and text both at `ordinal` 0, and the text starts before
 * the reasoning ends (capture §4.1, §4.2). A key of `${assistantMessageID}:${ordinal}` would therefore
 * collide, and the text deltas would land in the reasoning block. Instead each text, reasoning or tool item
 * takes the next content index of its message, in start order. The renderer partID is
 * `${assistantMessageID}:${index}`. This is the same key `translateHistoryV2` (src/backend/v2-queries.ts)
 * gives the stored content item at that index, so a resync reproduces the same ids. That holds when stored
 * content order equals start order. Capture 3b's stored message is `[reasoning, text]` in start order.
 * Open live check for the C2 live checklist, run at C2.5: an overlapping message with a tool call in it, where
 * the stored order must still match start order. Tool blocks keep the call `id` as the partID, as history does.
 */
export class V2EventTranslator {
  /** Open text, reasoning and tool blocks, keyed by renderer partID. */
  private readonly openParts = new Map<string, OpenPart>();

  /**
   * Text and reasoning identity (see `streamIdentity`) to partID. Lets a delta or an end find its block.
   * Kept after the block closes, so a duplicate start for the same identity is ignored.
   */
  private readonly streamParts = new Map<string, string>();

  /** Next content index per assistant message. Advanced by text, reasoning and tool starts. */
  private readonly nextContentIndex = new Map<string, number>();

  /** Tool call ids already started. Guards against a duplicate `session.tool.input.started`. */
  private readonly startedCalls = new Set<string>();

  /** Assistant messages for which `message-completed` was already emitted (v1 `completedAssistantMessageIDs`). */
  private readonly completedMessages = new Set<string>();

  /** Shell id to owner (capture §2c, §4.5). Bookkeeping only in C2.4a: no ReplEvent reads it. */
  private readonly shells = new Map<string, ShellLink>();

  /**
   * Live subagent child session ids (v1 `trackedChildSessions`, src/events.ts). Added by `session.created` with
   * `parentID` equal to the REPL's session. Removed on the child's terminal frame, or when the parent's `subagent`
   * call ends first. Frames of these children never reach the parent's blocks (capture §4.9).
   */
  private readonly children = new Set<string>();

  /** Parent `subagent` tool calls in flight, keyed by call id (capture §4.9). See `SubagentCall`. */
  private readonly subagentCalls = new Map<string, SubagentCall>();

  /** Prompt ids this octmux minted (`recordOwnMessageID`). Their inbox echoes are suppressed (own turn). */
  private readonly ownPromptIDs = new Set<string>();

  /** Expanded-command prefixes (`recordOwnCommandPrefix`). User items starting with one are suppressed. */
  private readonly ownCommandPrefixes = new Set<string>();

  /**
   * Own command echoes still expected. `recordOwnCommandPrefix` adds one for each command sent. A command's POST
   * returns no id, and exactly one user item, the expanded template, comes back for it. The next user item that is
   * neither an own prompt nor already rendered consumes one slot, whatever its text. The live inbox path and the resync
   * path (`getMissedHistory`) both claim user items by the same rule (`claimUserItem`), so an echo seen only through
   * resync also consumes its slot. A slot is released when the command's request fails (`releaseCommandEcho`), since a
   * failed request produces no echo. Cleared by `resetEventState`.
   */
  private pendingCommandEchoes = 0;

  /**
   * Message ids the renderer already shows for this session (Stage 15.2, D-A fix). It holds:
   * - inbox ids emitted as `foreign-user-turn`. A user item arrives as `enqueued` and again as `delivered`
   *   (capture §4.5, §4.12), so this also keeps the second arrival from rendering a second time;
   * - assistant message ids that opened a text, reasoning or tool block live (`startStreamPart`, `startTool`);
   * - every id `getHistory` returned (`markRendered`).
   * `getMissedHistory` renders only the complete messages that are not here. Own prompts are checked
   * separately through `ownPromptIDs`. Cleared by `resetEventState`.
   */
  private readonly renderedMessageIDs = new Set<string>();

  /** Last durable `seq` seen per session (capture §2b). Used to detect a gap, which needs a resync. */
  private readonly lastSeqBySession = new Map<string, number>();

  // ─── Public surface (mirrored by `BackendEvents`) ───

  /**
   * Translates one v2 frame, or one discovery input (see `discoveredPermission`). Returns one `ReplEvent`, several in
   * order, or `null`.
   *
   * Routing, in order:
   * 1. The discovery input. It is accepted only for the REPL's session (or its descendant, when `app.tsx` re-calls with
   *    the descendant's id, as for v1), the same rule as a frame.
   * 2. `session.created` whose `parentID` is the REPL's session. This is a new child (capture §4.9). The child's id is
   *    `data.sessionID`, so the rule must run before the attribution check below.
   * 3. Frames of any other session. A tracked child goes to `childFrame`. Every other session returns `null`.
   * 4. Frames of the REPL's session. Durable seq check, then `dispatch`.
   *
   * Child frames never touch the seq check. Their seq belongs to the child's own aggregate, and nothing of the child is
   * rendered, so a child gap has no effect on the parent's blocks.
   *
   * @param frame            One raw frame, as `subscribeEvents()` yields it in `payload`, or a discovery input.
   * @param currentSessionID The session the REPL is showing.
   */
  translate(frame: unknown, currentSessionID: string): ReplEvent | ReplEvent[] | null {
    // 1. Discovery input from app.tsx (C2.4b). Not a v2 envelope, so it is read before `parseFrame`.
    const discovered = discoveredPermission(frame);
    if (discovered !== undefined) {
      const sessionID = asString(discovered.sessionID);
      if (sessionID === undefined || sessionID !== currentSessionID) return null;
      return permissionAsked(asString(discovered.id), sessionID, asString(discovered.permission), discovered.patterns);
    }

    const parsed = parseFrame(frame);
    if (parsed === null) return null;
    const { type, data, seq } = parsed;

    // 2. A new child of the REPL's session (capture §4.9). Its `sessionID` is the child, not the REPL's.
    if (type === "session.created") return this.childCreated(data, currentSessionID);

    // shell.exited and shell.deleted carry no session key (capture §2c, §4.5). Only the bookkeeping entry
    // is removed. The exit code is read from `session.tool.success` `metadata.exit` instead.
    if (type === "shell.exited" || type === "shell.deleted") {
      const shellID = asString(data.id);
      if (shellID !== undefined) this.shells.delete(shellID);
      return null;
    }

    const sessionID = attributedSessionID(type, data);
    if (sessionID === undefined) return null;

    // 3. Another session. Only a tracked child is handled, and only for its activity, terminal and prompts.
    if (sessionID !== currentSessionID) return this.childFrame(type, data, sessionID);

    // 4. The REPL's own session. Durable frames carry a per-session seq (capture §2b). A gap means frames were
    // missed. The translator cannot rebuild them. It closes the session's open blocks, so the renderer does not keep
    // them open for ever, then asks the app to resync. The resync renders the missed complete messages from REST
    // and clears nothing (see `getMissedHistory`).
    if (seq !== undefined) {
      const check = this.checkSeq(sessionID, seq);
      if (check === "duplicate") return null;
      if (check === "gap") return [...this.closeOpenParts(sessionID), { kind: "resync-needed", sessionID }];
    }

    return this.dispatch(type, data, sessionID);
  }

  /**
   * Clears all translator state. Called on session switch and reset (`BackendEvents.resetEventState`).
   * After this call, no state from before the call affects translation (P6).
   */
  resetEventState(): void {
    this.openParts.clear();
    this.streamParts.clear();
    this.nextContentIndex.clear();
    this.startedCalls.clear();
    this.completedMessages.clear();
    this.shells.clear();
    this.ownPromptIDs.clear();
    this.ownCommandPrefixes.clear();
    this.pendingCommandEchoes = 0;
    this.renderedMessageIDs.clear();
    this.lastSeqBySession.clear();
    this.children.clear();
    this.subagentCalls.clear();
  }

  /**
   * Closes every open block and returns the idle pair. Same semantics as v1 `synthesizeSessionIdleEvents`
   * (`src/events.ts`): `session-idle` first, then one `block-end` per open part, then the open set is cleared.
   * The reconciler uses it when the stream missed the terminal frame. `streamParts` is kept, as in
   * `translate`.
   */
  synthesizeSessionIdleEvents(): ReplEvent[] {
    const closes: ReplEvent[] = [];
    for (const [partID, part] of this.openParts) {
      closes.push({ kind: "block-end", partID, role: part.role });
    }
    this.openParts.clear();
    return [{ kind: "session-idle" }, ...closes];
  }

  /**
   * True if a text or reasoning block is open. v1 `hasOpenStreamingPart` semantics (`src/events.ts`). Tool
   * blocks do not count, because the reconciler guards streamed text only.
   */
  hasOpenStreamingPart(): boolean {
    for (const part of this.openParts.values()) {
      if (part.role === "text" || part.role === "thinking") return true;
    }
    return false;
  }

  /** Records a prompt id this octmux minted. Called before `sendPrompt` (app.tsx). Its echo is then suppressed. */
  recordOwnMessageID(id: string): void {
    this.ownPromptIDs.add(id);
  }

  /**
   * Records a command this octmux sends. Its expanded echo is suppressed in two ways. The prefix suppresses any user
   * item that starts with it (v1 backstop). A pending echo slot suppresses the next user item whatever its text, because
   * a command's template need not start with the command name (for example a `rag.md` template). The slot is the only
   * match available, since the command's POST returns no id.
   *
   * @param prefix The expanded-text prefix, `"# /" + name`.
   */
  recordOwnCommandPrefix(prefix: string): void {
    this.ownCommandPrefixes.add(prefix);
    this.pendingCommandEchoes += 1;
  }

  /**
   * Gives back one pending command echo slot, with a floor of 0. Called when a command's request fails. A failed
   * request produces no echo, so its slot would otherwise swallow the next genuine foreign user turn. The prefix is
   * kept: it is only a backstop and does not count slots.
   */
  releaseCommandEcho(): void {
    if (this.pendingCommandEchoes > 0) this.pendingCommandEchoes -= 1;
  }

  /**
   * Records message ids as already rendered. `getHistory` calls it with every id it returns, so the history a
   * session switch replays is not rendered again by a later gap resync.
   *
   * @param messageIDs The message ids (user inbox ids and assistant message ids) now shown.
   */
  markRendered(messageIDs: readonly string[]): void {
    for (const id of messageIDs) this.renderedMessageIDs.add(id);
  }

  /**
   * True if the renderer already shows this message, or octmux suppressed it as its own. An own prompt
   * (`recordOwnMessageID`) is shown by the app when it is sent. An own command's expanded text (the prefix
   * from `recordOwnCommandPrefix`) is shown as the command line. Both count as rendered here.
   *
   * @param messageID The message id (user inbox id or assistant message id).
   * @param userText  The text of a user message, when the caller has one. Used for the command-prefix rule.
   */
  isRendered(messageID: string, userText?: string): boolean {
    if (this.renderedMessageIDs.has(messageID) || this.ownPromptIDs.has(messageID)) return true;
    if (userText === undefined) return false;
    for (const prefix of this.ownCommandPrefixes) {
      if (userText.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Claims a user item for suppression, and reports whether it is suppressed. This is the one rule shared by the live
   * inbox path (`userInboxItem`) and the resync path (`getMissedHistory`), so an item is suppressed the same way in both.
   * The checks run in this order:
   *
   * 1. An own prompt (`recordOwnMessageID`) is suppressed. Nothing is recorded.
   * 2. An item already rendered is suppressed. Nothing is recorded.
   * 3. While a command echo slot is pending, the item takes it whatever its text. The slot is given back, and the item
   *    is recorded as rendered, so its later arrival (the `delivered` frame, or the same item seen again by resync) is
   *    suppressed and does not take a second slot.
   * 4. An item whose text starts with a recorded command prefix (the v1 backstop) is suppressed and recorded the same way.
   * 5. Anything else is not claimed. Nothing is recorded, and the caller decides what to do with it.
   *
   * Unlike `isRendered`, this method has side effects. Call it only when the item is about to be shown or suppressed for
   * good.
   *
   * @param messageID The user item's id (its inbox id on the live path, its message id on the resync path).
   * @param text      The user item's text.
   * @returns True if the item is suppressed. False if it is not claimed, and the caller should render it.
   */
  claimUserItem(messageID: string, text: string): boolean {
    if (this.ownPromptIDs.has(messageID)) return true;
    if (this.renderedMessageIDs.has(messageID)) return true;

    if (this.pendingCommandEchoes > 0) {
      this.pendingCommandEchoes -= 1;
      this.renderedMessageIDs.add(messageID);
      return true;
    }

    for (const prefix of this.ownCommandPrefixes) {
      if (text.startsWith(prefix)) {
        this.renderedMessageIDs.add(messageID);
        return true;
      }
    }
    return false;
  }

  /**
   * v1 classifies a user turn by message id after its text parts arrive, and debounces it. v2 delivers the
   * whole user text in one `session.inbox.*` frame (capture §4.5), so there is nothing to debounce. The
   * classification happens in `translate`. This method returns `[]` so the seam stays the same.
   *
   * @param _messageID Ignored. Kept for the `BackendEvents` signature.
   */
  classifyUserTurn(_messageID: string): ReplEvent[] {
    return [];
  }

  // ─── Dispatch ───

  /**
   * Maps one attributed frame to its events. Every case names its capture section. Only frames of the REPL's
   * session reach this method (see `translate`).
   *
   * @param type      The frame type (`session.text.delta`, and so on).
   * @param data      The frame's `data` object.
   * @param sessionID The session the frame belongs to. Already checked against the current session.
   */
  private dispatch(type: string, data: Json, sessionID: string): ReplEvent | ReplEvent[] | null {
    switch (type) {
      // ─── Turn start and end (§4.8). v2 has no session.idle, so each terminal frame emits the idle pair. ───

      // v1 emits `generating` when the assistant turn is created (src/events.ts, the message.updated branch).
      case "session.execution.started":
        return { kind: "generating" };

      // v1 `session.idle` (src/events.ts): parent-turn-end "idle", then session-idle, then block-ends.
      case "session.execution.succeeded":
        return this.turnEnd(sessionID, [{ kind: "parent-turn-end", reason: "idle" }]);

      // v1 `MessageAbortedError` (src/events.ts, the message.updated error branch): reason "aborted" with
      // no error copy. An operator interrupt is not a server error.
      case "session.execution.interrupted":
        return this.turnEnd(sessionID, [{ kind: "parent-turn-end", reason: "aborted" }]);

      // v1 `session.error` (src/events.ts): parent-turn-end "error", then error. The idle pair is added
      // here because v2 has no session.idle to finish the turn.
      case "session.execution.failed":
        return this.turnEnd(sessionID, [
          { kind: "parent-turn-end", reason: "error" },
          { kind: "error", message: errorMessage(data, "unknown server error") },
        ]);

      // Non-terminal (§4.3). v1 has no equivalent. Shown as a transient system message by the C2.6 wiring.
      case "session.retry.scheduled": {
        const attempt = asNumber(data.attempt);
        if (attempt === undefined) return null;
        return { kind: "turn-retry", sessionID, attempt, message: errorMessage(data, "") };
      }

      // Step finished (§4.3). v1 `message-completed` (src/events.ts) is emitted once per assistant message,
      // and app.tsx refreshes the usage figures on it.
      case "session.step.ended":
        return this.messageCompleted(asString(data.assistantMessageID));

      // ─── Text and reasoning blocks (§4.1, §4.2) ───

      case "session.text.started":
        return this.startStreamPart("text", data, sessionID);
      case "session.text.delta":
        return this.deltaStreamPart("text", data);
      case "session.text.ended":
        return this.endStreamPart("text", data);

      case "session.reasoning.started":
        return this.startStreamPart("reasoning", data, sessionID);
      case "session.reasoning.delta":
        return this.deltaStreamPart("reasoning", data);
      case "session.reasoning.ended":
        return this.endStreamPart("reasoning", data);

      // ─── Tool lifecycle (§4.4, §4.5) ───

      // Opens the tool-call block. v1 opens it at the first `pending` state (src/events.ts, the tool branch).
      case "session.tool.input.started":
        return this.startTool(data, sessionID);

      // Links a shell to its call (§4.5). Nothing is shown. The shell id is kept for the bookkeeping map. For a
      // subagent call the same frame names the child in `metadata.sessionID` (§4.9), which links the call to it.
      case "session.tool.progress":
        this.linkShell(data, sessionID);
        this.linkSubagent(data);
        return null;

      // Completed tool. v1 `completed` branch (src/events.ts): block-end ok, then a tool-result block when the
      // output is non-empty. A non-zero shell exit stays `ok`, with `exitCode` set (§4.4 "Non-zero exit").
      // A subagent call also ends its child, if the child has not ended yet (§4.9).
      case "session.tool.success":
        return this.withSubagentEnd(data, this.succeedTool(data));

      // Rejected or aborted tool (§4.4). v1 generic `error` branch (src/events.ts): block-end error, no result.
      // A subagent call also ends its child, as above.
      case "session.tool.failed": {
        const failed = this.failTool(data);
        return this.withSubagentEnd(data, failed === null ? null : [failed]);
      }

      case "shell.created":
        this.recordShell(data, sessionID);
        return null;

      // ─── User turns (§4.5, §4.12). Own echoes are suppressed. Foreign turns are emitted once. ───

      case "session.inbox.enqueued":
      case "session.inbox.delivered":
        return this.userInboxItem(data);

      // ─── Nothing visible in C2.4a ───

      // Step start: one per assistant message attempt (§4.3). The turn already shows `generating`.
      case "session.step.started":
      case "session.step.streamed":
        return null;

      // Step failed (§4.3, §4.4). Not translated. A failed step is always followed by a terminal frame
      // carrying the same error (§4.3, capture 3), and an interrupt's `aborted` step is not a server error.
      // Emitting `error` here would show a duplicate line, and an error on every Ctrl-C.
      case "session.step.failed":
        return null;

      // Running totals (§4.3). v1 does not emit on usage either. app.tsx refreshes on message-completed
      // and session-idle.
      case "session.usage.updated":
        return null;

      // Tool input text (§4.4). v1 never shows tool input, so the translator does not either. `called` carries the
      // subagent's input (§4.9). That is recorded, and nothing is shown.
      case "session.tool.input.ended":
        return null;
      case "session.tool.called":
        this.recordSubagentInput(data);
        return null;

      case "session.instructions.updated":
      case "session.shell.started":
      case "session.shell.ended":
        return null;

      // ─── Permission (C2.4b, capture §4.7) ───

      // A tool-raised ask, or an ask on this session. v1 `permission.asked` (src/events.ts). The v2 fields are
      // `action` and `resources[]`, which differ from v1's `permission` and `patterns`.
      case "permission.asked":
        return permissionAsked(asString(data.id), sessionID, asString(data.action), data.resources);

      // The reply is not shown. v1 has no equivalent frame (its `permission.updated` only announces an ask). The
      // modal closes on the operator's own answer (`app.tsx`), not on this frame, as in v1.
      case "permission.replied":
        return null;

      // ─── Forms (C2.4b, capture §4.6). v1 `question.asked`, `question.replied`. ───

      // `data.form` holds the form. The form's `sessionID` is the attribution key (see `attributedSessionID`).
      case "form.created":
        return this.formAsked(data, sessionID);

      case "form.replied":
        return this.formClosed(data, sessionID, isRecord(data.answer) ? data.answer : {});

      // Typed in the client SDK, never observed (capture §4.6). Closes the modal with an empty answer, so a cancelled
      // form does not stay open. The frame is assumed to carry `id` and `sessionID` as `form.replied` does.
      case "form.cancelled":
        return this.formClosed(data, sessionID, {});

      // ─── Compaction (C2.4b, capture §4.12). The turn still ends with `session.execution.succeeded`. ───

      case "session.compaction.started":
        return { kind: "compaction-started", sessionID, reason: asString(data.reason) ?? "" };

      // Non-durable summary chunks. Empty chunks are dropped, as in the text deltas. The app decides whether to show them.
      case "session.compaction.delta": {
        const text = asString(data.text);
        return text ? { kind: "compaction-progress", sessionID, text } : null;
      }

      // The summary is `data.text` (§4.12). `tokens` and `cost` are kept when present (see `compactionTokens`).
      case "session.compaction.ended": {
        const tokens = compactionTokens(data.tokens);
        const cost = asNumber(data.cost);
        return {
          kind: "compaction-ended",
          sessionID,
          summary: asString(data.text) ?? "",
          ...(tokens !== undefined ? { tokens } : {}),
          ...(cost !== undefined ? { cost } : {}),
        };
      }

      // The provider error is in `data.error`, as for `session.execution.failed` (§4.12). Assumed, not observed.
      case "session.compaction.failed":
        return { kind: "compaction-failed", sessionID, message: errorMessage(data, "no error detail from server") };

      // ─── Model (C2.4b, capture §4.3). The model bound to the session. Not the v1 foreign-client `model-switched`. ───

      case "session.model.selected": {
        const model = isRecord(data.model) ? data.model : {};
        const providerID = asString(model.providerID);
        const modelID = asString(model.id);
        if (providerID === undefined || modelID === undefined) return null;
        return { kind: "model-selected", sessionID, providerID, modelID };
      }

      default:
        // Unknown or future types are tolerated. The type name is logged under OCTMUX_DEBUG_SSE.
        debugLog("unhandled frame type=" + type);
        return null;
    }
  }

  // ─── Turn boundaries ───

  /**
   * Builds a terminal frame's events: the given head events, then `session-idle`, then one `block-end` for each
   * open block of the session. The head comes first, as in v1 `session.idle` (src/events.ts). Closing a block
   * here stops it from being left open when the terminal frame arrives.
   *
   * @param sessionID The session whose blocks close.
   * @param head      The events that come before the idle pair (parent-turn-end, and error on failure).
   */
  private turnEnd(sessionID: string, head: ReplEvent[]): ReplEvent[] {
    const closes: ReplEvent[] = [];
    for (const [partID, part] of this.openParts) {
      if (part.sessionID === sessionID) {
        closes.push({ kind: "block-end", partID, role: part.role });
        this.openParts.delete(partID);
      }
    }
    return [...head, { kind: "session-idle" }, ...closes];
  }

  /**
   * Emits `message-completed` once per assistant message (v1 `completedAssistantMessageIDs`, src/events.ts).
   *
   * @param messageID The assistant message id from `session.step.ended`.
   */
  private messageCompleted(messageID: string | undefined): ReplEvent | null {
    if (messageID === undefined || this.completedMessages.has(messageID)) return null;
    this.completedMessages.add(messageID);
    return { kind: "message-completed", messageID };
  }

  // ─── Text and reasoning ───

  /**
   * Allocates the next content index of `messageID` and returns its renderer partID `${messageID}:${index}`.
   * Called once for each text, reasoning or tool start, so the indices follow start order (see the class note).
   *
   * @param messageID The assistant message id.
   */
  private allocateContentPartID(messageID: string): string {
    const index = this.nextContentIndex.get(messageID) ?? 0;
    this.nextContentIndex.set(messageID, index + 1);
    return `${messageID}:${index}`;
  }

  /**
   * Opens a text or reasoning block (§4.1, §4.2). A text block also emits `generating`, as v1 does
   * (src/events.ts, the text-part creation branch). v1 closes any open reasoning block at text start. v2
   * does not. Capture 2 and capture 3b overlap the two kinds (§4.1, §4.2), so each block closes only on its
   * own `*.ended`.
   *
   * @param kind      `text` or `reasoning`.
   * @param data      The start frame's data.
   * @param sessionID The owning session, recorded on the open block.
   */
  private startStreamPart(kind: "text" | "reasoning", data: Json, sessionID: string): ReplEvent | ReplEvent[] | null {
    const messageID = asString(data.assistantMessageID);
    const ordinal = asNumber(data.ordinal);
    if (messageID === undefined || ordinal === undefined) return null;

    const identity = streamIdentity(messageID, kind, ordinal);
    if (this.streamParts.has(identity)) return null; // duplicate start

    const partID = this.allocateContentPartID(messageID);
    this.streamParts.set(identity, partID);
    // The renderer now shows content of this message, so REST history must not render it again (D-A fix).
    this.renderedMessageIDs.add(messageID);

    if (kind === "reasoning") {
      this.openParts.set(partID, { role: "thinking", sessionID });
      return { kind: "block-start", partID, role: "thinking" };
    }
    this.openParts.set(partID, { role: "text", sessionID });
    // `messageID` is included, as in v1's text block-start (src/events.ts). The renderer does not read it for
    // reasoning, so reasoning omits it, as v1 does.
    return [
      { kind: "block-start", partID, role: "text", messageID },
      { kind: "generating" },
    ];
  }

  /**
   * Appends one streamed chunk to an open text or reasoning block (§4.1, §4.2). An empty delta or an unknown or
   * closed block returns `null`, as v1 does (src/events.ts, the message.part.delta branch).
   *
   * @param kind `text` or `reasoning`.
   * @param data The delta frame's data.
   */
  private deltaStreamPart(kind: "text" | "reasoning", data: Json): ReplEvent | null {
    const messageID = asString(data.assistantMessageID);
    const ordinal = asNumber(data.ordinal);
    const delta = asString(data.delta);
    if (messageID === undefined || ordinal === undefined || !delta) return null;

    const partID = this.streamParts.get(streamIdentity(messageID, kind, ordinal));
    if (partID === undefined) return null;
    const part = this.openParts.get(partID);
    if (part === undefined) return null;
    return { kind: "block-delta", partID, role: part.role, text: delta };
  }

  /**
   * Closes a text or reasoning block (§4.1, §4.2). `*.ended` carries the full text, which the translator does
   * not re-read, since the deltas already built the block. Returns `null` when the block is not open.
   *
   * @param kind `text` or `reasoning`.
   * @param data The end frame's data.
   */
  private endStreamPart(kind: "text" | "reasoning", data: Json): ReplEvent | null {
    const messageID = asString(data.assistantMessageID);
    const ordinal = asNumber(data.ordinal);
    if (messageID === undefined || ordinal === undefined) return null;

    const partID = this.streamParts.get(streamIdentity(messageID, kind, ordinal));
    if (partID === undefined) return null;
    const part = this.openParts.get(partID);
    if (part === undefined) return null;
    this.openParts.delete(partID);
    return { kind: "block-end", partID, role: part.role };
  }

  // ─── Tools ───

  /**
   * Opens a tool-call block (§4.4). The partID is the call `id` (`call_…`), as history uses (src/backend/v2-queries.ts).
   * The tool name comes from this frame, because `session.tool.called` has no name (capture §4.4). The call also
   * takes a content index, so that text and reasoning after it keep the same index history gives them.
   *
   * @param data      The `session.tool.input.started` data.
   * @param sessionID The owning session.
   */
  private startTool(data: Json, sessionID: string): ReplEvent | null {
    const callID = asString(data.id);
    const name = asString(data.name);
    const messageID = asString(data.assistantMessageID);
    if (callID === undefined || name === undefined || messageID === undefined) return null;
    if (this.startedCalls.has(callID)) return null; // duplicate start

    this.startedCalls.add(callID);
    this.allocateContentPartID(messageID);
    this.renderedMessageIDs.add(messageID); // the renderer now shows content of this message (D-A fix)
    this.openParts.set(callID, { role: "tool-call", sessionID });
    // A `subagent` call is tracked until its result arrives, so its child can be paired and ended (§4.9).
    if (name === "subagent") this.subagentCalls.set(callID, {});
    return { kind: "block-start", partID: callID, role: "tool-call", toolName: name };
  }

  /**
   * Records the shell a tool call is running (§4.5). `session.tool.progress` names the shell in `metadata.shellID`
   * and the call in `id`. For a subagent call, the same frame names the child session in `metadata.sessionID`.
   * That link is recorded separately, by `linkSubagent`. Nothing is returned.
   *
   * @param data      The `session.tool.progress` data.
   * @param sessionID The owning session, recorded with the shell.
   */
  private linkShell(data: Json, sessionID: string): void {
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const shellID = asString(metadata.shellID);
    const callID = asString(data.id);
    if (shellID === undefined) return;
    this.shells.set(shellID, { sessionID, ...(callID !== undefined ? { callID } : {}) });
  }

  /**
   * Records a new shell's owner from `shell.created` (§4.5). The session comes from `data.info.metadata.sessionID`,
   * and the attribution step has already matched it to the current session.
   *
   * @param data      The `shell.created` data.
   * @param sessionID The session the attribution step matched.
   */
  private recordShell(data: Json, sessionID: string): void {
    const info = isRecord(data.info) ? data.info : {};
    const shellID = asString(info.id);
    if (shellID !== undefined) this.shells.set(shellID, { sessionID });
  }

  /**
   * Closes a tool-call block as `ok` and adds its result block (§4.4). v1 `completed` branch (src/events.ts):
   * the result block is `${callID}-result` and appears only when the output is non-empty. A non-zero
   * `metadata.exit` is a completed tool, not an error (capture §4.4 "Non-zero exit"). It sets `exitCode`, and
   * the status stays `ok`. The renderer shows an exit marker under the block when `endBlock` receives the
   * `exitCode` (src/renderer/block-buffer.ts). An exit of 0 sets no `exitCode`.
   *
   * Returns `null` if the call's block is not open, as v1 does (src/events.ts).
   *
   * @param data The `session.tool.success` data.
   */
  private succeedTool(data: Json): ReplEvent[] | null {
    const callID = asString(data.id);
    if (callID === undefined) return null;
    const open = this.openParts.get(callID);
    if (open === undefined || open.role !== "tool-call") return null;
    this.openParts.delete(callID);

    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const exit = asNumber(metadata.exit);
    const end: ReplEvent =
      exit !== undefined && exit !== 0
        ? { kind: "block-end", partID: callID, role: "tool-call", status: "ok", exitCode: exit }
        : { kind: "block-end", partID: callID, role: "tool-call", status: "ok" };
    const events: ReplEvent[] = [end];

    const output = joinTextContent(data.content);
    if (output !== "") {
      const resultPartID = `${callID}-result`;
      events.push(
        { kind: "block-start", partID: resultPartID, role: "tool-result" },
        { kind: "block-delta", partID: resultPartID, role: "tool-result", text: output },
        { kind: "block-end", partID: resultPartID, role: "tool-result", status: "ok" },
      );
    }
    return events;
  }

  /**
   * Closes a tool-call block as `error` (§4.4). Covers a rejected permission and an interrupt abort. v1 generic
   * error branch (src/events.ts): block-end error, with no result block. Returns `null` if the block is not open.
   *
   * @param data The `session.tool.failed` data.
   */
  private failTool(data: Json): ReplEvent | null {
    const callID = asString(data.id);
    if (callID === undefined) return null;
    const open = this.openParts.get(callID);
    if (open === undefined || open.role !== "tool-call") return null;
    this.openParts.delete(callID);
    return { kind: "block-end", partID: callID, role: "tool-call", status: "error" };
  }

  // ─── User turns ───

  /**
   * Handles a user item from `session.inbox.enqueued` or `session.inbox.delivered` (§4.5, §4.12). Only `user`
   * items count. `synthetic` (user shell), `compaction` and `shell` items are not user turns, and they return
   * `null`. Own echoes are suppressed by prompt id, which the client minted and the server echoes as `inboxID`
   * (capture §A, §5 "client-supplied id"). A command's expanded text is suppressed by its pending echo slot, or by
   * prefix (v1 backstop). A foreign turn is emitted once, at its first arrival.
   *
   * @param data The inbox frame's data.
   */
  private userInboxItem(data: Json): ReplEvent | null {
    const inboxID = asString(data.inboxID);
    const item = isRecord(data.item) ? data.item : {};
    if (inboxID === undefined || item.type !== "user") return null;

    const payload = isRecord(item.payload) ? item.payload : {};
    const text = asString(payload.text);
    if (text === undefined || text === "") return null;

    // The shared claim rule (`claimUserItem`) suppresses an own prompt, an item already shown or consumed, an echo that
    // takes a pending command slot, and a prefix match. A claimed item is recorded as rendered inside `claimUserItem`,
    // so its enqueued and delivered arrivals share one suppression and only one slot is ever taken.
    if (this.claimUserItem(inboxID, text)) return null;

    // Not claimed: a genuine foreign turn. Its first arrival renders it, and its second arrival is then suppressed.
    this.renderedMessageIDs.add(inboxID);
    return { kind: "foreign-user-turn", messageID: inboxID, text };
  }

  // ─── Forms (C2.4b, capture §4.6) ───

  /**
   * Builds `form-asked` from `form.created` (capture §4.6). The form is in `data.form`. Returns `null` when the form
   * has no id, since no reply can be sent for it. Fields that cannot be mapped are dropped (see `formField`).
   *
   * @param data      The `form.created` data.
   * @param sessionID The session the form belongs to (`data.form.sessionID`, §2c).
   */
  private formAsked(data: Json, sessionID: string): ReplEvent | null {
    const form = isRecord(data.form) ? data.form : {};
    const formID = asString(form.id);
    if (formID === undefined) return null;
    const fields: FormField[] = [];
    if (Array.isArray(form.fields)) {
      for (const raw of form.fields) {
        const field = formField(raw);
        if (field !== null) fields.push(field);
      }
    }
    return { kind: "form-asked", formID, sessionID, title: asString(form.title) ?? "", fields };
  }

  /**
   * Builds `form-replied` for a form that was answered or closed. Returns `null` when the frame has no form id.
   *
   * @param data      The frame's data. `id` is the form id (§4.6).
   * @param sessionID The session the form belongs to.
   * @param answer    The answer. `form.replied` passes its `answer` (keyed by field key, §4.6). A cancel passes `{}`.
   */
  private formClosed(data: Json, sessionID: string, answer: Json): ReplEvent | null {
    const formID = asString(data.id);
    if (formID === undefined) return null;
    return { kind: "form-replied", formID, sessionID, answer };
  }

  // ─── Subagent children (C2.4b, capture §4.9) ───

  /**
   * Handles `session.created` for a child of the REPL's session (capture §4.9). Returns `subagent-detected`, or `null`
   * when the session is not a child of it, or is already tracked. The frame's own fields give `agent`, and `model`
   * as `providerID/id` (v1 reads the same fields from `info`, src/events.ts). The description comes from the parent's
   * pending `subagent` call (see `pairChild`).
   *
   * @param data             The `session.created` data. `sessionID` is the child, `parentID` is the parent.
   * @param currentSessionID The session the REPL is showing.
   */
  private childCreated(data: Json, currentSessionID: string): ReplEvent | null {
    if (asString(data.parentID) !== currentSessionID) return null;
    const childID = asString(data.sessionID);
    if (childID === undefined || this.children.has(childID)) return null;
    this.children.add(childID);

    // The observed frame has the fields at the top of `data`. Reading `data.info` as well keeps the v1 shape working.
    const info = isRecord(data.info) ? data.info : data;
    const rawModel = info.model;
    const model = isRecord(rawModel) ? `${asString(rawModel.providerID) ?? ""}/${asString(rawModel.id) ?? ""}` : "";
    const description = this.pairChild(childID, asString(data.title));
    return {
      kind: "subagent-detected",
      sessionID: childID,
      agent: asString(info.agent) ?? "",
      model,
      ...(description !== undefined ? { description } : {}),
    };
  }

  /**
   * Pairs a new child with the parent's pending `subagent` call, and returns that call's description, if any.
   * A call already linked to this child by `session.tool.progress` is used first, since that link is direct. Otherwise
   * the first unpaired call whose description equals the child's `title` is taken (capture §4.9: the child's title
   * equals the invocation's description). Matching by title avoids the first-in-first-out race that v1 pairs by
   * (src/events.ts `tryPair`).
   *
   * @param childID The new child session id.
   * @param title   The child's `title`, or `undefined` when the frame has none.
   */
  private pairChild(childID: string, title: string | undefined): string | undefined {
    for (const call of this.subagentCalls.values()) {
      if (call.childID === childID) return call.description;
    }
    if (title === undefined) return undefined;
    for (const call of this.subagentCalls.values()) {
      if (call.childID === undefined && call.description === title) {
        call.childID = childID;
        return call.description;
      }
    }
    return undefined;
  }

  /**
   * Routes a frame of a session other than the REPL's (capture §2c). Only a tracked child is handled. Every other
   * session returns `null`.
   *
   * - A terminal frame of the child (`session.execution.succeeded`, `.failed` or `.interrupted`, §4.8) gives
   *   `subagent-ended`, and the child is untracked. Its later frames are then ignored.
   * - Any other frame gives `subagent-activity`, which drives the spinner. v1 emits it unthrottled as well
   *   (src/events.ts, the `message.part.delta` branch). Child text and reasoning are never rendered in the parent.
   * - A child's permission ask or form is returned too, with the child's own session id. The v1 descendant path
   *   (app.tsx) re-calls `translateEvent` only for v1-shaped frames with `properties`, so it never runs for a v2 frame.
   *   Only direct children are tracked here. A grandchild's ask is picked up by the discovery pass instead.
   *
   * @param type      The frame type.
   * @param data      The frame's data.
   * @param childID   The frame's session id.
   */
  private childFrame(type: string, data: Json, childID: string): ReplEvent | ReplEvent[] | null {
    if (!this.children.has(childID)) return null;
    if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
      this.children.delete(childID);
      return { kind: "subagent-ended", sessionID: childID };
    }
    const activity: ReplEvent = { kind: "subagent-activity", sessionID: childID, ts: Date.now() };
    const prompt = this.childPrompt(type, data, childID);
    return prompt === null ? activity : [activity, prompt];
  }

  /**
   * The permission or form event a tracked child raises. Returns `null` for any other frame type.
   *
   * @param type      The frame type.
   * @param data      The frame's data.
   * @param childID   The child session id, used as the event's session.
   */
  private childPrompt(type: string, data: Json, childID: string): ReplEvent | null {
    switch (type) {
      case "permission.asked":
        return permissionAsked(asString(data.id), childID, asString(data.action), data.resources);
      case "form.created":
        return this.formAsked(data, childID);
      case "form.replied":
        return this.formClosed(data, childID, isRecord(data.answer) ? data.answer : {});
      case "form.cancelled":
        return this.formClosed(data, childID, {});
      default:
        return null;
    }
  }

  /**
   * Links a `subagent` call to its child from `session.tool.progress` `metadata.sessionID` (capture §4.9). This is a
   * direct link, so no pairing is needed. Only calls already in `subagentCalls` are linked. Other tools are ignored.
   *
   * @param data The `session.tool.progress` data.
   */
  private linkSubagent(data: Json): void {
    const callID = asString(data.id);
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const childID = asString(metadata.sessionID);
    if (callID === undefined || childID === undefined) return;
    const call = this.subagentCalls.get(callID);
    if (call !== undefined && call.childID === undefined) call.childID = childID;
  }

  /**
   * Records a subagent call's description from `session.tool.called`. The frame's `input` holds `{agent, description,
   * prompt}` (capture §4.9). Calls of other tools have no entry in `subagentCalls`, so they are unaffected.
   *
   * @param data The `session.tool.called` data.
   */
  private recordSubagentInput(data: Json): void {
    const callID = asString(data.id);
    if (callID === undefined) return;
    const call = this.subagentCalls.get(callID);
    if (call === undefined) return;
    const input = isRecord(data.input) ? data.input : {};
    const description = asString(input.description);
    if (description !== undefined) call.description = description;
  }

  /**
   * Ends the child of a `subagent` call when the call's result arrives (capture §4.9). It runs on success and on
   * failure, after the tool's own events, as v1 does (src/events.ts, the task-tool branches). The child is ended
   * only while it is still tracked, so a child that already ended on its own gives no second `subagent-ended`.
   * The call's entry is removed either way. A call of another tool has no entry, so its events pass through unchanged.
   *
   * @param data   The tool frame's data (`session.tool.success` or `session.tool.failed`).
   * @param events The tool's own events, or `null` when its block was not open.
   */
  private withSubagentEnd(data: Json, events: ReplEvent[] | null): ReplEvent[] | null {
    const callID = asString(data.id);
    if (callID === undefined) return events;
    const call = this.subagentCalls.get(callID);
    if (call === undefined) return events;
    this.subagentCalls.delete(callID);

    // The result's `metadata.sessionID` names the child too (§4.9). It covers a call whose progress frame was missed.
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const childID = call.childID ?? asString(metadata.sessionID);
    const ends: ReplEvent[] = [];
    if (childID !== undefined && this.children.has(childID)) {
      this.children.delete(childID);
      ends.push({ kind: "subagent-ended", sessionID: childID });
    }
    if (events === null && ends.length === 0) return null;
    return [...(events ?? []), ...ends];
  }

  // ─── Durable seq (§2b) ───

  /**
   * Checks a durable `seq` against the last one seen for `sessionID`. A `seq` at or below the last is a duplicate.
   * A `seq` more than one above it is a gap. Each frame records its `seq` as the last one seen. The gapped frame
   * itself is not translated, and the caller closes the open blocks (see `closeOpenParts`). The first `seq` seen
   * is accepted as the start.
   *
   * @param sessionID The session the frame belongs to.
   * @param seq       The frame's durable `seq`.
   */
  private checkSeq(sessionID: string, seq: number): SeqCheck {
    const last = this.lastSeqBySession.get(sessionID);
    // The first seq seen for a session is the start point, so it cannot be a gap.
    if (last === undefined) {
      this.lastSeqBySession.set(sessionID, seq);
      return "ok";
    }
    // A duplicate or replayed frame is dropped. It must not move the last seen value back.
    if (seq <= last) return "duplicate";
    this.lastSeqBySession.set(sessionID, seq);
    if (seq > last + 1) return "gap";
    return "ok";
  }

  /**
   * Closes the open blocks of a session after a gap, with one `block-end` each, and forgets them. Without this, the
   * renderer keeps the blocks open for ever: the translator would no longer know them, so the turn end would never
   * close them. The block keeps the text it already has. A later delta for one of them returns `null`, as for any
   * closed block. `streamParts` and the content counters are kept, so the partIDs that history replays stay the
   * ones live frames would use. No `session-idle` is emitted here: the turn's own terminal frame, or the resync's
   * `isSessionActive` check, decides whether the turn ended.
   *
   * @param sessionID The session whose open blocks are closed.
   */
  private closeOpenParts(sessionID: string): ReplEvent[] {
    const closes: ReplEvent[] = [];
    for (const [partID, part] of this.openParts) {
      if (part.sessionID !== sessionID) continue;
      closes.push({ kind: "block-end", partID, role: part.role });
      this.openParts.delete(partID);
    }
    return closes;
  }
}
