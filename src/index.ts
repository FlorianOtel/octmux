import { createOpencodeClient } from "@opencode-ai/sdk/client";

// ---------------------------------------------------------------------------
// Arg parsing — only --attach <port> for Phase 0
// ---------------------------------------------------------------------------

const attachIdx = process.argv.indexOf("--attach");
const port = attachIdx !== -1 ? parseInt(process.argv[attachIdx + 1], 10) : NaN;

if (isNaN(port)) {
  console.error("Usage: octmux --attach <port>");
  process.exit(1);
}

const baseUrl = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Health probe — mirrors opentmux isOpencodeHealthy pattern
// (opentmux/src/bin/opentmux.ts:122)
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 3_000;

async function isOpencodeHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/health`, { signal: controller.signal }).catch(() => null);
    return resp?.ok ?? false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (!(await isOpencodeHealthy(baseUrl))) {
  console.error(`health: failed — no opencode server responding on port ${port}`);
  process.exit(1);
}

console.log("health: ok");

// ---------------------------------------------------------------------------
// SDK smoke test — list sessions and print the count
// ---------------------------------------------------------------------------

const client = createOpencodeClient({ baseUrl });
const result = await client.session.list({});

// The SDK uses a fields-style result; data may be undefined on error.
const sessions = result.data ?? [];
console.log(`sessions: ${sessions.length}`);

process.exit(0);
