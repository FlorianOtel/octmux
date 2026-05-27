---
title: "octmux — open issues and deferred work"
created_at: 2026-05-20--19-30
created_by: Claude Code (Claude Sonnet 4.6)
context: >
  Tracks UX papercuts, known limitations, and deferred work that were
  identified during development but not resolved in the session where they
  were found. Each entry records what was reported, what was attempted, and
  concrete suggestions for a future fix. Entries are in reverse-chronological
  order (newest first).
---

## Open issues

---

### 2026-05-20--19-30 — Streaming output: disturbing screen refreshes / scroll jump

**Status:** Open — partial workaround applied, core problem remains

#### a. What was reported

When the model streams a response, the screen refreshes visibly on each
arriving chunk instead of the text scrolling upwards smoothly. The effect is
particularly bad once the streamed text grows long enough to push past the top
of the visible terminal area: at that point each repaint causes a noticeable
jump/flash as Ink erases and redraws the entire dynamic area.

The ideal behaviour described by the user: the response text scrolls upward
smoothly — or, as an alternative, in discrete "jump-scroll" steps where each
delivered chunk is written sequentially into the space freed by the jump.

#### b. What was attempted

A 50 ms debounce timer (`flushTimerRef` in `src/app.tsx`) was added to batch
`setStreamBuf` calls. Instead of one React re-render per SSE chunk (~20-50
repaints/sec), state is updated at most once per 50 ms (~20 repaints/sec).

**Result:** The debounce reduces flicker for short responses that fit within
the visible terminal height. It does not fix the jump when the streamed text
grows past the terminal height, because the root cause is architectural: Ink
re-renders by erasing and redrawing the entire dynamic area below `<Static>`
on every state change. When that area contains several screenfuls of text,
each repaint forces a large erase+redraw regardless of how often it fires.

#### c. Suggestions for a more comprehensive fix

**Approach 1 — Line-buffered Static commits (recommended, Ink-native)**

Commit each complete line of streaming text to `<Static>` immediately as it
arrives, keeping only the current partial line (text after the last `\n`) in
dynamic React state.

```
streamBufRef.current += ev.text;
const nlIdx = streamBufRef.current.lastIndexOf('\n');
if (nlIdx >= 0) {
  const completeLines = streamBufRef.current.slice(0, nlIdx);   // commit
  streamBufRef.current = streamBufRef.current.slice(nlIdx + 1); // keep tail
  setStreamHistory(h => [...h, ...completeLines.split('\n')]);  // → <Static>
}
setStreamBuf(streamBufRef.current);   // only the partial tail re-renders
```

Static items are written exactly once and never touched again; the terminal
cursor just advances past them. Only the last partial line (≤1 terminal row)
lives in dynamic state and re-renders per debounce tick. Response length has
no effect on repaint cost. This is fully Ink-native, requires no ANSI
cursor management, and is compatible with the future `StreamItem` typed union
(swap `string` entries for typed objects).

Complication: on `session-idle`, flush any remaining tail in `streamBufRef`
to Static as a final entry, then clear both `streamHistory` and `streamBuf`.
The `<Static>` stream-history entries must be distinguished from committed
conversation-history entries so they can be reset between turns (Static itself
cannot be cleared — use a generation counter or a separate Static list).

**Approach 2 — Direct stdout writes for streaming, Ink for the prompt area only**

Pause Ink's repaint cycle, write streaming chunks directly via
`process.stdout.write()`, then resume Ink. Streaming text uses the terminal's
own scroll mechanism — no React involvement. Ink only manages the fixed bottom
area (prompt, rules, status line).

Implementation sketch:
- Save/restore Ink's bottom area with `\x1b[s` / `\x1b[u` (ANSI save/restore
  cursor) or by using a fixed scroll region (`\x1b[1;<N>r`) where N = terminal
  rows minus prompt height.
- On each text-delta, write the chunk to stdout directly; the terminal scrolls
  naturally.
- On session-idle, the streamed content is already on screen; add it to
  `<Static>` history by faking a history entry that matches what was printed
  (or simply leave it in the scrollback — it's already there).

Risk: Ink and direct stdout writes can conflict if both try to position the
cursor concurrently. Requires careful synchronisation. More fragile than
Approach 1 but produces truly native scrolling.

**Approach 3 — Scroll region (ANSI `\x1b[r`)**

Set a terminal scrolling region that covers all rows except the fixed prompt
area at the bottom (`\x1b[1;<N>r`). Write streaming content normally via
stdout; it scrolls within the region. The prompt area below is outside the
region and never scrolls.

This is essentially what full-screen terminal applications (vim, htop, tmux
itself) do. It requires the prompt area height to be known at startup and
updated on terminal resize. Ink would manage only the static/dynamic UI
elements within the scroll region, not the prompt rows.

**Recommended path for the next session:**

Implement Approach 1 first — it is the safest change (pure React/Ink, no ANSI
cursor management) and will eliminate the scroll-jump for virtually all real
responses. Approach 2 or 3 can follow if smoother native scrolling is desired.
The `StreamItem` typed union (planned for Stage 4/5) should be designed to
work with the line-buffered Static model from the start.
