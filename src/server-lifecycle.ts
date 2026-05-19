import { createServer } from "net";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Checks if a port is free by attempting to bind a server to it.
async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

// Finds the first free port in [start, end]. Returns null if all are occupied.
export async function findFreePort(start: number, end: number): Promise<number | null> {
  for (let port = start; port <= end; port++) {
    if (await checkPort(port)) return port;
  }
  return null;
}

// Locates the opencode binary via `which`, with fallbacks for dev installs.
// opencode is not on PATH here — lives at ~/.opencode/bin/opencode.
export function findOpencodeBin(): string | null {
  try {
    const whichPath = execSync("which opencode", { encoding: "utf-8" }).trim();
    if (whichPath) return whichPath;
  } catch {
    // which failed; try fallbacks
  }

  const fallbacks = [
    join(homedir(), ".opencode", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  return null;
}

// Polls /health until it responds OK or the deadline is exceeded.
export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 200;
  while (true as boolean) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`opencode did not become healthy within ${timeoutMs}ms`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const resp = await fetch(`${url}/health`, { signal: controller.signal }).catch(() => null);
      if (resp?.ok) {
        clearTimeout(timer);
        return;
      }
    } catch {
      // fetch failed; retry
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}

// Lifecycle handle returned by spawnOpencodeServer.
export interface ServerHandle {
  url: string;
  port: number;
  dispose(): Promise<void>;
}

// Spawns opencode on a given port, waits for /health, returns a dispose handle.
// proc.unref() lets octmux exit without killing the server (intentional).
export async function spawnOpencodeServer(port: number): Promise<ServerHandle> {
  const bin = findOpencodeBin();
  if (!bin) {
    throw new Error("opencode binary not found; install opencode or add to PATH");
  }

  const proc = Bun.spawn([bin, "serve", "--port", String(port)], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();

  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, 10_000);

  return {
    url,
    port,
    dispose: async () => {
      proc.kill("SIGTERM");
      await Promise.race([
        proc.exited,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}
