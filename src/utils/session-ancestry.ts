/**
 * Session ancestry walking — enables parent-session OC instances to receive
 * permission/question events from descendant (child) sessions.
 * Implements one-shot revalidation on cache misses to handle new child sessions
 * during SSE degradation.
 */

// Module-scope cache of session list with TTL.
type SessionCacheEntry = {
  list: Array<{ id: string; parentID?: string | null }>;
  fetchedAt: number;
};
let sessionCache: SessionCacheEntry | null = null;
const CACHE_TTL_MS = 5000;

// Track IDs that caused cache-miss revalidation in the current TTL window.
// Cleared when the full cache is refreshed.
let knownMissIDs = new Set<string>();

/**
 * Fetch the current session list from the OC API, populate the cache, and
 * clear the knownMissIDs set. On network error, returns the last cached list
 * (or empty array if no cache exists).
 *
 * @param baseUrl - OC daemon base URL (e.g., "http://localhost:4096")
 * @param cwd - Working directory to pass as x-opencode-directory header
 * @returns Array of sessions with id and optional parentID
 */
export async function getSessionList(
  baseUrl: string,
  cwd: string
): Promise<Array<{ id: string; parentID?: string | null }>> {
  try {
    const r = await fetch(`${baseUrl}/session`, { headers: { "x-opencode-directory": cwd } });
    if (!r.ok) {
      // Return last cached list on error, or empty
      return sessionCache?.list ?? [];
    }
    const list = (await r.json()) as Array<{
      id: string;
      parentID?: string | null;
    }>;
    sessionCache = { list, fetchedAt: Date.now() };
    knownMissIDs.clear();
    return list;
  } catch {
    // Network error: return last cached list, or empty
    return sessionCache?.list ?? [];
  }
}

/**
 * Check whether candidateSessionID is a descendant of ancestorSessionID by
 * walking the parentID chain up to depth 5.
 *
 * If the candidate is not found in the current cache AND hasn't already
 * triggered a revalidation in this TTL window, force-refresh the cache once
 * and retry the walk. This pattern handles new child sessions created during
 * SSE degradation.
 *
 * @param candidateSessionID - The session ID to check
 * @param ancestorSessionID - The potential ancestor (parent) session ID
 * @param baseUrl - OC daemon base URL
 * @param cwd - Working directory to pass as x-opencode-directory header
 * @returns true if candidate is a descendant; false otherwise
 */
export async function isSessionDescendant(
  candidateSessionID: string,
  ancestorSessionID: string,
  baseUrl: string,
  cwd: string
): Promise<boolean> {
  // Ensure cache is initialized (populate if empty or stale)
  if (!sessionCache || Date.now() - sessionCache.fetchedAt > CACHE_TTL_MS) {
    await getSessionList(baseUrl, cwd);
  }

  const list = sessionCache?.list ?? [];

  // Walk parentID chain from candidate up to depth 5
  let current = candidateSessionID;
  for (let depth = 0; depth < 5; depth++) {
    if (current === ancestorSessionID) return true;
    const session = list.find(s => s.id === current);
    if (!session) break; // candidate or parent not in list
    const parentID = session.parentID;
    if (!parentID) break; // no parent (root session)
    current = parentID;
  }

  // Not found in current cache. Check if we should revalidate.
  // If candidate was not in the cache AND hasn't already triggered
  // a revalidation in this TTL window, do one-shot refresh and retry.
  if (!list.find(s => s.id === candidateSessionID) && !knownMissIDs.has(candidateSessionID)) {
    knownMissIDs.add(candidateSessionID);
    await getSessionList(baseUrl, cwd); // Force refresh
    const freshList = sessionCache?.list ?? [];

    // Retry the walk with fresh cache
    current = candidateSessionID;
    for (let depth = 0; depth < 5; depth++) {
      if (current === ancestorSessionID) return true;
      const session = freshList.find(s => s.id === current);
      if (!session) break;
      const parentID = session.parentID;
      if (!parentID) break;
      current = parentID;
    }
  }

  return false;
}
