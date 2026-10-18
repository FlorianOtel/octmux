/**
 * Session ancestry for the v2 protocol (Stage 15.2 C2.3a).
 *
 * Mirrors the v1 walk in shape: a TTL cache, a depth limit of 5,
 * and "not found is not cached". It differs in one respect. The v1 walk caches the whole session
 * list and needs a one-shot revalidation when a candidate is missing. The v2 walk asks the server
 * for one session at a time (`session.get`) and caches each answer for the TTL. A session that is
 * not in the cache is therefore fetched directly, so no separate revalidation step is needed.
 *
 * The module holds no state of its own. The caller (V2Backend) owns the cache Map and passes the
 * lookup function, which keeps the walk unit-testable without a server.
 */

/** Cache TTL, the same 5 seconds as the v1 session list cache. */
export const ANCESTRY_CACHE_TTL_MS = 5000;

/** Maximum number of parent links followed. The same limit as the v1 walk. */
export const ANCESTRY_MAX_DEPTH = 5;

/** One cached parent link. `parentID` is `undefined` for a root session. */
export type AncestryCacheEntry = { parentID: string | undefined; fetchedAt: number };

/** Cache of session ID to parent link. Owned by the caller, one per backend instance. */
export type AncestryCache = Map<string, AncestryCacheEntry>;

/**
 * Fetches the parent link of one session. Resolves `undefined` when the session cannot be
 * fetched, which the walk treats as "no further ancestor".
 */
export type SessionParentLookup = (sessionID: string) => Promise<{ parentID?: string } | undefined>;

/**
 * Returns the parent of `sessionID`, from the cache when the entry is fresh, otherwise from `lookup`.
 * A failed lookup is not cached, so the next call tries again.
 *
 * @returns the parent session ID, `undefined` for a root session, or `null` when the session
 *          itself could not be fetched. The `null` case is kept separate so the walk can stop.
 */
async function parentOf(
  sessionID: string,
  lookup: SessionParentLookup,
  cache: AncestryCache,
  now: () => number,
): Promise<string | undefined | null> {
  const cached = cache.get(sessionID);
  if (cached && now() - cached.fetchedAt <= ANCESTRY_CACHE_TTL_MS) {
    return cached.parentID;
  }

  const info = await lookup(sessionID);
  if (info === undefined) return null;

  cache.set(sessionID, { parentID: info.parentID, fetchedAt: now() });
  return info.parentID;
}

/**
 * True if `candidateSessionID` is `ancestorSessionID` or one of its descendants, walking the
 * parent chain up to `ANCESTRY_MAX_DEPTH` links. Same contract as the v1 `isSessionDescendant`.
 *
 * @param lookup - fetches one session's parent link (the V2Backend passes `session.get`).
 * @param cache  - caller-owned TTL cache, mutated in place.
 * @param now    - clock, injectable for tests.
 */
export async function isSessionDescendantV2(
  candidateSessionID: string,
  ancestorSessionID: string,
  lookup: SessionParentLookup,
  cache: AncestryCache,
  now: () => number = Date.now,
): Promise<boolean> {
  let current = candidateSessionID;
  for (let depth = 0; depth < ANCESTRY_MAX_DEPTH; depth++) {
    if (current === ancestorSessionID) return true;

    const parentID = await parentOf(current, lookup, cache, now);
    // `null`: the session could not be fetched. `undefined`: it is a root session. Both end the walk.
    if (parentID === null || parentID === undefined) return false;
    current = parentID;
  }
  return false;
}
