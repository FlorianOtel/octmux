/**
 * Pure helpers for the v2 `resync-needed` handler (Stage 15.2, C2.6b; PLAN-C2C3.md §C step 6).
 *
 * A `resync-needed` event means the v2 stream missed frames (a durable `seq` gap, capture doc §4.11). The
 * app then renders the missed complete messages from REST (no clear, D-A fix), and reconciles the generating
 * state. This module holds the two decisions that have no UI in them:
 *
 * - `ResyncGate`: at most one resync runs at a time. A request that arrives mid-run is not dropped. It
 *   queues one more run, because the run that is in flight may have fetched its history before the new gap.
 * - `decideResync`: after the replay, the generating flag is set to match the REST answer.
 *
 * Unit tests: `resync-gate.test.ts`.
 */

/**
 * Coalesces resync requests. Usage:
 *
 *   if (gate.request()) { do { await runOnce(); } while (gate.finish()); }
 *
 * `request()` returns true when the caller must start a run now. A request during a run returns false and is
 * remembered. `finish()` returns true when a remembered request needs one more run, and false when the gate is
 * idle again.
 */
export class ResyncGate {
  /** True from the moment a run starts until `finish()` reports that no run is queued. */
  private inFlight = false;
  /** True when a request arrived while a run was in flight and no run has started for it yet. */
  private rerunQueued = false;

  /**
   * Asks for a resync run.
   *
   * @returns true when the caller must start a run now. false when a run is already in flight; the request is
   *          then queued for one more run after it.
   */
  request(): boolean {
    if (this.inFlight) {
      this.rerunQueued = true;
      return false;
    }
    this.inFlight = true;
    return true;
  }

  /**
   * Reports that one run has ended.
   *
   * @returns true when a queued request needs another run, so the caller must run again now. The gate stays
   *          in flight for that run. false when nothing is queued, and the gate is idle again.
   */
  finish(): boolean {
    if (this.rerunQueued) {
      this.rerunQueued = false;
      return true;
    }
    this.inFlight = false;
    return false;
  }
}

/** What to do with the generating flag after a resync. */
export type ResyncAction =
  /** Nothing to change: the flag already matches REST, or REST could not answer. */
  | "none"
  /** The session is no longer running. End the turn the same way an idle synthesis does. */
  | "end-turn"
  /** The session is running, but the flag was off (a `session.execution.started` was missed). Turn it on. */
  | "start-turn";

/**
 * Decides the generating-flag change after a resync, from the flag before the resync and the REST answer.
 *
 * `active` comes from `Backend.isSessionActive`. `undefined` means the answer is unknown. In that case the
 * flag is left alone, so a failed lookup never ends or starts a turn by itself.
 *
 * @param wasGenerating The generating flag before the resync.
 * @param active        `true`/`false` from REST, or `undefined` when the answer is unknown.
 */
export function decideResync(wasGenerating: boolean, active: boolean | undefined): ResyncAction {
  if (active === undefined) return "none";
  if (active && !wasGenerating) return "start-turn";
  if (!active && wasGenerating) return "end-turn";
  return "none";
}
