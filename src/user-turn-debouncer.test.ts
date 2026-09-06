import { describe, expect, test } from "bun:test";
import { UserTurnDebouncer, USER_TURN_DEBOUNCE_MS } from "./user-turn-debouncer.ts";

describe("UserTurnDebouncer", () => {
  // (a) USER_TURN_DEBOUNCE_MS is 250
  test("USER_TURN_DEBOUNCE_MS equals 250", () => {
    expect(USER_TURN_DEBOUNCE_MS).toBe(250);
  });

  // (b) fires once after the window when not held
  test("fires once after the debounce window when not held", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let fired = false;
    debouncer.setCallbacks({
      isHeld: () => false,
      onFire: () => { fired = true; },
    });

    debouncer.arm("msg_1");
    expect(fired).toBe(false);
    await new Promise(r => setTimeout(r, 30));
    expect(fired).toBe(true);
  });

  // (c) re-arming resets the timer (only fires once, after the *last* arm)
  test("re-arming resets the timer; fires once after the last arm", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let fireCount = 0;
    debouncer.setCallbacks({
      isHeld: () => false,
      onFire: () => { fireCount++; },
    });

    debouncer.arm("msg_1");
    await new Promise(r => setTimeout(r, 10));
    debouncer.arm("msg_1"); // reset timer
    await new Promise(r => setTimeout(r, 30));
    expect(fireCount).toBe(1);
  });

  // (d) independent ids fire independently
  test("independent messageIDs fire independently", async () => {
    const debouncer = new UserTurnDebouncer(20);
    const fired: string[] = [];
    debouncer.setCallbacks({
      isHeld: () => false,
      onFire: (id) => { fired.push(id); },
    });

    debouncer.arm("msg_1");
    debouncer.arm("msg_2");
    await new Promise(r => setTimeout(r, 30));
    expect(fired).toContain("msg_1");
    expect(fired).toContain("msg_2");
    expect(fired.length).toBe(2);
  });

  // (e) held at fire time → parked, not fired, until flushHeld()
  test("held at fire time is parked; flushHeld() fires it", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let isHeld = false;
    let fired = false;
    debouncer.setCallbacks({
      isHeld: () => isHeld,
      onFire: () => { fired = true; },
    });

    isHeld = true;
    debouncer.arm("msg_1");
    await new Promise(r => setTimeout(r, 30));
    expect(fired).toBe(false); // parked, not fired

    debouncer.flushHeld();
    expect(fired).toBe(true);
  });

  // (f) flushHeld() on an empty set is a no-op
  test("flushHeld() on empty held set is safe", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let fireCount = 0;
    debouncer.setCallbacks({
      isHeld: () => false,
      onFire: () => { fireCount++; },
    });

    debouncer.flushHeld();
    expect(fireCount).toBe(0);
  });

  // (g) reset() cancels pending timers (never fire)
  test("reset() cancels pending timers", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let fireCount = 0;
    debouncer.setCallbacks({
      isHeld: () => false,
      onFire: () => { fireCount++; },
    });

    debouncer.arm("msg_1");
    debouncer.reset();
    await new Promise(r => setTimeout(r, 30));
    expect(fireCount).toBe(0);
  });

  // (h) reset() clears held ids (subsequent flushHeld() no-ops)
  test("reset() clears held ids; subsequent flushHeld() is a no-op", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let isHeld = false;
    let fireCount = 0;
    debouncer.setCallbacks({
      isHeld: () => isHeld,
      onFire: () => { fireCount++; },
    });

    isHeld = true;
    debouncer.arm("msg_1");
    await new Promise(r => setTimeout(r, 30));

    debouncer.reset();
    debouncer.flushHeld();
    expect(fireCount).toBe(0);
  });

  // (i) re-arming an already-parked id clears the stale hold and re-waits
  test("re-arming a parked id clears the hold and re-waits", async () => {
    const debouncer = new UserTurnDebouncer(20);
    let isHeld = false;
    let fireCount = 0;
    debouncer.setCallbacks({
      isHeld: () => isHeld,
      onFire: () => { fireCount++; },
    });

    isHeld = true;
    debouncer.arm("msg_1");
    await new Promise(r => setTimeout(r, 30)); // parked at 30ms

    isHeld = false;
    debouncer.arm("msg_1"); // re-arm, should clear the hold
    await new Promise(r => setTimeout(r, 30)); // wait 30ms more
    expect(fireCount).toBe(1); // fired on the second re-arm
  });
});
