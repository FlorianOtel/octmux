/**
 * Pure helpers for the v2 `resync-needed` handler (Stage 15.2, C2.6b; PLAN-C2C3.md §C step 6).
 *
 * A `resync-needed` event means the v2 stream missed frames (a durable `seq` gap, capture doc §4.11). The
 * app then renders the missed complete messages from REST (no clear, D-A fix), and reconciles the generating
 * and compacting state. This module holds the decisions that have no UI in them:
 *
 * - `ResyncGate`: at most one resync runs at a time. A request that arrives mid-run is not dropped. It
 *   queues one more run, because the run that is in flight may have fetched its history before the new gap.
 * - `decideResync`: after the replay, the generating flag is set to match the REST answer.
 * - `shouldEndCompacting`: after the replay, the compacting flag is cleared when the compaction is over.
 *
 * Unit tests: `resync-gate.test.ts`.
 */

// Type-only import: erased at runtime, so it cannot create an import cycle with `replay.ts`.
import type { HistoryOp } from "./replay.ts";

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

/**
 * Decides whether the compacting flag must be cleared after a resync.
 *
 * Why this is needed: the server skips one durable `seq` between `session.compaction.started` and
 * `session.compaction.ended` (`docs/OpenCode-v2-protocol-capture.md` capture 3b: seq 83 → 85; seen live as 46 → 48).
 * The seq gap check therefore reports a gap, and the translator drops `compaction.ended`. Nothing else
 * ends the compacting state, so the resync must end it itself. Two signals say the compaction is over:
 *
 * - The missed history contains a `compaction-divider`. The compaction completed, and its divider was rendered.
 * - REST says the session is not active (`active === false`). No compaction can still be running then.
 *
 * `undefined` for `active` (the answer is unknown) is not a signal, so it never clears the flag by itself.
 *
 * @param missedOps The history ops rendered by this resync. Empty when nothing was missed or the fetch failed.
 * @param active    `true`/`false` from REST, or `undefined` when the answer is unknown.
 * @returns true when the compacting flag should be set to false.
 */
export function shouldEndCompacting(missedOps: HistoryOp[], active: boolean | undefined): boolean {
  const divider = missedOps.some((op) => op.op === "compaction-divider");
  return divider || active === false;
}
