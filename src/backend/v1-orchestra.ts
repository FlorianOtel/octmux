/**
 * Legacy (v1 only): the orchestra badge state read from oconona's sidecar files.
 *
 * oconona's /brain and /duo setup writes its session directories under
 * ~/.config/opencode/orchestra/sessions/ on the OpenCode server's host. octmux is an
 * OpenCode client, and on v2 it reads the same state over the API instead
 * (src/backend/v2-orchestra.ts). v1 has no API channel for it, so the v1 path keeps
 * reading the files on octmux's own disk. That only works when the server runs on the
 * same host as octmux, under the same $HOME.
 *
 * File contract (oconona v7.5, see docs/octmux--orchestra-implementation-details.md):
 * - `<dir>/.oc-session-id`: the harness OpenCode session id.
 * - `<dir>/.brain-inflight` / `<dir>/.duo-inflight`: present while the run is active; the
 *   content is the badge title. duo wins over brain; a newer marker wins over an older one.
 * - `<dir>/telemetry.json`: `parser_warnings` is shown as " !" on the badge.
 * - A directory older than 24 h is ignored (stale-after-crash guard).
 */

import * as fs from "fs";
import * as path from "path";
import type { OrchestraState, SessionRecord } from "./types.ts";

/** Lists the server's sessions (`BackendSession.list`). */
export type ListSessions = () => Promise<SessionRecord[] | undefined>;

/** Safely realpath one side of a directory comparison. */
function safeRealpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Reads the v1 orchestra state. The harness session is resolved once per REPL session id: the most
 * recently updated top-level session whose directory equals octmux's local working directory.
 */
export class V1OrchestraFileReader {
  private resolvedFor: string | null = null;
  private harnessID: string | null = null;
  private harnessModel: { providerID: string; id: string } | undefined = undefined;

  constructor(
    private readonly listSessions: ListSessions,
    private readonly sessionsDir: string = path.join(process.env.HOME || "/root", ".config/opencode/orchestra/sessions"),
  ) {}

  async read(sessionID: string): Promise<OrchestraState | null> {
    if (sessionID !== this.resolvedFor) {
      this.resolvedFor = sessionID;
      await this.resolveHarness();
    }
    if (this.harnessID === null) return null;
    return this.scan(this.harnessID);
  }

  /** Harness session: newest top-level session in octmux's local working directory. */
  private async resolveHarness(): Promise<void> {
    this.harnessID = null;
    this.harnessModel = undefined;
    try {
      const sessions = (await this.listSessions()) ?? [];
      const currentCwd = safeRealpath(process.cwd());
      const candidates = sessions.filter((s) => s.parentID == null && safeRealpath(s.directory) === currentCwd);
      candidates.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      const last = candidates[0];
      if (last) {
        this.harnessID = last.id;
        this.harnessModel = last.model;
      }
    } catch {
      // Leave the harness unresolved; the badge stays off.
    }
  }

  /** Scans the session directories for the highest-priority live run of the harness session. */
  private scan(harnessID: string): OrchestraState | null {
    if (!fs.existsSync(this.sessionsDir)) return null;

    let best: OrchestraState | null = null;
    let bestPrio = -1;
    let bestMtime = 0;
    let liveCount = 0;

    try {
      for (const entry of fs.readdirSync(this.sessionsDir)) {
        const sessionDir = path.join(this.sessionsDir, entry);
        const stat = fs.statSync(sessionDir);
        if (!stat.isDirectory()) continue;

        // The .oc-session-id sidecar must name the harness session.
        let matches = false;
        try {
          const idPath = path.join(sessionDir, ".oc-session-id");
          if (fs.existsSync(idPath)) matches = fs.readFileSync(idPath, "utf-8").trim() === harnessID;
        } catch {
          // Unreadable sidecar: not a match.
        }
        if (!matches) continue;

        // Stale-after-crash guard: ignore directories older than 24 h.
        if (Date.now() - stat.mtimeMs > 24 * 3600 * 1000) continue;

        let parserWarnings: Array<{ code: string; message: string }> = [];
        try {
          const telemetryPath = path.join(sessionDir, "telemetry.json");
          if (fs.existsSync(telemetryPath)) {
            const data = JSON.parse(fs.readFileSync(telemetryPath, "utf-8"));
            if (Array.isArray(data.parser_warnings)) parserWarnings = data.parser_warnings;
          }
        } catch {
          // Unreadable telemetry: no warnings.
        }

        // Only a directory with a live inflight marker counts toward concurrency. A completed
        // directory (same .oc-session-id, no marker) must not make a single run look concurrent.
        let live = false;

        // .duo-inflight: priority 2, above brain.
        const duoPath = path.join(sessionDir, ".duo-inflight");
        if (fs.existsSync(duoPath)) {
          live = true;
          const mtime = fs.statSync(duoPath).mtimeMs;
          if (mtime > bestMtime || (mtime === bestMtime && 2 > bestPrio)) {
            try {
              // The stored value embeds the mode prefix ("orchestra light - <title>"); passed through.
              const title = fs.readFileSync(duoPath, "utf-8").trim().slice(0, 48);
              best = { mode: "duo", title, parserWarnings, model: this.harnessModel };
              bestPrio = 2;
              bestMtime = mtime;
            } catch {
              // Unreadable marker: skip it.
            }
          }
        }

        // .brain-inflight: priority 1.
        const brainPath = path.join(sessionDir, ".brain-inflight");
        if (fs.existsSync(brainPath)) {
          live = true;
          const mtime = fs.statSync(brainPath).mtimeMs;
          if (bestPrio < 1 && (mtime > bestMtime || bestPrio < 0)) {
            // The stored value embeds the mode prefix ("orchestra full - <title>"); passed through.
            const raw = fs.readFileSync(brainPath, "utf-8").trim();
            best = { mode: "brain", title: (raw || "orchestra full - brain").slice(0, 48), parserWarnings, model: this.harnessModel };
            bestPrio = 1;
            bestMtime = mtime;
          }
        }

        if (live) liveCount++;
      }

      // Two or more live runs of the same harness: the title shows the count.
      if (liveCount > 1 && best) best = { ...best, title: `orchestra light - #${liveCount}` };
    } catch {
      // Scan errors leave whatever was found so far.
    }
    return best;
  }
}
