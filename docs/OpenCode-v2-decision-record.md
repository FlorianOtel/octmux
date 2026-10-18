---
title: "OpenCode v2 support — decision record"
created_at: 2026-10-13--23-26
created_by: Claude Code (Claude Opus 5.5)
updated_by: Claude Code (Claude Haiku 5.5)
updated_at: 2026-10-18--18-27
context: >
  The operator asked that every decision taken during octmux's OpenCode v2 work be recorded in the
  repository. The work covers the Stage 14 /brain run and the Stage C /brain runs, sessions C1 to C3,
  which shipped Stages 14, 15.1, 15.2a, 15.2 and 15.3 and the follow-up fixes 5.6.1 and 3E.2.1. Until
  now the decisions lived only in /brain session directories, which are gitignored and reaped after
  30 days. This record consolidates them, with rationale, who decided, when, and current status.
  Source session directories (all under
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/):
  20261013T104013Z-1717914 (Stage 14 run: DECISIONS-draft.md, BRAIN-AMENDMENTS.md, RESEARCH.md,
  PLAN.md, review-comments.md); 20261013T123149Z-1871118 (Stage C run, sessions C1 and C2:
  DECISIONS-draft.md, BRAIN-AMENDMENTS.md, BRAIN-AMENDMENTS-C2C3.md, RESEARCH.md, PLAN.md,
  PLAN-C2C3.md, review-comments.md); 20261013T190810Z-2568784 (session C3: RESEARCH.md, PLAN.md with
  Brain amendments B1 to B3, review-comments.md). Also used: docs/Stage14.md, docs/Stage15.md,
  docs/Stage5.md (5.6.1), docs/Stage3.md (3E.2.1), docs/OpenCode-v2-protocol-capture.md, README.md,
  the git log 93e6c8d to 56ddacf, the operator's in-conversation statements as relayed by the
  dispatching session, and the oconona handover ~/Gin-AI/tmp/oconona-OCv2-support.md (read-only).
  Companion document: docs/OpenCode-v1-v2-adaptation-layer.md (the architecture of the v1/v2 seam).
  This record is the "why"; that document is the "how".
---

# OpenCode v2 support — decision record

All dates are 2026-10-13 unless stated. "Operator" is the user. "Brain" is the orchestrating Claude
session of a /brain run, "Planner", "Actor" and "Reviewer" are its subagents. The architecture that
these decisions produced is described in `docs/OpenCode-v1-v2-adaptation-layer.md`; the observed v2
wire protocol is in `docs/OpenCode-v2-protocol-capture.md`.

## 1. How to read this record

### 1.1 ID series

| Series | Origin | Where first written |
|---|---|---|
| D1–D17 | Stage 14 run, operator decisions (Phase 0 and after) | session `20261013T104013Z-1717914`, `DECISIONS-draft.md` |
| F1–F5 | Stage 14 run, load-bearing facts found in Phase 0 that constrained the design | same file |
| M1–M8 | Stage 14 run, Brain amendments to the Planner's plan | same session, `BRAIN-AMENDMENTS.md` |
| S14-1–S14-5 | Stage 14 implementation-level choices and review outcomes (Planner flags, Reviewer minors) | same session, `PLAN.md` and `review-comments.md`; `docs/Stage14.md` |
| C1–C10 | Stage C run (sessions C1 and C2), operator decisions | session `20261013T123149Z-1871118`, `DECISIONS-draft.md` |
| N1–N7 | Stage C run, Brain amendments to `PLAN.md` (sub-stages C0 and C1) | same session, `BRAIN-AMENDMENTS.md` |
| P1–P8 | Stage C run, Brain amendments to `PLAN-C2C3.md` (sub-stages C2 and C3) | same session, `BRAIN-AMENDMENTS-C2C3.md` |
| PL-1–PL-9 | Stage C run, design decisions of the Planner's `PLAN-C2C3.md` that were approved, and their fate | same session, `PLAN-C2C3.md` |
| 15.2-1–15.2-14 | Stage 15.2 accepted design decisions and deliberate deviations (session C2) | session C2 conversation; `docs/Stage15.md` |
| 15.2-D1… | Stage 15.2 defects found live or in review, and their fixes | `DECISIONS-draft.md` (C9 block), `review-comments.md`, `docs/Stage15.md` 15.2 entry |
| C3-1–C3-27 | Session C3 (Stage 15.3 and the follow-up fixes) | session `20261013T190810Z-2568784`; `docs/Stage15.md` 15.3 entry |
| C4-1–C4-11 | Stage 15.4 and 15.4.1: client-only boundary (orchestra state, model and command names over the API) and oconona's contract amendments A1–A8 | session C3 conversation; `docs/Stage15.md` 15.4 entry |
| 15.5-1 | Stage 15.5 decision: remove OpenCode v1 support entirely | session `20261018T151945Z-2329778`; `docs/Stage15.md` 15.5 entry |
| R1–R14 | Standing rules (security, live-test hygiene, doc/commit discipline) | collected from all three sessions; see §2 of this record |

Two naming clashes to watch:

- "C1", "C2", "C3" are both **decision IDs** (the C-series in §4 of this record) and **session /
  sub-stage names** (session C1 = Stage 15.1, and so on). This record writes "session C2" or
  "sub-stage C2" for the latter.
- The operator labels the Stage 14 run's chat session "C0". Sub-stage **C0** in the Stage C run is a
  different thing: the third live capture (captures 3 and 3b). This record uses "Stage 14 run" for
  the former and "sub-stage C0" for the latter.

### 1.2 Status vocabulary

- **In force** — the decision governs current code, docs or practice.
- **Implemented in `<commit>`** — the decision produced code or docs in that commit and is in force.
- **Done** — a one-off action that is complete.
- **Superseded by X** — replaced; the replacement is named.
- **Rejected** — considered and not taken (also consolidated in §6 of this record).
- **Open / deferred** — not decided or not scheduled (also in §7 of this record).

### 1.3 Session ↔ stage ↔ commit

| Session (session dir) | Stage | Commit | Kind | Time (local) |
|---|---|---|---|---|
| Stage 14 run (`20261013T104013Z-1717914`) | 14 | `93e6c8d` | code: config, Basic auth, detection, version gate | 14:09 |
| Stage 14 run | 14 | `1210e99` | docs: Stage 14 hash backfill; capture doc (capture 1) | 14:09 |
| Stage 14 run | — (Phase B) | `fd8dee5` | docs: capture 2 (permissions, subagent) | 14:30 |
| Stage C run, session C1 (`20261013T123149Z-1871118`) | 15.1 | `4bcc2b3` | code: `Backend` seam, `V1Backend` | 16:40 |
| session C1 | 15.1 | `5587a06` | docs: hash backfill | 16:46 |
| session C1 / sub-stage C0 | — | `232d58f` | docs: captures 3 and 3b | 17:09 |
| session C2 | 15.2a | `47bd8a6` | code: Backend reshape, v1 side | 17:51 |
| session C2 | 15.2a | `6362c30` | docs: hash backfill | 17:52 |
| session C2 | 15.2 | `390aa04` | code: native v2 core | 20:52 |
| session C2 | 15.2 | `b1e205d` | docs: hash backfill | 20:55 |
| session C3 (`20261013T190810Z-2568784`) | 15.3 | `a7a65a0` | code: v2 parity | 22:49 |
| session C3 | 15.3 | `25d0843` | docs: hash backfill | 22:53 |
| session C3 | 5.6.1 + 3E.2.1 | `3c5e213` | code: v1 follow-up fixes | 23:04 |
| session C3 | 5.6.1 + 3E.2.1 | `56ddacf` | docs: hash backfill | 23:05 |
| session C3 | — | `975752b` | docs: adaptation-layer doc + this decision record | 23:29 |
| session C3 | 15.3.1 | `0d346d1` | code: comment-only refresh | 23:33 |
| session C3 | 15.3.1 | `a7f15ba` | docs: hash backfill | 23:34 |
| session C3 | 15.4 | `4962c17` | code: client-only boundary | 23:59 |
| session C3 | 15.4 | `d73213c` | docs: hash backfill | 00:02 |
| session C3 | 15.4.1 | `fe6c7a5` | code: oconona amendments A3, A5, A6 | 00:15 |
| session `20261018T151945Z-2329778` | 15.5 | `<pending>` | code: remove OpenCode v1 support | — |

## 2. Standing rules

All in force. They apply to every future v2 (and v1) session on octmux.

**R1 — Password never on argv, never printed.** (Operator; Brain amendment N1, Stage C run.) `curl -u
opencode:<pw>` is visible in `ps`. Live work uses a 0600 curl config file (`user = "opencode:<pw>"`,
passed with `-K`) built from the secret file at invocation time and deleted afterwards. octmux itself
never prints the password; endpoint URLs pass through `redactUrl` (`docs/Stage14.md` "Authentication
funnel"). **Status:** In force (code: `93e6c8d`; practice: every live step since capture 3).

**R2 — Never call `/api/provider`.** (Fact F2; operator.) It returns provider API keys in plaintext.
`listProviders` on v2 is built from `model.list()`. **Status:** In force (`390aa04`).

**R3 — Never log or retain `GET /api/model/default`.** (Operator, session C2.) Its payload carries
`settings.apiKey`. `V2Backend` reduces it to `providerID` and `id`. **Status:** In force (`390aa04`).

**R4 — Captures are scrubbed and never committed.** (Operator; Stage 14 plan step B7, reaffirmed as
C6.) The MBP username becomes `<user>`; no credential, IP or other session's content appears in
`docs/OpenCode-v2-protocol-capture.md`. Raw artefacts stay in gitignored session directories. Test
fixtures are synthesised from the documented shapes (C6). **Status:** In force.

**R5 — Never quote other sessions' prompt text from the global event stream.** (Operator.) `/api/event`
is global and unfiltered (F3), so captures and live logs contain other sessions' traffic; it is
neither quoted nor kept. **Status:** In force.

**R6 — Live tests delete only session ids they created.** (Brain amendment P8, after an incident.)
Record session ids from your own create responses or pane badges, delete those and nothing else.
Never delete by a before/after list diff; the operator runs parallel test sessions. On the MBP remove
only your own `~/.local/share/opencode/shell/<projectID>/` files. Incident: a re-check agent in session
C2 deleted v2 session `ses_ec9ab2914ffe…`, which it had not created, by list diff (about 19:40);
reported to the operator. Memory: `feedback-live-test-session-hygiene.md`. **Status:** In force.

**R7 — Delete what a live test leaves behind.** (Operator preference, D15/D17, N6, N5.) Capture and
smoke-test sessions, child sessions and their shell output files are deleted afterwards (within R6).
v2 has no API to delete the OpenCode project records of scratch directories; those remain on the MBP.
**Status:** In force (superseded M5, see §3.3 of this record).

**R8 — Live-test mechanics.** (Brain amendments N5, N7, P7; C3 plan.) Detached tmux sessions
(`-x 200 -y 50`), text and Enter as separate `send-keys` calls, hard timeouts, trivial prompts
("reply with the single word ok"), `~/.claude/scripts/check-orphans.sh` after each live step,
`git status --short` unchanged afterwards. The `claude` process in `ps` is the agent's own parent.
**Status:** In force.

**R9 — Do not modify the operator's config.** (Operator.) Live tests never edit `~/.config/octmux/*`
or `~/.config/opencode/*`; they pass a scratch `--config`. The operator's dev setup
(`~/.config/octmux/octmux.json` and the 0600 secret file, D5) is left in place (M7). **Status:** In force.

**R10 — Do not edit operator documents without asking.** (Operator; global CLAUDE.md.) Example:
`README.md` changes in Stage 15.3 were proposed and approved first (C3-21). **Status:** In force.

**R11 — Commits only with the operator's OK, in a fixed order.** (Operator; repo CLAUDE.md.) Code
commit first, then a docs commit that backfills the code hash into the `docs/StageN.md` entry, then
the memory update (`project-octmux.md`). `dist/` is gitignored and never committed. The pipeline
proposes commit groupings; it does not commit on its own. **Status:** In force.

**R12 — Fresh review on a frozen tree.** (Global CLAUDE.md; applied by Brain throughout.) Each gate uses
a fresh Reviewer; if the tree must change during a review, that review is stopped and a new one
dispatched (session C3 did this for Review 3, C3-18). Reviewers must not run `git stash` or checkout
(a Stage 14 Reviewer did; Brain verified the tree afterwards, see S14-5). Brain re-verifies every
Actor and Reviewer claim (tests, tsgo, `git status`). **Status:** In force.

**R13 — No protocol branches in `src/app.tsx`.** (Brain/Planner design rule, Stage C run, PLAN-C2C3
§B; checked by every Reviewer.) `src/index.tsx` alone picks the protocol; everything else goes through
the `Backend` seam. **Status:** In force (`4bcc2b3` onwards).

**R14 — Version numbering and attribution.** (Operator rules in memory.) Bug fixes are filed as point
releases against the implementing stage (`git log -S` first), never as new top-level stages; doc
bylines name the Actor's model. Applied to Stage 14 / 15 numbering (S14-1, the Stage C plan) and to
5.6.1 / 3E.2.1 (C3-20). **Status:** In force.

## 3. Stage 14 run decisions

Session `20261013T104013Z-1717914`. Scope: Stage A (config, auth, detection, version gate) and Stage
B (live captures). Code `93e6c8d`; docs `1210e99`, `fd8dee5`.

### 3.1 Operator decisions D1–D17

**D1 — octmux does not manage tunnels.** Operator: "Reaching the endpoint (setting up the tunnel) is
not octmux job." The endpoint is reachable or not, and octmux fails loudly. Tunnels are a dev-time
convenience only. **Status:** In force. Development later moved to direct LAN access after the
operator enabled remote listening on the MBP (Stage C run), so no tunnel is used at all now.

**D2 — Config file `~/.config/octmux/octmux.json`, mirroring `opencode.json`.** Operator: credentials
belong in an octmux config that mirrors OpenCode ("octmux is a harness for OpenCode server"). `$schema`
accepted; JSONC (comments, trailing commas); `{env:VAR}` and `{file:path}` substitution with OpenCode
semantics (leading `~/` expanded, relative paths against the config file's directory, content trimmed,
tokens in `//` comments ignored); CLI flags override file values. **Status:** Implemented in `93e6c8d`;
extended by C8 (`server.directory`, `390aa04`).

**D3 — Deliberate fail-loud deviations from OpenCode.** Unset `{env:VAR}` is an error (OpenCode: empty
string); a missing `{file:}` is an error; a malformed config or unknown key is an error and exit
(OpenCode: warn and skip); a secrets file, or a config holding a literal password, that is group- or
world-readable is refused. Rationale: a silent fallback would turn a missing secret into an
unauthenticated or mis-targeted request. Implementation added: an empty `{env:}` value and a password
that resolves to an empty string are errors too (`docs/Stage14.md` "Token substitution", "Permission
checks"). **Status:** Implemented in `93e6c8d`.

**D4 — Credentials in config, HTTP Basic, username `opencode`.** `server.password`; a 401 with no or a
wrong password is a loud error naming the config key, then exit. **Status:** Implemented in `93e6c8d`
(also covers v1 servers with a password, see M2).

**D5 — Dev/test secret file.** `~/.config/octmux/oc-mbp.password` (0600), referenced as
`{file:~/.config/octmux/oc-mbp.password}`. **Status:** In force as the operator's dev setup; never
committed (see R9, M7).

**D6 — Prefer v2; fall back to v1 loudly.** v1 is used only if the server is not v2, with a warning.
**Status:** Implemented in `93e6c8d`; since `390aa04` the v2 branch runs natively instead of exiting.

**D7 — Native v2 internal model; v1 is the adapted side.** Operator choice. Rejected: translating v2
into octmux's v1 event model, and two parallel pipelines (§6 of this record). **Status:** In force,
as refined by the Stage C research: realised as a protocol-neutral core (the `Backend` interface and a
shared `ReplEvent` union) that both a native v2 adapter and the v1 adapter feed
(`docs/OpenCode-v1-v2-adaptation-layer.md`; Stages 15.1–15.3).

**D8 — Three stages.** (A) config, substitution, Basic auth, v2/v1 detection with loud v1 fallback;
(B) live v2 capture and characterisation doc; (C) native v2 implementation, with orchestra parity
after. **Status:** A and B done (`93e6c8d`, `1210e99`, `fd8dee5`). Stage C's structure superseded by
C4 (four gated sub-stages) and C10 (session C3 split off).

**D9 — One live capture on the MBP approved.** One session, one prompt, small token cost.
**Status:** Done (capture 1, `1210e99`).

**D10 — The v2 client is a maintained library, not one-off code.** Operator: "@opencode/client 2.0.28
(official) … better pay the price now and evolve with the OpenCode v2 API." **Status:** Implemented in
`93e6c8d` (dependency `^2.0.28`; used for `server.info()`), and the basis of `V2Backend` (`390aa04`).

**D11 — This run = Stages A and B only.** Stage B runs after plan approval (plan mode blocks live work);
Stage C is a separate /brain run, planned against the real captured shapes. **Status:** Done.

**D12 — Version gating and tolerant reader.** Operator agreed, after calling exact version pinning "a
bit extreme". Major mismatch → refuse loudly; same major, server newer → one info line; same major,
server older → a louder warning; exact → silent. Compare MAJOR and MINOR, ignore PATCH (M6). Unknown
event types and response fields are ignored (debug-logged under `OCTMUX_DEBUG_SSE`); requests send only
the fields octmux uses. The dependency is declared `^2.0.28` and `bun.lock` pins the exact version;
updating the library is a maintenance choice, not a requirement. **Status:** Implemented in `93e6c8d`
(`compareVersions`, `BUNDLED_OC_CLIENT_VERSION`, a test keeps it equal to `package.json`).

**D13 — Library preference order.** `@opencode/client` (official) → hybrid (`@opencode/client` REST
plus a thin typed event layer) → client generated from the server's `/openapi.json`. **Status:**
Resolved: the A1 compile gate passed, so `@opencode/client` is used and no fallback was needed.

**D14 — Restore `bun.lock` first.** It showed as deleted at session start; `git checkout bun.lock`,
then add dependencies, then commit it with Stage A. **Status:** Done (`93e6c8d`).

**D15 — Stage 14 close-out.** After the pipeline PASS, the operator kept the `README.md` and
`docs/Implementation-plan.md` edits, approved commits `93e6c8d` (code) and `1210e99` (docs), and
asked for the leftover capture and test sessions (one v1, one v2 with its shell output) and a scratch
cache directory to be deleted. **Status:** Done. Supersedes M5.

**D16 — Second capture.** Operator: "Wrt Stage C: run a second capture with a command." Approved a
second live v2 session to capture permissions (via a per-session `ask` ruleset, no server config
change) and a subagent child session. Recorded after Review 4 blocked on missing approval (S14-5).
**Status:** Done (`fd8dee5`).

**D17 — Delete the capture-2 sessions.** Parent and child sessions and their shell files deleted (204,
then 404). The OpenCode project records for the scratch directories remain (no v2 delete API).
**Status:** Done.

### 3.2 Facts that constrained the design, F1–F5

**F1 — Detection must require JSON.** A v2 server answers `200 text/html` (the web UI) for any unknown
non-`/api` path, including v1's `/config`, `/session` and `/health`. v2 = `/api/info` JSON 200, or 401
with JSON `{_tag:"UnauthorizedError"}`. **Status:** In force (`src/protocol-detect.ts`, `93e6c8d`).
During implementation the v1 probe became `GET /global/health`, because a v1 server also serves HTML on
`/health` (`docs/Stage14.md` "Protocol detection").

**F2 — `GET /api/provider` returns live provider API keys in plaintext.** Never log or persist it.
**Status:** In force as rule R2.

**F3 — `/api/event` takes no parameters.** No location filter, no cursor, no `Last-Event-ID` replay
(confirmed in capture 3). Filtering is client-side; the stream is volatile. **Status:** In force:
octmux owns reconnect and resync (`390aa04`), and the `@opencode/client` `event.subscribe()` iterator
ends on disconnect and is wrapped.

**F4 — A resumable per-session log exists** (`GET /api/experimental/session/{id}/log?after=&follow=`).
**Status:** Not used. Captures 1 and 3 showed it carries only `log.synced` lines with no event bodies
in 2.0.28 (`docs/OpenCode-v2-protocol-capture.md` §4.11). Gap recovery uses REST instead.

**F5 — Request bodies reject unknown fields.** Prompt `{text, id?, files?, agents?, skills?, metadata?,
delivery?, resume?}`; form reply `{answer:{<fieldKey>: value}}`; permission reply `{decision:
once|always|reject, message?}`; interrupt `?resume=`. **Status:** In force (send only used fields, D12).

### 3.3 Brain amendments M1–M8

**M1 — Exercise `@opencode/client` in the binary.** As planned, Stage A never imported the library, so
the bundler would tree-shake it and the compile gate would prove nothing. `detectProtocol` keeps raw
`fetch` for the JSON-strict classification but reads the server version via
`OpenCode.make({ baseUrl, headers }).server.info()`. **Status:** Implemented in `93e6c8d` (Reviewer
confirmed `server.info()` is in the bundle and no `effect` strings are).

**M2 — v1 servers with a password.** If `/api/info` is inconclusive and the v1 probe returns 401,
classify `v1-unauthorized` and print the loud credential error, not "unreachable". **Status:**
Implemented in `93e6c8d`.

**M3 — Correct capture endpoints.** Permission reply `POST /api/session/{sessionID}/permission/{requestID}/reply`
with `{decision:"once"}`; form reply `POST /api/session/{sessionID}/form/{formID}/reply` with
`{answer:{<fieldKey>:"A"}}`; pending lists per session. **Status:** Done (applied in capture 1).

**M4 — Concrete capture-1 prompt and scratch location.** A prompt that asks a question, runs `ls -la`,
then replies "done", in a scratch directory on the MBP, with a 3-minute cap. **Status:** Done.

**M5 — Do not delete the captured session; report its id.** **Status:** Superseded by D15 / D17 / R7
(the operator chose deletion).

**M6 — Version gate compares MAJOR and MINOR, ignores PATCH.** **Status:** Implemented in `93e6c8d`.

**M7 — Leave the operator's dev config and secret in place; kill the tunnel.** **Status:** Done; in force
as R9.

**M8 — Delete Phase 0 scratch leftovers in `/tmp`.** **Status:** Done.

### 3.4 Implementation-level choices and review outcomes, S14-1–S14-5

**S14-1 — Stage number 14** (Planner, per the version-numbering rule): a new config file, auth model,
detection subsystem and dependency, with no prior implementing commit. **Status:** In force.

**S14-2 — Substitute tokens after JSONC parsing, on string leaves.** (Planner flag, accepted.) OpenCode
substitutes on raw text before parsing. For octmux's small schema the behaviour is the same, the code
is simpler, and tokens inside comments are never substituted. **Status:** Implemented in `93e6c8d`.

**S14-3 — `--config <path>` flag.** (Planner flag, accepted.) A missing file named by `--config` is an
error; a missing default file is not. **Status:** Implemented in `93e6c8d`.

**S14-4 — Module-level auth singleton.** (Planner.) `src/auth-headers.ts` holds one header, set once
before any client is built (the v1 SDK copies headers at construction). Every raw `fetch` spreads
`getAuthHeaders()`. **Status:** Implemented in `93e6c8d`.

**S14-5 — Review outcomes.** Review 1 PASS. Review 2 PASS, with one accepted minor: a `{file:}` token
in `server.url` that fails names the config path, token and resolved path but not the key `server.url`
(not fixed; a URL is not a secret). Review 3 PASS (capture doc). Review 4 BLOCK on governance only (no
recorded approval for capture 2), resolved by recording D16. A Reviewer used `git stash` in a
read-only role; Brain verified the tree was intact (origin of the R12 "no stash" rule). **Status:**
Done.

## 4. Stage C run, sessions C1 and C2 (Stages 15.1, 15.2a, 15.2)

Session `20261013T123149Z-1871118`. Dev endpoint: the MBP v2 desktop service over the LAN, no tunnel.

### 4.1 Operator decisions C1–C10

**C1 — Stage C target is full parity with v1 on v2.** Rejected: a core-first subset or minimal spike.
**Status:** Achieved in 15.3 (`a7a65a0`), with the known limits in `docs/Stage15.md` and the orchestra
fence (C3-2).

**C2 — v1 stays fully working.** Adapted to the new internal model, behaviour unchanged, v1 tests keep
passing. Rejected: deprecating v1 (the local systemd server and the mobile/P4OC setups are v1).
**Status:** Superseded by 15.5-1 (Stage 15.5): v1 support removed entirely. Previously in force; deliberate
v1 output changes were made only in 15.3 (C3-16) and 5.6.1 / 3E.2.1 (C3-20).

**C3 — A third live capture inside Stage C** (failing tool allowed once, deliberate interrupt, forced
`/api/event` disconnect and reconnect), run outside plan mode as an early step gating design.
Rejected: designing the remaining gaps from client types only. **Status:** Done (sub-stage C0,
`232d58f`).

**C4 — Four gated sub-stages.** C0 capture → C1 neutral core with v1 behind it, zero behaviour change
→ C2 v2 core → C3 v2 parity. Each: Actor → Reviewer → live verify → commit with operator OK. The
Planner details C0 and C1 and outlines C2 and C3, which are re-planned after C0 (rejected: planning
C2/C3 in detail before the C0 facts exist). **Status:** Implemented; amended by C7 (15.2a checkpoint)
and C10 (C3 in a new session).

**C5 — Capture 3b.** Capture 3 ran while the MBP's model gateway was down, so only model-free paths were
observed. The operator fixed gateway reachability; capture 3b then observed a failing model tool, an
interrupt during a tool, a tool-raised permission, a real subagent and a successful compaction. C1
proceeded meanwhile. **Status:** Done (`232d58f`).

**C6 — C2 fixtures are synthesised** from the documented shapes in
`docs/OpenCode-v2-protocol-capture.md`; nothing from the captures is committed (Stage 14 precedent
kept). Rejected: the Planner's recommendation to commit scrubbed capture copies as fixtures. **Status:**
In force (R4).

**C7 — `PLAN-C2C3.md` approved with amendments P1–P7.** The P2 checkpoint after C2 steps 1–2 is
committed separately as Stage 15.2a (code and docs) before any v2 code. **Status:** Done (`47bd8a6`,
`6362c30`).

**C8 — `server.directory`.** Operator, at the C2 gate: a new optional `octmux.json` key, the server-side
path used as the session location instead of the local cwd (unset → local cwd); a
`LocationNotFoundError` is a loud error naming the key. **Status:** Implemented in `390aa04`. It must
be absolute; it is refused with `--worktree` and `--auto-spawn` (15.2-D10).

**C9 — Fix F-b and F-a inside Stage 15.2.** F-b: non-text streaming (summary, reasoning) committed each
delta as its own prefixed line; F-a: the paste filter held a lone ESC, so Escape never reached the
`/sessions` picker and modals. Both pre-existing (A/B-verified against `6362c30` / `fd8dee5`).
**Status:** Implemented in `390aa04` (15.2-D8, 15.2-D9).

**C10 — Close the Stage C run at session C2.** Operator, about 21:05, on context exhaustion: close as
PASS with 15.1, 15.2a and 15.2 shipped and the capture doc committed; Stage 15.3 not started (the
Actor had stopped during read-only diagnosis; tree clean); continue in a new /brain run from a
handover. **Status:** Done (session C3 = `20261013T190810Z-2568784`).

The pre-existing follow-ups recorded in the same file (F-a, F-b, F-c) are tracked in §7 of this record.

### 4.2 Brain amendments to `PLAN.md` (sub-stages C0 and C1), N1–N7

**N1 — Password never on argv; background curls started directly with `&` and `$!`.** (A capture-1
kill failed when started via a shell function.) **Status:** In force as R1.

**N2 — Capture-3 findings integrated into the existing per-concept sections** of
`docs/OpenCode-v2-protocol-capture.md` (§2–§6), citations prefixed `v2-capture-3/`, no separate
"Capture 3" section, no tombstone wording. Rejected: the Planner's appended "## 7. Capture 3".
**Status:** Implemented in `232d58f`.

**N3 — `Backend` shape = Option B, and one SSE owner.** `backend.session.*` mirrors `client.session.*`;
free functions stay flat. The initial event subscription in `src/index.tsx` also goes through
`backend.subscribeEvents()`. Rejected: Option A (all ~22 methods flat). **Status:** Implemented in
`4bcc2b3`; session arguments flattened later (PL-2, `47bd8a6`).

**N4 — Group the v1 pipeline helpers under `backend.events.*`** with a doc-comment that C2 will reshape
it. Accepted churn: C1 is a pure move. **Status:** Implemented in `4bcc2b3`; reshaped in `47bd8a6`.

**N5 — C1 live smoke hygiene.** Disposable tmux, hard timeouts, trivial prompt, delete the v1 session
afterwards. **Status:** In force as R7 / R8.

**N6 — Delete all capture-3 sessions incl. children and their shell files; report remaining project
records.** **Status:** Done.

**N7 — `claude` in `ps` is the parent; no stray processes; `check-orphans` after each operational step.**
**Status:** In force as R8.

### 4.3 Brain amendments to `PLAN-C2C3.md`, P1–P8

**P1 — Pending modals after reconnect or attach on v2.** The plan made `V2Backend.listPermissions()` a
no-op, so a permission pending at attach or missed in a stream gap would never surface. Fix:
`listPermissions()` returns the session's pending permissions reshaped into the v1 `/permission` shape
the discovery pass already parses; forms get `listForms` on the same discovery cadence and after
resync. **Status:** Implemented in `390aa04` (location-scoped request route; Review B then required
discovery after resync, 15.2-D11).

**P2 — Fresh-Reviewer checkpoint after C2.1–C2.2** (Backend reshape, V1 conformance, replay split)
before any v2 code, verifying zero v1 behaviour change. Motivated by the actor-revert lesson. The
operator chose to commit it as 15.2a (C7). **Status:** Done (`47bd8a6`).

**P3 — Correct plan item C3.8.** The plan claimed v1 does not roll child costs into the status line; it
does (`refreshTokenUsage` sums parent and children). Parity requires v2 to do the same. **Status:**
Implemented: v1 roll-up preserved in `v1-queries` (`47bd8a6`), v2 roll-up in `v2-queries` (`390aa04`).

**P4 — Verify the plan's `runCommand` premise before designing.** The plan said v1 expands commands
client-side; check the real code. **Status:** Resolved in session C3: v1 sends commands server-side
via `sendCommand`; no `runCommand` member was added (C3-6).

**P5 — Split C2.1–C2.2 into two Actor dispatches**, each leaving the build green. **Status:** Done.

**P6 — v2 translator state is reset by `resetEventState()`** and never leaks across session switches;
own-echo keyed by minted prompt ids; for commands, use the expanded-text prefix if the server echoes no
client id. **Status:** Implemented in `390aa04`; command echo handling superseded by the one-shot echo
slot (C3-5, `a7a65a0`).

**P7 — N1 and N5–N7 apply to all live steps.** **Status:** In force (R1, R7, R8).

**P8 — Live-test cleanup rule after the 19:40 incident.** **Status:** In force as R6.

### 4.4 Approved design decisions of `PLAN-C2C3.md`, PL-1–PL-9

**PL-1 — One shared SSE loop, reconcile loop and discovery pass for both protocols.** If `V2Backend`
implements the same `events.*` methods and `subscribeEvents()`, the `app.tsx` loop needs no change.
**Status:** In force (load-bearing for R13).

**PL-2 — Flat `BackendSession` arguments and a flat `SessionRecord`.** Drop the v1 SDK option-object
wrapper; v2 reshapes `location.directory` → `directory` so `orchestra-watch.ts` and `app.tsx` need no
field renames (the "landmine" fix). **Status:** Implemented in `47bd8a6` (v1 side) and `390aa04` (v2).

**PL-3 — Additive v2-only `ReplEvent` kinds** (`form-asked`, `form-replied`, `turn-retry`,
`compaction-*`, `model-selected`, `resync-needed`) and widened `permission-asked.resources` and
`block-end.exitCode`. No new `parent-turn-end` reason (`execution.failed` → `"error"`,
`execution.interrupted` → `"aborted"`). **Status:** Implemented in `47bd8a6`.

**PL-4 — `model-selected` kept distinct from v1's `model-switched`.** Avoids changing v1 semantics.
Rejected (out of scope): unifying them. **Status:** In force.

**PL-5 — `setModel` on the session, idempotent.** v2 has no per-prompt model; `sendPrompt` / `sendCommand`
call `setModel` first and skip it when the model already matches, to avoid a "model set" message every
turn. v1 `setModel` is a no-op. **Status:** Implemented in `390aa04`; cache made to follow foreign
switches in `a7a65a0` (C3-10).

**PL-6 — Replay split into translate and apply** (`getHistory` returns ops; one shared `applyHistory`),
verified by an equivalence test against the old `replaySession`. **Status:** Implemented in `47bd8a6`.

**PL-7 — Compaction progress is not streamed live.** The ~116 `compaction.delta` chunks are not rendered;
the compacting state is shown and the summary renders on `compaction-ended`. **Status:** In force.

**PL-8 — Full clear + replay on a durable-seq gap.** **Status:** Superseded by incremental resync
(15.2-6) after live defect D-A.

**PL-9 — `listProviders` / `getDefaultModelConfig` shimmed into the v1 shapes from `model.list()` /
`model.default()`;** the Planner's open risk was whether `ModelInfo` has a "connected" signal. **Status:**
Implemented in `390aa04`; risk resolved by 15.2-5. The plan's claim that v2 `getTokenUsage` reads
`session.get` was implemented differently: it reads the newest post-compaction assistant message, as v1
does (`docs/Stage15.md` "Queries and history").

### 4.5 Stage 15.2 accepted design decisions and deviations (session C2), 15.2-1–15.2-14

Decided by Brain and accepted by the operator at the 15.2 gate unless noted. **Status of all:**
Implemented in `390aa04` and in force, unless noted.

**15.2-1 — `getMessages` / `getChildren` removed from the shared `Backend`.** They are v1-only
(`V1BackendSession`); `V2Backend` uses internal `fetchMessages` / `fetchChildren`. Rationale: no caller
outside the backends needs raw messages once the queries moved behind `BackendEvents`.

**15.2-2 — Block keys `${messageID}:${startOrderIndex}`, shared with history.** v2 stream ordinals are
counted per kind, so `ordinal` collides between a reasoning and a text block in one message. The same
keys are used by `translateHistoryV2`, so a live block and a replayed one share a part id.

**15.2-3 — Translator deviations from the plan / from a literal mapping:**
- `session.step.failed` emits no error line (`execution.failed` carries the same error, and an aborted
  step on Ctrl-C must not show one);
- turn-end order mirrors v1: `parent-turn-end`, `session-idle`, then block ends;
- text start does not close an open reasoning block (they overlap in v2);
- a seq gap closes open blocks, then emits `resync-needed`; the gapped frame is dropped;
- `tool.failed` emits only a `block-end` with error;
- a non-zero shell exit is a successful tool plus `exitCode` (a marker line), not a failure;
- `tool.input` is not rendered (as in v1).

**15.2-4 — Error semantics.** Every v2 write rejects with a readable `Error` (tagged errors as
`<_tag>: <message>`; `LocationNotFoundError` names `server.directory` and the config file); reads
resolve `undefined` on an error status; `abort` swallows and returns `{ interrupted }`. Transport
failures are rethrown.

**15.2-5 — "Connected providers" = every provider present in `model.list()`.** The v2 catalog lists only
usable models, so no separate connected signal is needed.

**15.2-6 — Incremental resync.** `getMissedHistory` plus rendered-message tracking; no `clearAll`, no
full replay. Reason: `--single` cannot erase lines already printed to the terminal, and the full replay
caused D-A. **Status:** Supersedes PL-8.

**15.2-7 — `fork` ignores `directory` on v2.** The fork keeps the parent's location.

**15.2-8 — Commands carry no client id on v2; echo suppression by the prefix `# /<name>`.** **Status:**
Superseded in 15.3 by the one-shot echo slot (C3-5); the prefix remains as a backstop.

**15.2-9 — Form cancel uses `session.form.cancel`.** Esc and Ctrl-C cancel the form server-side.

**15.2-10 — Permission title format `"action: r1, r2"`.** Deliberately differs from v1's title, because a
v2 ask carries an action and a list of resources.

**15.2-11 — The `message-completed` guard is kept as defensive code** although v2 does not need it.

**15.2-12 — Form input is active only when no picker is open and no compaction runs.** From Review B.

**15.2-13 — `--auto-spawn` stays v1-only.** It spawns a local server and skips detection. Documented,
not built (`docs/Stage15.md` "Known limits").

**15.2-14 — One startup flow for v1 and v2;** a failed default session creation prints `octmux: could not
create a session: <message>` and exits 1.

### 4.6 Stage 15.2 defects found live or in review, 15.2-D1–15.2-D12

All fixed in `390aa04` unless noted.

**15.2-D1 (D1) — v2 write errors swallowed** (`sendPrompt`, `sendCommand`, `compact`, `setModel`).
Fix: 15.2-4.

**15.2-D2 (D2) — `ModelInfo.modelID` used instead of `ModelInfo.id`** for model keys, the default model
and `switchModel`. Fix: key by `ModelInfo.id` (the short name) everywhere; `modelID` is the upstream
API name and is unused. **In force.**

**15.2-D3 (D-A) — First prompt of a new session rendered twice.** The auto-title `session.renamed`
arrives with a durable-seq gap; the full clear+replay re-rendered. Fix: 15.2-6.

**15.2-D4 (D-B) — Reasoning tail lost or rendered after the turn separator.** Fix: flush non-text tails
before the next text block and before turn end (renderer).

**15.2-D5 (G1) — Stranded "◑ generating 0:00" rows.** `fetchGitBranch` inherited stderr, which wrote
behind Ink. Fix: git with stdio ignore/pipe; tmux `execFileSync` with `QUIET_SYNC_OPTS`; Review B
extended this to the tmux-window `execFile`.

**15.2-D6 (G3) — `getMissedHistory` skipped interrupted or failed assistant messages** with no completion
time. Fix: count them as ended (completed, finish, error, or followed by an idle).

**15.2-D7 (G2) — Context meter stuck near 8.0K.** No defect reproduced; two paged regression tests added;
live re-check matched on all 9 turns. **Status:** Closed, no change.

**15.2-D8 (F-a) — Paste filter held a lone ESC.** Fix: release it after 40 ms without continuation.

**15.2-D9 (F-b) — Non-text deltas fragmented into one prefixed line each.** Fix: per-block non-text
tails (`_nonTextTails`), flushed at block end and retag.

**15.2-D10 — Form footer wording** ("Press type answer"). Fix: footer depends on field type.

**15.2-D11 — Review B fixes:** discovery pass after resync (major; P1 required it), `formActive` gated on
pickers and compaction (15.2-12), quiet stdio for the tmux-window `execFile`, and `--auto-spawn`
refused together with `server.directory` (exit 2). Targeted re-review PASS.

**15.2-D12 — Review A minor:** unreachable `case "session.created"` in `dispatch()` deleted.

## 5. Session C3 (Stage 15.3 and the follow-up fixes)

Session `20261013T190810Z-2568784`. Code `a7a65a0`, `3c5e213`; docs `25d0843`, `56ddacf`. Decided by the
operator unless noted.

**C3-1 — New /brain session.** The stale Stage C /brain session had already been closed as PASS (C10);
a fresh session started for 15.3. **Status:** Done.

**C3-2 — Orchestra / subagent badges fenced off.** Operator: "fence off oconona (Orchestra) issues for
now." Analysis: the badge and the subagent rows (which render only inside a badge) need the OpenCode
server on the same host as octmux, because oconona writes its sidecar files under
`~/.config/opencode/orchestra/sessions/` on the server host while octmux reads its own disk, and octmux
matches the harness session by its local cwd. This is pre-existing and applies to v1 with a remote
`--endpoint` too; not a v2 issue. Rejected: fixing the protocol gaps; showing subagent rows without a
badge (a new feature beyond parity). **Status:** Superseded for v2 by C4-2 (badge over the API);
in force for v1 (legacy) by C4-3.

**C3-3 — v2 child-model backfill fenced off.** v2's `session.created` carries no model, so the child's
model is `""`; it could be filled from the child's `session.step.started`. Operator: not now. **Status:**
Deferred; documented as a known limit.

**C3-4 — oconona handover written.** `~/Gin-AI/tmp/oconona-OCv2-support.md`: session-id resolution
breaks on v2 (port, auth, `/api` path and wrapped shape; `GET /session` returns HTML on v2); the
telemetry DB uses `session_v2`; the subagent tool is `subagent`, not `task`; options for remote hosts
(oconona to decide). **Status:** Done; follow-up belongs to oconona.

**C3-5 — One-shot command echo slot.** After an own `sendCommand`, the next user item in that session
that is not an own prompt and not already rendered is suppressed, whatever its text; one slot per
command, cleared by `resetEventState`; the `# /<name>` prefix stays as a backstop. Rejected: "prefix
only, document the limit" (built-ins `/review`, `/init` and `/rag`, whose template does not start with
`# /`, would render twice). **Status:** Implemented in `a7a65a0`; supersedes 15.2-8.

**C3-6 — No `runCommand` Backend member.** v1 already sends commands server-side via `sendCommand`;
`expandCommands` serves only completion and highlighting. Rejected: the plan's `runCommand` (PLAN-C2C3
§B.2, §E item 3). **Status:** In force (no Backend contract change in 15.3).

**C3-7 — FIX-1: release the slot when a command fails.** Review 1 (major): the slot leaked when
`sendCommand` or `ensureModel` threw, and would swallow the next foreign turn. Brain's fix, simpler than
the Reviewer's: `V2Backend.sendCommand` calls `releaseCommandEcho()` (floor 0) and rethrows; no contract
or `app.tsx` change. A prefix-only test with the slot at 0 was added (Review 1 minor). **Status:**
Implemented in `a7a65a0`.

**C3-8 — FIX-2: one claim rule for live and resync.** Review 2 (major): an echo seen only through resync
never consumed its slot. Brain's fix: `claimUserItem(id, text)` (own prompt → rendered → slot → prefix →
false) used by the live inbox path and by `getMissedHistory`; `isRendered` stays side-effect-free.
**Status:** Implemented in `a7a65a0`.

**C3-9 — Accepted trade-off: a foreign turn before the echo takes the slot.** A genuine foreign prompt
(for example from the mobile companion) arriving between an own command and its echo is swallowed; the
echo then renders as a user line unless it matches the prefix. The window is small. **Status:**
Accepted; documented.

**C3-10 — `/model`: the `V2Backend` cache follows `session.model.selected`.** Defect 1: after a foreign
switch to X, an own reselect of M was a cache hit, no `switchModel` was sent, and the turn ran on X
while the UI showed M. Fix: `translateAndTrackModel` records each `model-selected` event for the REPL's
session. **Status:** Implemented in `a7a65a0`.

**C3-11 — `/model`: compare with `activeModelRef`; remove `lastRequestedModelRef`.** Defect 2: the
one-shot ref stayed armed on a cache hit and swallowed a later genuine foreign switch. Rule: a
`model-selected` equal to the active model does nothing; any other is adopted. v1 is unaffected (it
emits `model-switched`). **Status:** Implemented in `a7a65a0`.

**C3-12 — Accepted race: two back-to-back `/model` switches** before the first echo can briefly show the
stale model; `model.selected` carries no client id, and the old design had the same exposure.
**Status:** Accepted; documented.

**C3-13 — Status line shows the server directory.** (Follow-up #7, pulled in by the operator.)
`deriveProjectName(serverDirectory)`, the basename of `server.directory`, falling back to the launch
directory; identical to before when `server.directory` is unset (including `--worktree`). The git
branch stays local. **Status:** Implemented in `a7a65a0`.

**C3-14 — Replay "Interrupted" marker, v1 and v2.** (Follow-up #1.) v1: assistant
`MessageAbortedError`; v2: idle item `outcome: "interrupted"` (assistant fields are inconsistent across
interrupt shapes). Placed immediately after the turn's `turn-end`. Operator chose the text exactly
"Interrupted", deliberately different from the live "Interrupted: What next?" so a replayed abort is
distinguishable from a live one. This flips the 15.2 choice of no marker. **Status:** Implemented in
`a7a65a0`.

**C3-15 — Abandon hint only during an orchestra run.** (Follow-up #2.) The error line appends
`abandonHint(badge)` only when `watcherRef.current?.getBadge()` is non-null, naming `/duo-abandon` for a
duo run and `/brain-abandon` otherwise; reads the ref, not the stale `orchestraBadge` state. **Status:**
Implemented in `a7a65a0`.

**C3-16 — The two deliberate v1 output changes** in 15.3 are the replay marker and the hint gating;
all other v1 output stays byte-identical (verified by Review 4). **Status:** In force.

**C3-17 — Marker on full replay only.** `isCompleteRenderable` is false for idle items, so incremental
resync never shows the marker (no double print). **Status:** Accepted limit; documented.

**C3-18 — FIX-3: `shouldEndCompacting` in resync.** (Brain decision.) The live gate found `/compact`
wedged input on v2, a defect shipped in 15.2: the server skips one durable seq between
`compaction.started` (N) and `compaction.ended` (N+2), the translator drops `ended` as a gap, and nothing
cleared `isCompacting`. Fix in `resyncOnce`, protocol-neutral: end compacting when the missed ops contain
a `compaction-divider` or the session is not active; also corrected the stale "clear and replay" comment.
v1 is untouched (`resync-needed` is v2-only). Brain stopped the in-flight Review 3 because the tree was
about to change (R12); Review 4 (fresh) PASSED. **Status:** Implemented in `a7a65a0`.

**C3-19 — Accepted limit: a failed compaction in the seq hole unlocks input silently.** Review 4 minor;
untested live. **Status:** Accepted; documented.

**C3-20 — Two v1 oddities: classified pre-existing, then fixed.** Brain A/B-tested against the 15.2
build `b1e205d`: v1 `/compact` printed a second divider; burst-typed input left the cursor at 0 so
Backspace deleted the first character (yank had the same fault). The operator then asked to fix both.
Filed as point releases per R14: Stage 5.6.1 (one compaction divider per part,
`dividedCompactionPartIDs`) and Stage 3E.2.1 (multi-character insert advances the cursor; yank leaves
the cursor after the yanked text). **Status:** Implemented in `3c5e213`, docs `56ddacf`.

**C3-21 — README edits approved.** The operator approved a v2 row in the startup table and a native-v2
paragraph. Brain corrected an Actor claim that `--worktree` is v1-only: it is refused only together with
`server.directory`. **Status:** Done (`25d0843`).

**C3-22 — Execution plan: parallel Actor waves.** (Brain amendment B1.) Wave 1: three Actors on disjoint
files; wave 2: one Actor for the two `app.tsx` steps. Parallel Actors do not run `build.sh`; Brain runs
the final gate. **Status:** Done.

**C3-23 — tsgo gate.** (Brain amendment B2.) `./node_modules/.bin/tsgo --noEmit -p . | grep -c "error TS"`;
baseline 67 at `b1e205d`, the same multiset required. **Status:** In force for this codebase until the
baseline changes.

**C3-24 — Live testing by a dispatched agent with the verbatim rules.** (Brain amendment B3.) Docs only
after the live checklist passes. **Status:** Done (v2 11/11 after FIX-3; v1 smoke 8/8).

**C3-25 — Scope notes.** Auto-compaction is out of scope (only `reason: "manual"` observed);
`--auto-spawn` stays v1-only; grandchild subagents not tracked live. **Status:** In force; documented in
`docs/Stage15.md` "Known limits".

**C3-26 — Host-local assumptions analysis.** (Requested by the operator.) octmux never writes under
`~/.config/opencode`. It reads, on its own host: `orchestra/sessions/` (the badge),
`opencode.json` (friendly model names for the badge label) and `commands/*.md` names (completion). All
three are host-local assumptions that break or degrade with a remote server. **Status:** Resolved in
Stage 15.4 (`4962c17`) by C4-1 to C4-5.

**C3-27 — Remaining pre-existing items left out of 15.3.** The `isRendered` `userText` parameter is dead
in production (Review 4 minor, kept); session-picker "fork of" label; 8-char id prefixes on `/fork` and
`/new`; and the carried 15.2 list. (A "server ignores the `GET /api/session` filter" item is withdrawn, see C4-10.)
**Status:** Open (§7 of this record).

## 5a. Stage 15.4: client-only boundary (after session C3)

**C4-1: octmux is a client; oconona is server-side.** (Operator, 2026-10-13.)
- octmux is an OpenCode client. It cannot and should not assume access to OpenCode server files and
  directories (`~/.config/opencode/`, `~/.local/share/opencode/`); it reaches the server only through
  its API.
- oconona installs agents, commands and scripts on the server and runs as the server's shell tool, so it
  inevitably owns server-side configuration and state.
- v2 is the main code path, since the local server will also move to v2; v1 is kept for legacy use.

The operator asked to replace the three host-local reads of C3-26 with API equivalents. Where v1 has
no equivalent, or one would be cumbersome, the gap is documented instead.

**Status:** In force (memory `feedback-octmux-client-only-boundary`).

**C4-2: v2 orchestra badge over the API, from session metadata.** (Operator chose this option
over "keep the file read and document it" and "remove the file read entirely".)
- New `Backend.getOrchestraState(sessionID)`. `V2Backend` reads the harness session's
  `metadata.orchestra` (`GET /api/session/{id}`).
- The contract that oconona publishes is defined in `src/backend/v2-orchestra.ts`:

  ```
  PATCH /api/session/{id}
  { "metadata": { "orchestra": { "version": 1, "mode": "brain" | "duo", "title": "…",
                                 "active": true, "updatedAt": <ms>, "parserWarnings"?: [...] } } }
  ```
- What octmux ignores:
  - an entry with `active` not `true`;
  - an entry older than 24 h;
  - an entry with a malformed `mode` or `title`.
- What octmux tolerates: unknown fields and newer versions.
- Verified live on OpenCode 2.0.28 from another host: the badge appeared, and `active: false` cleared it
  within 5 s.

**Status:** Implemented in `4962c17`. The badge stays empty until oconona publishes the metadata.

**C4-3: v1 badge stays on oconona's files (legacy).** v1 has no API channel for the run state, so
`V1Backend.getOrchestraState` keeps the sidecar-file read, moved unchanged into
`src/backend/v1-orchestra.ts`. It still needs a same-host server. The `fs.watch` trigger is dropped;
the 5 s poll remains. **Status:** In force (legacy), `4962c17`.

**C4-4: Model display names from `listProviders()`.** Both protocols serve the model catalog with
display names, so the `~/.config/opencode/opencode.json` read is removed. **Status:** Implemented in
`4962c17`.

**C4-5: Slash completion from the server's command list.** `setServerCommands` is fed by the same
`listCommands` result that decides forwarding, on both protocols. The `~/.config/opencode/commands/*.md`
scan is removed. Server commands appear in completion once the list arrives, shortly after startup.
**Status:** Implemented in `4962c17`.

**C4-6: Fact: `PATCH /api/session/{id}` replaces `metadata` as a whole.** Verified live: two PATCHes
with different keys leave only the second key. oconona must read the current metadata, then write it
back with `orchestra` set. **Status:** Recorded in the contract (`src/backend/v2-orchestra.ts`) and the
oconona handover.

**C4-7: Contract ACK and amendments from oconona.** oconona acknowledged the following and sent
amendments A1–A8:
- the harness session and `metadata.orchestra`;
- schema `version: 1`;
- the write points;
- the read-before-write and tolerance rules;
- keeping the v1 sidecar files.

**Status:** Agreed. oconona fully acknowledged the amended contract (Stage 15.4.1) on 2026-10-14, so the
contract is final on both sides. The amendments are handled by C4-8 to C4-11.

**C4-8: A3: never read the badge from a child session.** A child session is created with a copy of its
parent's metadata (OpenCode `packages/core/src/session.ts`), so every subagent carries a stale
`orchestra.active: true`. `V2Backend.getOrchestraState` returns `null` for a session with a `parentID`.
Verified live: the child inherited `active: true`; octmux showed no badge on the child and showed the
badge on the parent. **Status:** Implemented in `fe6c7a5`.

**C4-9: A5/A6: end-of-run notice.** (Operator chose this over "accept; document only".)
- Parser warnings are produced at cleanup, so they arrive in the final `active: false` write, together
  with the optional `outcome` (A6).
- The badge stays active-only.
- When a run seen active turns inactive in the same session, octmux prints one line, for example
  `orchestra brain run ended: pass · 2 parser warnings (…)`.
- A run that was never seen active, or whose key is removed, prints nothing.
- v1 is unchanged.

**Status:** Implemented in `fe6c7a5`.

**C4-10: A1/A2: transport and lookup.**
- oconona writes through an in-server plugin (`ctx.session.update`), not HTTP PATCH. The contract names
  the transport as oconona's choice; both replace `metadata` as a whole.
- On v2, oconona takes the session id from `OPENCODE_SESSION_ID`.
- Correction: the session-list filter is the flat `directory` query (with `parentID=null` for root
  sessions), which octmux already sends. The earlier "server ignores the filter" finding came from a
  tester that used `location[directory]`, and it is withdrawn.

**Status:** Recorded in `src/backend/v2-orchestra.ts`, `docs/Stage15.md` (15.4.1) and the handover.

**C4-11: A4, A7, A8: no octmux change.**
- oconona refreshes `updatedAt` hourly on shell activity, so runs longer than 24 h keep their badge (A4).
- `orchestra-hook.sh` is removed as dead code; OpenCode never read those hooks (A7).
- v1 keeps the file-based, same-host badge (A8).

**Status:** Recorded.

## 5b. Stage 15.2.1: client and server directory trees differ (2026-10-14)

**D15.2.1-1 — Check the location before any session is used.** Operator, after the MBP showed
"Session location unavailable". A v2 `session.create` accepts a directory the server does not have
and leaves a project record that cannot be deleted. octmux calls `location.get` first and exits 1,
listing the server's resolvable projects. **Status:** Implemented in Stage 15.2.1.

**D15.2.1-2 — `server.directoryMap` for shared storage.** Operator chose a per-server prefix map in
`octmux.json` (`{ "/mnt/nfs": "/Volumes/Disks" }`). Longest whole-segment prefix wins; refused together
with `server.directory`, which stays as the fixed override. **Status:** Implemented in Stage 15.2.1.

**D15.2.1-3 — Multi-tenant use is out of octmux's scope.** One OpenCode server is one tenant (shared
password, global event stream, tools run as the server's OS user). Isolation is one server per tenant;
the general case is "choose a server project", not "send my cwd". Recorded in
`docs/OpenCode-v2-notes.md` "Known Limitations". Choosing a project by repo identity or `--project` is
not scheduled. **Status:** Recorded.

## 6. Rejected alternatives

| Alternative | Rejected by, when | Reason | Ref |
|---|---|---|---|
| octmux manages ssh tunnels | Operator, Stage 14 run | Reaching the endpoint is not octmux's job; fail loudly instead | D1 |
| Reading the remote host's `service.json` for credentials | Brain, Stage 14 Phase 0 | Impossible remotely; credentials come from `octmux.json` | D4 |
| Exact version match with the server | Operator ("a bit extreme"), Stage 14 run | Would force an octmux release per OpenCode minor | D12 |
| One-off hand-written v2 fetch client | Operator, Stage 14 run | Prefer a maintained library that evolves with the API | D10 |
| `@opencode-ai/sdk/v2` (1.19.0) | Brain, Stage 14 Phase 0 | Mixes v1 legacy paths with `/api` routes; version line unrelated to the server | D13 |
| OpenAPI-generated client as primary | Operator/Brain, Stage 14 run | The spec types event payloads as an opaque string; kept only as last fallback, never needed | D13 |
| Adapter translating v2 into octmux's v1 event model | Operator, Stage 14 run | Native v2 model chosen | D7 |
| Two parallel pipelines | Operator, Stage 14 and Stage C runs | Duplicate features forever | D7 |
| Deprecating v1 | Operator, Stage C run | Local systemd server and mobile/P4OC are v1 | C2 |
| Core-first subset / minimal spike | Operator, Stage C run | Full parity chosen | C1 |
| Planning C2/C3 in detail before capture 3 | Operator, Stage C run | Facts first | C4 |
| Designing remaining gaps from client types only | Operator, Stage C run | A third capture chosen | C3 |
| Committing scrubbed capture copies as test fixtures | Operator, Stage C run | Stage 14 precedent: never commit captures | C6 |
| Separate "## 7. Capture 3" doc section | Brain, Stage C run | Integrate per concept, no tombstones | N2 |
| `Backend` Option A (everything flat) | Brain, Stage C run | Option B keeps the `session.*` call sites unchanged | N3 |
| `listPermissions` / `listQuestions` as v2 no-ops | Brain (P1), Stage C run | Pending asks at attach or in a gap would never surface | P1 |
| Full clear + replay resync | Brain, session C2 (after D-A) | `--single` cannot erase printed lines; duplicated the first prompt | PL-8, 15.2-6 |
| Per-kind stream ordinal as block key | Brain, session C2 | Collides between reasoning and text in one message | 15.2-2 |
| Unifying `model-selected` with `model-switched` | Planner/Brain, session C2 | Would change v1 semantics | PL-4 |
| Streaming compaction progress live | Planner/Brain, session C2 | 116 chunks; static compacting state instead | PL-7 |
| Prefix-only command echo suppression | Operator, session C3 | `/review`, `/init`, `/rag` would render twice | C3-5 |
| `runCommand` Backend member | Brain/operator, session C3 | v1 already uses server-side `sendCommand` | C3-6 |
| Reviewer's FIX-1 shape (contract change) | Brain, session C3 | Releasing the slot inside `V2Backend` needs no contract change | C3-7 |
| One-shot `lastRequestedModelRef` | Brain/Planner, session C3 | Stays armed on a cache hit and swallows a foreign switch | C3-11 |
| Subagent rows without a badge | Operator, session C3 | New feature beyond parity | C3-2 |
| Fixing orchestra protocol gaps in octmux now | Operator, session C3 | Fenced off for oconona | C3-2 |
| Keep the orchestra file read on v2 and document it | Operator, Stage 15.4 | octmux is a client; v2 is the main path | C4-2 |
| Remove the orchestra file read on both protocols | Operator, Stage 15.4 | v1 has no API alternative; keep it as legacy | C4-3 |
| Accept the rarely seen " !"; document only | Operator, Stage 15.4.1 | An end-of-run notice shows the cleanup warnings | C4-9 |
| Replay marker text "Interrupted: What next?" | Operator, session C3 | Replay must be distinguishable from live | C3-14 |
| Sharing the orchestra directory via NFS/sshfs | Handover analysis, session C3 | Outside both projects; subtle path and latency errors (oconona to decide) | C3-4 |

## 7. Open questions and deferred items

### 7.1 Fenced orchestra work (oconona)

- oconona implements the agreed contract (C4-2, as amended by C4-7 to C4-11; `src/backend/v2-orchestra.ts`)
  with its in-server plugin. Until it ships, the v2 badge stays empty. No octmux work is open.
- v2 child-model backfill from the child's `session.step.started` (C3-3).
- oconona on v2: session-id resolution (port, auth, `/api/session` path and wrapped shape), telemetry from
  `session_v2`, `subagent` instead of `task` in prompts and hooks (handover §2.1, §2.3).

### 7.2 Pre-existing follow-ups from `docs/Stage15.md` (15.3 entry)

- Session picker labels any session with `parentID` as a fork; on v2 the subagent child is labelled a
  fork and a real `/fork` gets no label (`SessionPickerModal.tsx`).
- `/fork` and `/new` print only the 8-character id prefix; short id prefixes collide in the pickers.
- `isRendered`'s `userText` parameter is unused in production.
- Tmux-window line buffers keyed by role (F-d).
- Tall pickers leave stale rows after Esc.
- Occasional 3 s health-probe timeout right after a previous octmux exit.
- Replay hides tool output when tools-output is off.
- (Fixed and therefore closed: the v1 double compaction divider and the burst-input cursor, C3-20;
  the replay "Interrupted" marker and the hint gating, C3-14 / C3-15; F-a and F-b, C9.)

### 7.3 Known limits accepted (from `docs/Stage15.md` "Known limits")

Partly received messages at a gap are not repaired; a message whose opening frame was lost renders only
after the next switch or resync; a live compaction summary has no id and may re-render after a later
gap; a real dropped frame has not been observed live; grandchildren not tracked; `permission.replied`
does not clear a modal answered elsewhere (as v1); the foreign-turn echo-slot window (C3-9); silent unlock
on a failed compaction in the seq hole (C3-19); marker on full replay only (C3-17); resync-rendered
compaction looks like history; auto-compaction out of scope; `--auto-spawn` v1-only; the `/model`
back-to-back race (C3-12).

### 7.4 Unobserved protocol facts

`docs/OpenCode-v2-protocol-capture.md` §6 lists what captures 1–3b did not observe (non-zero cost,
reconnection under load, permission replies other than `once`/`reject`, child asks in the parent's
list, subagents other than `general`, `order` with `cursor`, a child tool raising a permission, and
others). No capture 4 is scheduled (PLAN-C2C3 "Out of scope").

### 7.5 Review minors not fixed

- A failing `{file:}` token in `server.url` does not name the key `server.url` (S14-5).
- `docs/Implementation-plan.md` index gaps for Stages 5–13 (Stage 14 Review 1 minor, pre-existing).

## 8. Session `20261018T151945Z-2329778` (Stage 15.5): remove OpenCode v1 support

Session `20261018T151945Z-2329778`. No live capture was needed: the change removes code and does not depend on new protocol facts.

**15.5-1 — Remove OpenCode v1 support entirely.** The operator confirmed that no install base still needs v1: the local systemd server and the mobile/P4OC setups are now v2 or retired. This supersedes C2. octmux becomes a v2-only client. `V1Backend`, the v1 modules, `--auto-spawn`, `src/server-lifecycle.ts` and the `@opencode-ai/sdk` dependency are removed. A detected v1 server is a hard startup error that names the reason and exits 1. The `/global/health` probe in `src/protocol-detect.ts` is kept only to produce that message. A 401 from the health probe is also treated as v1, so the separate "v1 unauthorized" outcome is removed.
Rejected: keeping `--auto-spawn` and making it spawn a v2 server (new code, and the operator chose a clean break); reporting a v1 server as "unreachable" (a vaguer error); keeping `@opencode-ai/sdk` as a type-only dependency (it would leave a v1 package in the tree). **Status:** Implemented in `<pending>`.
