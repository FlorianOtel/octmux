import { describe, expect, test } from "bun:test";
import { ORCHESTRA_STALE_MS, parseOrchestraMetadata } from "./v2-orchestra.ts";

// The orchestra metadata contract (src/backend/v2-orchestra.ts): what oconona writes to the
// harness session's `metadata.orchestra`, and what octmux shows for it.

const NOW = 1_800_000_000_000;
const MODEL = { providerID: "sohoai", id: "glm-5.3-flash" };

function meta(entry: Record<string, unknown>): Record<string, unknown> {
  return { orchestra: { version: 1, mode: "brain", title: "orchestra full - task", active: true, updatedAt: NOW, ...entry } };
}

describe("parseOrchestraMetadata", () => {
  test("an active brain entry gives the badge state with the session model", () => {
    expect(parseOrchestraMetadata(meta({}), MODEL, NOW)).toEqual({
      active: true,
      mode: "brain",
      title: "orchestra full - task",
      parserWarnings: [],
      model: MODEL,
    });
  });

  test("a duo entry keeps its mode; parser warnings are passed through", () => {
    const state = parseOrchestraMetadata(
      meta({ mode: "duo", title: "orchestra light - x", parserWarnings: [{ code: "snapshot_missing", message: "m" }] }),
      undefined,
      NOW,
    );
    expect(state).toEqual({
      active: true,
      mode: "duo",
      title: "orchestra light - x",
      parserWarnings: [{ code: "snapshot_missing", message: "m" }],
    });
  });

  test("the title is truncated to 48 characters, and an empty title gets a mode default", () => {
    expect(parseOrchestraMetadata(meta({ title: "x".repeat(80) }), undefined, NOW)?.title).toBe("x".repeat(48));
    expect(parseOrchestraMetadata(meta({ title: "  " }), undefined, NOW)?.title).toBe("orchestra full - brain");
    expect(parseOrchestraMetadata(meta({ mode: "duo", title: "" }), undefined, NOW)?.title).toBe("orchestra light - duo");
  });

  test("no metadata, no orchestra key, or a non-object entry gives null", () => {
    expect(parseOrchestraMetadata(undefined, MODEL, NOW)).toBeNull();
    expect(parseOrchestraMetadata({ other: 1 }, MODEL, NOW)).toBeNull();
    expect(parseOrchestraMetadata({ orchestra: "brain" }, MODEL, NOW)).toBeNull();
  });

  test("an inactive entry is returned with active: false and its outcome (oconona's final write)", () => {
    const state = parseOrchestraMetadata(
      meta({ active: false, outcome: "pass", parserWarnings: [{ code: "snapshot_missing", message: "m" }] }),
      undefined,
      NOW,
    );
    expect(state).toEqual({
      active: false,
      mode: "brain",
      title: "orchestra full - task",
      parserWarnings: [{ code: "snapshot_missing", message: "m" }],
      outcome: "pass",
    });
  });

  test("a non-boolean active gives null; an empty or non-string outcome is dropped", () => {
    expect(parseOrchestraMetadata(meta({ active: "true" }), MODEL, NOW)).toBeNull();
    expect(parseOrchestraMetadata(meta({ active: undefined }), MODEL, NOW)).toBeNull();
    expect(parseOrchestraMetadata(meta({ active: false, outcome: "" }), MODEL, NOW)).not.toHaveProperty("outcome");
    expect(parseOrchestraMetadata(meta({ active: false, outcome: 3 }), MODEL, NOW)).not.toHaveProperty("outcome");
  });

  test("a malformed mode or title gives null", () => {
    expect(parseOrchestraMetadata(meta({ mode: "solo" }), MODEL, NOW)).toBeNull();
    expect(parseOrchestraMetadata(meta({ title: 42 }), MODEL, NOW)).toBeNull();
  });

  test("an entry older than 24 h is ignored; a missing updatedAt is accepted", () => {
    expect(parseOrchestraMetadata(meta({ updatedAt: NOW - ORCHESTRA_STALE_MS - 1 }), MODEL, NOW)).toBeNull();
    expect(parseOrchestraMetadata(meta({ updatedAt: NOW - ORCHESTRA_STALE_MS + 1000 }), MODEL, NOW)).not.toBeNull();
    expect(parseOrchestraMetadata(meta({ updatedAt: undefined }), MODEL, NOW)).not.toBeNull();
  });

  test("unknown fields and a newer version are tolerated; malformed warnings are dropped", () => {
    const state = parseOrchestraMetadata(
      meta({ version: 7, extra: { a: 1 }, parserWarnings: [{ code: "ok", message: "fine" }, { code: 1 }, "bad"] }),
      undefined,
      NOW,
    );
    expect(state?.parserWarnings).toEqual([{ code: "ok", message: "fine" }]);
  });
});
