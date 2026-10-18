/**
 * Backend — the seam between octmux's UI/orchestration code (app.tsx, index.tsx,
 * orchestra-watch.ts, utils/formatters.ts) and the OpenCode v2 wire protocol.
 *
 * `V2Backend` (src/backend/v2.ts, @opencode/client) is the only implementation.
 * src/index.tsx constructs it once protocol detection confirms a v2 server; a v1
 * server is a hard startup error (Stage 15.5). Nothing else in octmux talks to the
 * wire protocol directly.
 *
 * Session operations take flat named arguments; `V2Backend` builds its own wire
 * requests from them.
 */

import type { FormField, ReplEvent } from "../events.ts";
import type { HistoryOp } from "../replay.ts";

// Re-exported unchanged so consumers can import the normalised event type from the Backend seam.
export type { ReplEvent } from "../events.ts";
export type { HistoryOp } from "../replay.ts";

/**
 * Permission reply vocabulary. These are the values `handlePermission` in app.tsx passes,
 * and the `decision` that `V2Backend.replyPermission` sends.
 */
export type PermissionDecision = "once" | "always" | "reject";

/**
 * One slash command the server offers (built-in or custom). Only the two fields octmux reads:
 * `app.tsx`'s opencodeCommands map and `/help` (`src/commands.ts`). The v2 `/api/command` route
 * also returns `template` (the raw command body), which octmux never reads.
 */
export type CommandInfo = { name: string; description?: string };

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
 * `/model` picker read are listed. `tool_call` is optional because not every model reports it.
 */
export type ProviderModelEntry = {
  /** The model's key in its `models` dict. On v2 this is `ModelInfo.id`, and `ModelRef.modelID` takes the same value. */
  id: string;
  /** Display name. The `/model` picker reads it (`src/app.tsx`). Always present. */
  name: string;
  limit?: { context?: number };
  tool_call?: boolean;
};

/**
 * Provider catalog: `all` holds each provider with its `models` dict, and `connected` holds the
 * provider IDs that may be used. `utils/formatters.ts` and the `/model` picker read this shape.
 * `V2Backend.listProviders()` builds it from `model.list()`.
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
 *   `data` field. That is `undefined` when the server answered with an error status.
 *   Call sites keep their `?? []`, `!` and `?.` handling unchanged.
 * - Write methods (`create`, `fork`, `update`, `compact`, `sendPrompt`, `sendCommand`,
 *   `setModel`, and the permission and form replies in `Backend`) resolve `void` or the
 *   new record. On an error status `V2Backend` rejects with an `Error` whose message is
 *   short and human-readable: `<_tag>: <message>` for a declared typed error, and
 *   `OpenCode server returned HTTP <status>` for a bare status. A `LocationNotFoundError`
 *   gets a hint that names `server.directory`. Headers and credentials never reach the message.
 *   Every call site that performs a write must therefore handle a rejection. Either it shows the
 *   message, or it ignores the failure with an explicit `.catch`.
 * - `abort` is not a write method in this sense. It always resolves `{ interrupted }`, which is
 *   `false` on an error status.
 * - A transport-level failure (the underlying fetch rejects) rejects the promise.
 */
export interface BackendSession {
  /** Single session record, including the bound model. */
  get(sessionID: string): Promise<SessionRecord | undefined>;

  /** Aborts the session's running turn. Resolves `interrupted: true` when the server reports the abort took effect. */
  abort(sessionID: string): Promise<{ interrupted: boolean }>;

  /** Creates a new session in `directory`. */
  create(options: { directory: string }): Promise<SessionRecord | undefined>;

  /**
   * Compacts the session's context using `model`. Named `compact` here because it is what `/compact` triggers.
   */
  compact(sessionID: string, model: ModelRef): Promise<void>;

  /** All sessions visible to the server for the current directory. */
  list(): Promise<SessionRecord[] | undefined>;

  /**
   * Forks a session into a child. `directory` is sent only when given.
   */
  fork(sessionID: string, options?: { directory?: string }): Promise<SessionRecord | undefined>;

  /** Renames a session. */
  update(sessionID: string, options: { title: string }): Promise<void>;

  /**
   * Runs a slash command inside a session. `name` is the command, `args` its arguments,
   * `promptID` the message ID octmux minted for the echo, and `model` the model override when given.
   */
  sendCommand(options: {
    sessionID: string;
    name: string;
    args: string;
    promptID?: string;
    model?: ModelRef;
  }): Promise<void>;

  /**
   * Sends a prompt without awaiting the turn. `promptID` is the message ID octmux minted for the prompt,
   * and `model` is the per-prompt model override when given.
   */
  sendPrompt(options: { sessionID: string; text: string; promptID?: string; model?: ModelRef }): Promise<void>;

  /**
   * Sets the session-level model. `V2Backend` sends it through `ensureModel`, which skips a model
   * the session already has.
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
 * The event pipeline and the session-read queries.
 *
 * `V2Backend` forwards the event members to its own `V2EventTranslator` instance (src/backend/v2-events.ts),
 * and the session-read members to src/backend/v2-queries.ts.
 */
export interface BackendEvents {
  /** Turns one raw SSE frame into zero, one or several ReplEvents. V2Backend forwards to V2EventTranslator.translate (src/backend/v2-events.ts). */
  translateEvent(event: unknown, sessionID: string): ReplEvent | ReplEvent[] | null;

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
   * Stage 15.2 (C2.6b, D-A fix): `V2Backend` records every message the fetch returns as rendered,
   * so a later `getMissedHistory` does not render it a second time.
   */
  getHistory(sessionID: string): Promise<HistoryOp[]>;

  /**
   * Replay operations for the part of a session's history that the live stream did not render: messages
   * the translator has not rendered, and that are complete. Pass them to `applyHistory`. Used by the v2
   * `resync-needed` handler (src/app.tsx) after a durable seq gap. A gap then renders only what was missed,
   * and clears nothing. Fetch errors yield `[]`.
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

  /**
   * Records a command about to be sent. Its expanded echo turn is suppressed, either by the prefix or by one
   * pending echo slot. The slot takes the next user turn whatever its text, because the POST returns no id.
   */
  recordOwnCommandPrefix(prefix: string): void;
}

/**
 * The full Backend seam consumed by the REPL.
 */
export interface Backend {
  /** Session-scoped REST operations (see `BackendSession`). */
  session: BackendSession;

  /** The event pipeline and session-read queries (see `BackendEvents`). */
  events: BackendEvents;

  /** Slash commands offered by the server (built-in + custom). */
  // Call sites read only `.data`. CommandInfo is the shared shape app.tsx's opencodeCommands Map is typed with.
  listCommands(): Promise<{ data?: CommandInfo[] }>;

  /** Server config; `data.model` is the default "provider/model" string. */
  // The data-only shape that formatters.getDefaultModel reads (`data.model`).
  // v2 builds `{ model: "providerID/modelID" }` from `model.default()` and keeps nothing else.
  getDefaultModelConfig(): Promise<{ data?: { model?: string } }>;

  /**
   * Providers and their models (used for context-window and validation).
   *
   * WARNING — this is NOT the v2 route `/api/provider`. That v2 route returns plaintext API keys
   * and must never be called from octmux. Any future v2 implementation of this method must
   * target a provider-metadata route that does not expose credentials.
   */
  // v2 builds the data-only ProviderCatalog from `model.list()` (see V2Backend.listProviders for the "connected" decision).
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
   * Answers a pending permission request. `decision` is sent as the reply body's `decision`.
   * `message` is sent only when given.
   */
  replyPermission(options: {
    sessionID: string;
    permissionID: string;
    decision: PermissionDecision;
    message?: string;
  }): Promise<void>;

  /**
   * True if `candidateSessionID` is a descendant of `ancestorSessionID`.
   * Walks the parent chain through `src/backend/v2-ancestry.ts`, with a TTL cache.
   */
  isSessionDescendant(candidateSessionID: string, ancestorSessionID: string): Promise<boolean>;

  /**
   * Opens the global SSE event stream. The caller reads `.stream`, iterated with `for await`, whose items
   * carry a `payload` (`src/app.tsx` `eventStream` prop). Used for the initial subscription and for reconnects.
   * `V2Backend` wraps each frame as `{ payload: frame }`.
   */
  subscribeEvents(): Promise<{ stream: AsyncIterable<{ payload: unknown }> }>;

  /**
   * Startup check that the server can resolve `directory` (a path as the SERVER sees it) before
   * octmux creates, forks or attaches to a session there. Rejects with a readable `Error` when it
   * cannot. Without this check a v2 server accepts a session at a directory it does not have and
   * records a project for it that the API cannot delete.
   *
   * `V2Backend` calls `location.get`. On a `LocationNotFoundError` the message names the directory,
   * the config keys to fix, and the projects the server knows (from `project.list`).
   */
  checkLocation(directory: string): Promise<void>;

  /**
   * Pending forms for a session. `undefined` on an error status, as with the other read-style session operations.
   */
  listForms(sessionID: string): Promise<BackendForm[] | undefined>;

  /**
   * Answers a pending form. A write: `V2Backend` rejects on an error status (see `BackendSession`).
   */
  replyForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void>;

  /**
   * Cancels a pending form without answering it (Stage 15.2 C2.6b). Used when the operator
   * dismisses a form with Esc or Ctrl-C. A write: `V2Backend` rejects on an error status, as with `replyForm`.
   */
  cancelForm(sessionID: string, formID: string): Promise<void>;

  /**
   * True while the session is running, false when it is not, and `undefined` when the answer is unknown.
   * The v2 `resync-needed` handler (C2.6b) uses it to reconcile the generating state after a replay.
   * `V2Backend` reads `GET /api/session/active` and resolves `undefined` on an error status.
   */
  isSessionActive(sessionID: string): Promise<boolean | undefined>;

  /**
   * The orchestra (/brain or /duo) run state of the REPL's session, for the status-line badge and the
   * end-of-run notice. `null` when there is no run state, or when it cannot be read. `active: false`
   * is the final state of a finished run.
   * - `V2Backend` reads it over the API: the session's `metadata.orchestra`, which oconona publishes
   *   (contract: `ORCHESTRA_METADATA_KEY` in src/backend/v2-orchestra.ts). No filesystem access.
   */
  getOrchestraState(sessionID: string): Promise<OrchestraState | null>;
}

/**
 * Protocol-neutral orchestra run state, the input of the status-line badge (src/orchestra-watch.ts).
 * Subagent rows are not part of it: they come from the event stream (`subagent-*` ReplEvents).
 */
export type OrchestraState = {
  /** True while the run is in flight. The badge is shown only then. */
  active: boolean;
  mode: "brain" | "duo";
  /** Badge title as published by oconona, already truncated to 48 characters. */
  title: string;
  /** oconona telemetry parser warnings; shown as " !" on the badge. */
  parserWarnings: Array<{ code: string; message: string }>;
  /** The model bound to the harness session, for the parent row label. */
  model?: { providerID: string; id: string };
  /** How a finished run ended ("pass", "fix-loop", "block", "abandoned"), when the backend reports it. */
  outcome?: string;
};
