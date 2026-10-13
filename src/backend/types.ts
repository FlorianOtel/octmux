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
 * Stage 15.2 (C2) adds `V2Backend` and reshapes the interface around
 * protocol-neutral operations; the v1-derived shapes here are expected to churn.
 */

import type {
  createOpencodeClient,
  SessionListData,
  SessionGetData,
  SessionChildrenData,
  SessionMessagesData,
  SessionCreateData,
  SessionForkData,
  SessionAbortData,
  SessionSummarizeData,
  SessionUpdateData,
  SessionCommandData,
  SessionPromptAsyncData,
  PostSessionIdPermissionsPermissionIdData,
} from "@opencode-ai/sdk/client";
import type { Event } from "@opencode-ai/sdk";
import type { ReplEvent } from "../events.ts";
import type { Renderer } from "../renderer/types.ts";
import type { LineEditor } from "../editor.ts";

// Re-exported unchanged so consumers can import the normalised event type from the Backend seam.
export type { ReplEvent } from "../events.ts";

/**
 * The v1 SDK client exactly as octmux constructs it today (`createOpencodeClient`).
 * Used only to derive v1 request/response types; the interface itself never
 * exposes the client object.
 */
export type V1Client = ReturnType<typeof createOpencodeClient>;

/**
 * Request options for a v1 SDK call: the generated `*Data` type minus its `url`
 * literal. This is the same shape the SDK's own `Options<TData>` exposes to
 * callers, so `{ path: { id } }`-style call sites keep compiling unchanged.
 */
export type V1Request<TData> = Omit<TData, "url">;

/**
 * Session-scoped operations. Method names and argument shapes mirror the v1
 * `client.session.*` calls they replace; the only rename is `summarize` →
 * `compact` (the user-facing `/compact` meaning) and `command`/`promptAsync` →
 * `sendCommand`/`sendPrompt`.
 */
export interface BackendSession {
  /** v1 `client.session.messages({ path: { id } })` — message list for a session. */
  getMessages(options: V1Request<SessionMessagesData>): ReturnType<V1Client["session"]["messages"]>;

  /** v1 `client.session.children({ path: { id } })` — direct child (subagent) sessions. */
  getChildren(options: V1Request<SessionChildrenData>): ReturnType<V1Client["session"]["children"]>;

  /** v1 `client.session.get({ path: { id } })` — single session record (includes bound model). */
  get(options: V1Request<SessionGetData>): ReturnType<V1Client["session"]["get"]>;

  /** v1 `client.session.abort({ path: { id } })` — abort the in-flight turn. */
  abort(options: V1Request<SessionAbortData>): ReturnType<V1Client["session"]["abort"]>;

  /** v1 `client.session.create({ query: { directory } })` — create a new session. */
  create(options: V1Request<SessionCreateData>): ReturnType<V1Client["session"]["create"]>;

  /**
   * v1 `client.session.summarize({ path: { id }, body: { providerID, modelID } })`.
   * Named `compact` here because it is what `/compact` triggers.
   */
  compact(options: V1Request<SessionSummarizeData>): ReturnType<V1Client["session"]["summarize"]>;

  /** v1 `client.session.list()` — all sessions visible to the server for the current directory. */
  list(): ReturnType<V1Client["session"]["list"]>;

  /** v1 `client.session.fork({ path: { id }, query? })` — fork a session into a child. */
  fork(options: V1Request<SessionForkData>): ReturnType<V1Client["session"]["fork"]>;

  /** v1 `client.session.update({ path: { id }, body: { title } })` — rename a session. */
  update(options: V1Request<SessionUpdateData>): ReturnType<V1Client["session"]["update"]>;

  /** v1 `client.session.command({ path: { id }, body })` — run a slash command inside a session. */
  sendCommand(options: V1Request<SessionCommandData>): ReturnType<V1Client["session"]["command"]>;

  /** v1 `client.session.promptAsync({ path: { id }, body })` — send a prompt without awaiting the turn. */
  sendPrompt(options: V1Request<SessionPromptAsyncData>): ReturnType<V1Client["session"]["promptAsync"]>;
}

/**
 * v1-derived event pipeline; Stage 15.2 reshapes this around protocol-neutral operations.
 *
 * Each member is a forwarder to the same-named export of `src/events.ts`.
 * The module-level state (ID sets, open-part maps) lives in `events.ts`, not here.
 */
export interface BackendEvents {
  /** v1 `filterEvent()` — turns one raw SDK event into zero, one or several ReplEvents. */
  translateEvent(event: Event, sessionID: string): ReplEvent | ReplEvent[] | null;

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

  /** v1 `client.command.list()` — slash commands offered by the server (built-in + custom). */
  listCommands(): ReturnType<V1Client["command"]["list"]>;

  /** v1 `client.config.get()` — server config; `data.model` is the default "provider/model" string. */
  getDefaultModelConfig(): ReturnType<V1Client["config"]["get"]>;

  /**
   * v1 `client.provider.list()` — providers and their models (used for context-window and validation).
   *
   * WARNING — this is NOT the v2 route `/api/provider`. That v2 route returns plaintext API keys
   * and must never be called from octmux. Any future v2 implementation of this method must
   * target a provider-metadata route that does not expose credentials.
   */
  listProviders(): ReturnType<V1Client["provider"]["list"]>;

  /** Raw `GET {baseUrl}/question` — pending MCP/tool questions. Caller checks `ok` and parses JSON. */
  listQuestions(): Promise<Response>;

  /** Raw `GET {baseUrl}/permission` — pending permission requests. Caller checks `ok` and parses JSON. */
  listPermissions(): Promise<Response>;

  /** Raw `POST {baseUrl}/question/{reqID}/reject` — reject a pending question. */
  rejectQuestion(reqID: string): Promise<Response>;

  /** Raw `POST {baseUrl}/question/{reqID}/reply` — answer a pending question (one array of answers per sub-question). */
  replyQuestion(reqID: string, answers: string[][]): Promise<Response>;

  /** v1 `client.postSessionIdPermissionsPermissionId({ path: { id, permissionID }, body: { response } })`. */
  replyPermission(
    options: V1Request<PostSessionIdPermissionsPermissionIdData>,
  ): ReturnType<V1Client["postSessionIdPermissionsPermissionId"]>;

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

  /**
   * Replays a session's history into the renderer and editor on attach.
   * Forwards to `replaySession()` in `src/replay.ts`.
   */
  replaySession(renderer: Renderer, sessionID: string, editor: LineEditor): Promise<void>;
}
