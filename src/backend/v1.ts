/**
 * V1Backend — the `Backend` implementation for the OpenCode v1 wire protocol.
 *
 * Stage 15.1 (C1) is a pure move: every method is a thin forwarder that repeats
 * the exact call the REPL made before the Backend seam existed. Raw `fetch()`
 * URLs and headers are copied verbatim, including `x-opencode-directory` and
 * `...getAuthHeaders()`, because the v1 server gates `/question`, `/permission`
 * and `/session` on the directory header.
 *
 * No logic lives here beyond argument forwarding. The event pipeline, replay and
 * ancestry walk stay in their existing modules (`src/events.ts`,
 * `src/replay.ts`, `src/utils/session-ancestry.ts`) and are only referenced.
 */

import type { Backend, BackendEvents, BackendForm, FormAnswer, OrchestraState, PermissionDecision, V1BackendSession, V1Client } from "./types.ts";
import { V1OrchestraFileReader } from "./v1-orchestra.ts";
import { getAuthHeaders } from "../auth-headers.ts";
import {
  filterEvent,
  resetEventState,
  synthesizeSessionIdleEvents,
  hasOpenStreamingPart,
  recordOwnMessageID,
  recordOwnCommandPrefix,
  classifyUserTurn,
} from "../events.ts";
import { fetchHistory } from "../replay.ts";
import { isSessionDescendant } from "../utils/session-ancestry.ts";
import {
  queryHasPendingToolCalls,
  queryLatestAssistantActivity,
  queryTokenUsage,
} from "./v1-queries.ts";

/**
 * Backend over the v1 SDK client plus the raw HTTP endpoints octmux still calls
 * directly (question/permission lists and replies).
 */
export class V1Backend implements Backend {
  /** Session-scoped REST operations, each forwarding to `this.client.session.*`. */
  readonly session: V1BackendSession;

  /** Event-pipeline helpers, forwarding to the same-named exports of `src/events.ts`. */
  readonly events: BackendEvents;

  /**
   * @param client  - v1 SDK client (must already carry the auth header and directory, as built in index.tsx).
   * @param baseUrl - OpenCode daemon base URL, used for the raw `fetch()` endpoints.
   * @param cwd     - Working directory sent as the `x-opencode-directory` header on raw `fetch()` calls.
   */
  constructor(
    private readonly client: V1Client,
    private readonly baseUrl: string,
    private readonly cwd: string,
  ) {
    // Arrow functions read `this.client` at call time, so the property initialisers
    // below do not depend on the order of parameter-property assignment.
    //
    // Each member builds exactly the SDK request the REPL made before the flat-argument
    // reshape (Stage 15.2a), and resolves per the convention documented on BackendSession:
    // `.data` for call sites that read the response, `void` for those that never did.
    this.session = {
      // Read-style operations: resolve with `.data` (undefined on an error status).
      getMessages: async (sessionID) => (await this.client.session.messages({ path: { id: sessionID } })).data,
      getChildren: async (sessionID) => (await this.client.session.children({ path: { id: sessionID } })).data,
      get: async (sessionID) => (await this.client.session.get({ path: { id: sessionID } })).data,
      list: async () => (await this.client.session.list()).data,
      create: async ({ directory }) => (await this.client.session.create({ query: { directory } })).data,

      // `query` is only sent when a directory is given, so the no-option request matches today's call.
      fork: async (sessionID, options) =>
        (
          await this.client.session.fork({
            path: { id: sessionID },
            ...(options?.directory !== undefined ? { query: { directory: options.directory } } : {}),
          })
        ).data,

      // Abort: the SDK types the response body as a boolean. `interrupted` is that boolean,
      // so an error status reports `false` (the call sites ignore the value either way).
      abort: async (sessionID) => {
        const resp = await this.client.session.abort({ path: { id: sessionID } });
        return { interrupted: resp.data === true };
      },

      // Void-style operations: the response is never read, so error statuses are swallowed as before.
      compact: async (sessionID, model) => {
        await this.client.session.summarize({
          path: { id: sessionID },
          body: { providerID: model.providerID, modelID: model.modelID },
        });
      },
      update: async (sessionID, options) => {
        await this.client.session.update({ path: { id: sessionID }, body: { title: options.title } });
      },

      // Prompt body: `parts`, then `messageID`, then `model` only when given (same key order as before).
      sendPrompt: async (options) => {
        await this.client.session.promptAsync({
          path: { id: options.sessionID },
          body: {
            parts: [{ type: "text", text: options.text }],
            messageID: options.promptID,
            ...(options.model
              ? { model: { providerID: options.model.providerID, modelID: options.model.modelID } }
              : {}),
          },
        });
      },

      // Command body: `command`, `arguments`, `messageID`, then `model` as a "provider/model" string.
      sendCommand: async (options) => {
        await this.client.session.command({
          path: { id: options.sessionID },
          body: {
            command: options.name,
            arguments: options.args,
            messageID: options.promptID,
            ...(options.model ? { model: `${options.model.providerID}/${options.model.modelID}` } : {}),
          },
        });
      },

      // v1 has no session-level model-set operation (see BackendSession.setModel). No request is sent.
      setModel: async () => {},
    };

    // Shorthand entries reference the imported functions directly: no logic is added.
    this.events = {
      translateEvent: filterEvent,
      resetEventState,
      synthesizeSessionIdleEvents,
      hasOpenStreamingPart,
      recordOwnMessageID,
      recordOwnCommandPrefix,
      classifyUserTurn,

      // Session queries (Stage 15.2 C2.1–2.2b). Each reads through `this.session`, so the request
      // is the same `client.session.*` call the REPL made before the scan moved out of app.tsx.
      hasPendingToolCalls: (sessionID) => queryHasPendingToolCalls(this.session, sessionID),
      getLatestAssistantActivity: (sessionID) => queryLatestAssistantActivity(this.session, sessionID, Date.now()),
      getTokenUsage: (sessionID) => queryTokenUsage(this.session, sessionID),

      // History: fetch the message list and translate it into replay operations (src/replay.ts).
      getHistory: (sessionID) => fetchHistory(this.client, sessionID),

      // v1 never emits `resync-needed` (no durable seq), so the missed-history path is never reached on v1.
      getMissedHistory: async () => [],
    };
  }

  /** v1 `client.command.list()`. */
  listCommands(): ReturnType<V1Client["command"]["list"]> {
    return this.client.command.list();
  }

  /** v1 `client.config.get()`. */
  getDefaultModelConfig(): ReturnType<V1Client["config"]["get"]> {
    return this.client.config.get();
  }

  /**
   * v1 `client.provider.list()`.
   * This is the v1 route. It is deliberately NOT `/api/provider` (v2), which exposes API keys.
   */
  listProviders(): ReturnType<V1Client["provider"]["list"]> {
    return this.client.provider.list();
  }

  /** Raw `GET {baseUrl}/question` with the directory header and auth headers. */
  listQuestions(): Promise<Response> {
    return fetch(`${this.baseUrl}/question`, { headers: { "x-opencode-directory": this.cwd, ...getAuthHeaders() } });
  }

  /** Raw `GET {baseUrl}/permission` with the directory header and auth headers. */
  listPermissions(): Promise<Response> {
    return fetch(`${this.baseUrl}/permission`, { headers: { "x-opencode-directory": this.cwd, ...getAuthHeaders() } });
  }

  /** Raw `POST {baseUrl}/question/{reqID}/reject` with an empty JSON body, as before. */
  rejectQuestion(reqID: string): Promise<Response> {
    return fetch(`${this.baseUrl}/question/${reqID}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": this.cwd, ...getAuthHeaders() },
      body: JSON.stringify({}),
    });
  }

  /** Raw `POST {baseUrl}/question/{reqID}/reply` with `{ answers }` as the JSON body. */
  replyQuestion(reqID: string, answers: string[][]): Promise<Response> {
    return fetch(`${this.baseUrl}/question/${reqID}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": this.cwd, ...getAuthHeaders() },
      body: JSON.stringify({ answers }),
    });
  }

  /**
   * v1 `client.postSessionIdPermissionsPermissionId({ path: { id, permissionID }, body: { response } })`.
   * `decision` is sent as `body.response`. `message` has no v1 counterpart and is not sent.
   * The response is never read, so an error status is swallowed as before.
   */
  async replyPermission(options: {
    sessionID: string;
    permissionID: string;
    decision: PermissionDecision;
    message?: string;
  }): Promise<void> {
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: options.sessionID, permissionID: options.permissionID },
      body: { response: options.decision },
    });
  }

  /**
   * Forwards to `isSessionDescendant()` in `src/utils/session-ancestry.ts`.
   * The imported function is module-scoped, so the same name inside this method
   * body refers to that import, not to this method.
   */
  isSessionDescendant(candidateSessionID: string, ancestorSessionID: string): Promise<boolean> {
    return isSessionDescendant(candidateSessionID, ancestorSessionID, this.baseUrl, this.cwd);
  }

  /** v1 has no location route, so there is nothing to check. Resolves without a request. */
  checkLocation(_directory: string): Promise<void> {
    return Promise.resolve();
  }

  /** v1 `client.global.event({})`; the caller reads `.stream` from the result. */
  subscribeEvents(): ReturnType<V1Client["global"]["event"]> {
    return this.client.global.event({});
  }

  /**
   * C2.3a: v1 has no forms (its question prompts go through `listQuestions`). Resolves an empty list,
   * so the caller finds nothing to show. Added to the seam for V2Backend. No v1 request is sent.
   */
  listForms(_sessionID: string): Promise<BackendForm[] | undefined> {
    return Promise.resolve([]);
  }

  /**
   * C2.3a: v1 has no forms, so there is nothing to reply to. No request is sent.
   * Added to the seam for V2Backend.
   */
  replyForm(_sessionID: string, _formID: string, _answer: FormAnswer): Promise<void> {
    return Promise.resolve();
  }

  /**
   * C2.6b: v1 has no forms, so there is nothing to cancel. No request is sent.
   */
  cancelForm(_sessionID: string, _formID: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * C2.6b: v1 never emits `resync-needed`, so the handler that calls this never runs on v1. Resolves
   * `undefined` ("unknown") and sends no request. See `Backend.isSessionActive` in types.ts.
   */
  isSessionActive(_sessionID: string): Promise<boolean | undefined> {
    return Promise.resolve(undefined);
  }

  // Legacy: v1 has no API channel for the orchestra state, so it is read from oconona's sidecar
  // files on octmux's own disk (src/backend/v1-orchestra.ts). Works only with a same-host server.
  private readonly orchestraReader = new V1OrchestraFileReader(() => this.session.list());

  getOrchestraState(sessionID: string): Promise<OrchestraState | null> {
    return this.orchestraReader.read(sessionID);
  }
}
