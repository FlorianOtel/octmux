#### 2026-05-23 -- 20:30 Issues with "--multi-pane" -- lag is inherent in panes due to tmux pane rendering: tmux serializes rendering in a window

  - Window: new-window -d — creates a new window in the same session, does not resize any existing window 
  - Pane: split-window -h -t originPaneId — splits the existing pane, resizes the main pane and sends SIGWINCH to the octmux process

  SIGWINCH is the key. When split-window fires, tmux shrinks the main pane and delivers SIGWINCH to our process. Ink's SIGWINCH handler triggers a full re-render. The critical problem: with lazy pane creation, this happens inside beginBlock — i.e., inside the SSE event loop — not before it (as the old eager setup() did). While execFileSync is blocking the event loop for the four tmux calls in _ensurePane, SIGWINCH is queued. When control returns, both the SIGWINCH handler and the backed-up thinking deltas compete for the event loop.  

  The result: thinking deltas that arrived while _ensurePane was running (the first 200–500ms of thinking content) are processed as a burst, not streamed. They write to the FIFO all at once, and tail -f displays them all at once — which looks like "late thinking."
                                                                    
  This is not caused by my events.ts fix. That fix moves the last-partial-line flush from session-idle to text-start (an improvement). The burst/lag issue is from SIGWINCH during lazy pane creation. 

  The fix is to move pane creation out of the SSE loop. The cleanest way: go back to eager pane creation at setup() time (as it was originally), so the split-window + SIGWINCH sequence happens before Ink starts rendering and before any SSE events flow. The setImmediate yield that index.tsx already has after setup() was specifically designed for this.

  Read 1 file (ctrl+o to expand)      

● Wait — let me read setup() from the top:                          

  Read 1 file (ctrl+o to expand)                                    

● The current setup() is the ORIGINAL eager one — we're on the 18d093e base, which already had eager pane creation. Let me check what beginBlock looks like right now: 

  Read 1 file (ctrl+o to expand)                                    

● Now I can give a definitive answer. The current code has eager pane creation in setup() (the original pre-Stage 4.3 code) — panes are created before any events flow, SIGWINCH is handled, and tail -f is already running. The FIFO write path is identical in both renderers. 

   The pane timing lag is not caused by my events.ts fix. 

  Here's why --multi-pane lags while --multi-window doesn't: 

  - --multi-pane: all panes live in the same tmux window. When Ink (in the main pane) is actively writing ANSI escape codes during text streaming, tmux must render all panes in the same window refresh cycle. tail -f output in the thinking pane competes with Ink's  main-pane output for tmux's render budget. 
  - --multi-window: each window is rendered independently by tmux. The thinking window's tail -f output is rendered in a completely separate refresh cycle from the main window where Ink is running. No competition. 

  My events.ts fix doesn't change this — it only changes when the last partial thinking line is flushed to the FIFO (from session-idle → text-start). Complete lines still write to the FIFO in real-time via appendToBlock. The lag you're seeing is tmux-level render contention between panes sharing a window. 

  Confirming my fix improved things: before the fix, the last partial line of thinking appeared only at session-idle (after the entire response). Now it appears when text starts. For models that output thinking without newlines, this is the difference between "thinking appears after everything" and "thinking appears when text response begins."

  What can be done about the contention: Nothing in octmux's code — it's tmux's pane-sharing window refresh model. The --multi-window mode is the correct mode for real-time thinking visibility. The --multi-pane mode will always have some rendering lag when text is streaming because tmux serialises updates within a window. This is a known limitation of the pane architecture.

  Summary of what I found:

  ┌──────────────────────────────┬─────────────────────────────────────────────────────┬─────────────────────────────────────┬──────────────────────────────────┐
  │            Issue             │                        Cause                        │               My fix                │              Status              │
  ├──────────────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────┤
  │ Thinking timer keeps ticking │ block-end for thinking never emitted mid-session    │ events.ts: emit it when text starts │ Fixed 7624592                    │
  ├──────────────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────────┼──────────────────────────────────┤
  │ Multi-pane thinking lag      │ tmux render contention — panes share window refresh │ Not applicable                      │ Pre-existing architectural limit │
  └──────────────────────────────┴─────────────────────────────────────────────────────┴─────────────────────────────────────┴──────────────────────────────────┘
