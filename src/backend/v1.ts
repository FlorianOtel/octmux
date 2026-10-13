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

import type { Backend, BackendEvents, BackendSession, V1Client } from "./types.ts";
import type { Renderer } from "../renderer/types.ts";
import type { LineEditor } from "../editor.ts";
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
import { replaySession } from "../replay.ts";
import { isSessionDescendant } from "../utils/session-ancestry.ts";

/**
 * Backend over the v1 SDK client plus the raw HTTP endpoints octmux still calls
 * directly (question/permission lists and replies).
 */
export class V1Backend implements Backend {
  /** Session-scoped REST operations, each forwarding to `this.client.session.*`. */
  readonly session: BackendSession;

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
    this.session = {
      getMessages: (options) => this.client.session.messages(options),
      getChildren: (options) => this.client.session.children(options),
      get: (options) => this.client.session.get(options),
      abort: (options) => this.client.session.abort(options),
      create: (options) => this.client.session.create(options),
      compact: (options) => this.client.session.summarize(options),
      list: () => this.client.session.list(),
      fork: (options) => this.client.session.fork(options),
      update: (options) => this.client.session.update(options),
      sendCommand: (options) => this.client.session.command(options),
      sendPrompt: (options) => this.client.session.promptAsync(options),
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

  /** v1 `client.postSessionIdPermissionsPermissionId(...)`. */
  replyPermission(
    options: Parameters<V1Client["postSessionIdPermissionsPermissionId"]>[0],
  ): ReturnType<V1Client["postSessionIdPermissionsPermissionId"]> {
    return this.client.postSessionIdPermissionsPermissionId(options);
  }

  /**
   * Forwards to `isSessionDescendant()` in `src/utils/session-ancestry.ts`.
   * The imported function is module-scoped, so the same name inside this method
   * body refers to that import, not to this method.
   */
  isSessionDescendant(candidateSessionID: string, ancestorSessionID: string): Promise<boolean> {
    return isSessionDescendant(candidateSessionID, ancestorSessionID, this.baseUrl, this.cwd);
  }

  /** v1 `client.global.event({})`; the caller reads `.stream` from the result. */
  subscribeEvents(): ReturnType<V1Client["global"]["event"]> {
    return this.client.global.event({});
  }

  /**
   * Forwards to `replaySession()` in `src/replay.ts`, which still takes the raw client.
   * Behaviour is unchanged: that function calls `client.session.messages` internally.
   */
  replaySession(renderer: Renderer, sessionID: string, editor: LineEditor): Promise<void> {
    return replaySession(this.client, renderer, sessionID, editor);
  }
}
