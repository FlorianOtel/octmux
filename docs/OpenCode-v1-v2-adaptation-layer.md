---
title: "OpenCode v1/v2 adaptation layer"
created_at: 2026-10-13--23-24
created_by: Claude Code (Claude Opus 5.5)
updated_by: Claude Code (Claude Haiku 5.5)
updated_at: 2026-10-18--18-27
context: >
  The operator asked for an extensive, authoritative description of the redesign that lets one
  octmux binary serve both the OpenCode v1 API (@opencode-ai/sdk, the local systemd server) and the
  OpenCode v2 API (@opencode/client ^2.0.28, for example the macOS desktop app 2.0.28). Written after
  Stage 15.3 (HEAD 56ddacf). The redesign was built in Stages 14, 15.1, 15.2a, 15.2 and 15.3.
  The code is the source of truth. This document was verified against src/backend/types.ts,
  src/backend/v1.ts, src/backend/v1-queries.ts, src/backend/v2.ts, src/backend/v2-events.ts,
  src/backend/v2-queries.ts, src/backend/v2-ancestry.ts, src/events.ts, src/replay.ts,
  src/resync-gate.ts, src/index.tsx, src/app.tsx, src/protocol-detect.ts, src/octmux-config.ts,
  src/auth-headers.ts, src/orchestra-watch.ts and src/command-registry.ts, and cross-read with
  docs/Stage14.md, docs/Stage15.md, docs/OpenCode-v2-protocol-capture.md and README.md
  "Configuration". The companion document docs/OpenCode-v2-decision-record.md records why the
  design decisions were taken; this document describes how the layer works.
---

# OpenCode v1/v2 adaptation layer

This document is retired. octmux is a v2-only OpenCode client (Stage 15.5). The dual-protocol
adaptation layer it described no longer exists. The current backend architecture is documented in:

- `docs/Stage15.md`, section "Native v2 backend"
- `src/backend/types.ts` (the `Backend` interface)
- `src/backend/v2.ts`, `src/backend/v2-events.ts` and `src/backend/v2-queries.ts` (the implementation)

The design rationale for the v2 work, including the decision to remove v1, is in
`docs/OpenCode-v2-decision-record.md`.
