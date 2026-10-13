/**
 * Pure helpers for the v2-only turn and compaction status lines (Stage 15.2, C2.6b).
 *
 * These functions decide what a status line says and whether a retry line is new. They do not touch the
 * renderer or React state, so `src/app.tsx` calls them and does the rendering. Unit tests: `turn-status.test.ts`.
 */

/**
 * True when a `turn-retry` event announces an attempt that has not been shown yet in this turn.
 *
 * The v2 server numbers attempts from 2 upwards within one turn (capture doc §4.3). A repeated event for
 * the same attempt, or an older one, must not add a second line. `lastShownAttempt` is 0 at the start of a
 * turn, so the first retry (attempt 2) always passes.
 *
 * @param lastShownAttempt The highest attempt number already shown in the current turn, or 0.
 * @param attempt          The attempt number in the `turn-retry` event.
 */
export function isNewRetryAttempt(lastShownAttempt: number, attempt: number): boolean {
  return attempt > lastShownAttempt;
}

/**
 * The transient system line for one retry attempt: `retrying (attempt N): <message>`.
 *
 * An empty provider message gives `retrying (attempt N)` with no colon, so the line never ends in ": ".
 *
 * @param attempt The attempt number that is about to run.
 * @param message The provider error text, or "" when the server gave none.
 */
export function formatRetryLine(attempt: number, message: string): string {
  const trimmed = message.trim();
  return trimmed === "" ? `retrying (attempt ${attempt})` : `retrying (attempt ${attempt}): ${trimmed}`;
}

/**
 * The error line for a failed compaction: `compaction failed: <message>`.
 *
 * The translator (`src/backend/v2-events.ts`) falls back to the text "no error detail from server" when the
 * server gave no error text, so the line reads "compaction failed: no error detail from server".
 * An empty message gives the bare "compaction failed".
 *
 * @param message The failure text from the `compaction-failed` event.
 */
export function formatCompactionFailedLine(message: string): string {
  const trimmed = message.trim();
  return trimmed === "" ? "compaction failed" : `compaction failed: ${trimmed}`;
}

/**
 * The start time of the "generating" elapsed-time line after a `message-completed` event (Stage 15.2, G1).
 *
 * `message-completed` restarts the timer so the display counts from zero for the next message of a turn. It must
 * only restart a timer that is still running. A turn ends at `session-idle`, which clears the timer, and a
 * `message-completed` that arrives after that would otherwise set a new start time, and nothing would clear it
 * again. The line then stays on screen with a frozen "0:00" elapsed time, until the next turn.
 *
 * @param isGenerating Whether the turn is still in progress (the app's `isGenerating` flag, read from its ref).
 * @param now          The current time in ms, as `Date.now()`.
 * @returns `now` while the turn runs, or `null` when it has ended, so the line stays hidden.
 */
export function generatingStartAfterMessageCompleted(isGenerating: boolean, now: number): number | null {
  return isGenerating ? now : null;
}
