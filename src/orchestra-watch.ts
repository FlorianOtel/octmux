import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import type { createOpencodeClient } from "@opencode-ai/sdk/client";

export type OrchestraBadge = {
  mode: "brain" | "duo";
  title: string;
  parentModelRaw?: string;
  parentModelLabel?: string;
  lastActivityAt: number;
  subagents: Array<{
    sessionID: string;
    agent: string;
    model: string;
    description?: string;
    lastActivityAt: number;
  }>;
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
  private modelFriendlyMap: Map<string, string> = new Map();    // "provider/modelId" → friendly name (parent row only)
  private harnessOcSessionModel: { providerID: string; id: string } | null = null;
  private _pendingSubagentQueue: Array<{ sessionID: string; agent: string; model: string; description?: string }> = [];

  constructor(client: Client) {
    super();
    this.client = client;
  }

  /**
   * Start watching the orchestra sessions directory.
   * Sets up fs.watch + 5-second fallback poll.
   */
  start(): void {
    // Load friendly model names for the parent (harness) row display.
    this.loadModelFriendlyNames();

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
      if (last) {
        const modelField = (last as any).model as { providerID: string; id: string } | undefined;
        this.harnessOcSessionModel = modelField ?? null;
      }
      return last ? last.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Load friendly model names from ~/.config/opencode/opencode.json.
   */
  private loadModelFriendlyNames(): void {
    try {
      const configPath = path.join(
        process.env.HOME || "/root",
        ".config/opencode/opencode.json"
      );
      if (!fs.existsSync(configPath)) return;

      const content = fs.readFileSync(configPath, "utf-8");
      const data = JSON.parse(content) as {
        provider?: Record<string, { models?: Record<string, { name?: string }> }>;
      };

      if (data.provider) {
        for (const [providerKey, providerData] of Object.entries(data.provider)) {
          if (providerData.models) {
            for (const [modelKey, modelData] of Object.entries(providerData.models)) {
              const friendlyName = (modelData as any).name;
              if (friendlyName) {
                const key = `${providerKey}/${modelKey}`;
                this.modelFriendlyMap.set(key, friendlyName);
              }
            }
          }
        }
      }
    } catch {
      // Silent on parse/read errors
    }
  }

  /**
   * Format a raw model string into a labeled display string.
   * Format: [provider/friendly] where friendly is looked up from opencode.json.
   */
  private formatModelLabel(raw?: string): string {
    if (!raw) return "";
    const parts = raw.split("/");
    const providerPart = parts[0];
    const friendly = this.modelFriendlyMap.get(raw) ?? parts.slice(1).join("/") ?? raw;
    return `[${providerPart}/${friendly}]`;
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

        // Track whether THIS dir contributes a live inflight marker. Only
        // count such dirs toward matchedSessionCount — completed dirs (same
        // .oc-session-id but no marker) must not inflate the concurrency
        // count, otherwise the #N rewrite below mislabels a single live
        // session as multi-concurrent on every subsequent /brain run.
        let dirHasInflight = false;

        // Check for .duo-inflight (priority 2, higher than brain)
        const duoMarkerPath = path.join(sessionDir, ".duo-inflight");
        if (fs.existsSync(duoMarkerPath)) {
          dirHasInflight = true;
          const duoStat = fs.statSync(duoMarkerPath);
          const duoMtime = duoStat.mtimeMs;
          if (duoMtime > bestMtime || (duoMtime === bestMtime && 2 > bestPrio)) {
            try {
              const title = fs.readFileSync(duoMarkerPath, "utf-8").trim();
              const truncated = title.slice(0, 30);
              bestBadge = {
                mode: "duo",
                title: truncated,
                lastActivityAt: Date.now(),
                // Preserve subagents across re-scans: scan() runs every 5s (poll)
                // and on fs.watch fires; without preservation, freshly-added rows
                // would be wiped before becoming visible.
                subagents: this.badge?.subagents ?? [],
                parentModelRaw: this.harnessOcSessionModel
                  ? `${this.harnessOcSessionModel.providerID}/${this.harnessOcSessionModel.id}`
                  : undefined,
                parentModelLabel: this.formatModelLabel(
                  this.harnessOcSessionModel
                    ? `${this.harnessOcSessionModel.providerID}/${this.harnessOcSessionModel.id}`
                    : undefined
                ),
                parserWarnings: dirParserWarnings,
              };
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
          dirHasInflight = true;
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
            bestBadge = {
              mode: "brain",
              title: truncated,
              lastActivityAt: Date.now(),
              // Preserve subagents across re-scans (see duo branch comment).
              subagents: this.badge?.subagents ?? [],
              parentModelRaw: this.harnessOcSessionModel
                ? `${this.harnessOcSessionModel.providerID}/${this.harnessOcSessionModel.id}`
                : undefined,
              parentModelLabel: this.formatModelLabel(
                this.harnessOcSessionModel
                  ? `${this.harnessOcSessionModel.providerID}/${this.harnessOcSessionModel.id}`
                  : undefined
              ),
              parserWarnings: dirParserWarnings,
            };
            bestPrio = 1;
            bestMtime = brainMtime;
          }
        }

        if (dirHasInflight) matchedSessionCount++;
      }

      // Multi-concurrent: if 2+ matched session dirs have inflight markers, render count
      if (matchedSessionCount > 1 && bestBadge) {
        bestBadge = { ...bestBadge, title: `#${matchedSessionCount}` };
      }
    } catch {
      // Silently ignore scan errors
    }

    this._updateBadge(bestBadge);
  }

  /**
   * Notify of a detected subagent dispatch (child session created with
   * parentID === harness sessionID). Queue-and-drain: if badge is null
   * (badge-scan hasn't materialised it yet), buffer the call until
   * `_updateBadge` produces a non-null badge.
   */
  notifySubagentStarted(sessionID: string, agent: string, model: string, description?: string): void {
    if (process.env.OCTMUX_DEBUG_SSE === "1") {
      console.error(
        "[octmux-debug] notifySubagentStarted sessionID=" + sessionID +
        " agent=" + agent +
        " model=" + model +
        " badgePresent=" + String(this.badge !== null) +
        " queueLen=" + this._pendingSubagentQueue.length
      );
    }
    if (!this.badge) {
      this._pendingSubagentQueue.push({ sessionID, agent, model, description });
      return;
    }

    // Dedup by child sessionID.
    if (this.badge.subagents.some(s => s.sessionID === sessionID)) return;

    this.badge.subagents.push({
      sessionID,
      agent,
      model,
      description,
      lastActivityAt: Date.now(),
    });

    // New top-level reference so React's setOrchestraBadge sees a different
    // object and re-renders immediately. The subagents array reference is
    // shared (with the recent push), so StatusLine reads the latest state.
    this.badge = {...this.badge};
    this.emit("changed", this.badge);
  }

  /**
   * Notify of a subagent's session ending (session.idle or session.deleted
   * for the child sessionID).
   */
  notifySubagentEnded(sessionID: string): void {
    if (!this.badge) return;

    this.badge.subagents = this.badge.subagents.filter(s => s.sessionID !== sessionID);
    this.badge = {...this.badge};
    this.emit("changed", this.badge);
  }

  /**
   * Notify all subagents ended (parent session-idle force-flush).
   */
  notifyAllSubagentsEnded(): void {
    if (!this.badge) return;

    this.badge.subagents = [];
    this.badge = {...this.badge};
    this.emit("changed", this.badge);
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
   * After setting badge, drain any pending subagent notifications from the queue.
   */
  private _updateBadge(newBadge: OrchestraBadge): void {
    const changed = JSON.stringify(this.badge) !== JSON.stringify(newBadge);
    if (changed) {
      this.badge = newBadge;
      this.emit("changed", newBadge);
    }

    if (newBadge !== null && this._pendingSubagentQueue.length > 0) {
      const pendingLenBefore = this._pendingSubagentQueue.length;
      const subagentsLenBefore = newBadge.subagents.length;
      if (process.env.OCTMUX_DEBUG_SSE === "1") {
        console.error(
          "[octmux-debug] _updateBadge drain pendingLen=" + pendingLenBefore +
          " badgeSubagentsBefore=" + subagentsLenBefore
        );
      }
      const queue = this._pendingSubagentQueue.splice(0);
      for (const item of queue) {
        if (newBadge.subagents.some(s => s.sessionID === item.sessionID)) continue;

        newBadge.subagents.push({
          sessionID: item.sessionID,
          agent: item.agent,
          model: item.model,
          description: item.description,
          lastActivityAt: Date.now(),
        });
      }
      if (process.env.OCTMUX_DEBUG_SSE === "1") {
        console.error("[octmux-debug] _updateBadge drain done badgeSubagentsAfter=" + newBadge.subagents.length);
      }

      // New top-level reference for React re-render (drain shares the same
      // newBadge object — `this.badge` is set to it earlier in this method).
      this.badge = {...newBadge};
      this.emit("changed", this.badge);
    }
  }

  /**
   * Bump the parent (harness) row's activity timestamp. Direct mutation +
   * emit (bypasses JSON.stringify diff in _updateBadge).
   */
  notifyParentActivity(ts: number): void {
    if (this.badge) {
      this.badge.lastActivityAt = ts;
      this.badge = {...this.badge};
      this.emit("changed", this.badge);
    }
  }

  /**
   * Bump activity on a single subagent row by child sessionID. Mirrors
   * `notifyParentActivity`: direct mutation + emit, same-reference bailout
   * suppresses unrelated re-render.
   */
  notifySubagentActivity(sessionID: string, ts: number): void {
    if (!this.badge) return;
    const subagent = this.badge.subagents.find(s => s.sessionID === sessionID);
    if (subagent) {
      subagent.lastActivityAt = ts;
      this.badge = {...this.badge};
      this.emit("changed", this.badge);
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
