import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";

export type OrchestraBadge = {
  mode: "brain" | "duo";
  title: string;
  subagent?: string | null;
  parserWarnings?: Array<{ code: string; message: string }>;
} | null;

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * Watches ~/.config/opencode/orchestra/sessions/ for active /brain or /duo sessions
 * matching the given OC session ID. Emits badge state changes.
 */
export class OrchestraWatcher extends EventEmitter {
  private client: Client;
  private badge: OrchestraBadge = null;
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timer | null = null;
  private harnessOcSessionID: string | null = null;
  private lastSessionIDInput: string | null = null;

  constructor(client: Client) {
    super();
    this.client = client;
  }

  /**
   * Start watching the orchestra sessions directory.
   * Sets up fs.watch + 5-second fallback poll.
   */
  start(): void {
    // Initial scan
    this.scan();

    const sessionsDir = path.join(
      process.env.HOME || "/root",
      ".config/opencode/orchestra/sessions"
    );

    // Try to set up fs.watch if directory exists
    if (fs.existsSync(sessionsDir)) {
      try {
        this.watcher = fs.watch(sessionsDir, { recursive: false }, () => {
          this.scan();
        });
      } catch {
        // Silently skip if watch fails
      }
    }

    // Fallback: 5-second poll for missed events and NFS lag
    this.pollInterval = setInterval(() => {
      this.scan();
    }, 5000);
  }

  /**
   * Helper: safely realpath both sides of a directory comparison.
   */
  private safeRealpath(dir: string): string {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  }

  /**
   * Resolve the OC session ID to the harness session dir basename.
   * Returns null on failure or if not found. Caches result.
   */
  private async resolveHarnessSessionID(sessionID: string): Promise<string | null> {
    try {
      const resp = await this.client.session.list();
      const sessions = resp.data ?? [];

      // Filter: parentID === null && directory matches current working directory
      const currentCwd = this.safeRealpath(process.cwd());
      const candidates = sessions.filter(s => {
        if (s.parentID != null) return false;
        const sessionCwd = this.safeRealpath(s.directory);
        return sessionCwd === currentCwd;
      });

      // Sort by time.updated descending; take last
      candidates.sort((a, b) => {
        const aTime = (a as any).time?.updated ?? 0;
        const bTime = (b as any).time?.updated ?? 0;
        return bTime - aTime;
      });

      const last = candidates[0];
      return last ? last.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Set the OC session ID and trigger resolution + re-scan.
   * Non-blocking: triggers async resolve in background.
   */
  setOcSessionID(sessionID: string): void {
    if (sessionID === this.lastSessionIDInput) return;
    this.lastSessionIDInput = sessionID;

    // Fire-and-forget async resolve
    this.resolveHarnessSessionID(sessionID).then(resolved => {
      if (resolved !== this.harnessOcSessionID) {
        this.harnessOcSessionID = resolved;
        this.scan();
      }
    }).catch(() => {
      // Silently fail; leave cached value
    });
  }

  /**
   * Read ~/.config/opencode/orchestra/invocations.log and detect active subagent.
   * Filters by session_id matching the provided sessionDirBasename.
   * Returns subagent (or stage for back-compat) if last start event > last end event, null otherwise.
   */
  private readActiveSubagent(sessionDirBasename: string): string | null {
    try {
      const invocPath = path.join(
        os.homedir(),
        ".config/opencode/orchestra/invocations.log"
      );
      if (!fs.existsSync(invocPath)) {
        return null;
      }

      const content = fs.readFileSync(invocPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      let lastStart: { ts: string; subagent?: string | null; stage?: string | null; session_id?: string } | null = null;
      let lastEnd: { ts: string } | null = null;

      // Reverse scan to find most recent start and end events
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.event === "start" && !lastStart) {
            // Skip if session_id present but doesn't match
            if (entry.session_id != null && entry.session_id !== sessionDirBasename) {
              continue;
            }
            lastStart = { ts: entry.ts, subagent: entry.subagent ?? null, stage: entry.stage ?? null, session_id: entry.session_id };
          }
          if (entry.event === "end" && !lastEnd) {
            // Apply same session_id filter as start for cross-session isolation
            if (entry.session_id != null && entry.session_id !== sessionDirBasename) {
              continue; // skip end events from other sessions
            }
            lastEnd = { ts: entry.ts };
          }
          if (lastStart && lastEnd) break;
        } catch {
          // Skip malformed lines
        }
      }

      // Compare timestamps lexicographically (ISO 8601 sorts correctly)
      if (lastStart && (!lastEnd || lastStart.ts > lastEnd.ts)) {
        return lastStart.subagent ?? lastStart.stage ?? null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Scan all session subdirs and return highest-priority matching badge.
   * If harnessOcSessionID is null, emit null badge sync and schedule async resolve.
   */
  scan(): void {
    const sessionsDir = path.join(
      process.env.HOME || "/root",
      ".config/opencode/orchestra/sessions"
    );

    // Two-phase: if harnessOcSessionID not yet resolved, emit null and schedule async.
    if (this.harnessOcSessionID === null && this.lastSessionIDInput !== null) {
      this._updateBadge(null);
      // Async resolve already in progress from setOcSessionID; no need to re-trigger
      return;
    }

    if (!fs.existsSync(sessionsDir)) {
      this._updateBadge(null);
      return;
    }

    let bestBadge: OrchestraBadge = null;
    let bestPrio = -1;
    let bestMtime = 0;
    let matchedSessionCount = 0;
    let bestSessionDirBasename: string | null = null;

    try {
      const entries = fs.readdirSync(sessionsDir);
      for (const entry of entries) {
        const sessionDir = path.join(sessionsDir, entry);
        const stat = fs.statSync(sessionDir);
        if (!stat.isDirectory()) continue;

        // Check .oc-session-id sidecar: must exist and match harnessOcSessionID
        const ocSessionIdPath = path.join(sessionDir, ".oc-session-id");
        let ocSessionIdMatches = false;
        try {
          if (fs.existsSync(ocSessionIdPath) && this.harnessOcSessionID) {
            const storedId = fs.readFileSync(ocSessionIdPath, "utf-8").trim();
            ocSessionIdMatches = storedId === this.harnessOcSessionID;
          }
        } catch {
          // Ignore read errors
        }

        if (!ocSessionIdMatches) continue;
        matchedSessionCount++;

        // Check mtime — skip if older than 24h (stale-after-crash guard)
        const nowSecs = Date.now() / 1000;
        const mtimeSecs = stat.mtimeMs / 1000;
        const ageSecs = nowSecs - mtimeSecs;
        if (ageSecs > 24 * 3600) continue;

        // Read telemetry.json for parser_warnings from this session dir
        const telemetryPath = path.join(sessionDir, "telemetry.json");
        let dirParserWarnings: Array<{ code: string; message: string }> = [];
        try {
          if (fs.existsSync(telemetryPath)) {
            const content = fs.readFileSync(telemetryPath, "utf-8");
            const data = JSON.parse(content);
            if (Array.isArray(data.parser_warnings)) {
              dirParserWarnings = data.parser_warnings;
            }
          }
        } catch {
          // ignore
        }

        // Check for .duo-inflight (priority 2, higher than brain)
        const duoMarkerPath = path.join(sessionDir, ".duo-inflight");
        if (fs.existsSync(duoMarkerPath)) {
          const duoStat = fs.statSync(duoMarkerPath);
          const duoMtime = duoStat.mtimeMs;
          if (duoMtime > bestMtime || (duoMtime === bestMtime && 2 > bestPrio)) {
            try {
              const title = fs.readFileSync(duoMarkerPath, "utf-8").trim();
              const truncated = title.slice(0, 30);
              bestBadge = { mode: "duo", title: truncated, subagent: null, parserWarnings: dirParserWarnings };
              bestPrio = 2;
              bestMtime = duoMtime;
              bestSessionDirBasename = entry;
            } catch {
              // Ignore read errors
            }
          }
        }

        // Check for .brain-inflight (priority 1, lower than duo)
        const brainMarkerPath = path.join(sessionDir, ".brain-inflight");
        if (fs.existsSync(brainMarkerPath)) {
          const brainStat = fs.statSync(brainMarkerPath);
          const brainMtime = brainStat.mtimeMs;
          if (bestPrio < 1 && (brainMtime > bestMtime || bestPrio < 0)) {
            // Read ORCHESTRA_TITLE from ~/.config/opencode/orchestra/state.env
            const stateEnvPath = path.join(
              process.env.HOME || "/root",
              ".config/opencode/orchestra/state.env"
            );
            let title = "brain";
            try {
              if (fs.existsSync(stateEnvPath)) {
                const content = fs.readFileSync(stateEnvPath, "utf-8");
                const match = content.match(/^ORCHESTRA_TITLE=(.*)$/m);
                if (match && match[1]) {
                  title = match[1];
                }
              }
            } catch {
              // Ignore read errors; use default
            }
            const truncated = title.slice(0, 30);
            bestBadge = { mode: "brain", title: truncated, subagent: null, parserWarnings: dirParserWarnings };
            bestPrio = 1;
            bestMtime = brainMtime;
            bestSessionDirBasename = entry;
          }
        }
      }

      // Multi-concurrent: if 2+ matched session dirs have inflight markers, render count
      if (matchedSessionCount > 1 && bestBadge) {
        bestBadge = { ...bestBadge, title: `#${matchedSessionCount}` };
      }
    } catch {
      // Silently ignore scan errors
    }

    // Attach active subagent if badge is non-null
    if (bestBadge && bestSessionDirBasename) {
      bestBadge.subagent = this.readActiveSubagent(bestSessionDirBasename);
    }

    this._updateBadge(bestBadge);
  }

  /**
   * Get the current badge state.
   */
  getBadge(): OrchestraBadge {
    return this.badge;
  }

  /**
   * Emit a "changed" event if badge state changed.
   */
  on(event: "changed", callback: (badge: OrchestraBadge) => void): this;
  on(event: string, callback: (...args: any[]) => void): this {
    return super.on(event, callback);
  }

  /**
   * Internal: update badge and emit if changed.
   */
  private _updateBadge(newBadge: OrchestraBadge): void {
    const changed = JSON.stringify(this.badge) !== JSON.stringify(newBadge);
    if (changed) {
      this.badge = newBadge;
      this.emit("changed", newBadge);
    }
  }

  /**
   * Clean up: stop watching and polling.
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
