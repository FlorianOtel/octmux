/**
 * Tests for `V2Backend` (src/backend/v2.ts), the REST layer of the v2 backend (Stage 15.2, C2.3a).
 *
 * Each REST test asserts that one method calls the right SDK method with the right input. Test names
 * cite the row of `docs/OpenCode-v2-protocol-capture.md` §5 (or the §4.x subsection) it follows.
 *
 * The fake client is injected through `V2Backend`'s optional third constructor argument. Its shape is
 * the subset of `@opencode/client`'s `OpenCodeClient` that V2Backend calls. Each fake method records
 * `{ method, input }` into `calls` and returns a canned reply. A reply can be a value, or an `Error` that
 * the method throws. Production code never builds this fake, so the cast at the seam is test-only.
 */
import { describe, expect, test } from "bun:test";
import { ClientError, type OpenCodeClient } from "@opencode/client";
import { V2Backend, toProviderCatalog, toSessionRecord, toV1PermissionShape } from "./v2.ts";

// ─── Fake client ───

/** One recorded SDK call: the dotted method name and the input object it received. */
type Call = { method: string; input: unknown };

/** A canned reply: a value to resolve with, or an `Error` to reject with. */
type Reply = unknown;

/**
 * Builds a fake client. `replies` maps a dotted method name (e.g. `"session.get"`) to the reply that
 * method gives. Methods without a reply resolve `undefined`. `calls` records every invocation in order.
 */
function makeFake(replies: Record<string, Reply> = {}): { client: OpenCodeClient; calls: Call[] } {
  const calls: Call[] = [];
  /** Creates a recorded method for `name`. It resolves or rejects with the canned reply. */
  const method = (name: string) => async (input?: unknown) => {
    calls.push({ method: name, input });
    const reply = replies[name];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const client = {
    session: {
      get: method("session.get"),
      list: method("session.list"),
      create: method("session.create"),
      fork: method("session.fork"),
      update: method("session.update"),
      interrupt: method("session.interrupt"),
      compact: method("session.compact"),
      active: method("session.active"),
      prompt: method("session.prompt"),
      command: method("session.command"),
      switchModel: method("session.switchModel"),
      form: {
        list: method("session.form.list"),
        reply: method("session.form.reply"),
        cancel: method("session.form.cancel"),
      },
    },
    message: { list: method("message.list") },
    location: { get: method("location.get") },
    project: { list: method("project.list") },
    model: { list: method("model.list"), default: method("model.default") },
    command: { list: method("command.list") },
    permission: {
      request: { list: method("permission.request.list") },
      reply: method("permission.reply"),
    },
    event: {
      subscribe: (_options?: unknown) => {
        calls.push({ method: "event.subscribe", input: undefined });
        return asyncFrames(replies["event.subscribe"] as unknown[] | undefined);
      },
    },
    // Deliberately absent: `provider` (the /api/provider route, forbidden) and `server`.
    // Any call to a missing member throws a TypeError, so such a call fails the test.
  };
  return { client: client as unknown as OpenCodeClient, calls };
}

/** Yields each frame of a canned list, in order. */
async function* asyncFrames(frames: unknown[] | undefined): AsyncGenerator<unknown> {
  for (const frame of frames ?? []) yield frame;
}

/** A v2 session record, shaped as the SDK returns it (`location` nested, not flat `directory`). */
function v2Session(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_parent",
    projectID: "proj_1",
    cost: 0,
    tokens: {},
    title: "parent title",
    location: { directory: "/work/project" },
    time: { created: 1, updated: 99 },
    ...overrides,
  };
}

/** A status error as the SDK throws it for a non-2xx response (`UnexpectedStatus`). */
function statusError(status: number): ClientError {
  return new ClientError("UnexpectedStatus", { cause: { status }, detail: String(status) });
}

/** A transport error as the SDK throws when the fetch itself rejects. */
function transportError(): ClientError {
  return new ClientError("Transport", { cause: new TypeError("fetch failed") });
}

/**
 * A declared typed error as the SDK throws it (`declared()` in `@opencode/client`): the response body is
 * copied onto an `Error`, its `message` is the message, and its `_tag` is the name.
 */
function declaredError(body: Record<string, unknown>): Error {
  const error = Object.assign(new Error(String(body.message)), body);
  error.name = String(body._tag);
  return error;
}

/** Resolves to the message of the rejection, and fails the test if the promise resolves. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const CWD = "/work/project";
const BASE = "http://127.0.0.1:4096";

// ─── Pure helpers ───

describe("toSessionRecord (capture §5 session record shape)", () => {
  test("flattens location.directory into the flat directory field", () => {
    const record = toSessionRecord(v2Session() as never);
    expect(record.directory).toBe("/work/project");
    expect(record).not.toHaveProperty("location");
  });

  test("keeps parentID for a child session (capture §4.9 child creation)", () => {
    const record = toSessionRecord(v2Session({ id: "ses_child", parentID: "ses_parent" }) as never);
    expect(record.parentID).toBe("ses_parent");
  });

  test("omits parentID for a top-level session", () => {
    const record = toSessionRecord(v2Session() as never);
    expect(record).not.toHaveProperty("parentID");
  });

  test("reshapes the model ref to {providerID, id} and drops the variant", () => {
    const record = toSessionRecord(
      v2Session({ model: { id: "glm-5.3-flash", providerID: "sohoai", variant: "default" } }) as never,
    );
    expect(record.model).toEqual({ providerID: "sohoai", id: "glm-5.3-flash" });
  });

  test("omits model when the session has none bound", () => {
    expect(toSessionRecord(v2Session() as never)).not.toHaveProperty("model");
  });

  test("falls back to an empty title when the v2 title is absent", () => {
    const record = toSessionRecord(v2Session({ title: undefined }) as never);
    expect(record.title).toBe("");
  });

  test("keeps time.updated", () => {
    expect(toSessionRecord(v2Session() as never).time).toEqual({ updated: 99 });
  });
});

describe("toV1PermissionShape (capture §4.7 request frame and list)", () => {
  test("maps action to permission and resources to patterns, keeping every resource", () => {
    // The compound command `sleep 20 && echo finished` raised one ask with two resources (capture §4.7).
    const shaped = toV1PermissionShape({
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["sleep 20", "echo finished"],
      save: ["sleep *", "echo *"],
    } as never);
    expect(shaped).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      permission: "shell",
      patterns: ["sleep 20", "echo finished"],
    });
  });
});

describe("toProviderCatalog (capture §5 /api/model/default row, ModelInfo shape)", () => {
  const modelInfo = (providerID: string, modelID: string, context: number, tools: boolean) => ({
    id: modelID,
    modelID,
    providerID,
    name: `${modelID} display`,
    limit: { context, output: 1000 },
    capabilities: { tools, input: ["text"], output: ["text"] },
    enabled: true,
    status: "active",
  });

  test("groups models by provider into the v1 all[] dict shape, with limit.context and tool_call", () => {
    const catalog = toProviderCatalog([
      modelInfo("sohoai", "glm-5.3-flash", 128000, true) as never,
      modelInfo("sohoai", "glm-5.1", 200000, false) as never,
      modelInfo("anthropic", "claude-sonnet-4-6", 1000000, true) as never,
    ]);
    expect(catalog.all.map((p) => p.id)).toEqual(["sohoai", "anthropic"]);
    expect(Object.keys(catalog.all[0]!.models).sort()).toEqual(["glm-5.1", "glm-5.3-flash"]);
    expect(catalog.all[0]!.models["glm-5.3-flash"]).toEqual({
      id: "glm-5.3-flash",
      name: "glm-5.3-flash display",
      limit: { context: 128000 },
      tool_call: true,
    });
    expect(catalog.all[0]!.models["glm-5.1"]!.tool_call).toBe(false);
  });

  test("treats every provider in the list as connected (no connected signal in ModelInfo)", () => {
    const catalog = toProviderCatalog([
      modelInfo("sohoai", "glm-5.1", 1, true) as never,
      modelInfo("anthropic", "claude-sonnet-4-6", 1, true) as never,
    ]);
    expect(catalog.connected).toEqual(["sohoai", "anthropic"]);
  });

  // D2: octmux identifies a model by ModelInfo.id. The upstream modelID (e.g. "ollama-cloud/glm-5.3-flash") is not used.
  test("keys each model by id, not by the upstream modelID (D2)", () => {
    const catalog = toProviderCatalog([
      { ...modelInfo("sohoai", "glm-5.3-flash", 128000, true), modelID: "ollama-cloud/glm-5.3-flash" } as never,
    ]);
    expect(Object.keys(catalog.all[0]!.models)).toEqual(["glm-5.3-flash"]);
    expect(catalog.all[0]!.models["glm-5.3-flash"]!.id).toBe("glm-5.3-flash");
    expect(catalog.all[0]!.models["glm-5.3-flash"]!.name).toBe("glm-5.3-flash display");
  });

  // D2: two models that share one upstream modelID are distinct by id, so neither overwrites the other.
  test("keeps two models that share a modelID distinct, because they differ by id (D2)", () => {
    const catalog = toProviderCatalog([
      { ...modelInfo("sohoai", "model-a", 1000, true), modelID: "shared/upstream" } as never,
      { ...modelInfo("sohoai", "model-b", 2000, false), modelID: "shared/upstream" } as never,
    ]);
    expect(Object.keys(catalog.all[0]!.models).sort()).toEqual(["model-a", "model-b"]);
    expect(catalog.all[0]!.models["model-a"]!.limit).toEqual({ context: 1000 });
    expect(catalog.all[0]!.models["model-b"]!.limit).toEqual({ context: 2000 });
  });
});

// ─── Session REST operations ───

describe("V2Backend.session.get (capture §5 /api/session/{id} GET)", () => {
  test("calls session.get with sessionID and returns the flat record", async () => {
    const { client, calls } = makeFake({ "session.get": v2Session({ id: "ses_a" }) });
    const backend = new V2Backend(BASE, CWD, client);
    const record = await backend.session.get("ses_a");
    expect(calls).toEqual([{ method: "session.get", input: { sessionID: "ses_a" } }]);
    expect(record?.directory).toBe("/work/project");
  });

  test("resolves undefined on an error status (the convention for read-style calls)", async () => {
    const { client } = makeFake({ "session.get": statusError(404) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.session.get("ses_missing")).toBeUndefined();
  });

  test("rethrows a transport failure (the fetch itself rejected)", async () => {
    const { client } = makeFake({ "session.get": transportError() });
    const backend = new V2Backend(BASE, CWD, client);
    await expect(backend.session.get("ses_a")).rejects.toBeInstanceOf(ClientError);
  });
});

describe("V2Backend.session.list (capture §5 /api/session GET, directory scope)", () => {
  test("calls session.list scoped to the backend's directory, then follows cursors without order", async () => {
    const { client, calls } = makeFake({});
    // Two pages: the first returns a `next` cursor, the second ends the chain with `next: null`.
    let page = 0;
    (client as unknown as { session: { list: (i: unknown) => Promise<unknown> } }).session.list = async (input) => {
      calls.push({ method: "session.list", input });
      page++;
      return page === 1
        ? { data: [v2Session({ id: "ses_1" })], cursor: { next: "cur_2" } }
        : { data: [v2Session({ id: "ses_2" })], cursor: { next: null } };
    };
    const backend = new V2Backend(BASE, CWD, client);
    const records = await backend.session.list();
    expect(calls.map((c) => c.input)).toEqual([{ directory: CWD }, { directory: CWD, cursor: "cur_2" }]);
    expect(records?.map((r) => r.id)).toEqual(["ses_1", "ses_2"]);
  });

  test("resolves undefined on an error status", async () => {
    const { client } = makeFake({ "session.list": statusError(500) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.session.list()).toBeUndefined();
  });
});

describe("V2Backend.fetchChildren (internal, not on the seam; capture §5 /api/session?parentID row)", () => {
  test("calls session.list with the parentID filter and returns flat child records", async () => {
    const { client, calls } = makeFake({
      "session.list": { data: [v2Session({ id: "ses_child", parentID: "ses_parent" })], cursor: { next: null } },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const children = await backend.fetchChildren("ses_parent");
    expect(calls).toEqual([{ method: "session.list", input: { parentID: "ses_parent" } }]);
    expect(children?.[0]?.parentID).toBe("ses_parent");
  });
});

describe("V2Backend.session.create (capture §5 /api/session POST, location body)", () => {
  test("sends the directory in location, not as a flat directory field", async () => {
    const { client, calls } = makeFake({ "session.create": v2Session({ id: "ses_new" }) });
    const backend = new V2Backend(BASE, CWD, client);
    const record = await backend.session.create({ directory: "/work/other" });
    expect(calls).toEqual([{ method: "session.create", input: { location: { directory: "/work/other" } } }]);
    expect(record?.id).toBe("ses_new");
  });
});

describe("V2Backend.session.fork (capture §5 fork, SessionForkInput has no directory)", () => {
  test("calls session.fork with sessionID only", async () => {
    const { client, calls } = makeFake({ "session.fork": v2Session({ id: "ses_fork" }) });
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.fork("ses_parent");
    expect(calls).toEqual([{ method: "session.fork", input: { sessionID: "ses_parent" } }]);
  });

  test("does not send a directory: v2 has no input for it, so the option is ignored", async () => {
    const { client, calls } = makeFake({ "session.fork": v2Session({ id: "ses_fork" }) });
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.fork("ses_parent", { directory: "/work/worktree" });
    expect(calls[0]!.input).toEqual({ sessionID: "ses_parent" });
  });
});

describe("V2Backend.session.update (session.update with title)", () => {
  test("calls session.update with sessionID and title", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.update("ses_a", { title: "renamed" });
    expect(calls).toEqual([{ method: "session.update", input: { sessionID: "ses_a", title: "renamed" } }]);
  });
});

describe("V2Backend.session.abort (capture §5 /api/session/{id}/interrupt POST)", () => {
  test("calls session.interrupt and resolves the server's interrupted flag", async () => {
    const { client, calls } = makeFake({ "session.interrupt": { interrupted: true } });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.session.abort("ses_a")).toEqual({ interrupted: true });
    expect(calls).toEqual([{ method: "session.interrupt", input: { sessionID: "ses_a" } }]);
  });

  test("reports interrupted: false on an error status", async () => {
    const { client } = makeFake({ "session.interrupt": statusError(409) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.session.abort("ses_a")).toEqual({ interrupted: false });
  });
});

describe("V2Backend.session.compact (capture §5 /api/session/{id}/compact POST)", () => {
  test("calls session.compact with sessionID only, since v2 takes no model", async () => {
    const { client, calls } = makeFake({ "session.compact": {} });
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.compact("ses_a", { providerID: "sohoai", modelID: "glm-5.1" });
    expect(calls).toEqual([{ method: "session.compact", input: { sessionID: "ses_a" } }]);
  });
});

// ─── Message paging ───

describe("V2Backend.fetchMessages (internal, not on the seam; capture §4.11 and §5 message paging)", () => {
  /** A fake `message.list` that serves the pages in `pages` by cursor, recording every input. */
  function pagedMessages(pages: Array<{ data: unknown[]; next: string | null }>) {
    const { client, calls } = makeFake({});
    let index = 0;
    (client as unknown as { message: { list: (i: unknown) => Promise<unknown> } }).message.list = async (input) => {
      calls.push({ method: "message.list", input });
      const page = pages[index++];
      return { data: page!.data, cursor: { next: page!.next } };
    };
    return { client, calls };
  }

  test("the first page sets order asc, and later pages send cursor alone (never order with cursor)", async () => {
    const { client, calls } = pagedMessages([
      { data: [{ id: "msg_1" }, { id: "msg_2" }], next: "cur_a" },
      { data: [{ id: "msg_3" }], next: "cur_b" },
      { data: [{ id: "msg_4" }], next: null },
    ]);
    const backend = new V2Backend(BASE, CWD, client);
    const messages = await backend.fetchMessages("ses_a");
    expect(calls.map((c) => c.input)).toEqual([
      { sessionID: "ses_a", order: "asc" },
      { sessionID: "ses_a", cursor: "cur_a" },
      { sessionID: "ses_a", cursor: "cur_b" },
    ]);
    // No later call carries `order`. Capture §4.11 shows order plus cursor is an InvalidCursorError.
    for (const call of calls.slice(1)) {
      expect(call.input).not.toHaveProperty("order");
    }
    expect(messages?.map((m) => (m as { id: string }).id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
  });

  test("stops and does not loop when the server repeats a cursor", async () => {
    const { client, calls } = pagedMessages([
      { data: [{ id: "msg_1" }], next: "cur_a" },
      { data: [{ id: "msg_2" }], next: "cur_a" },
    ]);
    const backend = new V2Backend(BASE, CWD, client);
    const messages = await backend.fetchMessages("ses_a");
    expect(calls).toHaveLength(2);
    expect(messages).toHaveLength(2);
  });

  test("resolves undefined on an error status", async () => {
    const { client } = makeFake({ "message.list": statusError(404) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.fetchMessages("ses_a")).toBeUndefined();
  });
});

// ─── Prompt, command and model ───

describe("V2Backend.session.sendPrompt (capture §5 /api/session/{id}/prompt POST, client id)", () => {
  test("without a model, sends only the prompt with the client id, and no switchModel", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.sendPrompt({ sessionID: "ses_a", text: "hello", promptID: "msg_octmux0001" });
    expect(calls).toEqual([
      { method: "session.prompt", input: { sessionID: "ses_a", text: "hello", id: "msg_octmux0001" } },
    ]);
  });

  test("with a model the session has not used yet, calls switchModel before the prompt", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.sendPrompt({
      sessionID: "ses_a",
      text: "hi",
      promptID: "msg_1",
      model: { providerID: "sohoai", modelID: "glm-5.1" },
    });
    expect(calls.map((c) => c.method)).toEqual(["session.switchModel", "session.prompt"]);
    expect(calls[0]!.input).toEqual({
      sessionID: "ses_a",
      model: { id: "glm-5.1", providerID: "sohoai" },
    });
  });

  // D2: the catalog key is ModelInfo.id, and a prompt sent with that key must switch to the same id.
  test("a catalog key taken from listProviders reaches switchModel as model.id (D2 round trip)", async () => {
    const { client, calls } = makeFake({
      "model.list": {
        location: { directory: CWD },
        data: [
          {
            id: "glm-5.3-flash",
            modelID: "ollama-cloud/glm-5.3-flash",
            providerID: "sohoai",
            name: "GLM 5.3 Flash",
            limit: { context: 128000, output: 8000 },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        ],
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const catalog = (await backend.listProviders()).data!;
    const modelKey = Object.keys(catalog.all[0]!.models)[0]!;
    await backend.session.sendPrompt({
      sessionID: "ses_a",
      text: "hi",
      promptID: "msg_1",
      model: { providerID: "sohoai", modelID: modelKey },
    });
    const switchCall = calls.find((c) => c.method === "session.switchModel");
    expect(switchCall?.input).toEqual({ sessionID: "ses_a", model: { id: "glm-5.3-flash", providerID: "sohoai" } });
  });
});

// ─── Write operations reject on an error status (D1) ───

describe("V2Backend write operations reject on an error status (D1)", () => {
  /** Every write operation, each called so that its one SDK call is the one that fails. */
  const writeOps: Array<{ name: string; method: string; run: (backend: V2Backend) => Promise<unknown> }> = [
    { name: "sendPrompt", method: "session.prompt", run: (b) => b.session.sendPrompt({ sessionID: "ses_a", text: "x" }) },
    {
      name: "sendCommand",
      method: "session.command",
      run: (b) => b.session.sendCommand({ sessionID: "ses_a", name: "review", args: "" }),
    },
    { name: "compact", method: "session.compact", run: (b) => b.session.compact("ses_a", { providerID: "p", modelID: "m" }) },
    { name: "update", method: "session.update", run: (b) => b.session.update("ses_a", { title: "t" }) },
    { name: "create", method: "session.create", run: (b) => b.session.create({ directory: "/work/other" }) },
    { name: "fork", method: "session.fork", run: (b) => b.session.fork("ses_a") },
    { name: "setModel", method: "session.switchModel", run: (b) => b.session.setModel("ses_a", { providerID: "p", modelID: "m" }) },
    {
      name: "replyPermission",
      method: "permission.reply",
      run: (b) => b.replyPermission({ sessionID: "ses_a", permissionID: "per_1", decision: "once" }),
    },
    { name: "replyForm", method: "session.form.reply", run: (b) => b.replyForm("ses_a", "frm_1", { q0: "A" }) },
    { name: "cancelForm", method: "session.form.cancel", run: (b) => b.cancelForm("ses_a", "frm_1") },
  ];

  for (const op of writeOps) {
    test(`${op.name} rejects with the status message on a bare error status`, async () => {
      const { client } = makeFake({ [op.method]: statusError(500) });
      const backend = new V2Backend(BASE, CWD, client);
      expect(await rejectionMessage(op.run(backend))).toBe("OpenCode server returned HTTP 500");
    });

    test(`${op.name} rethrows a transport failure unchanged`, async () => {
      const { client } = makeFake({ [op.method]: transportError() });
      const backend = new V2Backend(BASE, CWD, client);
      const err = await op.run(backend).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ClientError);
      expect((err as ClientError).reason).toBe("Transport");
    });
  }

  test("a declared typed error becomes <_tag>: <message>", async () => {
    const { client } = makeFake({
      "session.prompt": declaredError({ _tag: "InvalidRequestError", message: "prompt is empty" }),
    });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await rejectionMessage(backend.session.sendPrompt({ sessionID: "ses_a", text: "" }))).toBe(
      "InvalidRequestError: prompt is empty",
    );
  });

  test("LocationNotFoundError names the server-side directory and the config hint, with the default hint", async () => {
    const { client } = makeFake({
      "session.prompt": declaredError({ _tag: "LocationNotFoundError", message: "Location not found: /srv/octmux" }),
    });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await rejectionMessage(backend.session.sendPrompt({ sessionID: "ses_a", text: "noop" }))).toBe(
      "LocationNotFoundError: the OpenCode server has no directory /srv/octmux — set server.directory or " +
        "server.directoryMap in ~/.config/octmux/octmux.json to the server-side path",
    );
  });

  test("LocationNotFoundError uses the configHint given to the constructor", async () => {
    const { client } = makeFake({
      "session.prompt": declaredError({ _tag: "LocationNotFoundError", message: "Location not found: /srv/octmux" }),
    });
    const backend = new V2Backend(BASE, CWD, client, "/home/florian/.config/octmux/octmux.json");
    expect(await rejectionMessage(backend.session.sendPrompt({ sessionID: "ses_a", text: "noop" }))).toContain(
      "in /home/florian/.config/octmux/octmux.json to the server-side path",
    );
  });

  test("LocationNotFoundError falls back to the backend cwd when the server message has another shape", async () => {
    const { client } = makeFake({
      "session.prompt": declaredError({ _tag: "LocationNotFoundError", message: "no such place" }),
    });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await rejectionMessage(backend.session.sendPrompt({ sessionID: "ses_a", text: "noop" }))).toContain(
      `the OpenCode server has no directory ${CWD} `,
    );
  });

  test("the message never carries fields of the error body other than _tag and message", async () => {
    const secret = "sk-test-SECRET-VALUE";
    const { client } = makeFake({
      "session.prompt": declaredError({ _tag: "UnauthorizedError", message: "denied", apiKey: secret, headers: { x: secret } }),
    });
    const backend = new V2Backend(BASE, CWD, client);
    const message = await rejectionMessage(backend.session.sendPrompt({ sessionID: "ses_a", text: "x" }));
    expect(message).toBe("UnauthorizedError: denied");
    expect(message).not.toContain(secret);
  });

  test("a write that fails through ensureModel rejects, so sendPrompt does not send the prompt", async () => {
    const { client, calls } = makeFake({ "session.switchModel": statusError(502) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(
      await rejectionMessage(
        backend.session.sendPrompt({ sessionID: "ses_a", text: "hi", model: { providerID: "sohoai", modelID: "m" } }),
      ),
    ).toBe("OpenCode server returned HTTP 502");
    expect(calls.map((c) => c.method)).toEqual(["session.switchModel"]);
  });

  test("a read still resolves undefined on a declared error (reads keep the V1 parity)", async () => {
    const { client } = makeFake({ "session.get": declaredError({ _tag: "SessionNotFoundError", message: "gone" }) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.session.get("ses_a")).toBeUndefined();
  });
});

describe("V2Backend.setModel idempotency (capture §4.3 model select)", () => {
  test("skips switchModel when the session's last-known model is unchanged", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    const model = { providerID: "sohoai", modelID: "glm-5.1" };
    await backend.session.setModel("ses_a", model);
    await backend.session.setModel("ses_a", model);
    expect(calls.filter((c) => c.method === "session.switchModel")).toHaveLength(1);
  });

  test("sends switchModel again when the model changes", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.setModel("ses_a", { providerID: "sohoai", modelID: "glm-5.1" });
    await backend.session.setModel("ses_a", { providerID: "sohoai", modelID: "glm-5.3-flash" });
    expect(calls.filter((c) => c.method === "session.switchModel")).toHaveLength(2);
  });

  test("keeps the last-known model per session, so another session still sends its first switch", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    const model = { providerID: "sohoai", modelID: "glm-5.1" };
    await backend.session.setModel("ses_a", model);
    await backend.session.setModel("ses_b", model);
    expect(calls.filter((c) => c.method === "session.switchModel")).toHaveLength(2);
  });

  test("does not record a failed switch, so the next call retries it", async () => {
    const { client, calls } = makeFake({ "session.switchModel": statusError(500) });
    const backend = new V2Backend(BASE, CWD, client);
    const model = { providerID: "sohoai", modelID: "glm-5.1" };
    // The first call rejects (D1: write operations reject on an error status); the second must still send.
    await backend.session.setModel("ses_a", model).catch(() => undefined);
    await backend.session.setModel("ses_a", model).catch(() => undefined);
    expect(calls.filter((c) => c.method === "session.switchModel")).toHaveLength(2);
  });
});

describe("V2Backend.setModel cache follows a foreign model switch (C3.6 defect 1)", () => {
  test("a session.model.selected frame updates the cache, so a select of the foreign model skips switchModel", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    // A foreign client switched ses_a to glm-5.3-flash. The frame has the shape of capture 3 (events.sse:365).
    // The translator emits model-selected only for the REPL's current session, so ses_a is passed as currentSessionID.
    const frame = {
      id: "evt_0",
      created: 1,
      type: "session.model.selected",
      location: { directory: "/tmp/octmux-test" },
      data: { sessionID: "ses_a", model: { id: "glm-5.3-flash", providerID: "sohoai" } },
      durable: { aggregateID: "ses_a", seq: 0, version: 1 },
    };
    expect(backend.events.translateEvent(frame as never, "ses_a")).toEqual({
      kind: "model-selected",
      sessionID: "ses_a",
      providerID: "sohoai",
      modelID: "glm-5.3-flash",
    });
    await backend.session.setModel("ses_a", { providerID: "sohoai", modelID: "glm-5.3-flash" });
    expect(calls.filter((c) => c.method === "session.switchModel")).toHaveLength(0);
    await backend.session.setModel("ses_a", { providerID: "sohoai", modelID: "glm-5.1" });
    expect(calls.filter((c) => c.method === "session.switchModel")).toHaveLength(1);
  });
});

describe("V2Backend.session.sendCommand (capture §4.12 session command)", () => {
  test("calls session.command with name and text, and no client id", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.sendCommand({ sessionID: "ses_a", name: "review", args: "uncommitted", promptID: "msg_x" });
    expect(calls).toEqual([
      { method: "session.command", input: { sessionID: "ses_a", name: "review", text: "uncommitted" } },
    ]);
  });

  test("with a model, calls switchModel first (same idempotent path as sendPrompt)", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.session.sendCommand({
      sessionID: "ses_a",
      name: "review",
      args: "",
      model: { providerID: "sohoai", modelID: "glm-5.1" },
    });
    expect(calls.map((c) => c.method)).toEqual(["session.switchModel", "session.command"]);
  });
});

// ─── Command echo slot on a failed sendCommand (review issue 1, FIX-1) ───

/**
 * A live v2 user inbox frame in the envelope `V2EventTranslator` reads (capture §2a, §4.5). It carries no `durable`,
 * so the seq check is skipped. The same fixture shape is used by `src/backend/v2-events.test.ts`.
 */
function inboxFrame(inboxID: string, text: string): unknown {
  return {
    id: "evt_live",
    created: 1,
    type: "session.inbox.enqueued",
    data: { sessionID: "ses_a", inboxID, item: { type: "user", payload: { text } } },
  };
}

describe("V2Backend.sendCommand releases its echo slot when the request fails (FIX-1)", () => {
  test("a failed session.command rejects with the same error, and the next foreign turn renders", async () => {
    const { client } = makeFake({ "session.command": statusError(500) });
    const backend = new V2Backend(BASE, CWD, client);
    backend.events.recordOwnCommandPrefix("# /review");

    expect(
      await rejectionMessage(backend.session.sendCommand({ sessionID: "ses_a", name: "review", args: "" })),
    ).toBe("OpenCode server returned HTTP 500");
    // No echo comes back for a failed POST, so the slot must be gone: the foreign turn is not swallowed.
    expect(backend.events.translateEvent(inboxFrame("msg_for_1", "from mobile") as never, "ses_a")).toEqual({
      kind: "foreign-user-turn",
      messageID: "msg_for_1",
      text: "from mobile",
    });
  });

  test("a failed switchModel (model given) rejects with the same error, skips the POST, and releases the slot", async () => {
    const { client, calls } = makeFake({ "session.switchModel": statusError(502) });
    const backend = new V2Backend(BASE, CWD, client);
    backend.events.recordOwnCommandPrefix("# /review");

    expect(
      await rejectionMessage(
        backend.session.sendCommand({
          sessionID: "ses_a",
          name: "review",
          args: "",
          model: { providerID: "sohoai", modelID: "glm-5.1" },
        }),
      ),
    ).toBe("OpenCode server returned HTTP 502");
    // The command POST never ran, so no echo can come back.
    expect(calls.map((c) => c.method)).toEqual(["session.switchModel"]);
    expect(backend.events.translateEvent(inboxFrame("msg_for_1", "from mobile") as never, "ses_a")).toEqual({
      kind: "foreign-user-turn",
      messageID: "msg_for_1",
      text: "from mobile",
    });
  });

  test("a successful sendCommand keeps its slot, so the echo is swallowed and the next item renders", async () => {
    const { client } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    backend.events.recordOwnCommandPrefix("# /review");

    await backend.session.sendCommand({ sessionID: "ses_a", name: "review", args: "" });
    // The echo takes the slot, whatever its text (the template need not start with the command name).
    expect(backend.events.translateEvent(inboxFrame("msg_echo_1", "Review the diff.") as never, "ses_a")).toBeNull();
    expect(backend.events.translateEvent(inboxFrame("msg_for_1", "from mobile") as never, "ses_a")).toEqual({
      kind: "foreign-user-turn",
      messageID: "msg_for_1",
      text: "from mobile",
    });
  });
});

describe("V2Backend.events.getMissedHistory consumes a command echo slot the live stream never saw (FIX-2)", () => {
  // The expanded template of a command need not start with the command name (a `rag.md`-style template). The resync
  // path must claim it by the same slot rule as the live path, so the slot is spent and does not swallow a later turn.
  const TEMPLATE = "Review the diff against the base branch and report findings.";
  const messages = [
    { id: "msg_echo_1", type: "user", time: { created: 1 }, text: TEMPLATE },
    {
      id: "msg_asst_1",
      type: "assistant",
      agent: "build",
      model: { id: "glm-5.3-flash", providerID: "sohoai" },
      time: { created: 2, completed: 3 },
      content: [{ type: "text", text: "No issues found." }],
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    { id: "msg_idle_1", type: "idle", time: { created: 4 }, outcome: "succeeded" },
  ];

  test("a resync-only command echo is not rendered, and its slot does not swallow a later live foreign turn", async () => {
    const { client } = makeFake({ "message.list": { data: messages, cursor: { next: null } } });
    const backend = new V2Backend(BASE, CWD, client);
    // The command was sent (its slot is armed), but its echo is missed by the live stream.
    backend.events.recordOwnCommandPrefix("# /review");

    const ops = await backend.events.getMissedHistory("ses_a");
    // The echo is claimed by the slot, so it renders no user-input op. The assistant reply is still rendered.
    expect(ops.some((op) => op.op === "user-input")).toBe(false);
    expect(ops.some((op) => op.op === "block")).toBe(true);

    // The slot was consumed by resync, so a later genuine foreign turn renders.
    expect(backend.events.translateEvent(inboxFrame("msg_for_1", "from mobile") as never, "ses_a")).toEqual({
      kind: "foreign-user-turn",
      messageID: "msg_for_1",
      text: "from mobile",
    });
  });
});

// ─── Permissions, questions and forms ───

describe("V2Backend.replyPermission (capture §4.7 and §5 permission reply POST)", () => {
  test("calls permission.reply with requestID and decision, and no message when none is given", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.replyPermission({ sessionID: "ses_a", permissionID: "per_1", decision: "once" });
    expect(calls).toEqual([
      { method: "permission.reply", input: { sessionID: "ses_a", requestID: "per_1", decision: "once" } },
    ]);
  });

  test("sends the message on a reject that carries one (capture §4.7 reject with message)", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.replyPermission({
      sessionID: "ses_a",
      permissionID: "per_2",
      decision: "reject",
      message: "capture: rejected on purpose",
    });
    expect(calls[0]!.input).toEqual({
      sessionID: "ses_a",
      requestID: "per_2",
      decision: "reject",
      message: "capture: rejected on purpose",
    });
  });
});

describe("V2Backend.listPermissions (P1: location-scoped list, reshaped to the v1 /permission array)", () => {
  test("calls permission.request.list with the location directory and returns the v1 JSON array", async () => {
    const { client, calls } = makeFake({
      "permission.request.list": {
        location: { directory: CWD },
        data: [
          {
            id: "per_1",
            sessionID: "ses_a",
            action: "shell",
            resources: ["ls -la"],
            save: ["ls *"],
            source: { type: "tool", messageID: "msg_1", id: "call_1" },
          },
        ],
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.listPermissions();
    expect(calls).toEqual([{ method: "permission.request.list", input: { location: { directory: CWD } } }]);
    expect(resp.ok).toBe(true);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(await resp.json()).toEqual([
      { id: "per_1", sessionID: "ses_a", permission: "shell", patterns: ["ls -la"] },
    ]);
  });

  test("returns a non-ok Response on an error status, so the discovery pass skips", async () => {
    const { client } = makeFake({ "permission.request.list": statusError(500) });
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.listPermissions();
    expect(resp.ok).toBe(false);
  });
});

describe("V2Backend question stubs (v2 has forms, not questions)", () => {
  test("listQuestions resolves an empty JSON array and makes no SDK call", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.listQuestions();
    expect(resp.ok).toBe(true);
    expect(await resp.json()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejectQuestion and replyQuestion resolve ok and make no SDK call", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    expect((await backend.rejectQuestion("q_1")).ok).toBe(true);
    expect((await backend.replyQuestion("q_1", [["A"]])).ok).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("V2Backend forms (capture §4.6 and §5 form list and reply)", () => {
  test("listForms calls session.form.list and maps each form, falling back to the key for a missing title", async () => {
    const { client, calls } = makeFake({
      "session.form.list": [
        {
          id: "frm_1",
          sessionID: "ses_a",
          title: "Questions",
          fields: [
            {
              key: "q0",
              type: "string",
              title: "Your choice",
              options: [{ value: "A", label: "A" }, { value: "B", label: "B", description: "Option B" }],
              custom: true,
            },
            { key: "ok", type: "boolean" },
          ],
        },
      ],
    });
    const backend = new V2Backend(BASE, CWD, client);
    const forms = await backend.listForms("ses_a");
    expect(calls).toEqual([{ method: "session.form.list", input: { sessionID: "ses_a" } }]);
    expect(forms).toEqual([
      {
        id: "frm_1",
        sessionID: "ses_a",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Your choice",
            type: "string",
            options: [{ value: "A", label: "A" }, { value: "B", label: "B", description: "Option B" }],
            custom: true,
          },
          { key: "ok", title: "ok", type: "boolean" },
        ],
      },
    ]);
  });

  test("listForms resolves undefined on an error status", async () => {
    const { client } = makeFake({ "session.form.list": statusError(404) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.listForms("ses_a")).toBeUndefined();
  });

  test("replyForm calls session.form.reply with the answer map (capture §4.6 reply body)", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.replyForm("ses_a", "frm_1", { q0: "A" });
    expect(calls).toEqual([
      { method: "session.form.reply", input: { sessionID: "ses_a", formID: "frm_1", answer: { q0: "A" } } },
    ]);
  });

  // C2.6b: Esc and Ctrl-C in app.tsx cancel the form on the server through this call.
  test("cancelForm calls session.form.cancel with the session and form IDs (C2.6b; no answer body)", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    await backend.cancelForm("ses_a", "frm_1");
    expect(calls).toEqual([{ method: "session.form.cancel", input: { sessionID: "ses_a", formID: "frm_1" } }]);
  });

  // D1: write operations reject on an error status. The Esc and Ctrl-C call sites in app.tsx add `.catch(() => {})`.
  test("cancelForm rejects on an error status, with the formatted message", async () => {
    const { client } = makeFake({ "session.form.cancel": statusError(404) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await rejectionMessage(backend.cancelForm("ses_a", "frm_1"))).toBe("OpenCode server returned HTTP 404");
  });
});

describe("V2Backend.isSessionActive (C2.6b; capture §5 GET /api/session/active)", () => {
  test("calls session.active and resolves true when the session has an entry in the map", async () => {
    const { client, calls } = makeFake({ "session.active": { ses_a: { type: "running" } } });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.isSessionActive("ses_a")).toBe(true);
    expect(calls).toEqual([{ method: "session.active", input: undefined }]);
  });

  test("resolves false when the map does not list the session (capture §4.8 post-idle shape {})", async () => {
    const { client } = makeFake({ "session.active": {} });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.isSessionActive("ses_a")).toBe(false);
  });

  test("resolves undefined on an error status, so the caller keeps its current state", async () => {
    const { client } = makeFake({ "session.active": statusError(500) });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.isSessionActive("ses_a")).toBeUndefined();
  });
});

describe("V2Backend.getOrchestraState (orchestra badge over the API, session metadata)", () => {
  const active = { version: 1, mode: "brain", title: "orchestra full - task", active: true, updatedAt: Date.now() };

  test("reads metadata.orchestra and the session model through session.get", async () => {
    const { client, calls } = makeFake({
      "session.get": v2Session({
        id: "ses_a",
        metadata: { orchestra: active },
        model: { id: "glm-5.3-flash", providerID: "sohoai", variant: "default" },
      }),
    });
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.getOrchestraState("ses_a")).toEqual({
      active: true,
      mode: "brain",
      title: "orchestra full - task",
      parserWarnings: [],
      model: { providerID: "sohoai", id: "glm-5.3-flash" },
    });
    expect(calls).toEqual([{ method: "session.get", input: { sessionID: "ses_a" } }]);
  });

  test("a child session never yields a badge: it carries a stale copy of its parent's metadata", async () => {
    const { client } = makeFake({
      "session.get": v2Session({ id: "ses_child", parentID: "ses_a", metadata: { orchestra: active } }),
    });
    expect(await new V2Backend(BASE, CWD, client).getOrchestraState("ses_child")).toBeNull();
  });

  test("resolves null when the session has no orchestra metadata", async () => {
    const { client } = makeFake({ "session.get": v2Session({ id: "ses_a" }) });
    expect(await new V2Backend(BASE, CWD, client).getOrchestraState("ses_a")).toBeNull();
  });

  test("resolves null on an error status", async () => {
    const { client } = makeFake({ "session.get": statusError(404) });
    expect(await new V2Backend(BASE, CWD, client).getOrchestraState("ses_a")).toBeNull();
  });
});

// ─── Provider, model and command discovery ───

describe("V2Backend.listProviders (model.list shim; never /api/provider)", () => {
  test("calls model.list with the location and returns the v1-shaped catalog", async () => {
    const { client, calls } = makeFake({
      "model.list": {
        location: { directory: CWD },
        data: [
          {
            id: "glm-5.1",
            modelID: "glm-5.1",
            providerID: "sohoai",
            name: "GLM 5.1",
            limit: { context: 200000, output: 8000 },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        ],
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.listProviders();
    expect(calls).toEqual([{ method: "model.list", input: { location: { directory: CWD } } }]);
    expect(resp.data?.connected).toEqual(["sohoai"]);
    expect(resp.data?.all[0]?.models["glm-5.1"]).toEqual({
      id: "glm-5.1",
      name: "GLM 5.1",
      limit: { context: 200000 },
      tool_call: true,
    });
  });

  test("never calls the provider route (the fake has no provider member, so a call would throw)", async () => {
    const { client, calls } = makeFake({ "model.list": { location: { directory: CWD }, data: [] } });
    const backend = new V2Backend(BASE, CWD, client);
    await backend.listProviders();
    expect(calls.map((c) => c.method).some((m) => m.startsWith("provider"))).toBe(false);
  });

  test("resolves an absent data field on an error status", async () => {
    const { client } = makeFake({ "model.list": statusError(500) });
    const backend = new V2Backend(BASE, CWD, client);
    expect((await backend.listProviders()).data).toBeUndefined();
  });
});

describe("V2Backend.getDefaultModelConfig (SECURITY: only the two IDs survive)", () => {
  test("returns {data:{model:'providerID/modelID'}} from model.default", async () => {
    const { client, calls } = makeFake({
      "model.default": {
        location: { directory: CWD },
        data: { id: "glm-5.1", modelID: "glm-5.1", providerID: "sohoai", name: "GLM" },
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.getDefaultModelConfig();
    expect(calls).toEqual([{ method: "model.default", input: { location: { directory: CWD } } }]);
    expect(resp).toEqual({ data: { model: "sohoai/glm-5.1" } });
  });

  test("drops provider settings, including any apiKey, from the returned object", async () => {
    const secret = "sk-test-SECRET-VALUE";
    const { client } = makeFake({
      "model.default": {
        location: { directory: CWD },
        data: {
          id: "glm-5.1",
          modelID: "glm-5.1",
          providerID: "sohoai",
          settings: { apiKey: secret, baseURL: "https://example.invalid" },
        },
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.getDefaultModelConfig();
    expect(JSON.stringify(resp)).not.toContain(secret);
    expect(JSON.stringify(resp)).not.toContain("apiKey");
    expect(Object.keys(resp.data!)).toEqual(["model"]);
  });

  test("resolves an absent data field when the server has no default", async () => {
    const { client } = makeFake({ "model.default": { location: { directory: CWD }, data: null } });
    const backend = new V2Backend(BASE, CWD, client);
    expect((await backend.getDefaultModelConfig()).data).toBeUndefined();
  });

  // D2: the default model is "providerID/id", the same identifier the catalog and switchModel use.
  test("uses ModelInfo.id, not the upstream modelID, in the default model string (D2)", async () => {
    const { client } = makeFake({
      "model.default": {
        location: { directory: CWD },
        data: { id: "glm-5.3-flash", modelID: "ollama-cloud/glm-5.3-flash", providerID: "sohoai", name: "GLM" },
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    expect((await backend.getDefaultModelConfig()).data).toEqual({ model: "sohoai/glm-5.3-flash" });
  });
});

describe("V2Backend.listCommands (capture §4.12 and §5 /api/command GET)", () => {
  test("calls command.list with the location and maps entries to the CommandInfo shape", async () => {
    const { client, calls } = makeFake({
      "command.list": {
        location: { directory: CWD },
        data: [{ name: "review", description: "Review changes" }, { name: "init" }],
      },
    });
    const backend = new V2Backend(BASE, CWD, client);
    const resp = await backend.listCommands();
    expect(calls).toEqual([{ method: "command.list", input: { location: { directory: CWD } } }]);
    expect(resp.data).toEqual([
      { name: "review", description: "Review changes" },
      { name: "init" },
    ]);
  });
});

// ─── Ancestry, events and the temporary translator stubs ───

describe("V2Backend.isSessionDescendant (capture §5 session.get, TTL-cached parent walk)", () => {
  test("walks session.get parentID links from the candidate up to the ancestor", async () => {
    const parents: Record<string, Reply> = {
      "session.get:ses_grandchild": v2Session({ id: "ses_grandchild", parentID: "ses_child" }),
      "session.get:ses_child": v2Session({ id: "ses_child", parentID: "ses_root" }),
    };
    const { client, calls } = makeFake({});
    (client as unknown as { session: { get: (i: { sessionID: string }) => Promise<unknown> } }).session.get = async (
      input,
    ) => {
      calls.push({ method: "session.get", input });
      return parents[`session.get:${input.sessionID}`] ?? v2Session({ id: input.sessionID });
    };
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.isSessionDescendant("ses_grandchild", "ses_root")).toBe(true);
    expect(await backend.isSessionDescendant("ses_root", "ses_grandchild")).toBe(false);
  });

  test("caches parent links for the TTL, so a second walk over the same chain makes no new calls", async () => {
    const { client, calls } = makeFake({});
    (client as unknown as { session: { get: (i: { sessionID: string }) => Promise<unknown> } }).session.get = async (
      input,
    ) => {
      calls.push({ method: "session.get", input });
      return input.sessionID === "ses_child"
        ? v2Session({ id: "ses_child", parentID: "ses_root" })
        : v2Session({ id: input.sessionID });
    };
    const backend = new V2Backend(BASE, CWD, client);
    expect(await backend.isSessionDescendant("ses_child", "ses_root")).toBe(true);
    const firstWalkCalls = calls.length;
    expect(await backend.isSessionDescendant("ses_child", "ses_root")).toBe(true);
    expect(calls.length).toBe(firstWalkCalls);
  });
});

describe("V2Backend.subscribeEvents (capture §2a frame envelope, /api/event)", () => {
  test("yields each v2 frame wrapped as {payload: frame}, in order", async () => {
    const frames = [
      { type: "session.created", data: { sessionID: "ses_a" } },
      { type: "server.connected", data: {} },
    ];
    const { client, calls } = makeFake({ "event.subscribe": frames });
    const backend = new V2Backend(BASE, CWD, client);
    const result = await backend.subscribeEvents();
    const received: unknown[] = [];
    for await (const item of result.stream) received.push(item);
    expect(calls.map((c) => c.method)).toEqual(["event.subscribe"]);
    expect(received).toEqual([{ payload: frames[0] }, { payload: frames[1] }]);
  });
});

// C2.3b made hasPendingToolCalls, getLatestAssistantActivity, getTokenUsage and getHistory real. Their tests
// are in src/backend/v2-queries.test.ts. The translator members are C2.4a. Their behaviour is tested in
// src/backend/v2-events.test.ts. The tests here only check that V2Backend forwards to its own translator.
describe("V2Backend.events translator wiring (C2.4a)", () => {
  test("translator members forward to the backend's translator, with no REST call", async () => {
    const { client, calls } = makeFake({});
    const backend = new V2Backend(BASE, CWD, client);
    // A text start opens a block and emits generating. That output shows translateEvent reached the translator.
    const started = backend.events.translateEvent(
      { type: "session.text.started", data: { sessionID: "ses_a", assistantMessageID: "msg_1", ordinal: 0 } } as never,
      "ses_a",
    );
    expect(started).toEqual([
      { kind: "block-start", partID: "msg_1:0", role: "text", messageID: "msg_1" },
      { kind: "generating" },
    ]);
    expect(backend.events.hasOpenStreamingPart()).toBe(true);
    expect(backend.events.synthesizeSessionIdleEvents()).toEqual([
      { kind: "session-idle" },
      { kind: "block-end", partID: "msg_1:0", role: "text" },
    ]);
    expect(backend.events.hasOpenStreamingPart()).toBe(false);
    backend.events.recordOwnMessageID("msg_own");
    backend.events.recordOwnCommandPrefix("/brain");
    expect(calls).toEqual([]);
  });

  test("two backends do not share translator state (P6)", () => {
    const first = new V2Backend(BASE, CWD, makeFake({}).client);
    const second = new V2Backend(BASE, CWD, makeFake({}).client);
    first.events.translateEvent(
      { type: "session.text.started", data: { sessionID: "ses_a", assistantMessageID: "msg_1", ordinal: 0 } } as never,
      "ses_a",
    );
    expect(first.events.hasOpenStreamingPart()).toBe(true);
    expect(second.events.hasOpenStreamingPart()).toBe(false);
    expect(second.events.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });

  test("resetEventState clears the open blocks of the backend it is called on", () => {
    const backend = new V2Backend(BASE, CWD, makeFake({}).client);
    backend.events.translateEvent(
      { type: "session.text.started", data: { sessionID: "ses_a", assistantMessageID: "msg_1", ordinal: 0 } } as never,
      "ses_a",
    );
    backend.events.resetEventState();
    expect(backend.events.hasOpenStreamingPart()).toBe(false);
    expect(backend.events.synthesizeSessionIdleEvents()).toEqual([{ kind: "session-idle" }]);
  });
});

describe("V2Backend.checkLocation (location.get before session create, fork or resume)", () => {
  const missing = () =>
    declaredError({ _tag: "LocationNotFoundError", message: "Location not found: /mnt/nfs/x", location: { directory: "/mnt/nfs/x" } });

  /**
   * A fake whose `location.get` rejects with `LocationNotFoundError` for the `missingDirectories` and
   * resolves for every other directory. The other methods come from `makeFake(replies)`.
   */
  function makeFakeLocation(missingDirectories: string[], replies: Record<string, Reply> = {}) {
    const fake = makeFake(replies);
    const client = fake.client as unknown as { location: { get: (input: { location: { directory: string } }) => Promise<unknown> } };
    client.location.get = async (input) => {
      fake.calls.push({ method: "location.get", input });
      if (missingDirectories.includes(input.location.directory)) throw missing();
      return { directory: input.location.directory, project: {} };
    };
    return fake;
  }

  test("calls location.get with the directory and resolves when the server has it", async () => {
    const { client, calls } = makeFake({ "location.get": { directory: "/Volumes/Disks/x", project: {} } });
    await new V2Backend(BASE, CWD, client).checkLocation("/Volumes/Disks/x");
    expect(calls).toEqual([{ method: "location.get", input: { location: { directory: "/Volumes/Disks/x" } } }]);
  });

  test("LocationNotFoundError names the directory and lists the known projects, sorted, without global", async () => {
    const { client } = makeFakeLocation(["/mnt/nfs/x"], {
      "project.list": [
        { id: "p2", canonical: "/Users/me" },
        { id: "global", canonical: "/" },
        { id: "p1", canonical: "/Volumes/Disks/x" },
      ],
    });
    expect(await rejectionMessage(new V2Backend(BASE, CWD, client).checkLocation("/mnt/nfs/x"))).toBe(
      "LocationNotFoundError: the OpenCode server has no directory /mnt/nfs/x — set server.directory or " +
        "server.directoryMap in ~/.config/octmux/octmux.json to the server-side path\n" +
        "Projects the OpenCode server knows:\n  /Users/me\n  /Volumes/Disks/x",
    );
  });

  test("projects at paths the server cannot resolve (placeholders) are left out", async () => {
    const { client } = makeFakeLocation(["/mnt/nfs/x", "/mnt/nfs/old"], {
      "project.list": [
        { id: "p1", canonical: "/mnt/nfs/old" },
        { id: "p2", canonical: "/Users/me" },
      ],
    });
    const message = await rejectionMessage(new V2Backend(BASE, CWD, client).checkLocation("/mnt/nfs/x"));
    expect(message).toEndWith("Projects the OpenCode server knows:\n  /Users/me");
  });

  test("no list is added when no project resolves", async () => {
    const { client } = makeFakeLocation(["/mnt/nfs/x", "/mnt/nfs/old"], {
      "project.list": [{ id: "p1", canonical: "/mnt/nfs/old" }],
    });
    const message = await rejectionMessage(new V2Backend(BASE, CWD, client).checkLocation("/mnt/nfs/x"));
    expect(message).toEndWith("to the server-side path");
  });

  test("a failing project.list leaves only the location message", async () => {
    const { client } = makeFake({ "location.get": missing(), "project.list": transportError() });
    const message = await rejectionMessage(new V2Backend(BASE, CWD, client).checkLocation("/mnt/nfs/x"));
    expect(message).toEndWith("to the server-side path");
  });

  test("another typed error is formatted and does not list projects", async () => {
    const { client, calls } = makeFake({ "location.get": declaredError({ _tag: "UnauthorizedError", message: "no" }) });
    expect(await rejectionMessage(new V2Backend(BASE, CWD, client).checkLocation("/x"))).toBe("UnauthorizedError: no");
    expect(calls.map((c) => c.method)).toEqual(["location.get"]);
  });

  test("a transport failure is rethrown unchanged", async () => {
    const { client } = makeFake({ "location.get": transportError() });
    const err = await new V2Backend(BASE, CWD, client).checkLocation("/x").then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ClientError);
  });
});
