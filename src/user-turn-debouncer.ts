/**
 * Per-messageID debouncer for foreign user turns (Stage 13.x).
 *
 * Lives here (not in events.ts) because the eight existing synchronous
 * contract tests in events.test.ts (lines 798–917) must remain synchronous
 * and timer-free. Moving timers into events.ts would risk their interference
 * with those contract tests. The debouncer calls back into events-originated
 * functions (classifyUserTurn) from app.tsx, not from events.ts itself, so
 * event classification itself remains pure.
 */

export const USER_TURN_DEBOUNCE_MS = 250; // ~47x margin over measured 5.3ms intra-message
                                          // SSE part gap; 12-40x below AYA's 3–10s utterance
                                          // cadence (RESEARCH.md Phase 0 live-probe finding).

export interface UserTurnDebouncerCallbacks {
  isHeld: () => boolean;                 // queried at FIRE time, not arm time
  onFire: (messageID: string) => void;
}

export class UserTurnDebouncer {
  private callbacks: UserTurnDebouncerCallbacks = { isHeld: () => false, onFire: () => {} };
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private heldIDs = new Set<string>();
  constructor(private readonly debounceMs: number = USER_TURN_DEBOUNCE_MS) {}

  setCallbacks(cb: UserTurnDebouncerCallbacks): void { this.callbacks = cb; }

  arm(messageID: string): void {
    const existing = this.timers.get(messageID);
    if (existing) clearTimeout(existing);
    this.heldIDs.delete(messageID);   // new part arrived — wait for quiescence again
    const t = setTimeout(() => {
      this.timers.delete(messageID);
      if (this.callbacks.isHeld()) this.heldIDs.add(messageID);
      else this.callbacks.onFire(messageID);
    }, this.debounceMs);
    this.timers.set(messageID, t);
  }

  flushHeld(): void {
    const ids = [...this.heldIDs];
    this.heldIDs.clear();
    for (const id of ids) this.callbacks.onFire(id);
  }

  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.heldIDs.clear();
  }
}
