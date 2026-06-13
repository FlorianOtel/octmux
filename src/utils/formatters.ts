import type { createOpencodeClient } from "@opencode-ai/sdk/client";

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * Format a token count as a human-readable string.
 * >= 1_000_000 → "1.2M" (1 decimal, drop trailing .0)
 * >= 1_000 → "12K" (1 decimal, drop trailing .0)
 * else → "500" (integer)
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return String(n);
}

/**
 * Fetch the current git branch name via Bun.spawn.
 * Returns empty string if not in a git repo or on error.
 */
export async function fetchGitBranch(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return "";
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Fallback context window sizes for known models.
 */
export const MODEL_CONTEXT_FALLBACK: Record<string, number> = {
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-4-6-20250514": 1_000_000,
  "claude-sonnet-4-5-20241022": 200_000,
  "claude-haiku-4-5-20241001": 200_000,
  "claude-opus-4-7-20250219": 1_000_000,
  "claude-fable-5": 1_000_000,
};

/**
 * Cache for context window lookups: ${providerID}/${modelID} → context window
 */
const contextWindowCache = new Map<string, number>();

/**
 * Get the context window size for a model.
 * 1. Calls client.provider.list(), finds matching provider/model, reads limit.context
 * 2. Falls back to MODEL_CONTEXT_FALLBACK[modelID]
 * 3. Falls back to 200_000
 * Never throws; swallows errors silently.
 */
export async function getContextWindow(
  client: Client,
  providerID: string,
  modelID: string,
): Promise<number> {
  const cacheKey = `${providerID}/${modelID}`;
  if (contextWindowCache.has(cacheKey)) {
    return contextWindowCache.get(cacheKey)!;
  }

  try {
    const resp = await client.provider.list();
    const provData = resp.data;
    if (provData) {
      // Pass 1: match provider ID first, then model by dict key OR mInfo.id field.
      // The dict key format may differ from sess.model.id (e.g. "moonshot/kimi-k2.7" vs "kimi-k2.7").
      for (const p of provData.all) {
        if (p.id === providerID) {
          for (const [mId, mInfo] of Object.entries(p.models)) {
            if (mId === modelID || mInfo.id === modelID) {
              const rawCtx = mInfo.limit?.context;
              if (rawCtx && typeof rawCtx === "number") {
                contextWindowCache.set(cacheKey, rawCtx);
                return rawCtx;
              }
            }
          }
        }
      }
      // Pass 2: provider ID mismatch — search all providers by model ID.
      // Covers cases where the routing provider (e.g. openrouter) differs from providerID.
      for (const p of provData.all) {
        for (const [mId, mInfo] of Object.entries(p.models)) {
          if (mId === modelID || mInfo.id === modelID) {
            const rawCtx = mInfo.limit?.context;
            if (rawCtx && typeof rawCtx === "number") {
              contextWindowCache.set(cacheKey, rawCtx);
              return rawCtx;
            }
          }
        }
      }
    }
  } catch {
    // Silently swallow errors
  }

  // Fallback to model ID map, then hard default
  const fallback = MODEL_CONTEXT_FALLBACK[modelID] ?? 200_000;
  contextWindowCache.set(cacheKey, fallback);
  return fallback;
}

/**
 * Cache for tool_call lookups: ${providerID}/${modelID} → boolean | undefined.
 * `undefined` cached entries mean "looked up, not discoverable" — we don't refetch.
 */
const toolCallCache = new Map<string, boolean | undefined>();

/**
 * Discover whether a model supports the Anthropic-style tool-use protocol.
 * Mirrors `getContextWindow`: two-pass provider/model match against
 * `client.provider.list()`, swallows errors, never throws.
 * Returns `undefined` when the field is missing or the lookup fails — callers
 * should treat undefined as "don't warn" (uncertain, not negative).
 */
export async function getToolCallSupport(
  client: Client,
  providerID: string,
  modelID: string,
): Promise<boolean | undefined> {
  const cacheKey = `${providerID}/${modelID}`;
  if (toolCallCache.has(cacheKey)) {
    return toolCallCache.get(cacheKey);
  }

  try {
    const resp = await client.provider.list();
    const provData = resp.data;
    if (provData) {
      for (const p of provData.all) {
        if (p.id === providerID) {
          for (const [mId, mInfo] of Object.entries(p.models)) {
            if (mId === modelID || mInfo.id === modelID) {
              const tc = (mInfo as { tool_call?: boolean }).tool_call;
              if (typeof tc === "boolean") {
                toolCallCache.set(cacheKey, tc);
                return tc;
              }
            }
          }
        }
      }
      for (const p of provData.all) {
        for (const [mId, mInfo] of Object.entries(p.models)) {
          if (mId === modelID || mInfo.id === modelID) {
            const tc = (mInfo as { tool_call?: boolean }).tool_call;
            if (typeof tc === "boolean") {
              toolCallCache.set(cacheKey, tc);
              return tc;
            }
          }
        }
      }
    }
  } catch {
    // Silently swallow errors
  }

  toolCallCache.set(cacheKey, undefined);
  return undefined;
}

/**
 * Get the default model from the OC server config.
 * Calls client.config.get(), reads config.model (e.g. "sohoai/glm-5.1"),
 * and splits on the first "/" to extract providerID/modelID.
 * Returns { providerID, modelID } | null. Swallows errors silently.
 * If config.model has no "/" or is not set, returns null.
 */
export async function getDefaultModel(client: Client): Promise<{ providerID: string; modelID: string } | null> {
  try {
    const resp = await client.config.get();
    const cfg = resp.data;
    if (!cfg?.model) return null;

    const model = cfg.model;
    const slashIdx = model.indexOf("/");
    if (slashIdx < 0) {
      // No "/" — return null; this will fall back to session.model or last-resort ternary
      return null;
    }

    const providerID = model.substring(0, slashIdx);
    const modelID = model.substring(slashIdx + 1);
    return { providerID, modelID };
  } catch {
    // Silently swallow errors
    return null;
  }
}

/**
 * Pretty-print a model ID.
 * "claude-sonnet-4-6" → "Sonnet 4.6"
 * Unknown IDs returned as-is.
 */
export function prettyModelName(modelID: string): string {
  const mapping: Record<string, string> = {
    "claude-sonnet-4-6": "Sonnet 4.6",
    "claude-sonnet-4-5": "Sonnet 4.5",
    "claude-haiku-4-5": "Haiku 4.5",
    "claude-opus-4-7": "Opus 4.7",
    "claude-sonnet-4-6-20250514": "Sonnet 4.6",
    "claude-sonnet-4-5-20241022": "Sonnet 4.5",
    "claude-haiku-4-5-20241001": "Haiku 4.5",
    "claude-opus-4-7-20250219": "Opus 4.7",
    "claude-fable-5": "Fable 5",
  };
  return mapping[modelID] ?? modelID;
}

/**
 * Format a context window as a labeled string.
 * "1M context", "200K context", etc.
 */
export function contextLabel(contextWindow: number): string {
  return `${formatTokens(contextWindow)} context`;
}
