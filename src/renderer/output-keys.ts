import type { Role } from "../blocks.ts";

// Output-gate registry — single source of truth for which streaming block
// classes route to dedicated tmux side windows (--multi-window mode) or get
// inline-rendered (--single mode), and which gate keys the operator can
// control via /<key>-output [on|off].
//
// CONTRACT — read before adding a new key (e.g. "subagent"):
//
// 1. To add a new streaming block class, add ONE line to OUTPUT_KEY mapping
//    its Role to a gate key (e.g. `subagent: "subagent"`). That single line
//    automatically wires up:
//      - the /<key>-output [on|off] slash command (parseBlockOutputCommand
//        validates against OUTPUT_KEYS),
//      - the /show status line,
//      - the /help listing (via the COMMANDS registry dynamic expander),
//      - the live slash-completion overlay,
//      - the gate-default-true initialization in both renderers' constructors.
//
// 2. All toggles inherit PURE-GATE semantics:
//      - setOutputEnabled(key, on) sets the gate Map entry. It MUST NOT
//        call _ensureWindow, spawn windows, open or close FIFOs, kill
//        windows, run any SYNCHRONOUS tmux subprocess, or emit events.
//      - Permitted side effect (Phase 4.5.2): on `on=true`, kick a
//        non-blocking `_refreshLiveIdsAsync()` so the in-memory liveness
//        cache is fresh by the next block-start. This is a cache-only
//        mutation in a background fire-and-forget tmux subprocess — no
//        window/FIFO/block touched, no blocking I/O. Without this kick,
//        the cache would stay stale through the gate-off period and
//        block 1 after toggle-on would write to a dead FIFO if the
//        operator killed the window during gate-off.
//      - Window / FIFO / streaming lifecycle is owned EXCLUSIVELY by
//        _ensureWindow, invoked EXCLUSIVELY from beginBlock (the Phase 4.4.3
//        load-bearing path). Re-entry safety and async liveness caching
//        (Phase 4.4.4) live there.
//      - When the gate is off, beginBlock/appendToBlock/endBlock early-exit
//        AFTER registering partID in _openBlocks (so a later toggle-on flips
//        seamlessly with no lost block bookkeeping).
//
// 3. WHY the strict invariant exists: Phase 4.5 (commit 25c644a) tried
//    adding an eager _ensureWindow call inside setOutputEnabled so the
//    side window would appear immediately on /<key>-output on. That eager
//    call interacted badly with the Phase 4.4.4 async liveness cache and
//    broke streaming to the re-created window. The behavior was reverted
//    in Phase 4.5.1; see docs/Phase4.md for the full post-mortem. The
//    lazy-on-block-start UX (window appears on the next matching block,
//    not on toggle) is the accepted trade-off.
//
// 4. WHY the Phase 4.5.2 cache-refresh exception exists: with strict
//    Phase 4.5.1, an operator who toggled off, killed the window manually,
//    then toggled on would still lose block 1 (the cache stayed stale
//    through the entire quiescent gate-off period). The non-blocking
//    refresh on toggle-on warms the cache before the next block-start
//    in the typical operator timing (refresh completes in ~50 ms; typing
//    a follow-up prompt takes seconds). See docs/Phase4.md §Phase 4.5.2
//    for the full design + the Option B sync-probe alternative held in
//    reserve if this turns out insufficient.
//
// tool-call and tool-result share one "tools" gate so the full
// call → result sequence can be toggled together.
export const OUTPUT_KEY: Partial<Record<Role, string>> = {
  thinking:      "thinking",
  "tool-call":   "tools",
  "tool-result": "tools",
  rag:           "rag",
};

// Unique deduped list of all output gate keys.
export const OUTPUT_KEYS: readonly string[] = [...new Set(Object.values(OUTPUT_KEY))];
