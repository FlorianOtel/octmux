// Unit tests for the pure classifiers and the version gate in protocol-detect.ts.
// These tests make NO network calls. detectProtocol() is exercised live during
// Phase A-verify, not here.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyInfoResponse,
  classifyHealthResponse,
  compareVersions,
  BUNDLED_OC_CLIENT_VERSION,
} from "./protocol-detect.ts";

const JSON_CT = "application/json";
const HTML_CT = "text/html;charset=UTF-8";

describe("classifyInfoResponse (v2 /api/info probe)", () => {
  test("v2-authorized: 200 JSON with a string version", () => {
    const body = { version: "2.0.28", pid: 1234, urls: [], paths: { tmp: "/tmp" } };
    expect(classifyInfoResponse(200, JSON_CT, body)).toBe("v2-authorized");
  });

  test("v2-authorized: JSON content-type with a charset parameter is still JSON", () => {
    expect(classifyInfoResponse(200, "application/json; charset=utf-8", { version: "2.0.28" })).toBe(
      "v2-authorized",
    );
  });

  test("v2-unauthorized: 401 JSON with _tag UnauthorizedError", () => {
    const body = { _tag: "UnauthorizedError", message: "Authentication required" };
    expect(classifyInfoResponse(401, JSON_CT, body)).toBe("v2-unauthorized");
  });

  // REGRESSION: a v2 server answers ANY unknown non-/api path with 200 text/html
  // (the bundled web UI's SPA catch-all). An earlier design treated a bare 200 as
  // "v2", which misidentified v1 servers. This test locks in that an HTML 200 is
  // inconclusive, so detection falls through to the v1 probe.
  test("REGRESSION: 200 text/html SPA catch-all on /api/info is inconclusive, not v2-authorized", () => {
    const htmlBody = "<!doctype html><html><body>OpenCode</body></html>";
    expect(classifyInfoResponse(200, HTML_CT, htmlBody)).toBe("inconclusive");
    // Even if a body object were somehow present, an HTML content-type must not qualify.
    expect(classifyInfoResponse(200, HTML_CT, { version: "2.0.28" })).toBe("inconclusive");
  });

  test("inconclusive: 200 JSON whose body has no string version", () => {
    expect(classifyInfoResponse(200, JSON_CT, { pid: 1 })).toBe("inconclusive");
    expect(classifyInfoResponse(200, JSON_CT, { version: 228 })).toBe("inconclusive");
  });

  test("inconclusive: 200 JSON with an unparseable body (undefined)", () => {
    expect(classifyInfoResponse(200, JSON_CT, undefined)).toBe("inconclusive");
  });

  test("inconclusive: 200 JSON with a non-object body (array or null)", () => {
    expect(classifyInfoResponse(200, JSON_CT, ["2.0.28"])).toBe("inconclusive");
    expect(classifyInfoResponse(200, JSON_CT, null)).toBe("inconclusive");
  });

  test("inconclusive: 401 without a JSON content-type", () => {
    const body = { _tag: "UnauthorizedError" };
    expect(classifyInfoResponse(401, HTML_CT, body)).toBe("inconclusive");
    expect(classifyInfoResponse(401, null, body)).toBe("inconclusive");
  });

  test("inconclusive: 401 JSON with a different _tag", () => {
    expect(classifyInfoResponse(401, JSON_CT, { _tag: "NotFound" })).toBe("inconclusive");
  });

  test("inconclusive: null content-type with a 200 body", () => {
    expect(classifyInfoResponse(200, null, { version: "2.0.28" })).toBe("inconclusive");
  });

  test("inconclusive: 404 and 500 responses", () => {
    expect(classifyInfoResponse(404, HTML_CT, undefined)).toBe("inconclusive");
    expect(classifyInfoResponse(500, JSON_CT, { _tag: "UnauthorizedError" })).toBe("inconclusive");
  });
});

describe("classifyHealthResponse (v1 /global/health probe)", () => {
  test("v1: 200 with JSON content-type", () => {
    expect(classifyHealthResponse(200, JSON_CT)).toBe("v1");
  });

  test("v1-unauthorized: 401 with JSON content-type", () => {
    expect(classifyHealthResponse(401, JSON_CT)).toBe("v1-unauthorized");
  });

  test("v1-unauthorized: 401 with any other content-type (e.g. text/plain)", () => {
    expect(classifyHealthResponse(401, "text/plain")).toBe("v1-unauthorized");
    expect(classifyHealthResponse(401, null)).toBe("v1-unauthorized");
  });

  // A v1 server's /health path returns the SPA catch-all HTML, so a 200 text/html
  // must not identify a v1 server.
  test("inconclusive: 200 text/html (SPA catch-all) is not a v1 identification", () => {
    expect(classifyHealthResponse(200, HTML_CT)).toBe("inconclusive");
  });

  test("inconclusive: 200 with null content-type", () => {
    expect(classifyHealthResponse(200, null)).toBe("inconclusive");
  });

  test("inconclusive: 404 and 500 responses", () => {
    expect(classifyHealthResponse(404, HTML_CT)).toBe("inconclusive");
    expect(classifyHealthResponse(500, JSON_CT)).toBe("inconclusive");
  });
});

describe("compareVersions (MAJOR.MINOR compared, PATCH ignored)", () => {
  test("exact: identical versions", () => {
    expect(compareVersions("2.0.28", "2.0.28")).toBe("exact");
  });

  test("exact: patch-only difference is ignored (server patch higher)", () => {
    expect(compareVersions("2.0.99", "2.0.28")).toBe("exact");
  });

  test("exact: patch-only difference is ignored (server patch lower)", () => {
    expect(compareVersions("2.0.0", "2.0.28")).toBe("exact");
  });

  test("server-newer-minor: server minor above client minor", () => {
    expect(compareVersions("2.1.0", "2.0.28")).toBe("server-newer-minor");
  });

  test("server-older-minor: server minor below client minor", () => {
    expect(compareVersions("2.0.28", "2.1.0")).toBe("server-older-minor");
  });

  test("major-mismatch: server major higher", () => {
    expect(compareVersions("3.0.0", "2.0.28")).toBe("major-mismatch");
  });

  test("major-mismatch: server major lower", () => {
    expect(compareVersions("1.9.0", "2.0.28")).toBe("major-mismatch");
  });

  test("major-mismatch wins over minor: a higher major with a lower minor is still a major mismatch", () => {
    expect(compareVersions("3.0.0", "2.5.0")).toBe("major-mismatch");
  });

  test("exact: a semver prerelease suffix is accepted and ignored", () => {
    expect(compareVersions("2.0.28-rc.1", "2.0.28")).toBe("exact");
  });

  test("unparseable: non-semver server string", () => {
    expect(compareVersions("not-a-version", "2.0.28")).toBe("unparseable");
    expect(compareVersions("", "2.0.28")).toBe("unparseable");
    expect(compareVersions("2.0", "2.0.28")).toBe("unparseable");
    expect(compareVersions("v2.0.28", "2.0.28")).toBe("unparseable");
  });

  test("unparseable: non-semver client string", () => {
    expect(compareVersions("2.0.28", "bogus")).toBe("unparseable");
  });
});

describe("BUNDLED_OC_CLIENT_VERSION", () => {
  test("matches the @opencode/client pin in package.json (keep-in-sync guard)", () => {
    // package.json lives one directory above src/. Read it as text so the test
    // does not depend on bun's JSON import behaviour.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@opencode/client"]).toBe(`^${BUNDLED_OC_CLIENT_VERSION}`);
  });
});
