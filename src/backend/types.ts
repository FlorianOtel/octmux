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

import type { Command, createOpencodeClient, SessionMessagesResponses } from "@opencode-ai/sdk/client";
import type { Event } from "@opencode-ai/sdk";
import type { FormField, ReplEvent } from "../events.ts";
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
 *
 * On v2, `modelID` holds `ModelInfo.id` (the short name such as `glm-5.3-flash`), the same key the
 * catalog uses. It does not hold `ModelInfo.modelID`, which is the upstream API name.
 */
export type ModelRef = { providerID: string; modelID: string };

/**
 * One model entry in a `ProviderCatalog`. Only the fields that `utils/formatters.ts` and the
 * `/model` picker read are listed. `tool_call` is optional because not every backend reports it.
 */
export type ProviderModelEntry = {
  /** The model's key in its `models` dict. On v2 this is `ModelInfo.id`, and `ModelRef.modelID` takes the same value. */
  id: string;
  /** Display name. The `/model` picker reads it (`src/app.tsx`). Always present on v1 and v2 models. */
  name: string;
  limit?: { context?: number };
  tool_call?: boolean;
};

/**
 * Provider catalog in the v1 `provider.list()` shape: `all` holds each provider with its `models`
 * dict, and `connected` holds the provider IDs that may be used. `utils/formatters.ts` and the
 * `/model` picker read this shape. `V2Backend.listProviders()` builds it from `model.list()`.
 */
export type ProviderCatalog = {
  all: Array<{ id: string; models: Record<string, ProviderModelEntry> }>;
  connected: string[];
};

/**
 * A pending form (v2 question-style request). `fields` uses the `FormField` shape from
 * `src/events.ts`, which is also the payload of the `form-asked` ReplEvent.
 */
export type BackendForm = { id: string; sessionID: string; title: string; fields: FormField[] };

/** Answer to a form: field key to value. v2 sends it as `{ answer: {...} }`. */
export type FormAnswer = Record<string, string | number | boolean | string[]>;

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
 * - Write methods (`create`, `fork`, `update`, `compact`, `sendPrompt`, `sendCommand`,
 *   `setModel`, and the permission and form replies in `Backend`) resolve `void` or the
 *   new record. On an error status the two backends differ:
 *   - `V1Backend` swallows the status, as the v1 call sites were written.
 *   - `V2Backend` rejects with an `Error` whose message is short and human-readable:
 *     `<_tag>: <message>` for a declared typed error, and `OpenCode server returned HTTP <status>`
 *     for a bare status. A `LocationNotFoundError` gets a hint that names `server.directory`.
 *     Headers and credentials never reach the message.
 *   Every call site that performs a write must therefore handle a rejection. Either it shows the
 *   message, or it ignores the failure with an explicit `.catch`.
 * - `abort` is not a write method in this sense. It always resolves `{ interrupted }`, which is
 *   `false` on an error status in both backends.
 * - A transport-level failure (the underlying fetch rejects) rejects the promise in
 *   every case, in both backends.
 *
 * Method names mirror the v1 `client.session.*` calls they replace. The renames are
 * `summarize` → `compact` (the user-facing `/compact` meaning), and
 * `command`/`promptAsync` → `sendCommand`/`sendPrompt`.
 */
export interface BackendSession {
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
 * The v1-only session operations. `getMessages` and `getChildren` are not on the shared
 * `BackendSession`: their only consumer is `src/backend/v1-queries.ts`, which reads the v1 element
 * types. `V1Backend.session` is typed with this interface, so v1-queries keeps its v1 types.
 * `V2Backend` keeps equivalent internal methods (`fetchMessages`, `fetchChildren`) outside the seam.
 */
export interface V1BackendSession extends BackendSession {
  /** v1 `client.session.messages({ path: { id } })`. Message list in the v1 `{ info, parts }[]` shape. */
  getMessages(sessionID: string): Promise<SessionMessagesResponses[200] | undefined>;

  /** v1 `client.session.children({ path: { id } })`. Direct child (subagent) sessions. */
  getChildren(sessionID: string): Promise<SessionRecord[] | undefined>;
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
   *
   * Stage 15.2 (C2.6b, D-A fix): every message the fetch returns is recorded as rendered, so a later
   * `getMissedHistory` does not render it a second time. The v2 backend does this. v1 does not track it.
   */
  getHistory(sessionID: string): Promise<HistoryOp[]>;

  /**
   * Replay operations for the part of a session's history that the live stream did not render: messages
   * the translator has not rendered, and that are complete. Pass them to `applyHistory`. Used by the v2
   * `resync-needed` handler (src/app.tsx) after a durable seq gap. A gap then renders only what was missed,
   * and clears nothing. Fetch errors yield `[]`.
   *
   * V1Backend resolves `[]`, because v1 never emits `resync-needed`.
   */
  getMissedHistory(sessionID: string): Promise<HistoryOp[]>;

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
  // C2.3a: return type widened from ReturnType<V1Client["command"]["list"]> to a data-only shape. v2 has
  // no SDK response envelope to return. Call sites read only `.data`. `Command` is the v1 SDK type that
  // app.tsx's opencodeCommands Map is typed with, so it is kept as the element type.
  listCommands(): Promise<{ data?: Command[] }>;

  /** v1 `client.config.get()`. Server config; `data.model` is the default "provider/model" string. */
  // C2.3a: return type widened to the data-only shape that formatters.getDefaultModel reads (`data.model`).
  // v2 builds `{ model: "providerID/modelID" }` from `model.default()` and keeps nothing else.
  getDefaultModelConfig(): Promise<{ data?: { model?: string } }>;

  /**
   * v1 `client.provider.list()`. Providers and their models (used for context-window and validation).
   *
   * WARNING — this is NOT the v2 route `/api/provider`. That v2 route returns plaintext API keys
   * and must never be called from octmux. Any future v2 implementation of this method must
   * target a provider-metadata route that does not expose credentials.
   */
  // C2.3a: return type widened to the data-only ProviderCatalog. v2 builds it from `model.list()`
  // (see V2Backend.listProviders for the "connected" decision).
  listProviders(): Promise<{ data?: ProviderCatalog }>;

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
   *
   * C2.3a: return type widened from `ReturnType<V1Client["global"]["event"]>` to the shape the
   * consumers read: `.stream`, iterated with `for await`, whose items carry a `payload`
   * (`src/app.tsx` `eventStream` prop). v1 satisfies it unchanged. v2 wraps each frame as `{ payload: frame }`.
   */
  subscribeEvents(): Promise<{ stream: AsyncIterable<{ payload: unknown }> }>;

  /**
   * Pending forms for a session (v2 only). v1 has no forms, so `V1Backend` returns `[]`.
   * `undefined` on an error status, as with the other read-style session operations.
   */
  listForms(sessionID: string): Promise<BackendForm[] | undefined>;

  /**
   * Answers a pending form (v2 only). v1 has no forms, so `V1Backend` does nothing.
   * Error statuses are swallowed, as with the other void session operations.
   */
  replyForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void>;

  /**
   * Cancels a pending form without answering it (v2 only, Stage 15.2 C2.6b). Used when the operator
   * dismisses a form with Esc or Ctrl-C. `V1Backend` resolves without sending a request, because v1
   * has no forms. Error statuses are swallowed, as with `replyForm`.
   */
  cancelForm(sessionID: string, formID: string): Promise<void>;

  /**
   * True while the session is running, false when it is not, and `undefined` when the answer is unknown.
   * The v2 `resync-needed` handler (C2.6b) uses it to reconcile the generating state after a replay.
   * `V2Backend` reads `GET /api/session/active` and resolves `undefined` on an error status. `V1Backend`
   * resolves `undefined` and sends no request, because v1 never emits `resync-needed`, so the question
   * never arises there.
   */
  isSessionActive(sessionID: string): Promise<boolean | undefined>;
}
