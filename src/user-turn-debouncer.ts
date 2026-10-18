/**
 * Per-messageID debouncer for foreign user turns (Stage 13.x).
 *
 * Holds the timers for debounced user-turn classification, so that event
 * translation stays pure and synchronous and never owns a timer. When a timer
 * fires, the `onFire` callback wired in app.tsx calls
 * `props.backend.events.classifyUserTurn` (src/backend/v2.ts), which reaches
 * `classifyUserTurn` on the V2 translator in src/backend/v2-events.ts. That
 * method currently returns `[]`, because v2 delivers the whole user text in
 * one `session.inbox.*` frame and needs no debounce.
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
