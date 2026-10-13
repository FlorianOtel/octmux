/**
 * V2Backend — the `Backend` implementation for the OpenCode v2 wire protocol (Stage 15.2, C2.3a).
 *
 * This file covers the REST surface, the four read-only `events.*` queries added in C2.3b
 * (history, pending tools, latest assistant activity, token usage; see src/backend/v2-queries.ts), and
 * the live translator members, which forward to `V2EventTranslator` (C2.4a; see src/backend/v2-events.ts).
 * `src/index.tsx` selects V2Backend when protocol detection (`src/protocol-detect.ts`) reports v2, and V1Backend otherwise.
 *
 * Endpoint and body shapes come from `docs/OpenCode-v2-protocol-capture.md` §4 and §5. Each method's
 * comment names the row it follows.
 *
 * Every REST call goes through the `@opencode/client` SDK, not raw `fetch()`. The SDK adds the
 * `location` and `directory` parameters that v2 needs, so there is no `x-opencode-directory`
 * header here (that header is a v1 gate only).
 */

import {
  ClientError,
  OpenCode,
  type FormInfo,
  type ModelInfo,
  type OpenCodeClient,
  type PermissionRequest,
  type SessionInfo,
  type SessionMessageInfo,
  type V2Event,
} from "@opencode/client";
import type { Command } from "@opencode-ai/sdk/client";
import { getAuthHeaders } from "../auth-headers.ts";
import type { FormField, ReplEvent } from "../events.ts";
import { V2EventTranslator } from "./v2-events.ts";
import type {
  Backend,
  BackendEvents,
  BackendForm,
  BackendSession,
  FormAnswer,
  ModelRef,
  OrchestraState,
  PermissionDecision,
  ProviderCatalog,
  ProviderModelEntry,
  SessionRecord,
} from "./types.ts";
import { isSessionDescendantV2, type AncestryCache, type SessionParentLookup } from "./v2-ancestry.ts";
import { parseOrchestraMetadata } from "./v2-orchestra.ts";
import {
  fetchHistoryV2,
  fetchMissedHistoryV2,
  queryHasPendingToolCallsV2,
  queryLatestAssistantActivityV2,
  queryTokenUsageV2,
} from "./v2-queries.ts";

/**
 * Result of one SDK call. An error status is a value (`ok: false`), not a throw, because the
 * BackendSession convention resolves `undefined` or `void` for error statuses.
 */
type CallOutcome<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs one SDK call and converts an error status into `{ ok: false }`.
 *
 * Only a `Transport` failure (the fetch itself rejected) is rethrown, as the BackendSession convention
 * requires. Every other SDK error is an error status here. That covers `UnexpectedStatus` (non-2xx)
 * and the declared typed errors, which the SDK throws as `Error`s carrying a `_tag`.
 *
 * Keep the call narrow: wrap only the SDK call, not the mapping that follows it, so that a bug in the
 * mapping is not silently reported as an error status.
 */
async function attempt<T>(call: () => Promise<T>): Promise<CallOutcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (err instanceof ClientError && err.reason === "Transport") throw err;
    return { ok: false };
  }
}

/**
 * The config-file hint used in the `LocationNotFoundError` message when the constructor gets no
 * `configHint`. It names the file octmux reads `server.directory` from.
 */
export const DEFAULT_CONFIG_HINT = "~/.config/octmux/octmux.json";

/** Prefix the server puts in front of the missing directory in a `LocationNotFoundError` message. */
const LOCATION_NOT_FOUND_PREFIX = "Location not found: ";

/**
 * Turns one failed write call into the `Error` that a write operation rejects with.
 *
 * - A declared typed error (the SDK copies the response body onto the `Error`, so it has a `_tag`)
 *   becomes `"<_tag>: <message>"`. For `LocationNotFoundError` the message is replaced by the
 *   config hint, which names the directory the server could not find.
 * - A non-2xx status with no declared body becomes `"OpenCode server returned HTTP <status>"`.
 * - Any other SDK failure becomes `"OpenCode request failed (<reason>)"`, or its own message.
 *
 * Only the `_tag`, the `message` and the status reach the text. Headers and the rest of the response
 * body are never included, so credentials cannot leak into the UI.
 *
 * Transport failures are not formatted here. The caller rethrows them unchanged.
 */
function formatWriteError(err: unknown, cwd: string, configHint: string): Error {
  if (err instanceof ClientError) {
    if (err.reason === "UnexpectedStatus") {
      const status = (err.cause as { status?: unknown } | undefined)?.status;
      return new Error(`OpenCode server returned HTTP ${String(status)}`);
    }
    return new Error(`OpenCode request failed (${err.reason})`);
  }
  if (err instanceof Error) {
    const tag = (err as { _tag?: unknown })._tag;
    if (typeof tag === "string") {
      if (tag === "LocationNotFoundError") {
        // The server's message is "Location not found: <dir>". Fall back to the backend's cwd if the shape differs.
        const dir = err.message.startsWith(LOCATION_NOT_FOUND_PREFIX)
          ? err.message.slice(LOCATION_NOT_FOUND_PREFIX.length)
          : cwd;
        return new Error(
          `${tag}: the OpenCode server has no directory ${dir} — set server.directory in ${configHint} to the server-side path`,
        );
      }
      return new Error(err.message ? `${tag}: ${err.message}` : tag);
    }
    return new Error(`OpenCode request failed: ${err.message}`);
  }
  return new Error("OpenCode request failed");
}

/**
 * Collects every page of a cursor-paged list.
 *
 * The first call gets `undefined` and is the caller's first page. Each later call gets the previous
 * page's `cursor.next`. The loop stops when `next` is absent or was already seen. The seen-set guards
 * against a server that repeats a cursor and would otherwise loop forever.
 *
 * The caller is responsible for not putting `order` next to a cursor. Capture §4.11 shows that the
 * server rejects that combination with `InvalidCursorError`.
 */
async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ data: T[]; cursor: { next?: string | null } }>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.data);
    const next = page.cursor.next ?? undefined;
    if (next === undefined || seen.has(next)) return items;
    seen.add(next);
    cursor = next;
  }
}

/** A JSON `Response` with status 200, as the v1 raw endpoints return. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Reshapes one v2 session record into the flat `SessionRecord` that octmux's call sites read.
 *
 * - `location.directory` becomes `directory`. This is the reshape that keeps `orchestra-watch.ts`
 *   (`s.directory`) working unchanged.
 * - `parentID` is kept only when present, since top-level sessions have none.
 * - `model` keeps only `providerID` and `id`. The v2 `variant` is dropped, as `SessionRecord` has no field for it.
 * - `title` falls back to `""`, because the v2 type marks `title` optional.
 */
export function toSessionRecord(info: SessionInfo): SessionRecord {
  return {
    id: info.id,
    ...(info.parentID !== undefined ? { parentID: info.parentID } : {}),
    directory: info.location.directory,
    title: info.title ?? "",
    time: { updated: info.time.updated },
    ...(info.model !== undefined ? { model: { providerID: info.model.providerID, id: info.model.id } } : {}),
  };
}

/**
 * Maps one SDK form field onto the `FormField` shape from `src/events.ts`.
 *
 * The SDK field is a discriminated union whose `title` is optional. The `FormField` type in
 * `src/events.ts` requires `title`, so `title` falls back to the field key. `options` and `custom`
 * are copied only when the SDK variant has them (string and multiselect fields do).
 */
function toFormField(field: FormInfo["fields"][number]): FormField {
  const options =
    "options" in field && field.options !== undefined
      ? field.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
        }))
      : undefined;
  return {
    key: field.key,
    title: field.title ?? field.key,
    type: field.type,
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(options !== undefined ? { options } : {}),
    ...("custom" in field && field.custom !== undefined ? { custom: field.custom } : {}),
  };
}

/**
 * Reshapes one v2 form into the `BackendForm` the seam exposes.
 */
function toBackendForm(form: FormInfo): BackendForm {
  return { id: form.id, sessionID: form.sessionID, title: form.title, fields: form.fields.map(toFormField) };
}

/**
 * Reshapes one v2 pending permission into the v1 `GET /permission` item shape. The discovery pass in
 * `src/app.tsx` parses that shape: `id`, `sessionID`, `permission` (the action) and `patterns` (the resources).
 * `resources` can hold several entries, one per part of a compound command.
 */
export function toV1PermissionShape(request: PermissionRequest): { id: string; sessionID: string; permission: string; patterns: string[] } {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: [...request.resources],
  };
}

/**
 * Builds the v1-shaped provider catalog from the flat v2 `model.list()`.
 *
 * `all` groups the models by `providerID`. Each model is keyed by `id` (`ModelInfo.id`, the short name such as
 * `glm-5.3-flash`), and `tool_call` comes from `capabilities.tools`. Octmux identifies a model by `id` everywhere:
 * the catalog key, the entry `id`, the default model, and the `switchModel` body. `ModelInfo.modelID` is the
 * upstream API name (for example `ollama-cloud/glm-5.3-flash`). It is not used, and two models can share one.
 * Keying by `id` keeps such models distinct.
 *
 * DECISION, "connected": `ModelInfo` carries no connected or credentials flag. Its only related fields
 * are `enabled` and `status`, and neither says whether the provider can be used. The one route that
 * reports provider activation is `/api/provider`, and that route is forbidden because it returns
 * plaintext API keys. So every provider that `model.list()` returns is treated as connected.
 * `enabled` is not filtered on. This is the default the C2.3a brief named, and it is open for
 * live verification in C2.9 (PLAN-C2C3.md §G).
 */
export function toProviderCatalog(infos: ModelInfo[]): ProviderCatalog {
  const byProvider = new Map<string, Record<string, ProviderModelEntry>>();
  for (const info of infos) {
    const models = byProvider.get(info.providerID) ?? {};
    models[info.id] = {
      id: info.id,
      name: info.name,
      limit: { context: info.limit.context },
      tool_call: info.capabilities.tools,
    };
    byProvider.set(info.providerID, models);
  }
  const all = [...byProvider].map(([id, models]) => ({ id, models }));
  // Every provider in `all` is listed as connected. See the DECISION note above.
  return { all, connected: all.map((provider) => provider.id) };
}

/**
 * Wraps each v2 frame as `{ payload: frame }`. The v1 consumers in `src/app.tsx` read
 * `.payload` from each item of `.stream`, so the v2 frames take the same outer shape.
 */
async function* wrapFrames(frames: AsyncIterable<V2Event>): AsyncGenerator<{ payload: unknown }> {
  for await (const frame of frames) {
    yield { payload: frame };
  }
}

/**
 * Backend over the `@opencode/client` v2 SDK.
 *
 * The constructor takes the client as an optional third argument. Production code omits it, so the
 * real client is built from `baseUrl` and the auth headers. The tests pass a fake client through it.
 */
export class V2Backend implements Backend {
  /** Session-scoped REST operations (see `BackendSession`). */
  readonly session: BackendSession;

  /** Event-pipeline members. The four queries are C2.3b. The translator members are C2.4a (`src/backend/v2-events.ts`). */
  readonly events: BackendEvents;

  /**
   * The v2 event translator for this backend. One per instance, so no state is shared between backends (P6).
   * `resetEventState` clears it.
   */
  private readonly translator = new V2EventTranslator();

  /** Per-session model last sent with `switchModel`. Lets `setModel` skip an unchanged model. */
  private readonly lastModelBySession = new Map<string, ModelRef>();

  /** TTL cache for `isSessionDescendant`. See `src/backend/v2-ancestry.ts`. */
  private readonly ancestryCache: AncestryCache = new Map();

  /**
   * @param baseUrl - OpenCode daemon base URL.
   * @param cwd     - Working directory. Sent as the `location` (or `directory`) parameter on the
   *                  endpoints that take one, so v2 results are scoped to the same project as v1.
   * @param client  - Optional SDK client. Production omits it. Tests pass a fake.
   * @param configHint - Config-file path named in the `LocationNotFoundError` message, so the operator
   *                  knows where to set `server.directory`. Defaults to `DEFAULT_CONFIG_HINT`.
   */
  constructor(
    baseUrl: string,
    private readonly cwd: string,
    private readonly client: OpenCodeClient = OpenCode.make({ baseUrl, headers: getAuthHeaders() }),
    private readonly configHint: string = DEFAULT_CONFIG_HINT,
  ) {
    this.session = {
      // --- Read-style operations. Resolve `undefined` on an error status. ---

      // capture §5 `/api/session/{id}` GET. Single session record.
      get: async (sessionID) => {
        const outcome = await attempt(() => this.client.session.get({ sessionID }));
        return outcome.ok ? toSessionRecord(outcome.value) : undefined;
      },

      // capture §5 `/api/session` GET, filtered by `directory` (the SDK `SessionListInput.directory`
      // query). Pages are followed by cursor. The filter is repeated on every page, so the cursor
      // never stands alone without the scope (see the C2.5 live check).
      list: async () => {
        const outcome = await attempt(() =>
          collectPages((cursor) =>
            this.client.session.list({ directory: this.cwd, ...(cursor !== undefined ? { cursor } : {}) }),
          ),
        );
        return outcome.ok ? outcome.value.map(toSessionRecord) : undefined;
      },

      // --- Creation and forking. Write operations: an error status rejects (see `BackendSession`). ---

      // capture §5 `/api/session` POST. The directory goes in `location`, not a flat `directory`.
      create: async ({ directory }) => {
        const created = await this.write(() => this.client.session.create({ location: { directory } }));
        return toSessionRecord(created);
      },

      // Fork. v2 `session.fork` takes only `sessionID` (and `before`). It has no `directory` input,
      // so `options.directory` cannot be honoured. The fork keeps the parent's location. See the C2.3a report.
      fork: async (sessionID) => {
        const forked = await this.write(() => this.client.session.fork({ sessionID }));
        return toSessionRecord(forked);
      },

      // --- Void-style write operations. An error status rejects (see `BackendSession`). ---

      // SDK `session.update` with `title`. No capture §5 row covers it, so it is unverified against a live server.
      update: async (sessionID, options) => {
        await this.write(() => this.client.session.update({ sessionID, title: options.title }));
      },

      // capture §5 `/api/session/{id}/interrupt` POST. Body `{interrupted: boolean}`. An error
      // status reports `interrupted: false`.
      abort: async (sessionID) => {
        const outcome = await attempt(() => this.client.session.interrupt({ sessionID }));
        return { interrupted: outcome.ok ? outcome.value.interrupted : false };
      },

      // capture §5 `/api/session/{id}/compact` POST, body `{}`. v2 takes no model, so the `model`
      // argument is unused here. The v1 backend uses it. See `BackendSession.compact`.
      compact: async (sessionID) => {
        await this.write(() => this.client.session.compact({ sessionID }));
      },

      // capture §5 `/api/session/{id}/prompt` POST. The client `id` is `promptID` (capture §5, row
      // "client-supplied id"). When `model` is given, `ensureModel` runs first. v2 has no per-prompt
      // model override (capture §4.3).
      sendPrompt: async (options) => {
        if (options.model) await this.ensureModel(options.sessionID, options.model);
        await this.write(() =>
          this.client.session.prompt({
            sessionID: options.sessionID,
            text: options.text,
            ...(options.promptID !== undefined ? { id: options.promptID } : {}),
          }),
        );
      },

      // capture §5 `/api/session/{id}/command` POST, body `{name, text}`. `args` goes in `text`.
      // v2 has no client-side id for commands, so `promptID` is dropped (the request has no field for
      // it). The expanded template comes back as an ordinary `user` item (capture §4.12). The
      // ownership check for command echoes is handled in the translator (C2.4), not here.
      // The echo slot is armed by the caller before this call. If `ensureModel` or the POST fails, no echo
      // arrives, so this method releases the slot and rethrows the same error unchanged.
      sendCommand: async (options) => {
        try {
          if (options.model) await this.ensureModel(options.sessionID, options.model);
          await this.write(() =>
            this.client.session.command({ sessionID: options.sessionID, name: options.name, text: options.args }),
          );
        } catch (err) {
          this.translator.releaseCommandEcho();
          throw err;
        }
      },

      // Session-level model select. The SDK `session.switchModel` is the v2 route. See `ensureModel`.
      setModel: async (sessionID, model) => {
        await this.ensureModel(sessionID, model);
      },
    };

    this.events = {
      // --- C2.3b: the four read-only queries below read the session's message and children lists through
      // this backend's fetchers, then run the pure functions in src/backend/v2-queries.ts. ---
      hasPendingToolCalls: (sessionID) => queryHasPendingToolCallsV2((id) => this.fetchMessages(id), sessionID),
      getLatestAssistantActivity: (sessionID) =>
        queryLatestAssistantActivityV2((id) => this.fetchMessages(id), sessionID, Date.now()),
      getTokenUsage: (sessionID) =>
        queryTokenUsageV2((id) => this.fetchMessages(id), (id) => this.fetchChildren(id), sessionID),
      // D-A fix: every message the replay returns is recorded as rendered, so a later resync does not render it again.
      getHistory: (sessionID) =>
        fetchHistoryV2((id) => this.fetchMessages(id), sessionID, (messages) =>
          this.translator.markRendered(messages.map((message) => message.id)),
        ),

      // D-A fix: the resync path. Renders only the complete messages the translator has not rendered, and records them.
      // The predicate returns true when the item is already shown or suppressed, so the item is skipped.
      // A user item is claimed with `claimUserItem`, the same rule the live inbox path uses. Its command echo slot is
      // consumed here, so a command echo seen only through resync does not leave a slot pending. The claim has side
      // effects, which is safe: `translateMissedHistoryV2` calls the predicate only for complete renderable items
      // (`isCompleteRenderable(...) && !isRendered(...)`, v2-queries.ts), so an in-flight item is never claimed.
      // Other kinds use `isRendered`, which is side-effect free. `message.text` is a required string on user items.
      getMissedHistory: async (sessionID) => {
        const missed = await fetchMissedHistoryV2((id) => this.fetchMessages(id), sessionID, (message) =>
          message.type === "user"
            ? this.translator.claimUserItem(message.id, message.text)
            : this.translator.isRendered(message.id),
        );
        this.translator.markRendered(missed.renderedIDs);
        return missed.ops;
      },

      // --- C2.4a: the translator members forward to this backend's own V2EventTranslator (src/backend/v2-events.ts).
      // Each backend has its own instance, so no state is shared between backends (P6). ---
      translateEvent: (event, sessionID) => this.translateAndTrackModel(event, sessionID),
      resetEventState: () => this.translator.resetEventState(),
      synthesizeSessionIdleEvents: () => this.translator.synthesizeSessionIdleEvents(),
      hasOpenStreamingPart: () => this.translator.hasOpenStreamingPart(),
      recordOwnMessageID: (id) => this.translator.recordOwnMessageID(id),
      recordOwnCommandPrefix: (prefix) => this.translator.recordOwnCommandPrefix(prefix),
      classifyUserTurn: (messageID) => this.translator.classifyUserTurn(messageID),
    };
  }

  /**
   * Every message of a session, oldest first, paged to the end. capture §5 `/api/session/{id}/message`
   * GET. The first page sets `order: "asc"` (as the v1 list is). Later pages send `cursor` alone,
   * because the cursor encodes its own order and direction. `order` plus `cursor` is an
   * InvalidCursorError (capture §4.11).
   *
   * NOT part of the `Backend` seam. `V1BackendSession.getMessages` has the v1 element type, and
   * the only consumer of the list is v1-queries. The C2.3b v2 queries and history (src/backend/v2-queries.ts) call this method through the fetchers in `events`.
   * Resolves `undefined` on an error status.
   */
  async fetchMessages(sessionID: string): Promise<SessionMessageInfo[] | undefined> {
    const outcome = await attempt(() =>
      collectPages<SessionMessageInfo>((cursor) =>
        cursor === undefined
          ? this.client.message.list({ sessionID, order: "asc" })
          : this.client.message.list({ sessionID, cursor }),
      ),
    );
    return outcome.ok ? outcome.value : undefined;
  }

  /**
   * Direct child sessions of `sessionID`. capture §5 `/api/session?parentID` GET, with cursor paging.
   *
   * NOT part of the `Backend` seam (see `fetchMessages`). Resolves `undefined` on an error status.
   */
  async fetchChildren(sessionID: string): Promise<SessionRecord[] | undefined> {
    const outcome = await attempt(() =>
      collectPages((cursor) =>
        this.client.session.list({ parentID: sessionID, ...(cursor !== undefined ? { cursor } : {}) }),
      ),
    );
    return outcome.ok ? outcome.value.map(toSessionRecord) : undefined;
  }

  /**
   * Sends `switchModel` only when the session's last-known model differs from `model`.
   *
   * This keeps a per-turn model from producing a `model.selected` event, and so a "model set" system
   * message, on every prompt. The map starts empty, so the first call per session always sends.
   *
   * A failed call rejects (see `write`) and is not recorded, so the next call tries again.
   *
   * The model is identified by `ModelInfo.id` (for example `glm-5.3-flash`), which is what `switchModel`
   * takes as `model.id`. `ModelRef.modelID` carries that value here, because `listProviders` keys the
   * catalog by `id`. `ModelInfo.modelID` is the upstream API name, and octmux does not use it.
   */
  private async ensureModel(sessionID: string, model: ModelRef): Promise<void> {
    const last = this.lastModelBySession.get(sessionID);
    if (last && last.providerID === model.providerID && last.modelID === model.modelID) return;

    await this.write(() =>
      this.client.session.switchModel({
        sessionID,
        model: { id: model.modelID, providerID: model.providerID },
      }),
    );
    this.lastModelBySession.set(sessionID, { providerID: model.providerID, modelID: model.modelID });
  }

  /**
   * Translates one frame, and records any `model-selected` event in the setModel cache.
   *
   * The server binds the model per session. A switch made by another client (a foreign REST call) reaches
   * here as `session.model.selected`. Without this, the cache keeps the old model, and a later select of
   * that old model would skip `switchModel` while the server is on another model.
   *
   * The result is returned unchanged, in the same shape the translator gave it (null, one event, or a list).
   */
  private translateAndTrackModel(frame: unknown, sessionID: string): ReplEvent | ReplEvent[] | null {
    const result = this.translator.translate(frame, sessionID);
    // Normalise to a list only for the scan. The original value is what gets returned.
    const events = result === null ? [] : Array.isArray(result) ? result : [result];
    for (const ev of events) {
      if (ev.kind === "model-selected") {
        this.lastModelBySession.set(ev.sessionID, { providerID: ev.providerID, modelID: ev.modelID });
      }
    }
    return result;
  }

  /**
   * Runs one write SDK call. A write operation rejects on an error status, so the caller can show why.
   *
   * A transport failure is rethrown as it is, as the BackendSession convention requires. Every other
   * SDK failure is converted by `formatWriteError` into an `Error` with a short, human-readable message.
   * Keep the call narrow: wrap only the SDK call, not the code that uses its result.
   */
  private async write<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof ClientError && err.reason === "Transport") throw err;
      throw formatWriteError(err, this.cwd, this.configHint);
    }
  }

  /**
   * v1 `client.command.list()` equivalent. capture §5 `/api/command` GET, scoped by the `location`
   * parameter. The v2 entries carry only `name` and `description`. Each one is mapped to the
   * v1 `Command` type, which app.tsx's opencodeCommands Map is typed with.
   *
   * `template: ""` is a placeholder. A v2 command is expanded by the server (capture §4.12), and
   * octmux never reads `template` on the v2 path. Nothing in app.tsx reads `template` either.
   */
  async listCommands(): Promise<{ data?: Command[] }> {
    const outcome = await attempt(() => this.client.command.list({ location: { directory: this.cwd } }));
    if (!outcome.ok) return {};
    return {
      data: outcome.value.data.map((entry) => ({
        name: entry.name,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        template: "",
      })),
    };
  }

  /**
   * `{ data: { model: "providerID/id" } }` from `model.default()`, the shape `formatters.getDefaultModel` reads.
   * The model part is `ModelInfo.id`, the same value the catalog is keyed by (see `toProviderCatalog`).
   *
   * SECURITY: the raw response carries `settings.apiKey`. This method reads the two IDs and drops the
   * rest. Nothing is logged or kept. Do not change it to pass the response through.
   */
  async getDefaultModelConfig(): Promise<{ data?: { model?: string } }> {
    const outcome = await attempt(() => this.client.model.default({ location: { directory: this.cwd } }));
    if (!outcome.ok || outcome.value.data === null) return {};
    const { providerID, id } = outcome.value.data;
    return { data: { model: `${providerID}/${id}` } };
  }

  /**
   * The v1-shaped provider catalog, built from `model.list()`. Never calls `/api/provider`, which
   * returns plaintext API keys. See `toProviderCatalog` for the "connected" decision.
   */
  async listProviders(): Promise<{ data?: ProviderCatalog }> {
    const outcome = await attempt(() => this.client.model.list({ location: { directory: this.cwd } }));
    if (!outcome.ok) return {};
    return { data: toProviderCatalog(outcome.value.data) };
  }

  /**
   * v2 has no question endpoint; questions are forms (`listForms`). Resolves an empty list, so the
   * discovery pass in app.tsx finds nothing and runs unchanged.
   */
  listQuestions(): Promise<Response> {
    return Promise.resolve(jsonResponse([]));
  }

  /**
   * The v1 `GET /permission` shape, built from the location-scoped v2 list
   * (`GET /api/permission/request?location[directory]`, capture §4.7 and §5).
   *
   * DECISION (P1): this uses the location route, not the per-session route. The discovery pass in
   * `src/app.tsx` already keeps only the current session and its descendants (`isSessionDescendant`).
   * So the list does not need to know the current session, and no `setCurrentSessionID` hook is needed.
   *
   * OPEN: capture §4.7 does not establish whether a child session's ask appears in the parent's
   * list. Child sessions share the directory, so the location route is expected to include them.
   * That is checked in the C2.5 live run.
   *
   * An error status returns a non-ok Response, so discovery skips the pass, as it does for v1.
   */
  async listPermissions(): Promise<Response> {
    const outcome = await attempt(() => this.client.permission.request.list({ location: { directory: this.cwd } }));
    if (!outcome.ok) return new Response(null, { status: 500 });
    return jsonResponse(outcome.value.data.map(toV1PermissionShape));
  }

  /** v2 has no question reject. A no-op response, so the caller's `ok` check passes. */
  rejectQuestion(_reqID: string): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  /** v2 has no question reply. A no-op response. Questions are answered through `replyForm`. */
  replyQuestion(_reqID: string, _answers: string[][]): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  /**
   * capture §4.7 and §5 `/api/session/{id}/permission/{requestID}/reply` POST, body `{decision, message?}`.
   * The `message` is sent only when given. A rejection with a message is the only case that carries one.
   */
  async replyPermission(options: {
    sessionID: string;
    permissionID: string;
    decision: PermissionDecision;
    message?: string;
  }): Promise<void> {
    await this.write(() =>
      this.client.permission.reply({
        sessionID: options.sessionID,
        requestID: options.permissionID,
        decision: options.decision,
        ...(options.message !== undefined ? { message: options.message } : {}),
      }),
    );
  }

  /**
   * capture §5 `/api/session/{id}/form` GET (pending forms). Resolves `undefined` on an error status.
   */
  async listForms(sessionID: string): Promise<BackendForm[] | undefined> {
    const outcome = await attempt(() => this.client.session.form.list({ sessionID }));
    return outcome.ok ? outcome.value.map(toBackendForm) : undefined;
  }

  /**
   * capture §4.6 and §5 `/api/session/{id}/form/{formID}/reply` POST, body `{answer}`. Write, so an
   * error status rejects (see `BackendSession`).
   */
  async replyForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void> {
    await this.write(() => this.client.session.form.reply({ sessionID, formID, answer }));
  }

  /**
   * capture §5 `/api/session/{id}/form/{formID}/cancel` route, through the SDK `session.form.cancel`
   * (`node_modules/@opencode/client`, `SessionFormCancelInput`). The operator dismissed the form, so
   * the server closes it. Write, so an error status rejects, as with `replyForm`.
   *
   * The capture doc records no observed `form.cancelled` frame (§4.6), so this is unverified against a
   * live server (C2.6b live check).
   */
  async cancelForm(sessionID: string, formID: string): Promise<void> {
    await this.write(() => this.client.session.form.cancel({ sessionID, formID }));
  }

  /**
   * capture §5 `/api/session/active` GET (`GET /api/session/active`, `session.active()` in the SDK). The
   * response is a map keyed by session ID, and a running session has an entry (capture §5 rows for `/active`).
   * Resolves `true` when the session is in the map, `false` when it is not, and `undefined` on an error
   * status. The `undefined` case keeps the caller's current state, so a failed lookup changes nothing.
   *
   * A session whose user shell is still running may not appear in the map (capture §4.5, one sample only).
   */
  async isSessionActive(sessionID: string): Promise<boolean | undefined> {
    const outcome = await attempt(() => this.client.session.active());
    return outcome.ok ? Object.hasOwn(outcome.value, sessionID) : undefined;
  }

  /**
   * The orchestra run state, read over the API from the session's `metadata.orchestra`
   * (contract in src/backend/v2-orchestra.ts). `null` when absent, inactive, stale or unreadable.
   */
  async getOrchestraState(sessionID: string): Promise<OrchestraState | null> {
    const outcome = await attempt(() => this.client.session.get({ sessionID }));
    if (!outcome.ok) return null;
    const info = outcome.value;
    const model = info.model ? { providerID: info.model.providerID, id: info.model.id } : undefined;
    return parseOrchestraMetadata(info.metadata, model);
  }

  /**
   * Walks the parent chain using `session.get`, via `src/backend/v2-ancestry.ts`. Transport failures
   * are not rethrown here. A session that cannot be fetched ends the walk, as v1 does on a network error.
   */
  isSessionDescendant(candidateSessionID: string, ancestorSessionID: string): Promise<boolean> {
    return isSessionDescendantV2(candidateSessionID, ancestorSessionID, this.lookupParent, this.ancestryCache);
  }

  /** The parent-link lookup passed to the ancestry walk. `session.get`, with every failure mapped to `undefined`. */
  private readonly lookupParent: SessionParentLookup = async (sessionID) => {
    try {
      const outcome = await attempt(() => this.client.session.get({ sessionID }));
      return outcome.ok ? { parentID: outcome.value.parentID } : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Opens the v2 event stream (`GET /api/event`). Each frame is wrapped as `{ payload: frame }`, the
   * outer shape the v1 consumers read.
   */
  async subscribeEvents(): Promise<{ stream: AsyncIterable<{ payload: unknown }> }> {
    return { stream: wrapFrames(this.client.event.subscribe()) };
  }
}
