---
title: "octmux — Troubleshooting Guide"
created_at: 2026-05-19--17-46
created_by: Claude Code (claude-code-kimi-k2.6)
context: >
  This document collects runtime errors, warnings, and edge cases encountered
  while running octmux against the opencode server. Each entry includes the
  observed symptom, root-cause analysis, whether the issue is inside octmux or
  the upstream opencode binary, and any available workarounds. Entries are
  appended in reverse chronological order (newest first).
---

# Troubleshooting Guide

## 2026-05-19--17-46 — MaxListenersExceededWarning from opencode server

### Symptom

The opencode server stderr prints a `MaxListenersExceededWarning` shortly after
startup:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:4096

MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 event listeners added to [cI]. MaxListeners is undefined. Use events.setMaxListeners() to increase limit
 emitter: cI {
  _events: [Object ...],
  _eventsCount: 1,
  _maxListeners: undefined,
  [Symbol(kCapture)]: false,
  ...
}
```

### Root cause

The warning originates **inside the compiled opencode binary**, not in octmux
code. Evidence:

- Stack-trace frames point to `/$bunfs/root/chunk-658twvfx.js` — a Bun
  `--compile` artifact, not octmux's `src/` tree.
- `~effect/Effect/evaluate` and `runTasks` indicate the leak is in opencode's
  internal Effect-TS event-stream plumbing.

The `_eventsCount: 1` (single event type) with a listener count of 11 suggests an
opencode internal stream repeatedly adds listeners and fails to remove previous
ones. Octmux opens a **persistent SSE stream** via `client.global.event({})`
(`src/index.ts:129`), which likely triggers the leaky path in opencode's SSE
handler.

### Impact

At 11 listeners this is still a warning, not a fatal error. For short REPL
sessions the leak is negligible. On long-running sessions the listener count
could grow, increasing memory pressure.

### Proposed workaround

Suppress the warning server-side by passing `NODE_NO_WARNINGS=1` in the spawn
environment (`src/server-lifecycle.ts`):

```ts
const proc = Bun.spawn([bin, "serve", "--port", String(port)], {
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
```

### Upstream fix

Report to opencode with:
- Full stack trace (as shown above).
- opencode version (`opencode --version`).
- Reproduction: "Connect any client that opens `client.global.event({})` and
  observe `MaxListenersExceededWarning` after a few events."

The proper fix is for opencode to either:
1. Call `.setMaxListeners(n)` with a higher limit on its internal `EventTarget`,
   or
2. Dispose / remove listeners when an SSE event is fully consumed, preventing
the accumulation.
