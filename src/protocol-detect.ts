// Protocol detection: decides whether the server at a given endpoint speaks
// the v2 OpenCode protocol (the one @opencode/client talks), a v1 server
// (refused with a hard error, Stage 15.5), or neither.
//
// The module has two layers:
//   1. Pure classifiers (classifyInfoResponse, classifyHealthResponse,
//      compareVersions). They take already-received status / content-type /
//      body values and return an enum. No I/O, so they are unit-tested directly.
//   2. A thin network wrapper (detectProtocol) that performs the two GET
//      probes and feeds the results to the classifiers.
//
// WHY JSON-STRICT CLASSIFICATION:
// A v2 server answers ANY unknown non-/api path with `200 text/html` (the
// bundled web UI's catch-all). A v1 server does the same for its own unknown
// paths. A bare "status 200" check would therefore call a v1 server "v2" (or
// vice versa) and the operator would get a confusing failure later. Only a
// response whose content-type is JSON AND whose body has the expected shape
// counts as a positive identification. Anything else is "inconclusive" and
// the caller falls through to the next probe.

import { OpenCode } from "@opencode/client";
import { getAuthHeaders } from "./auth-headers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of probing an endpoint. `detail` on "unreachable" is a short,
 * human-readable reason for the error message shown to the operator.
 * It never contains header values or passwords.
 */
export type ProtocolResult =
  | { kind: "v2-authorized"; version: string }
  | { kind: "v2-unauthorized" }
  | { kind: "v1" }
  | { kind: "unreachable"; detail: string };

/** Result of classifying a /api/info response (v2 probe). */
export type InfoClassification = "v2-authorized" | "v2-unauthorized" | "inconclusive";

/** Result of classifying a /global/health response (v1 probe). */
export type HealthClassification = "v1" | "inconclusive";

/** Outcome of comparing the server's version against the bundled client's. */
export type VersionGate =
  | "exact"
  | "server-newer-minor"
  | "server-older-minor"
  | "major-mismatch"
  | "unparseable";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The @opencode/client version octmux is compiled against.
 *
 * Hard-coded rather than read from node_modules/@opencode/client/package.json:
 * that package's "exports" map does not list "./package.json", so the import
 * is not an officially supported path (Bun happens to resolve it, Node does
 * not). KEEP THIS IN SYNC with the "@opencode/client" entry in package.json.
 * The test file asserts the two agree.
 */
export const BUNDLED_OC_CLIENT_VERSION = "2.0.28";

/**
 * Path of the v1 health endpoint.
 *
 * Verified against a live v1 server (opencode 0.0.0-dev-202606181138):
 *   GET /health         -> 200 text/html   (SPA catch-all, NOT a health check)
 *   GET /global/health  -> 200 application/json  {"healthy":true,"version":"..."}
 * So /global/health is the path that can positively identify a v1 server.
 */
const V1_HEALTH_PATH = "/global/health";

/** The v2 server-info endpoint. Its body is JSON, or a 401 JSON error if auth is required. */
const V2_INFO_PATH = "/api/info";

/** Default per-request timeout for each probe. */
const DEFAULT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * True when the content-type header is JSON. Lower-cased and substring-matched
 * so that "application/json; charset=utf-8" is accepted.
 */
function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes("application/json");
}

/** True for a non-null, non-array object: the only shape a JSON body can usefully have here. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classifies the response to GET /api/info.
 *
 * - "v2-authorized":   200, JSON content-type, body.version is a string.
 * - "v2-unauthorized": 401, JSON content-type, body._tag === "UnauthorizedError".
 * - "inconclusive":    everything else, including the v2 SPA catch-all
 *                      (200 text/html). The caller must then try /global/health.
 */
export function classifyInfoResponse(
  status: number,
  contentType: string | null,
  body: unknown,
): InfoClassification {
  const isJson = isJsonContentType(contentType);

  if (status === 200 && isJson && isPlainObject(body) && typeof body.version === "string") {
    return "v2-authorized";
  }

  if (status === 401 && isJson && isPlainObject(body) && body._tag === "UnauthorizedError") {
    return "v2-unauthorized";
  }

  return "inconclusive";
}

/**
 * Classifies the response to GET /global/health (the v1 probe).
 *
 * - "v1":           200 with JSON content-type, or 401 with ANY content-type. A v1 server with
 *                   `server.password` set answers 401 to unauthenticated requests, and the
 *                   content-type of that rejection is not relied on. Both are v1 identifications.
 * - "inconclusive": everything else, including 200 text/html (the SPA catch-all served at /health
 *                   on a v1 server).
 */
export function classifyHealthResponse(
  status: number,
  contentType: string | null,
): HealthClassification {
  if (status === 401 || (status === 200 && isJsonContentType(contentType))) {
    return "v1";
  }

  return "inconclusive";
}

/**
 * Parses MAJOR.MINOR.PATCH with an optional semver prerelease (-x) or build (+x)
 * suffix. The suffix is accepted but ignored. Anything else returns null.
 *
 * The prerelease tolerance exists because a v1 server reports a dev build
 * string such as "0.0.0-dev-202606181138", which is still semver-shaped.
 */
function parseSemver(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Compares the server's version with the client's, pinned by D12:
 * MAJOR and MINOR are compared, PATCH is ignored.
 *
 * Rationale: patch releases of the same minor are wire-compatible, so a
 * "2.0.28 server with 2.0.99 client" must pass as "exact". A minor or major
 * difference is what changes the protocol surface.
 *
 * Returns "unparseable" if either input is not MAJOR.MINOR.PATCH-shaped.
 */
export function compareVersions(serverVersion: string, clientVersion: string): VersionGate {
  const server = parseSemver(serverVersion);
  const client = parseSemver(clientVersion);
  if (server === null || client === null) {
    return "unparseable";
  }

  if (server.major !== client.major) {
    return "major-mismatch";
  }
  if (server.minor === client.minor) {
    return "exact";
  }
  return server.minor > client.minor ? "server-newer-minor" : "server-older-minor";
}

// ---------------------------------------------------------------------------
// Network wrapper
// ---------------------------------------------------------------------------

/** What one probe request returned, reduced to the fields the classifiers need. */
interface ProbeResponse {
  status: number;
  contentType: string | null;
  /** Parsed JSON body, present only when the content-type is JSON and the parse succeeded. */
  body: unknown;
}

/**
 * Performs one GET against `${baseUrl}${path}` with the shared auth headers.
 *
 * The body is parsed as JSON only when the content-type says JSON. A parse
 * failure is swallowed and yields `body: undefined`, which every classifier
 * treats as inconclusive. Non-JSON bodies are read and discarded so the
 * connection is released.
 *
 * Throws on network failure or timeout. The caller maps that to "unreachable".
 */
async function probe(baseUrl: string, path: string, timeoutMs: number): Promise<ProbeResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: getAuthHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const contentType = response.headers.get("content-type");

  if (!isJsonContentType(contentType)) {
    // We do not need the HTML body. Consume it to release the connection.
    await response.text().catch(() => undefined);
    return { status: response.status, contentType, body: undefined };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Declared JSON but unparseable. Leave body undefined so the classifiers
    // report inconclusive instead of throwing.
    body = undefined;
  }
  return { status: response.status, contentType, body };
}

/**
 * Maps a thrown fetch error to a short reason string for the operator.
 * Only error names and codes are used, never the raw message, so nothing
 * from the request (URL credentials, headers) can leak into the detail.
 */
function describeNetworkError(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `timed out after ${timeoutMs} ms`;
  }

  // Bun and Node put the system error code on the error or on its cause.
  // Node uses "ECONNREFUSED"; Bun's fetch uses "ConnectionRefused" (verified
  // against the bundled runtime). Both mean the same thing here.
  const code =
    (error as { code?: unknown } | null)?.code ??
    (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") {
    return "connection refused";
  }

  return "request failed";
}

/** Describes a non-positive HTTP response for the "unreachable" detail string. */
function describeResponse(response: ProbeResponse): string {
  return `HTTP ${response.status} ${response.contentType ?? "no content-type"}`;
}

/**
 * Detects which protocol the server at `baseUrl` speaks.
 *
 * Order of probes:
 *   1. GET /api/info. A v2 server answers JSON here, or 401 JSON if it needs a password.
 *   2. If inconclusive, GET /global/health. A v1 server answers JSON here, or 401 if it needs a password.
 *   3. If both are inconclusive, the endpoint is "unreachable" for octmux's purposes.
 *
 * A network error on step 1 (refused, timeout) stops immediately, because
 * step 2 would fail the same way.
 *
 * On "v2-authorized" the version is taken from @opencode/client's server.info()
 * call, not from the raw probe body. This keeps the bundled client in the
 * module graph (so the compile gate is meaningful) and uses the typed SDK path.
 *
 * Never logs or returns header values or passwords.
 */
export async function detectProtocol(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolResult> {
  // Step 1: the v2 probe.
  let infoResponse: ProbeResponse;
  try {
    infoResponse = await probe(baseUrl, V2_INFO_PATH, timeoutMs);
  } catch (error) {
    return { kind: "unreachable", detail: describeNetworkError(error, timeoutMs) };
  }

  const infoClass = classifyInfoResponse(infoResponse.status, infoResponse.contentType, infoResponse.body);

  if (infoClass === "v2-unauthorized") {
    return { kind: "v2-unauthorized" };
  }

  if (infoClass === "v2-authorized") {
    // M1: obtain the version through the bundled @opencode/client. This is
    // the same typed SDK path the rest of the app uses, and it confirms the
    // endpoint works with that client.
    try {
      const serverInfo = await OpenCode.make({ baseUrl, headers: getAuthHeaders() }).server.info({
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { kind: "v2-authorized", version: serverInfo.version };
    } catch (error) {
      // Report the error class only. The SDK's message text is not needed for
      // the operator-facing detail.
      const errorName = error instanceof Error ? error.name : "unknown error";
      return {
        kind: "unreachable",
        detail: `@opencode/client server.info() failed (${errorName})`,
      };
    }
  }

  // Step 2: the v1 probe. Reached only when /api/info was inconclusive.
  // A v1 server answers JSON here (200) or not (401) — either way it is refused.
  let healthResponse: ProbeResponse;
  try {
    healthResponse = await probe(baseUrl, V1_HEALTH_PATH, timeoutMs);
  } catch (error) {
    return { kind: "unreachable", detail: describeNetworkError(error, timeoutMs) };
  }

  const healthClass = classifyHealthResponse(healthResponse.status, healthResponse.contentType);

  if (healthClass === "v1") {
    return { kind: "v1" };
  }

  // Step 3: neither probe identified a server. Describe both responses so the
  // operator can see what the endpoint actually returned.
  return {
    kind: "unreachable",
    detail:
      `${describeResponse(infoResponse)} on ${V2_INFO_PATH} and ` +
      `${describeResponse(healthResponse)} on ${V1_HEALTH_PATH}`,
  };
}
