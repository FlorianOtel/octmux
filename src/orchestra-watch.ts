import { EventEmitter } from "events";
import type { Backend, OrchestraState } from "./backend/types.ts";

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

// Age-eviction threshold for subagent ticker rows (Layer C backstop). Kept in sync
// with StatusLine.tsx:6 ACTIVITY_FREEZE_MS = 120_000 — the spinner-freeze threshold and
// the eviction threshold deliberately share the same value so a row cannot be both
// "frozen visually" and "still present". If you change one, change the other.
const SUBAGENT_EVICTION_MS = 120_000;

// How often the orchestra state is re-read from the backend.
const ORCHESTRA_POLL_MS = 5000;

/**
 * Tracks the active /brain or /duo run of the REPL's session and emits badge state changes.
 *
 * The run state comes from the backend (`Backend.getOrchestraState`): over the API on v2 (the
 * session's `metadata.orchestra`), from oconona's sidecar files on v1 (legacy, same-host only).
 * Subagent rows come from the event stream through the `notifySubagent*` methods.
 */
export class OrchestraWatcher extends EventEmitter {
  private backend: Backend;
  private badge: OrchestraBadge = null;
  private pollInterval: NodeJS.Timer | null = null;
  private lastSessionIDInput: string | null = null;
  private modelFriendlyMap: Map<string, string> = new Map();    // "provider/modelId" → display name (parent row only)
  private _pendingSubagentQueue: Array<{ sessionID: string; agent: string; model: string; description?: string }> = [];
  // Guards against overlapping refreshes (a slow read and the next poll tick).
  private refreshInFlight = false;

  constructor(backend: Backend) {
    super();
    this.backend = backend;
  }

  /**
   * Start tracking: load the model display names once, read the state now, then every 5 s.
   */
  start(): void {
    void this.loadModelFriendlyNames();
    void this.refresh();
    this.pollInterval = setInterval(() => {
      void this.refresh();
    }, ORCHESTRA_POLL_MS);
  }

  /**
   * Load model display names from the server's model catalog (`Backend.listProviders`), keyed
   * "providerID/modelID". Used only for the badge's parent row label. Errors leave the map empty,
   * and the label then shows the raw model id.
   */
  private async loadModelFriendlyNames(): Promise<void> {
    try {
      const catalog = (await this.backend.listProviders()).data;
      for (const provider of catalog?.all ?? []) {
        for (const [modelKey, model] of Object.entries(provider.models)) {
          if (model.name) this.modelFriendlyMap.set(`${provider.id}/${modelKey}`, model.name);
        }
      }
      // A badge already shown gets its label re-derived on the next refresh.
      void this.refresh();
    } catch {
      // No names: the label falls back to the raw model id.
    }
  }

  /**
   * Format a raw "provider/model" string into the parent row label "[provider/display name]".
   */
  private formatModelLabel(raw?: string): string {
    if (!raw) return "";
    const parts = raw.split("/");
    const providerPart = parts[0];
    const friendly = this.modelFriendlyMap.get(raw) ?? parts.slice(1).join("/") ?? raw;
    return `[${providerPart}/${friendly}]`;
  }

  /**
   * Set the REPL's session and re-read the state for it. Non-blocking.
   */
  setOcSessionID(sessionID: string): void {
    if (sessionID === this.lastSessionIDInput) return;
    this.lastSessionIDInput = sessionID;
    void this.refresh();
  }

  /**
   * Re-read the orchestra state from the backend and update the badge. Subagent rows already shown
   * are kept across refreshes; they are owned by the event stream.
   */
  async refresh(): Promise<void> {
    const sessionID = this.lastSessionIDInput;
    if (sessionID === null || this.refreshInFlight) return;
    this.refreshInFlight = true;
    let state: OrchestraState | null = null;
    try {
      state = await this.backend.getOrchestraState(sessionID);
    } catch {
      state = null;
    } finally {
      this.refreshInFlight = false;
    }
    // The operator may have switched sessions during the read; that result is dropped.
    if (sessionID !== this.lastSessionIDInput) return;
    this._updateBadge(this.toBadge(state));
  }

  /** Builds the badge from the backend state, keeping the current subagent rows. */
  private toBadge(state: OrchestraState | null): OrchestraBadge {
    if (state === null) return null;
    const parentModelRaw = state.model ? `${state.model.providerID}/${state.model.id}` : undefined;
    return {
      mode: state.mode,
      title: state.title,
      lastActivityAt: Date.now(),
      // Preserve subagents across refreshes: the poll runs every 5 s, and without preservation
      // freshly-added rows would be wiped before becoming visible.
      subagents: this.badge?.subagents ?? [],
      parentModelRaw,
      parentModelLabel: this.formatModelLabel(parentModelRaw),
      parserWarnings: state.parserWarnings,
    };
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
   * Internal: compare two badges ignoring lastActivityAt timestamps.
   * Returns true if the content (excluding timestamps) is equal.
   */
  private _badgeContentEquals(a: OrchestraBadge, b: OrchestraBadge): boolean {
    if (a === null || b === null) return a === b;
    
    // Deep clone, strip timestamps via destructuring, then compare
    const strip = (badge: NonNullable<OrchestraBadge>): {
      mode: "brain" | "duo";
      title: string;
      parentModelRaw?: string;
      parentModelLabel?: string;
      subagents: Array<{
        sessionID: string;
        agent: string;
        model: string;
        description?: string;
      }>;
      parserWarnings?: Array<{ code: string; message: string }>;
    } | undefined => {
      const { lastActivityAt: _ts, subagents, ...rest } = badge;
      return {
        ...rest,
        subagents: subagents.map(({ lastActivityAt: _saTs, ...saRest }) => saRest),
      };
    };
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }

  /**
   * Internal: update badge and emit if changed.
   * After setting badge, drain any pending subagent notifications from the queue.
   */
  private _updateBadge(newBadge: OrchestraBadge): void {
    const changed = !this._badgeContentEquals(this.badge, newBadge);
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
    * Layer C backstop: evict subagent rows whose lastActivityAt is older than maxAgeMs.
    * Catches orphaned rows that escaped both metadata-keyed removal (Layer A) and the
    * parent-turn-end sweep (Layer B). Emits "changed" only if rows were actually dropped,
    * to avoid spurious React re-renders.
    */
   sweepStaleSubagents(maxAgeMs: number = SUBAGENT_EVICTION_MS): void {
    if (!this.badge) return;
    const now = Date.now();
    const before = this.badge.subagents.length;
    const kept = this.badge.subagents.filter(
      s => s.lastActivityAt === undefined || (now - s.lastActivityAt) <= maxAgeMs
    );
    if (kept.length === before) return; // nothing dropped — no emit
    this.badge.subagents = kept;
    this.badge = { ...this.badge };
    this.emit("changed", this.badge);
  }

  /**
   * Clean up: stop watching and polling.
   */
  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
