/**
 * Backend — the protocol-neutral seam between octmux's UI/orchestration code
 * (app.tsx, index.tsx, orchestra-watch.ts, utils/formatters.ts) and whichever
 * OpenCode wire protocol is in use.
 *
 * Stage 15.1 (C1): this interface is v1-derived. Every member mirrors a call
 * shape octmux uses today against the v1 SDK client, so that call sites can be
 * swapped from `props.client.*` / raw `fetch()` / free functions to
 * `props.backend.*` without changing argument shapes, return types or behaviour.
 * `V1Backend` (src/backend/v1.ts) is the only implementation shipped in C1.
 *
 * Stage 15.2a (C2.1–2.2a): the session operations are reshaped to flat named
 * arguments. The SDK option-object wrapper (`{ path, query, body }`) is gone from
 * the interface; `V1Backend` builds the same SDK requests internally.
 *
 * Stage 15.2 (C2) adds `V2Backend` and reshapes the rest of the interface around
 * protocol-neutral operations; the v1-derived shapes here are expected to churn.
 */

import type { createOpencodeClient, SessionMessagesResponses } from "@opencode-ai/sdk/client";
import type { Event } from "@opencode-ai/sdk";
import type { ReplEvent } from "../events.ts";
import type { HistoryOp } from "../replay.ts";

// Re-exported unchanged so consumers can import the normalised event type from the Backend seam.
export type { ReplEvent } from "../events.ts";
export type { HistoryOp } from "../replay.ts";

/**
 * The v1 SDK client exactly as octmux constructs it today (`createOpencodeClient`).
 * Used only to derive v1 request/response types; the interface itself never
 * exposes the client object.
 */
export type V1Client = ReturnType<typeof createOpencodeClient>;

/**
 * Permission reply vocabulary. These are the v1 `body.response` strings, and the
 * same values `handlePermission` in app.tsx already passes.
 */
export type PermissionDecision = "once" | "always" | "reject";

/**
 * A model binding passed with prompt, command and compact calls: `{ providerID, modelID }`,
 * the same shape as the REPL's `activeModel` state.
 */
export type ModelRef = { providerID: string; modelID: string };

/**
 * The flat session record. It lists only the fields octmux's call sites read:
 * `id`, `parentID`, `directory`, `title`, `time.updated`, and the bound `model`.
 * Fields such as `projectID`, `version`, `summary` and `time.created` are not listed
 * because no call site reads them.
 *
 * The SDK `Session` type (v1) satisfies this record. `model` is read at runtime but is
 * absent from the SDK `Session` type, so declaring it here is what lets those reads type-check.
 */
export type SessionRecord = {
  id: string;
  /** Absent for top-level sessions. Present on subagent (child) sessions. */
  parentID?: string;
  /** Working directory the session belongs to. */
  directory: string;
  title: string;
  time: { updated: number };
  /** Model bound to the session. Read by session switch, `/model` and the orchestra watcher. */
  model?: { providerID: string; id: string };
};

/**
 * Session-scoped operations, with flat named arguments.
 *
 * Resolution convention, applied uniformly to every method below:
 * - A method whose call sites read the response resolves with the SDK response's
 *   `data` field. That is `undefined` when the server answered with an error status,
 *   which is exactly what the old `resp.data` checks saw. Call sites keep their
 *   `?? []`, `!` and `?.` handling unchanged.
 * - A method whose call sites never read the response resolves `void`, or the
 *   `{ interrupted }` result for `abort`. An error status is swallowed here, as it
 *   was at those call sites.
 * - A transport-level failure (the underlying fetch rejects) rejects the promise in
 *   every case, as before.
 *
 * Method names mirror the v1 `client.session.*` calls they replace. The renames are
 * `summarize` → `compact` (the user-facing `/compact` meaning), and
 * `command`/`promptAsync` → `sendCommand`/`sendPrompt`.
 */
export interface BackendSession {
  /** v1 `client.session.messages({ path: { id } })`. Message list in the v1 `{ info, parts }[]` shape. */
  getMessages(sessionID: string): Promise<SessionMessagesResponses[200] | undefined>;

  /** v1 `client.session.children({ path: { id } })`. Direct child (subagent) sessions. */
  getChildren(sessionID: string): Promise<SessionRecord[] | undefined>;

  /** v1 `client.session.get({ path: { id } })`. Single session record, including the bound model. */
  get(sessionID: string): Promise<SessionRecord | undefined>;

  /** v1 `client.session.abort({ path: { id } })`. Resolves `interrupted: true` when the server reports the abort took effect. */
  abort(sessionID: string): Promise<{ interrupted: boolean }>;

  /** v1 `client.session.create({ query: { directory } })`. Creates a new session. */
  create(options: { directory: string }): Promise<SessionRecord | undefined>;

  /**
   * v1 `client.session.summarize({ path: { id }, body: { providerID, modelID } })`.
   * Named `compact` here because it is what `/compact` triggers.
   */
  compact(sessionID: string, model: ModelRef): Promise<void>;

  /** v1 `client.session.list()`. All sessions visible to the server for the current directory. */
  list(): Promise<SessionRecord[] | undefined>;

  /**
   * v1 `client.session.fork({ path: { id }, query? })`. Forks a session into a child.
   * `directory` is sent as the `query.directory` only when given, as before.
   */
  fork(sessionID: string, options?: { directory?: string }): Promise<SessionRecord | undefined>;

  /** v1 `client.session.update({ path: { id }, body: { title } })`. Renames a session. */
  update(sessionID: string, options: { title: string }): Promise<void>;

  /**
   * v1 `client.session.command({ path: { id }, body })`. Runs a slash command inside a session.
   * `name` is sent as `body.command`, `args` as `body.arguments`, `promptID` as `body.messageID`,
   * and `model` as the `"provider/model"` string in `body.model`.
   */
  sendCommand(options: {
    sessionID: string;
    name: string;
    args: string;
    promptID?: string;
    model?: ModelRef;
  }): Promise<void>;

  /**
   * v1 `client.session.promptAsync({ path: { id }, body })`. Sends a prompt without awaiting the turn.
   * The body is `parts: [{ type: "text", text }]`, `messageID: promptID`, and `model` when given.
   */
  sendPrompt(options: { sessionID: string; text: string; promptID?: string; model?: ModelRef }): Promise<void>;

  /**
   * Sets the session-level model. v1 has no session-level model-set operation: the
   * `/model` command only updates octmux's local `activeModel` and relies on the per-prompt
   * model override. So the v1 implementation is a no-op.
   */
  setModel(sessionID: string, model: ModelRef): Promise<void>;
}

/**
 * Newest assistant message of a session, as the stall watchdog reads it. `null` when the session
 * has no assistant message yet.
 *
 * - `hasContent`: the message has at least one part.
 * - `completedAt`: `time.completed` of the message, or `null`/`undefined` while it is still running.
 * - `openChild`: set only for an incomplete message that has content and whose last part is a
 *   running `task` call paired to a child session. `stale` is true when that child's own newest
 *   turn has shown no progress for 3 minutes. Otherwise `openChild` is `null`.
 */
export type LatestAssistantActivity =
  | {
      hasContent: boolean;
      completedAt: number | null | undefined;
      openChild: { sessionID: string; stale: boolean } | null;
    }
  | null;

/**
 * Token usage for the status line. `used` is the context size of the newest post-summary
 * assistant message. `runningCost` is the cost summed over the session and its direct children.
 * `providerID` and `modelID` are those of the same message.
 */
export type TokenUsageSummary = {
  used: number;
  providerID: string | undefined;
  modelID: string | undefined;
  runningCost: number;
};

/**
 * v1-derived event pipeline; Stage 15.2 reshapes this around protocol-neutral operations.
 *
 * Each member is a forwarder to the same-named export of `src/events.ts`.
 * The module-level state (ID sets, open-part maps) lives in `events.ts`, not here.
 */
export interface BackendEvents {
  /** v1 `filterEvent()`. Turns one raw SDK event into zero, one or several ReplEvents. */
  translateEvent(event: Event, sessionID: string): ReplEvent | ReplEvent[] | null;

  /**
   * True if any tool part of the session is still `pending` or `running`. Reconciler guard
   * (Layer 4) that stops an idle synthesis while work is still in flight.
   */
  hasPendingToolCalls(sessionID: string): Promise<boolean>;

  /** Newest assistant message for the stall watchdog. See `LatestAssistantActivity`. */
  getLatestAssistantActivity(sessionID: string): Promise<LatestAssistantActivity>;

  /** Status-line token usage and running cost. `null` when there is no post-summary usage. See `TokenUsageSummary`. */
  getTokenUsage(sessionID: string): Promise<TokenUsageSummary | null>;

  /**
   * Replay operations for a session's history, in order. Pass them to `applyHistory` (src/replay.ts).
   * Fetch errors yield `[]`. Replay is best-effort.
   */
  getHistory(sessionID: string): Promise<HistoryOp[]>;

  /** Clears all event-pipeline state (called on session switch and reset). */
  resetEventState(): void;

  /** Synthesises session-idle plus block-end events for any open parts (reconciler use). */
  synthesizeSessionIdleEvents(): ReplEvent[];

  /** True if a text or thinking part is currently streaming (reconciler guard). */
  hasOpenStreamingPart(): boolean;

  /** Records a message ID that octmux itself created, so its user turn is not re-rendered. */
  recordOwnMessageID(id: string): void;

  /** Records a custom command prefix so the injected system-reminder turn is suppressed. */
  recordOwnCommandPrefix(prefix: string): void;

  /** Classifies one user turn by message ID (debounced foreign-turn path). Idempotent. */
  classifyUserTurn(messageID: string): ReplEvent[];
}

/**
 * The full Backend seam consumed by the REPL.
 */
export interface Backend {
  /** Session-scoped REST operations (see `BackendSession`). */
  session: BackendSession;

  /** v1-derived event pipeline helpers (see `BackendEvents`). */
  events: BackendEvents;

  /** v1 `client.command.list()`. Slash commands offered by the server (built-in + custom). */
  listCommands(): ReturnType<V1Client["command"]["list"]>;

  /** v1 `client.config.get()`. Server config; `data.model` is the default "provider/model" string. */
  getDefaultModelConfig(): ReturnType<V1Client["config"]["get"]>;

  /**
   * v1 `client.provider.list()`. Providers and their models (used for context-window and validation).
   *
   * WARNING — this is NOT the v2 route `/api/provider`. That v2 route returns plaintext API keys
   * and must never be called from octmux. Any future v2 implementation of this method must
   * target a provider-metadata route that does not expose credentials.
   */
  listProviders(): ReturnType<V1Client["provider"]["list"]>;

  /** Raw `GET {baseUrl}/question`. Pending MCP/tool questions. Caller checks `ok` and parses JSON. */
  listQuestions(): Promise<Response>;

  /** Raw `GET {baseUrl}/permission`. Pending permission requests. Caller checks `ok` and parses JSON. */
  listPermissions(): Promise<Response>;

  /** Raw `POST {baseUrl}/question/{reqID}/reject`. Rejects a pending question. */
  rejectQuestion(reqID: string): Promise<Response>;

  /** Raw `POST {baseUrl}/question/{reqID}/reply`. Answers a pending question (one array of answers per sub-question). */
  replyQuestion(reqID: string, answers: string[][]): Promise<Response>;

  /**
   * Answers a pending permission request. v1 maps `decision` to `body.response`.
   * `message` is accepted for the protocol-neutral shape. The v1 body has no such field,
   * so the v1 implementation ignores it.
   */
  replyPermission(options: {
    sessionID: string;
    permissionID: string;
    decision: PermissionDecision;
    message?: string;
  }): Promise<void>;

  /**
   * True if `candidateSessionID` is a descendant of `ancestorSessionID`.
   * Forwards to `isSessionDescendant()` in `src/utils/session-ancestry.ts` (cached session list).
   */
  isSessionDescendant(candidateSessionID: string, ancestorSessionID: string): Promise<boolean>;

  /**
   * Opens the global SSE event stream. v1 `client.global.event({})`; the caller reads `.stream`.
   * Used for the initial subscription and for reconnects.
   */
  subscribeEvents(): ReturnType<V1Client["global"]["event"]>;
}
