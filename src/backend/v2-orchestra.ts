/**
 * v2: the orchestra badge state read over the API, from the harness session's metadata.
 *
 * octmux is an OpenCode client and does not read OpenCode server files. oconona (the server-side
 * /brain and /duo setup) publishes its run state on the OpenCode session that runs the pipeline,
 * through the v2 session metadata API. octmux reads it back with `GET /api/session/{id}`.
 *
 * Contract (oconona writes, octmux reads). Key `orchestra` in the session's `metadata`:
 *
 *   PATCH /api/session/{sessionID}   body { "metadata": { "orchestra": {
 *     "version": 1,
 *     "mode": "brain" | "duo",
 *     "title": "<badge title, e.g. orchestra full - <task>>",
 *     "active": true,                      // false (or the key removed) when the run ends
 *     "updatedAt": <epoch ms of this write>,
 *     "parserWarnings": [{ "code": "...", "message": "..." }]   // optional
 *   } } }
 *
 * - The session is the harness session: the top-level session in which /brain or /duo was typed,
 *   which is the session octmux shows. octmux reads only that session's metadata.
 * - Write `active: true` at setup, rewrite it with a fresh `updatedAt` when anything shown changes
 *   (title, parserWarnings), and write `active: false` at cleanup, abandon and block.
 * - octmux ignores an entry whose `updatedAt` is more than 24 h old (stale-after-crash guard), an
 *   entry with `active` not exactly `true`, and an entry whose `mode` or `title` is malformed. Unknown
 *   fields and newer `version` values are tolerated.
 * - PATCH replaces the session's whole `metadata` object; it does not merge keys (verified live on
 *   OpenCode 2.0.28). oconona must read the current metadata (`GET /api/session/{id}`) and write
 *   it back with `orchestra` set, so other keys survive.
 */

import type { OrchestraState } from "./types.ts";

/** The metadata key oconona writes. */
export const ORCHESTRA_METADATA_KEY = "orchestra";

/** An entry older than this is ignored, as v1 ignores a sidecar directory older than 24 h. */
export const ORCHESTRA_STALE_MS = 24 * 3600 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the `orchestra` entry of a session's metadata into the badge state, or `null` when no
 * active, well-formed, fresh entry is present.
 *
 * @param metadata The session's `metadata` object (`SessionInfo.metadata`), if any.
 * @param model    The model bound to the session, for the parent row label.
 * @param now      Current time in epoch ms (injectable for tests).
 */
export function parseOrchestraMetadata(
  metadata: unknown,
  model: { providerID: string; id: string } | undefined,
  now: number = Date.now(),
): OrchestraState | null {
  if (!isRecord(metadata)) return null;
  const entry = metadata[ORCHESTRA_METADATA_KEY];
  if (!isRecord(entry)) return null;
  if (entry.active !== true) return null;
  if (entry.mode !== "brain" && entry.mode !== "duo") return null;
  if (typeof entry.title !== "string") return null;
  if (typeof entry.updatedAt === "number" && now - entry.updatedAt > ORCHESTRA_STALE_MS) return null;

  const parserWarnings = Array.isArray(entry.parserWarnings)
    ? entry.parserWarnings
        .filter(isRecord)
        .filter((w) => typeof w.code === "string" && typeof w.message === "string")
        .map((w) => ({ code: w.code as string, message: w.message as string }))
    : [];
  const fallbackTitle = entry.mode === "duo" ? "orchestra light - duo" : "orchestra full - brain";

  return {
    mode: entry.mode,
    title: (entry.title.trim() || fallbackTitle).slice(0, 48),
    parserWarnings,
    ...(model ? { model } : {}),
  };
}
