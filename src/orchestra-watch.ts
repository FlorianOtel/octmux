import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

export type OrchestraBadge = {
  mode: "brain" | "duo";
  title: string;
  stage?: string | null;
} | null;

/**
 * Watches ~/.config/opencode/orchestra/sessions/ for active /brain or /duo sessions
 * matching the given project directory. Emits badge state changes.
 */
export class OrchestraWatcher extends EventEmitter {
  private projectDir: string;
  private badge: OrchestraBadge = null;
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timer | null = null;

  constructor(projectDir: string) {
    super();
    this.projectDir = projectDir.trim();
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
   * Read ~/.config/opencode/orchestra/invocations.log and detect active stage.
   * Returns stage name if last start event > last end event, null otherwise.
   */
  private readActiveStage(): string | null {
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

      let lastStart: { ts: string; stage: string } | null = null;
      let lastEnd: { ts: string } | null = null;

      // Reverse scan to find most recent start and end events
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.event === "start" && !lastStart) {
            lastStart = { ts: entry.ts, stage: entry.stage };
          }
          if (entry.event === "end" && !lastEnd) {
            lastEnd = { ts: entry.ts };
          }
          if (lastStart && lastEnd) break;
        } catch {
          // Skip malformed lines
        }
      }

      // Compare timestamps lexicographically (ISO 8601 sorts correctly)
      if (lastStart && (!lastEnd || lastStart.ts > lastEnd.ts)) {
        return lastStart.stage || null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Scan all session subdirs and return highest-priority matching badge.
   */
  scan(): void {
    const sessionsDir = path.join(
      process.env.HOME || "/root",
      ".config/opencode/orchestra/sessions"
    );

    if (!fs.existsSync(sessionsDir)) {
      this._updateBadge(null);
      return;
    }

    let bestBadge: OrchestraBadge = null;
    let bestPrio = -1;
    let bestMtime = 0;

    try {
      const entries = fs.readdirSync(sessionsDir);
      for (const entry of entries) {
        const sessionDir = path.join(sessionsDir, entry);
        const stat = fs.statSync(sessionDir);
        if (!stat.isDirectory()) continue;

        // Check .project-dir sidecar
        const projectDirPath = path.join(sessionDir, ".project-dir");
        let projectDirMatches = false;
        try {
          if (fs.existsSync(projectDirPath)) {
            const storedDir = fs.readFileSync(projectDirPath, "utf-8").trim();
            // Normalize via realpathSync: brain.md writes $PWD (logical/symlink path),
            // but process.cwd() in Bun returns the real path (getcwd syscall resolves symlinks).
            // Without this, the badge never shows when octmux is launched via a symlink.
            const resolvedStoredDir = (() => { try { return fs.realpathSync(storedDir); } catch { return storedDir; } })();
            projectDirMatches = resolvedStoredDir === this.projectDir;
          }
        } catch {
          // Ignore read errors
        }

        if (!projectDirMatches) continue;

        // Check mtime — skip if older than 24h (stale-after-crash guard)
        const nowSecs = Date.now() / 1000;
        const mtimeSecs = stat.mtimeMs / 1000;
        const ageSecs = nowSecs - mtimeSecs;
        if (ageSecs > 24 * 3600) continue;

        // Check for .duo-inflight (priority 2, higher than brain)
        const duoMarkerPath = path.join(sessionDir, ".duo-inflight");
        if (fs.existsSync(duoMarkerPath)) {
          const duoStat = fs.statSync(duoMarkerPath);
          const duoMtime = duoStat.mtimeMs;
          if (duoMtime > bestMtime || (duoMtime === bestMtime && 2 > bestPrio)) {
            try {
              const title = fs.readFileSync(duoMarkerPath, "utf-8").trim();
              const truncated = title.slice(0, 30);
              bestBadge = { mode: "duo", title: truncated };
              bestPrio = 2;
              bestMtime = duoMtime;
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
            bestBadge = { mode: "brain", title: truncated };
            bestPrio = 1;
            bestMtime = brainMtime;
          }
        }
      }
    } catch {
      // Silently ignore scan errors
    }

    // Attach active stage if badge is non-null
    if (bestBadge) {
      bestBadge.stage = this.readActiveStage();
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
