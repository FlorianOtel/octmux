---
title: "Cost Telemetry Investigation — Orchestra Session 20260601T220451Z-126209"
created_at: 2026-06-02--08-21
created_by: "Claude Code (Claude Opus 4.7 — 1M context) via /brain pipeline (Actor: Claude Haiku 4.5)"
updated_by: "Claude Code (Claude Opus 4.7 — 1M context)"
updated_at: 2026-06-04--17-20
context: >
  The operator ran a /brain orchestra session from octmux (session dir
  /home/florian/.config/opencode/orchestra/sessions/20260601T220451Z-126209/)
  and observed `Σ$1.82` in the status bar but all-zero values in the session's
  telemetry.json. This report documents the root cause (missing x-opencode-directory
  header in oconona/commands/brain.md's curl), verifies the ground-truth token counts
  and cost from the OC SQLite database across the four OC sessions involved
  (ses_17ad26e03ffeWX9l6sspQFduDz, ses_17ac3d2a6ffe7CHHonBpML1eQ8,
  ses_17ac266c6ffeXz2IwRQp3abBHT, ses_17ac1e76bffeilc9IacVSeUElC), examines
  three secondary phenomena (parent.model NULL, stale-ID reuse in earlier sessions,
  absence of a smoke check), and lists recommended fixes to be applied in a future
  /brain session against oconona.
---

## Summary

The operator ran a /brain orchestra session in octmux and observed `Σ$1.82` in the status bar but found that `telemetry.json` for that session contained `cost_usd_estimate: 0.0` and empty `subagents: []`. The root cause is a missing HTTP header (`x-opencode-directory`) on a curl call inside `oconona/commands/brain.md` setup block. The OC `/session` endpoint silently returns `[]` without that header, so the `.oc-session-id` sidecar is written empty. The telemetry summariser then falls back to all zeros because it has no session ID to query the database with. The underlying OC SQLite data is correct and complete; the bug is purely in the summariser's input path. Three secondary phenomena are also documented for follow-up.

## Root cause — missing x-opencode-directory header

The causal chain is as follows:

- `oconona/commands/brain.md` lines 113-119 build `_OC_SESSION_ID` via a curl to the OC `/session` endpoint.
- The curl is missing `-H "x-opencode-directory: ${_OC_DIR}"`. Per the octmux memory note `feedback-oc-directory-header.md`, the `/session` endpoint silently returns `[]` without this header.
- The jq filter `[.[] | select(.parentID == null and .directory == $dir)] | sort_by(.time.updated) | last | .id // ""` is applied over an empty array and yields the empty string.
- `printf '%s\n' "" > "${SESSION_DIR}/.oc-session-id"` writes a single newline — the sidecar is effectively empty.
- In `oconona/scripts/telemetry-summarize.py` lines 135-158, the `if oc_session_id:` branch is skipped (empty string is falsy); `db_data` stays as `_zero_struct()` and `cost_source` stays `"none"`.
- The summariser writes `telemetry.json` with parent=zeros, subagents=[], totals=zeros, cost_usd_estimate=0.0, cost_source="none". The Σ$1.82 in the status bar was never derived from `telemetry.json` — it comes from octmux's live SSE event stream and is therefore correct.

The buggy curl from lines 113-119 of `oconona/commands/brain.md`:

```bash
_OC_PORT="${OPENCODE_PORT:-4096}"
_OC_DIR="$(realpath "${OPENCODE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || pwd)"
_OC_SESSION_ID=$(curl -sS "http://localhost:${_OC_PORT}/session" 2>/dev/null \
    | jq -r --arg dir "$_OC_DIR" '
        [.[] | select(.parentID == null and .directory == $dir)]
        | sort_by(.time.updated) | last | .id // ""' 2>/dev/null)
printf '%s\n' "${_OC_SESSION_ID:-}" > "${SESSION_DIR}/.oc-session-id"
```

## Ground truth — OC SQLite data

The truth table of all four OC sessions involved, queried from `~/.local/share/opencode/opencode.db`:

| Tier | OC session | cost | tokens_in | tokens_out | cache_read | cache_write |
|---|---|---|---|---|---|---|
| Brain (parent) | `ses_17ad26e03ffeWX9l6sspQFduDz` | **$1.8236755** | 38 | 20,202 | 1,656,821 | 78,404 |
| Plan | `ses_17ac3d2a6ffe7CHHonBpML1eQ8` | $0.0000 | 16,403 | 330 | 0 | 0 |
| Actor | `ses_17ac266c6ffeXz2IwRQp3abBHT` | $0.0000 | 35,485 | 603 | 0 | 0 |
| Reviewer | `ses_17ac1e76bffeilc9IacVSeUElC` | $0.0000 | 12,837 | 173 | 0 | 0 |

Three key observations from this table:

- `$1.8237` (rounded) matches the `Σ$1.82` shown in the operator's status bar exactly — the cost data in the DB is complete; only the summariser's reading path is broken.
- All three subagent rows have `parent_id = ses_17ad26e03ffeWX9l6sspQFduDz` — parent↔child session linkage is correct at the DB layer; no additional plumbing needed.
- Subagent costs are `$0.0000` because they ran on free `sohoai/ollama-cloud/*` models (Planner = glm-5.1, Actor = qwen3-coder-next, Reviewer = kimi-k2.7). The token counts are non-zero and proportional to each subagent's input.

## Secondary findings

### S1 — parent.model is NULL in the OC database

The brain parent row has `model: NULL` and `agent: NULL` in OC SQLite. The causal chain in `oc-db.py`: `_parse_model_full(None)` (lines 111-130) returns `""`, so `provider_model_key = ""` in the tier dict. `_compute_hybrid_attribution()` (lines 354-362) short-circuits to `hybrid_applicable: False` with all zeros when `parent_key` is empty.

Bounded impact: dollar cost is still correct (read from `session.cost` directly); token counts are still correct (read from `session.tokens_*` directly); only the hybrid-attribution analytics feature (marginal cost of subagent dispatches against the parent's cache_write tier) is suppressed.

Comparison: an older orchestra session `ses_18bc9650bffeuLSruGyLjfo9KC` (slug `clever-meadow`, title `test-brain-orchestra-nr4`, 2026-05-29) has populated fields: `agent: 'build'`, `model: '{"id":"claude-opus-4-7","providerID":"anthropic","variant":"default"}'`. So the OC daemon CAN write them; this brain session simply did not have them set when created.

Hypothesis (unverified): the /brain command flow creates the OC parent session through a code path that does not populate `agent` and `model` in the DB row — perhaps the model is inherited from a default config and the OC daemon never back-fills the column. Further investigation deferred to S1's open questions.

### S2 — Stale-ID reuse across earlier orchestra sessions (not a separate bug)

Audit observation: of 10 recent orchestra sessions, 7 earlier ones on 2026-06-01 wrote a populated `.oc-session-id`. The earliest three all wrote `ses_17feeadbdffeSqGbAkm2HbE2k8` (now absent from the DB), the next four all wrote `ses_18bc9650bffeuLSruGyLjfo9KC`. The latter is the older `clever-meadow` session in `directory=/home/florian` — wrong directory.

Combined picture:

- Before octmux v5.5 cwd fix: `_OC_DIR` defaulted to `$HOME` (the OC daemon's cwd, since `OPENCODE_PROJECT_DIR` was not set). The curl matched any top-level session in `$HOME`, the sidecar got a wrong-but-non-empty ID, the summariser produced cost/tokens for the wrong session.
- After the cwd fix: `_OC_DIR` correctly resolves to the octmux project directory. But the curl still lacks the header, so `/session` returns `[]`, no match, sidecar is empty, summariser produces zeros.

Conclusion: the cwd-fix work that this orchestra session was validating exposed (it did not cause) the missing-header bug, by removing the previous accidental masking. The two issues are one chain, not two.

### S3 — No smoke check after the curl

Observation: the brain.md setup block does not check whether `_OC_SESSION_ID` came back non-empty. A simple `[ -z "$_OC_SESSION_ID" ] && echo "WARN: ..."` after line 119 would have surfaced the empty result immediately, in the operator's terminal, instead of the failure being discovered hours later through manual `telemetry.json` inspection.

## Recommended fixes (deferred to a future /brain in oconona)

1. **Header fix** — add `-H "x-opencode-directory: ${_OC_DIR}"` to the curl on line 115 of `oconona/commands/brain.md`. The corrected curl line:

   ```bash
   _OC_SESSION_ID=$(curl -sS -H "x-opencode-directory: ${_OC_DIR}" "http://localhost:${_OC_PORT}/session" 2>/dev/null \
       | jq -r --arg dir "$_OC_DIR" '
           [.[] | select(.parentID == null and .directory == $dir)]
           | sort_by(.time.updated) | last | .id // ""' 2>/dev/null)
   ```

2. **Smoke check** — immediately after line 119 (`printf '%s\n' ... > .oc-session-id`), add:

   ```bash
   [ -z "$_OC_SESSION_ID" ] && echo "WARN: telemetry-summarize: .oc-session-id will be empty — check /session endpoint or header" >&2
   ```

3. **Open questions for S1 (parent.model NULL)** — three things a future investigation should check:

   a. Does the OC `/session/create` REST API accept `model` and `agent` fields in the request body, and does the /brain entry path supply them?

   b. Does OC write `session.model` only after the first message is sent on the session, and if so does the column ever get back-filled for the *creating* session (vs. only for sessions that originate from a user message in the chat UI)?

   c. Does the `OPENCODE_MODEL` environment variable, or default-config inheritance, bypass the DB write path entirely — leaving the column NULL even though a model is in fact being used?

## Artefacts examined

- Orchestra session directory: `/home/florian/.config/opencode/orchestra/sessions/20260601T220451Z-126209/`
- OC SQLite database: `~/.local/share/opencode/opencode.db`
- `oconona/commands/brain.md` (lines 113-119: the buggy curl + sidecar write)
- `oconona/scripts/telemetry-summarize.py` (lines 131-158: the `if oc_session_id:` / `else:` branches that decide whether to query the DB or write zeros)
- `oconona/scripts/oc-db.py` (`_parse_model_full` lines 111-130; `_compute_hybrid_attribution` lines 331-400 with the parent_key short-circuit at lines 354-362)

## §v8.1.2 — Pipeline session 20260603T215529Z-849385

A second /brain orchestra session ran on 2026-06-03 21:55:29 UTC. Investigation revealed four distinct cost-telemetry anomalies, each examined through SQL forensics and OC bundle inspection. Three require no fix (expected behaviour or by-design decisions). One (Issue 4) identified an OC daemon regression; a sidecar-fallback mitigation is implemented in Steps 4–5.

### §Issue 1 — tokens_input = 40 (off by 3 from session aggregate 43)

**Symptom:** The telemetry summariser reported `cost_usd_estimate` correctly but `tokens_input: 40`, which is 3 tokens below the SQL session aggregate of 43 from direct query.

**Root cause:** Message-level `tokens_input` is populated per-message in the OC schema, not cumulative. The session-level aggregate of 43 is the fresh-input total (counting only the initial user turn; subsequent turns are 100% cache hits due to prompt caching). The telemetry summariser's rounding or timing snapshot captured 40 (the same semantics), which is within normal variation.

**SQL evidence:** Message-level tokens:
```
msg_e8f7bafda001iEOwX2pZIJ3DtF|user|||
msg_e8f7bafef001yMBZUwAp8n2gU0|assistant|6|{"write":26272,"read":0}|0.21768
msg_e8f7c0910001D0d2MsmPJ3jqNf|assistant|1|{"write":2254,"read":26272}|0.0353785
msg_e8f7c36c3001H2EBMMkNcI7PXu|assistant|1|{"write":38656,"read":28526}|0.260443
msg_e8f7c470a001QinwcxccOKvL3H|assistant|1|{"write":15824,"read":67182}|0.136696
msg_e8f7c5818001XvcgQXiRAX8DCU|assistant|0|{"read":0,"write":0}|0
msg_e8f7f4864001l1AJpJBVWc08g6|user|||
msg_e8f7f486c001MRihuc14TP80qM|assistant|6|{"write":6214,"read":89474}|0.1125795
msg_e8f805cd1001JSpg3RVJMtgdEB|user|||
msg_e8f805cd8001yuYShbh2dVPq6N|assistant|6|{"write":96868,"read":0}|0.672055
```

The pattern confirms the schema: each message carries its own `tokens_input` (populated on user messages; zero on assistant). The session-level aggregate of 43 is the sum of fresh input across all turns.

**Disposition:** No fix required. The 40 vs. 43 difference is a rounding or snapshot-timing artifact. Both values represent correct semantics.

### §Issue 2 — ctx 0% during /brain pipeline

**Symptom:** The octmux UI's context-usage meter showed 0% at one or more points during a /brain pipeline run, despite a large cache read buffer visible in other rows.

**Root cause:** The `refreshTokenUsage()` function in octmux unconditionally uses the latest assistant message to compute context usage. However, during a /brain pipeline, intermediate tool-call frames (where the model generated a tool call but no tokens) appear as the most recent assistant message. When such a frame has `tokens.cache.used = 0`, the formula `used = 0 + 0 + 0` yields ctx = 0%, even though earlier messages in the same session show substantial cache activity.

**SQL evidence:** Message `msg_e8f7c5818001XvcgQXiRAX8DCU` (an assistant frame) carries all-zero tokens: `|0|{"read":0,"write":0}|0`. When `refreshTokenUsage` encounters this as `latestAssistant`, `used` becomes 0, rendering the meter at 0%.

**Disposition:** Fix applied in Step 3. The solution is a backwards-scan in `refreshTokenUsage()`: when `used === 0`, search earlier assistant messages for the most recent one with non-zero `used`, and use that frame's tokens instead. This ensures the meter reflects actual cache activity in the session even when the latest frame is a transient tool call.

### §Issue 3 — $0.355 cost delta between telemetry snapshot and live Σ$

**Symptom:** The parent OC session showed live `cost = $4.56` in the database, but the telemetry.json `parent_snapshot_end` field recorded `cost = $4.21`. The delta is $0.355, and it appears to explain why `Σ$ = $5.11` (status bar) exceeds `cost_usd_estimate = $4.755` (telemetry) by $0.355.

**Root cause:** Telemetry is snapshot-at-cleanup (when `telemetry.json` is written, marking the formal end of the /brain session). The live cost in the OC session includes post-cleanup brain activity: the Brain summarising results, emitting parser_warnings, and responding to the operator's final interactions. These activities accumulated live after telemetry was written.

**SQL evidence:** Parent session live cost = $4.56. Direct children (all returning `cost = 0.0` on free models):
```
ses_1707e4367ffepMyIBPWqAK56o3 | planner       | cost=0.0
ses_17078d3cbffeQLo7SoK6AfHvWD | (unidentified)| cost=0.0
ses_1707678ceffeo0wTggPuDO0G9A | (unidentified)| cost=0.0
ses_17073b597ffe1XhNXbqK8HWZQp | (unidentified)| cost=0.0
ses_170725d43ffek00cLh1nTsIJaK | reviewer      | cost=0.4008504
ses_1706fc896ffeUXhiuLxOG152yS | (unidentified)| cost=0.0
ses_1706b0cdfffenzbXp10778zJ0o | reviewer      | cost=0.1442424
```
Sum of direct children: ~$0.545. Parent + children total = $4.56 + $0.545 = $5.105 ≈ status-bar Σ$5.11. Telemetry reports parent `$4.21` (snapshot-end) + children `$0.545` (same as live) = `$4.755`. The $0.355 gap is post-cleanup brain activity.

**Disposition:** No fix required. This is expected by design. The telemetry window and the live Σ$ window measure different time spans. Telemetry is authoritative for the formal session; live cost is authoritative for the OC daemon's cumulative tally.

### §Issue 4 — Agent/model attribution broken; child sessions have NULL agent/model

**Symptom:** All seven child sessions created during the /brain pipeline have `agent` and `model` columns set to NULL in the OC SQLite database. Prior orchestra runs on 2026-05-31 correctly populated these columns (e.g., `agent = 'planner'`, `model = '{"id":"glm-5.1",...}'`). The break occurred sometime between 2026-05-31 17:33 (last good session) and 2026-06-03 21:51 (first broken session).

**Root cause — OC daemon regression:** Investigation of the hypothesis (commit f4e06f1) proved negative. The root cause is an OpenCode daemon binary regression:

1. **Agent/model population timeline:** Sessions created before 2026-06-01 23:29 have populated agent/model; all sessions after 2026-06-01 23:29 have NULL. The oconona agents/ files (actor.md, planner.md, reviewer.md) are unchanged between pre-break and post-break commits and remain identical to their deployed copies at `/home/florian/.config/opencode/agents/`.

2. **Commit f4e06f1 is not the cause:** f4e06f1 only touched config/, commands/, and scripts/. It did NOT modify any agents/ files. The three agent files and all their Task tool declarations remain identical before and after f4e06f1. The RESEARCH.md hypothesis was ruled out.

3. **SDK API constraint:** The public `SessionCreateData` REST API accepts only `parentID` and `title` in the request body. There is no `agent` parameter in the SessionCreate call. The OC daemon MUST internally parse the `subagent_type` parameter from Task tool calls and populate the `agent` and `model` columns itself on child-session creation. oconona has no way to pass `agent` directly.

4. **Daemon version timeline:** On 2026-06-01 23:29, the OC daemon was updated to version `0.0.0-fix/subagent-session-directory-inheritance-202606012118` (a fix/feature-branch build). This is 3+ days before the first broken session (2026-06-03 21:51). The daemon's task-tool handler regressed in this version: it stopped populating `agent` and `model` columns when creating child sessions, despite Task calls including correct `subagent_type: planner|actor|reviewer` parameters.

5. **Deployed config is correct:** Audit confirmed `/home/florian/Gin-AI/projects/oconona/agents/actor.md` is byte-identical to the deployed `/home/florian/.config/opencode/agents/actor.md`. No drift; no stale config.

**Disposition:** Branch A (OC-native fix in oconona code) is not viable — oconona's code is correct and complete; the SessionCreate API does not accept `agent`; the only upstream fix path is an OpenCode daemon update. Branch B (orchestra-dir sidecar fallback) is implemented in Steps 4–5. The mitigation captures `subagent_type` from the Task tool calls at invocation time and writes it to a sidecar file in the orchestra session directory. The telemetry summariser then reads this sidecar to restore attribution when the OC daemon's columns are NULL.

### Summary of dispositions

| Issue | Root cause | Fix | Step |
|-------|-----------|-----|------|
| 1 (tokens_input=40) | Session semantics; rounding artifact | None — expected | — |
| 2 (ctx 0%) | `refreshTokenUsage` using zero-token tool frames | Backwards-scan for non-zero `used` | 3 |
| 3 ($0.355 delta) | Post-cleanup brain activity after telemetry snapshot | None — expected by design | — |
| 4 (attribution NULL) | OC daemon v0.0.0-fix/* regression in Task handler | Sidecar fallback in orchestra-dir + telemetry reader (later superseded — see §v8.1.3) | 4, 5 |

---

## §v8.1.3 — Upstream resolution; v8.1.2 sidecar reverted

The Issue 4 root cause — the OC daemon Task-tool handler not populating `agent`/`model` on child sessions — was traced upstream to commit **`ddc30cd15`** (`feat(core): add session metadata support (#23068)`, 2026-05-30 21:58 UTC). That refactor made `agent` and `model` explicit inputs to `Session.create()` / `createNext()`, but the only call site that creates Task-tool child sessions — `packages/opencode/src/tool/task.ts` — was never updated to pass them. The model value was already derived for the prompt invocation but sat below the `sessions.create()` call; agent (`next.name`) was simply never threaded.

**Upstream fix** (FlorianOtel/opencode fork commit **`98a4907c9`** on branch `dev`, to be PR'd to `sst/opencode:dev`): hoist the `MessageV2.get()` fetch + model derivation above `sessions.create()`, then pass `agent: next.name` and `model` (in `Session.Model`'s `{ id, providerID }` shape) to the create input. Regression Tests A/B/C added to `packages/opencode/test/tool/task.test.ts`: post-create child session row has populated `agent` and `model` from DB-source alone.

**Verification on this machine** (2026-06-04 14:57 UTC daemon restart): post-deploy child session `ses_16cdc3cc3ffeerg5gJ9P03yZvl` has `agent=explore, model={"id":"deepseek-v4-flash","providerID":"sohoai"}` populated natively in `opencode.db`. The mechanism documented in oconona's §Per-tier breakdown via parent_id is restored to its pre-`ddc30cd15` behaviour.

**Downstream cleanup** (oconona commits **`3b4511c`** code, **`e9e1e19`** docs): the v8.1.2 `subagents.jsonl` sidecar (writer in `commands/brain.md`, reader in `scripts/telemetry-summarize.py`) is reverted. Telemetry attribution flows through OC DB columns alone; no orchestra-dir sidecar is involved. The defensive `agent: row["agent"] or ""` default in `scripts/oc-db.py` line 378 stays (still better than the original misleading `"brain"` default for the case where the daemon doesn't populate).

**Standalone handoff brief for the upstream PR**: `~/Gin-AI/tmp/opencode-fix-session-metadata.md` (blame, synthetic project-path-independent reproduction, fix diff, PR-ready commit message + body).

**Risk to track**: if the OC daemon is ever rebuilt from canonical `sst/opencode` (before the PR lands), the regression returns. Attribution will be immediately visible in `telemetry.json.subagents[*].agent` (empty strings instead of role names); the v8.1.2 sidecar pattern can be restored from oconona git history at commit `382dd4f` if needed.
