---
title: "OpenCode v2 protocol — live capture characterisation"
created_at: 2026-10-13--13-46
created_by: Claude Code (Claude Haiku 5.5)
updated_by: Claude Code (Claude Haiku 5.5)
updated_at: 2026-10-13--16-50
context: >
  Phase B step B9 of the Stage 14 orchestra run. Live captures of the OpenCode 2.0.28 v2 server on the MBP
  desktop shared service. Captures 1 and 2 are from that run; captures 3 and 3b are from the later Stage 15
  sub-stage C0 run. Capture 1: one session, one prompt (question tool, then shell `ls -la`,
  then reply "done"), outcome succeeded in about 4.5 s. Raw artefacts live in the session directory
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/20261013T104013Z-1717914/v2-capture/.
  Capture 2: a second session on the same server, created with a per-session `permissions` ruleset
  (effect `ask` for `shell` and `bash`) so that shell calls required approval, with a prompt that drove two
  parallel shell calls (one approved, one rejected) and one subagent call. Outcome succeeded in about 10.3 s.
  Raw artefacts live in the same session directory under v2-capture-2/. Neither capture is committed.
  Capture 3 (Stage 15, sub-stage C0): a session on the same server, created with the same `ask` ruleset, while the
  model provider was failing server-wide. Every model step failed with `provider.transport` (FailedToOpenSocket), so
  capture 3 observed model-free paths only: user shell commands, client-supplied prompt ids, session commands, a
  failing compaction, a model select, API-created permission and form items, global and per-session list routes,
  event-stream reconnects with a durable-seq gap, REST resync, message paging and child listing. Capture 3b (same
  run, later): the same server after the operator restored gateway reachability. Model steps succeeded, so capture 3b
  observed model-driven shell exit codes, tool-raised permissions, an interrupt during a running tool, a real subagent
  and a successful compaction. Raw artefacts live under v2-capture-3/ and v2-capture-3b/ in the session directory
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/20261013T123149Z-1871118/. Neither is committed.
  This document describes what was observed and maps it onto octmux concepts. It is input for the
  native-v2 octmux stage (Stage C), not a design.
---

# OpenCode v2 protocol — live capture characterisation

Citations name their capture. `v2-capture/<file>:N` refers to the capture 1 artefact directory,
`v2-capture-2/<file>:N` to the capture 2 directory, `v2-capture-3/<file>:N` to the capture 3 directory and
`v2-capture-3b/<file>:N` to the capture 3b directory, all inside the session directory named in the
frontmatter. Capture 3 has five event streams: `events.sse` and four segments (`events-retest.sse`,
`events-p2.sse`, `events-p2b.sse`, `events-p3a.sse`), each cited by its own file name. A bare `events.sse:N`
is not used. Every payload example below is copied from those
artefacts; long strings are trimmed with "…". Paths for the MBP home directory and username are redacted
to `/Users/<user>` and `<user>`. Client-type and route citations (`node_modules/@opencode/client/...`) and
v1 citations (`src/events.ts`) refer to the files named in each case.

## 1. Capture setup

Four captures were made against the same server, in two runs. Captures 1 and 2 ran while the model worked. Capture 3 ran while the model provider was failing (§1c). Capture 3b ran after gateway reachability was restored (§1d).

- **Server:** OpenCode 2.0.28 on the MBP desktop shared service. The server requires Basic auth; no credential appears in any artefact. No capture changed server configuration.

### 1a. Capture 1

- **Session:** `ses_ecaf279a0fferfPEx4LQ1FsOrZ`, title `octmux-v2-capture`, project directory `/tmp/octmux-v2-capture` on the MBP (`v2-capture/session-create.json:1`).
- **Model:** not requested. The server chose agent `build` and model `sohoai/glm-5.3-flash` (`v2-capture/events.sse:35`).
- **Prompt** (`v2-capture/prompt-request.json:2`): "Step 1: use your question tool to ask me to choose 'A' or 'B'. Step 2: after I answer, run the shell command `ls -la` in the current directory using your bash tool. Step 3: reply with the single word done."
- **Result:** three assistant steps. Tools used were `question` (rendered as a form) and `shell`. Final text was `done`. Outcome `succeeded` (`v2-capture/session-final.json:1`). Turn ran from `created` 1791891441254 to `execution.succeeded` 1791891445708 epoch ms, that is 2026-10-13T11:37:21Z to 11:37:25Z (`v2-capture/events.sse:5`, `v2-capture/events.sse:117`).
- **Artefacts** (`v2-capture/`): `events.sse` (live `/api/event` stream), `session-create.json`, `prompt-request.json`, `prompt-response.json`, `form-1.json`, `form-1-reply-request.json`, `form-1-reply-response.json`, `active-sample.json`, `session-final.json`, `messages-page-1.json`, `messages-page-2.json`, `session-log.sse`, `session-log-replay.headers`, `session-log-replay.sse`, `session-log-replay-after0.sse`, `session-log-replay-after25.sse`.

### 1b. Capture 2

- **Session (parent):** `ses_ecad2fc3effeKko2WsNH68s41a`, title `octmux-v2-capture-2`, project directory `/tmp/octmux-v2-capture-2` on the MBP (`v2-capture-2/session-create.json:1`). Created at epoch 1791893504965 (about 12:11:45Z).
- **Session (child):** `ses_ecad2e243ffeRU5SRXXCTakYE0`, agent `general`, created by the server as a subagent of the parent (`v2-capture-2/events.sse:131`).
- **Ruleset trick:** the session was created with a per-session `permissions` array (`v2-capture-2/session-create-request.json:6–17`). Each entry is `{action, resource, effect}` with `effect: "ask"`, so `shell` and `bash` calls on this session raise a permission request instead of running. The same ruleset is echoed on the session (`v2-capture-2/session-create.json:1`) and on the child (`v2-capture-2/events.sse:131`). This made permission behaviour observable without changing server config.
- **Model:** not requested. Agent `build` and model `sohoai/glm-5.3-flash` (`v2-capture-2/events.sse:17`). The child used agent `general` on the same model (`v2-capture-2/events.sse:143`).
- **Prompt** (`v2-capture-2/prompt-request.json:2`): "Step 1: run the shell command `ls -la` in the current directory using your shell tool. Step 2: run the shell command `cat ./does-not-exist.txt` using your shell tool. Step 3: use your task/subagent tool (the tool that launches a subagent) to have a subagent run the shell command `pwd` and report back the output. Step 4: reply with the single word done."
- **Driver:** a driver script made the calls. `v2-capture-2/driver.log:1–9` records each action and HTTP status: create 200, prompt 200, approve parent `ls` (`once`, 204), reject parent `cat` (`reject`, 204), approve child `pwd` (`once`, 204), then the parent reached `session.execution.succeeded`. The script itself is not among the artefacts.
- **Result:** five assistant steps in total across the parent and its child (three in the parent, two in the child). The parent's `ls -la` ran and succeeded. The parent's `cat` was rejected before it ran. The subagent ran `pwd`. Final text was `done`. Outcome `succeeded` (`v2-capture-2/parent-session-final.json:1`). The parent turn ran from `created` 1791893504965 to `execution.succeeded` 1791893515221 epoch ms (about 10.3 s, `v2-capture-2/events.sse:213`).
- **Artefacts** (`v2-capture-2/`): `events.sse`; `driver.log`; `sid.txt`; `session-create-request.json`; `session-create.json`; `prompt-request.json`; `prompt-response.json`; `active-sample.json`; `active-after.json`; `permission-1-parent-list.json`, `permission-1-parent-reply-request.json`, `permission-1-parent-reply-response.json`; `permission-2-parent-list.json`, `permission-2-parent-reply-request.json`, `permission-2-parent-reply-response.json`; `permission-3-child-list.json`, `permission-3-child-reply-request.json`, `permission-3-child-reply-response.json`; `children-list-0.json`, `children-list-1.json`, `children-final.json`; `parent-messages-page-1.json`, `parent-messages-page-2.json`, `parent-session-final.json`; `child-1-children.json`, `child-1-messages-page-1.json`, `child-1-messages-page-2.json`, `child-1-session-final.json`; `events.err` (0 bytes).

### 1c. Capture 3

- **Session:** `ses_eca8ef401ffeG520AuaU6mWafm`, title `octmux-v2-capture-3`, project directory `/tmp/octmux-v2-capture-3` on the MBP (`v2-capture-3/session-create.json:1`). Created with the same per-session `permissions` ruleset as capture 2 (`v2-capture-3/session-create-request.json:1–18`).
- **Model provider state:** every model step failed with `provider.transport` and the message `FailedToOpenSocket: Was there a typo in the url or port?` (`v2-capture-3/events.sse:93`, `:95`). No model-driven tool call ran, so no `session.tool.*`, `session.text.*` or `session.step.streamed` frame exists in capture 3. It observed model-free paths only.
- **Prompts:** three prompts were sent (`v2-capture-3/prompt-1-request.json:1–4`, `prompt-2-request.json:1–3`, `prompt-3-request.json:1–3`). Everything else was a driver-side action logged in `v2-capture-3/driver.log:1–25`, `driver-phase2.log:1–35` and `driver-phase3.log:1–6`: user shell commands, a session command, a model select, a compaction, API-created permission and form items, reconnects, paging, child creation and cleanup.
- **Stream segments:** `events.sse` was opened before the session was created and runs up to the retest. The four segments were opened after reconnects. Each segment begins with `server.connected`. `events.sse` also carries frames for other sessions in other directories; those frames are not quoted (§2c).
- **Cleanup:** the session and its child were deleted (HTTP 204). A later GET returned 404 (`v2-capture-3/cleanup-delete-ses_eca8ef401ffeG520AuaU6mWafm.json:2`, `cleanup-get-after-delete-ses_eca8ef401ffeG520AuaU6mWafm.json:1`).

### 1d. Capture 3b

- **Session (parent):** `ses_eca4e5f6cffel0VZOQZzz5QKqf`, title `octmux-v2-capture-3b`, project directory `/tmp/octmux-v2-capture-3b` (`v2-capture-3b/session-create-response.json:1`). Same `ask` ruleset as capture 2.
- **Session (child):** `ses_eca4c2725ffenXtfxS1xSAe6Hx`, agent `general`, `parentID` set to the parent (`v2-capture-3b/events.sse:275`).
- **Model:** model steps succeeded (`v2-capture-3b/events.sse:51`, `:117`, `:181`; finish `stop`). The model is `glm-5.3-flash` on provider `sohoai`, as in captures 1 and 2.
- **Driver:** `v2-capture-3b/driver.log:1–29`. Observations: `obs1`, a `cat` of a missing file that exits 1, with one permission reply; `obs2a`, a `sleep 20 && echo finished` run to completion; `obs2b`, the same command interrupted mid-run (`driver.log:13–14`); `obs3`, a subagent call; `obs4`, a compaction. `driver.log:9` records a driver bug: the first `obs2` run looked for `data.sessionID` on `shell.created`, which is absent there, so no interrupt was sent. That run is kept as `obs2a-*` and the interrupt run as `obs2b-*`.
- **Stream:** `v2-capture-3b/events.sse` (602 lines; `events.err` is 0 bytes). It carries only the two capture sessions and global frames.
- **Cleanup:** both sessions deleted (HTTP 204), and GET after delete returned 404 (`v2-capture-3b/driver.log:24–27`).

## 2. Event stream envelope (`GET /api/event`)

### 2a. Frame format

- Frames are plain `data: <json>` lines. There are no SSE `event:` or `id:` fields (`v2-capture/events.sse` and `v2-capture-2/events.sse` contain none).
- Keep-alives are `: heartbeat` comment lines. Capture 1 has 21 (`v2-capture/events.sse:3,119,121,127–161`, odd lines). Capture 2 has 2 (`v2-capture-2/events.sse:3,215`).
- Totals. Capture 1: 62 `data:` frames, 21 heartbeat comments. Capture 2: 106 `data:` frames, 2 heartbeat comments. Capture 3: `events.sse` has 261 `data:` frames and 30 heartbeat comments; the four segment streams together have 41 `data:` frames and 6 heartbeat comments. These counts include frames for other sessions on the same connection. Capture 3b: `events.sse` has 284 `data:` frames and 17 heartbeat comments (`v2-capture-3b/events.sse`).

| Field | Presence | Observed |
|---|---|---|
| `id` | every data frame | `evt_` plus a time-ordered suffix. Lexicographic order equals stream order in captures 1 and 2 (capture 2: 106 ids, sorted), and in captures 3 and 3b. |
| `created` | every frame except `server.connected` | epoch milliseconds |
| `type` | every frame | dotted name, for example `session.text.delta` |
| `location` | absent on `server.connected` (`v2-capture/events.sse:1`, `v2-capture-2/events.sse:1`), `session.execution.started` (`v2-capture/events.sse:29`, `v2-capture-2/events.sse:11,137`), `session.execution.succeeded` (`v2-capture/events.sse:117`, `v2-capture-2/events.sse:191,213`), `session.usage.updated` (`v2-capture/events.sse:65,93,115`; `v2-capture-2/events.sse:85,175,189,197,211`), `session.execution.failed` and `session.execution.interrupted` (`v2-capture-3/events.sse:95`, `v2-capture-3/events-retest.sse:25`, `v2-capture-3b/events.sse:241`), `session.deleted` (`v2-capture-3b/events.sse:599`) | `{"directory": …}`. Session frames carry the project directory. Some global frames carry the MBP home directory (`v2-capture/events.sse:123,125`). |
| `metadata` | only `session.instructions.updated` | `{"instructions":{"initial":true}}` (`v2-capture/events.sse:31`; `v2-capture-2/events.sse:13,139`) |
| `data` | every frame | payload. Empty `{}` for most global `*.updated` frames. |
| `durable` | durable session events only | `{aggregateID, seq, version}`. `aggregateID` equals the sessionID. |

### 2b. Durable versus non-durable

- Durable frames carry `durable.seq`. Capture 1 seq runs 0 to 30 with no gaps (`v2-capture/events.sse:5` seq 0 through `v2-capture/events.sse:117` seq 30). Capture 2 parent seq runs 0 to 34 with no gaps (`v2-capture-2/events.sse:5`, `:213`). Capture 2 child seq runs 0 to 19 under its own `aggregateID` (`v2-capture-2/events.sse:131`, `:191`).
- Non-durable frames carry no `seq`.
- Capture 3 seq for the capture session runs 0 to 131 with no gaps across `events.sse` and its segments (`v2-capture-3/events.sse:5` seq 0 through `v2-capture-3/events.sse:579` seq 112; `v2-capture-3/events-retest.sse:5` seq 113; `v2-capture-3/events-p3a.sse:13` seq 131). Seq 132 to 134 were emitted while no stream was connected and appear on no stream file (§4.11). Capture 3b parent seq runs 0 to 87 and child seq 0 to 13, with no gaps (`v2-capture-3b/events.sse:5`, `:601`; child `:275`, `:599`).
- `durable.version` is 1 for most frames. It is 2 for `session.instructions.updated` (`v2-capture/events.sse:31`; `v2-capture-2/events.sse:13,139`), for `session.tool.success` (`v2-capture/events.sse:61,89`; `v2-capture-2/events.sse:77,171,193`), and for `session.tool.failed` (`v2-capture-2/events.sse:81`). Capture 3b adds `session.deleted` at version 2 (`v2-capture-3b/events.sse:599`, `:601`), and `session.tool.success` and `session.tool.failed` at version 2 (`v2-capture-3b/events.sse:313`, `:235`). Do not assume a fixed value.
- Durable in capture 1: `session.created`, `session.inbox.enqueued`, `session.execution.started`, `session.instructions.updated`, `session.inbox.delivered`, `session.step.started`, `session.reasoning.started`, `session.reasoning.ended`, `session.tool.input.started`, `session.tool.input.ended`, `session.tool.called`, `session.step.streamed`, `session.tool.success`, `session.step.ended`, `session.text.started`, `session.text.ended`, `session.execution.succeeded`.
- Durable in capture 2: the same set, plus `session.tool.failed`. `session.tool.progress`, `permission.asked`, `permission.replied`, `shell.created` and `shell.exited` are non-durable there, as in capture 1 for the shell and progress frames.
- Non-durable in capture 1: `server.connected`, all global `*.updated`, `session.reasoning.delta`, `session.text.delta`, `session.tool.progress`, `session.usage.updated`, `form.created`, `form.replied`, `shell.created`, `shell.exited`.
- Non-durable in capture 2: `server.connected`, `project.updated`, `session.reasoning.delta`, `session.text.delta`, `session.tool.progress`, `session.usage.updated`, `permission.asked`, `permission.replied`, `shell.created`, `shell.exited`.
- Durable in capture 3 (capture session only): `session.created`, `session.inbox.enqueued`, `session.inbox.delivered`, `session.execution.started`, `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`, `session.instructions.updated`, `session.step.started`, `session.step.failed`, `session.retry.scheduled`, `session.model.selected`, `session.compaction.started`, `session.compaction.failed`, `session.shell.started`, `session.shell.ended`. In capture 3 the user-shell `session.shell.started` and `session.shell.ended` are durable, unlike the `shell.created` and `shell.exited` frames.
- Non-durable in capture 3: `server.connected`, global `*.updated`, `rpc.experimental.browser.control`, `permission.asked`, `permission.replied`, `form.created`, `form.replied`, `shell.created`, `shell.exited`.
- Durable in capture 3b: `session.created`, `session.inbox.enqueued`, `session.inbox.delivered`, `session.execution.started`, `session.execution.succeeded`, `session.execution.interrupted`, `session.instructions.updated`, `session.step.started`, `session.step.streamed`, `session.step.ended`, `session.step.failed`, `session.reasoning.started`, `session.reasoning.ended`, `session.text.started`, `session.text.ended`, `session.tool.input.started`, `session.tool.input.ended`, `session.tool.called`, `session.tool.success`, `session.tool.failed`, `session.compaction.started`, `session.compaction.ended`, `session.deleted`.
- Non-durable in capture 3b: `server.connected`, global `*.updated`, `models-dev.refreshed`, `session.reasoning.delta`, `session.text.delta`, `session.tool.progress`, `session.usage.updated`, `session.compaction.delta`, `permission.asked`, `permission.replied`, `shell.created`, `shell.deleted`, `shell.exited`.

### 2c. Session attribution (where the sessionID sits)

The stream is global and unfiltered. Frames for other locations arrive on the same connection (`v2-capture/events.sse:123,125` for the home directory, `v2-capture/events.sse:163,165` for the project directory). Capture 2 puts parent and child frames on the same connection (`v2-capture-2/events.sse:131–191`). Attribution differs by event:

| Frame | Session key | Example line |
|---|---|---|
| most session events | `data.sessionID` | `v2-capture/events.sse:27`, `:35`, `:39`; `v2-capture-2/events.sse:9`, `:17` |
| child session events (capture 2) | `data.sessionID` is the child id | `v2-capture-2/events.sse:137`, `:151` |
| `form.created` | `data.form.sessionID` (the tool link is in `data.form.metadata.tool`) | `v2-capture/events.sse:57` |
| `permission.asked`, `permission.replied` | `data.sessionID` | `v2-capture-2/events.sse:65`, `:69` |
| `session.tool.progress` for a subagent call | `data.sessionID` is the parent. The child id is in `data.metadata.sessionID`. | `v2-capture-2/events.sse:133` |
| `shell.created` | `data.info.metadata.sessionID` | `v2-capture/events.sse:83`; `v2-capture-2/events.sse:71` (parent), `:165` (child) |
| `shell.exited` | none. Correlate by `data.id` (`sh_…`) to `shell.created` `data.info.id`. | `v2-capture/events.sse:87`; `v2-capture-2/events.sse:75`, `:169` |
| `session.execution.started`, `session.usage.updated` | `data.sessionID`, but no `location` | `v2-capture/events.sse:29`, `:65`; `v2-capture-2/events.sse:11`, `:85` |
| global `*.updated`, `server.connected` | none | `v2-capture/events.sse:1`, `:7–25`, `:123`, `:125`; `v2-capture-2/events.sse:1`, `:7` |
| `session.shell.started`, `session.shell.ended` (user shell, capture 3) | `data.sessionID`; the shell object is nested under `data.shell` | `v2-capture-3/events-p2.sse:7`, `:13` |
| `shell.created` for a model-driven or user shell in capture 3b / 3 | `data.info.metadata.sessionID`; the top-level keys are `id`, `type`, `location`, `created`, `data` only | `v2-capture-3/events-p2.sse:5`; `v2-capture-3b/events.sse:95` |
| `shell.deleted` | none. Correlate by `data.id`. | `v2-capture-3b/events.sse:233` |
| `session.execution.failed`, `session.execution.interrupted`, `session.step.failed`, `session.retry.scheduled`, `session.compaction.*`, `session.deleted` | `data.sessionID`. The `session.execution.*` frames carry no `location`. | `v2-capture-3/events.sse:95`, `:37`; `v2-capture-3b/events.sse:241`, `:349`, `:599` |
| `models-dev.refreshed` | none (global) | `v2-capture-3b/events.sse:199` |

- The capture-3 stream also carries frames for sessions in other directories, including frames whose `location` is a home directory and a frame for another session's step (`v2-capture-3/events.sse:303`, `:455`). Those frames are not quoted. Filter on `data.sessionID` (or the attribution key above), never on `location`.

## 3. Event catalogue (observed)

"Capture" names the capture(s) in which the type appeared. First line columns give the first occurrence
in each capture's `events.sse`; a cell prefixed `retest:` or `p2:` names `events-retest.sse` or
`events-p2.sse` where the first occurrence is not in `events.sse`. Count columns are occurrences in that
capture (scope for captures 3 and 3b in the note below the table). Rows follow capture 1's first-occurrence
order, then the types first seen in capture 2, then the types first seen in capture 3 and 3b.

| Type | Capture | First line c1 | First line c2 | First line c3 | First line c3b | Count c1 | Count c2 | Count c3 | Count c3b | Durable | sessionID location | octmux concept (v1 analogue in `src/events.ts`) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `server.connected` | 1, 2, 3, 3b | 1 | 1 | 1 | 1 | 1 | 1 | 5 | 1 | no | none | connection banner |
| `session.created` | 1, 2, 3, 3b | 5 | 5 | 5 | 5 | 1 | 2 | 1 | 2 | yes (seq 0) | `data.sessionID` | session created (`session.created`, line 639). Capture 2 and 3b children carry `parentID` (§4.9). |
| `project.updated` | 1, 2, 3, 3b | 7 | 7 | 7 | 7 | 1 | 1 | 18 | 3 | no | none | global, ignored |
| `integration.updated` | 1, 3, 3b | 9 | — | 9 | 9 | 1 | 0 | 2 | 2 | no | none | global, ignored |
| `provider.updated` | 1, 3, 3b | 11 | — | 11 | 11 | 3 | 0 | 9 | 4 | no | none | global, ignored |
| `model.updated` | 1, 3, 3b | 13 | — | 13 | 13 | 3 | 0 | 9 | 4 | no | none | global, ignored |
| `agent.updated` | 1, 3, 3b | 15 | — | 15 | 15 | 1 | 0 | 2 | 1 | no | none | global, ignored |
| `command.updated` | 1, 3, 3b | 17 | — | 17 | 17 | 1 | 0 | 2 | 1 | no | none | global, ignored |
| `skill.updated` | 1, 3, 3b | 19 | — | 19 | 19 | 1 | 0 | 2 | 1 | no | none | global, ignored |
| `websearch.updated` | 1, 3, 3b | 21 | — | 21 | 21 | 1 | 0 | 2 | 1 | no | none | global, ignored |
| `reference.updated` | 1, 3, 3b | 23 | — | 23 | 23 | 1 | 0 | 2 | 1 | no | none | global, ignored |
| `plugin.updated` | 1, 3, 3b | 25 | — | 25 | 25 | 1 | 0 | 2 | 1 | no | none | global, ignored |
| `session.inbox.enqueued` | 1, 2, 3, 3b | 27 | 9 | 27 | 27 | 1 | 2 | 9 | 7 | yes (seq 1) | `data.sessionID` | user message queued; also user-shell synthetic items (§4.5) and compaction items (§4.12) |
| `session.execution.started` | 1, 2, 3, 3b | 29 | 11 | 29 | 29 | 1 | 2 | 6 | 7 | yes (seq 2) | `data.sessionID` | busy begins (no v1 analogue; see §4.8) |
| `session.instructions.updated` | 1, 2, 3, 3b | 31 | 13 | 31 | 31 | 1 | 2 | 1 | 2 | yes (v2) | `data.sessionID` | instruction set hashes, not interpreted |
| `session.inbox.delivered` | 1, 2, 3, 3b | 33 | 15 | 33 | 33 | 1 | 2 | 6 | 7 | yes (seq 4) | `data.sessionID` | queued user message delivered |
| `session.step.started` | 1, 2, 3, 3b | 35 | 17 | 35 | 35 | 3 | 5 | 47 | 9 | yes | `data.sessionID` | one per assistant message attempt (§4.3) |
| `session.reasoning.started` | 1, 2, 3b | 37 | 19 | — | 37 | 3 | 3 | 0 | 6 | yes | `data.sessionID` | reasoning part begins (§4.2) |
| `session.reasoning.delta` | 1, 2, 3b | 39 | 21 | — | 39 | 7 | 24 | 0 | 14 | no | `data.sessionID` | reasoning chunk (§4.2) |
| `session.reasoning.ended` | 1, 2, 3b | 49 | 53 | — | 45 | 3 | 3 | 0 | 6 | yes | `data.sessionID` | reasoning part ends, full text (§4.2) |
| `session.tool.input.started` | 1, 2, 3b | 47 | 49 | — | 81 | 2 | 4 | 0 | 4 | yes | `data.sessionID` | tool call begins, carries `name` (§4.4) |
| `session.tool.input.ended` | 1, 2, 3b | 51 | 55 | — | 85 | 2 | 4 | 0 | 4 | yes | `data.sessionID` | raw input JSON as text (§4.4) |
| `session.tool.called` | 1, 2, 3b | 53 | 57 | — | 87 | 2 | 4 | 0 | 4 | yes | `data.sessionID` | parsed input, ready to run (§4.4) |
| `session.step.streamed` | 1, 2, 3b | 55 | 63 | — | 49 | 3 | 5 | 0 | 9 | yes | `data.sessionID` | step output streaming marker, no payload (§4.3) |
| `form.created` | 1, 3 | 57 | — | p2:19 | — | 1 | 0 | 1 | 0 | no | `data.form.sessionID` | question form (v1 `question.asked`, line 859) (§4.6) |
| `form.replied` | 1, 3 | 59 | — | p2:23 | — | 1 | 0 | 1 | 0 | no | `data.sessionID` | question answered (v1 `question.replied`, line 880) (§4.6) |
| `session.tool.success` | 1, 2, 3b | 61 | 77 | — | 101 | 2 | 3 | 0 | 3 | yes (v2) | `data.sessionID` | tool completed (§4.4) |
| `session.step.ended` | 1, 2, 3b | 63 | 83 | — | 51 | 3 | 5 | 0 | 8 | yes | `data.sessionID` | step finished, finish reason and tokens (§4.3) |
| `session.usage.updated` | 1, 2, 3b | 65 | 85 | — | 53 | 3 | 5 | 0 | 10 | no | `data.sessionID` | running cost and token totals, per session (§4.3) |
| `shell.created` | 1, 2, 3, 3b | 83 | 71 | p2:5 | 95 | 1 | 2 | 3 | 3 | no | `data.info.metadata.sessionID` | shell process started (§4.5) |
| `session.tool.progress` | 1, 2, 3b | 85 | 73 | — | 97 | 1 | 3 | 0 | 4 | no | `data.sessionID` | tool metadata, shell id (§4.5); child session id for subagent (§4.9) |
| `shell.exited` | 1, 2, 3, 3b | 87 | 75 | p2:11 | 99 | 1 | 2 | 3 | 3 | no | none | shell process exited (§4.5) |
| `session.text.started` | 1, 2, 3b | 103 | 107 | — | 41 | 1 | 3 | 0 | 5 | yes | `data.sessionID` | text part begins (§4.1) |
| `session.text.delta` | 1, 2, 3b | 107 | 109 | — | 43 | 1 | 7 | 0 | 5 | no | `data.sessionID` | text chunk (v1 `message.part.delta`) (§4.1) |
| `session.text.ended` | 1, 2, 3b | 109 | 127 | — | 47 | 1 | 3 | 0 | 5 | yes | `data.sessionID` | text part ends, full text (§4.1) |
| `session.execution.succeeded` | 1, 2, 3, 3b | 117 | 191 | 479 | 55 | 1 | 2 | 1 | 6 | yes | `data.sessionID` | turn finished, idle equivalent (§4.8). Capture 2 has one per session (child at `:191`, parent at `:213`). |
| `permission.asked` | 2, 3, 3b | — | 65 | p2:17 | 91 | 0 | 3 | 1 | 3 | no | `data.sessionID` | permission request (§4.7). v1 `permission.asked` at `src/events.ts:840`. |
| `permission.replied` | 2, 3, 3b | — | 69 | p2:21 | 93 | 0 | 3 | 1 | 3 | no | `data.sessionID` | permission answer (§4.7) |
| `session.tool.failed` | 2, 3b | — | 81 | — | 235 | 0 | 1 | 0 | 1 | yes (v2) | `data.sessionID` | tool failure: a permission rejection in capture 2, an abort in capture 3b (§4.4) |
| `session.retry.scheduled` | 3 | — | — | 37 | — | 0 | 0 | 43 | 0 | yes | `data.sessionID` | retry before the next attempt; v1 `session-status` with `retry` (`src/events.ts:25`) (§4.3) |
| `session.step.failed` | 3, 3b | — | — | 93 | 237 | 0 | 0 | 4 | 1 | yes | `data.sessionID` | step failed with an error type (§4.3, §4.4) |
| `session.execution.failed` | 3 | — | — | 95 | — | 0 | 0 | 4 | 0 | yes | `data.sessionID`; no `location` | turn failed; v1 `session.error` (`src/events.ts:790`) (§4.8) |
| `session.execution.interrupted` | 3, 3b | — | — | retest:25 | 241 | 0 | 0 | 1 | 1 | yes | `data.sessionID`; no `location` | turn interrupted by the operator; v1 parent-turn-end `aborted` (`src/events.ts:42`, `:343–348`) (§4.8) |
| `session.model.selected` | 3 | — | — | 365 | — | 0 | 0 | 1 | 0 | yes | `data.sessionID` | model chosen for the session (§4.3) |
| `session.compaction.started` | 3, 3b | — | — | 375 | 349 | 0 | 0 | 1 | 1 | yes | `data.sessionID` | compaction begins (§4.12) |
| `session.compaction.failed` | 3 | — | — | 477 | — | 0 | 0 | 1 | 0 | yes | `data.sessionID` | compaction failed with a provider error (§4.12) |
| `session.compaction.delta` | 3b | — | — | — | 351 | 0 | 0 | 0 | 116 | no | `data.sessionID` | summary text chunk (§4.12) |
| `session.compaction.ended` | 3b | — | — | — | 587 | 0 | 0 | 0 | 1 | yes | `data.sessionID` | compaction finished with summary text, tokens and cost; v1 `session.compacted` (`src/events.ts:722`) (§4.12) |
| `session.shell.started` | 3 | — | — | p2:7 | — | 0 | 0 | 3 | 0 | yes | `data.sessionID` (shell nested under `data.shell`) | user shell started (§4.5) |
| `session.shell.ended` | 3 | — | — | p2:13 | — | 0 | 0 | 3 | 0 | yes | `data.sessionID` | user shell ended, with output (§4.5) |
| `shell.deleted` | 3b | — | — | — | 233 | 0 | 0 | 0 | 1 | no | none; `data.id` | shell removed on interrupt (§4.5) |
| `session.deleted` | 3b | — | — | — | 599 | 0 | 0 | 0 | 2 | yes (v2) | `data.sessionID` | session deleted (§5) |
| `models-dev.refreshed` | 3b | — | — | — | 199 | 0 | 0 | 0 | 1 | no | none (global) | global, ignored |
| `rpc.experimental.browser.control` | 3 | — | — | 311 | — | 0 | 0 | 2 | 0 | no | none (global) | global, ignored |

Capture 3 and 3b counts are scoped. Capture 3 counts `events.sse` and the four segment streams for frames
whose session is `ses_eca8ef401ffeG520AuaU6mWafm`, plus global frames. A `shell.exited` is counted when its
shell id belongs to a counted `shell.created`. Capture 3b counts frames of its parent and child sessions,
plus global frames. Global counts include frames for other directories that share the connection, so the
`*.updated` and `project.updated` counts for capture 3 are larger than one session alone would produce. Frames
for other sessions are not counted and not quoted.

Observed types with no row above: `session.permissions`, `session.viewed` and `session.agent.selected`. In
capture 3 these appeared only on other sessions' frames.

Capture 2 had no `form.*` frame and no `*.updated` frame other than `project.updated`. Capture 3 had one
API-created form (`form.created`, `form.replied`). Capture 3b had no `form.*` frame. Capture 3 had no tool
frame at all, because no model step succeeded. A count of 0 means the type did not occur in that capture's
scope.

### 3b. Known from client types, not observed in captures 1 to 3b

These names come from the typed union `V2Event` (`node_modules/@opencode/client/dist/promise/generated/types.d.ts:3418`). None appeared in captures 1, 2, 3 or 3b, except where a row below says otherwise. Their shapes are client-type declarations only. The names observed in captures 3 and 3b (`session.execution.failed`, `session.execution.interrupted`, `session.step.failed`, `session.shell.started`, `session.shell.ended`, `shell.deleted`, `session.retry.scheduled`, `session.compaction.*`) have moved to §3 and their concept sections.

| Type | Declared at (`types.d.ts`) | Relevance |
|---|---|---|
| `session.idle` | 2457 | typed end-of-turn event. Data: `sessionID`. Not observed; see §4.8. |
| `session.status` | 2444 | status change event. Not observed. |
| `session.forked` | 1388–1403 | fork event, data includes `parentID`. Not observed. |
| `form.cancelled` | 2421 | form dismissed. Data: `id`, `sessionID`. Not observed. |
| `session.tool.input.delta` | 2151 | streamed tool-input chunks. Not observed in any capture; tool input arrived only as `input.started` then `input.ended`. |
| `session.revert.*`, `session.skill.activated`, `session.synthetic` | 1568, 1590 (others in union) | not observed. The inbox item type `synthetic` is observed (§4.5); the event name is not. |

## 4. Concept mapping to octmux

Each subsection shows observed payloads, then the nearest v1 concept in `src/events.ts`.

### 4.1 Streaming text

Observed sequence in capture 1: `session.text.started` (`v2-capture/events.sse:103`), `session.text.delta` (`:107`), `session.text.ended` (`:109`).

```json
// v2-capture/events.sse:103  session.text.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9499001MYaFsJiEIsV9HE","ordinal":0}
// v2-capture/events.sse:107  session.text.delta (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9499001MYaFsJiEIsV9HE","ordinal":0,"delta":"done"}
// v2-capture/events.sse:109  session.text.ended (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9499001MYaFsJiEIsV9HE","ordinal":0,"text":"done"}
```

Capture 2 has the same shape. The child's text part is shown:

```json
// v2-capture-2/events.sse:179  session.text.started (data), child session
{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","assistantMessageID":"msg_1352d24f6001ooMS5OCysvLtvV","ordinal":0}
// v2-capture-2/events.sse:181  session.text.delta (data), child session, trimmed
{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","assistantMessageID":"msg_1352d24f6001ooMS5OCysvLtvV","ordinal":0,"delta":"The exact output of `pwd` was:\n\n```\n/private/tmp/o…"}
```

- No part id. The key is `assistantMessageID` plus `ordinal`, and the kind comes from the event type.
- `ordinal` 0 is used for both reasoning and text in the same message in captures 1 and 2 (`v2-capture/events.sse:97` reasoning, `:103` text; `v2-capture-2/events.sse:89` reasoning, `:107` text, same message `msg_1352d147a001pKAHKU0tp6Iol1`), and in capture 3b (§4.1). Whether ordinal counts per kind or per message cannot be determined from either capture.
- `session.text.ended` carries the full text.
- Capture 2 shows the same reasoning/text overlap: `session.text.started` (`v2-capture-2/events.sse:107`) precedes `session.reasoning.ended` (`:121`) for the same message.
- v1 equivalent: `message.part.delta` (`src/events.ts:381`, keyed by `partID` and `field`) and `message.part.updated` with `part.type === "text"` (`src/events.ts:410`, `:436`). v2 has no part id.
- Capture 3b shows the same sequence for a model step (`v2-capture-3b/events.sse:41`, `:43`, `:47`). Reasoning and text in that message both have `ordinal` 0 (`v2-capture-3b/events.sse:37`, `:41`), as in captures 1 and 2. Capture 3 has no text part, because every model step failed before streaming (§4.3).

### 4.2 Reasoning

Observed sequence in capture 1: `session.reasoning.started` (`v2-capture/events.sse:37`), `session.reasoning.delta` (`:39,41,43,45`), `session.reasoning.ended` (`:49`). Capture 2 repeats it for each assistant message (`v2-capture-2/events.sse:19`, `:89`, `:145` started; `:53`, `:121`, `:153` ended).

```json
// v2-capture/events.sse:37  session.reasoning.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","ordinal":0,"state":{"reasoningField":"reasoning_content"}}
// v2-capture/events.sse:39  session.reasoning.delta (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","ordinal":0,"delta":"The user wants a simple three-step sequence: first, ask them to choose between '"}
// v2-capture/events.sse:49  session.reasoning.ended (data), trimmed
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","ordinal":0,"text":"The user wants a simple three-step sequence: first, ask them to choose between 'A' or 'B' using the question tool; …"}
```

- `state.reasoningField` is `reasoning_content` in every reasoning start in captures 1, 2 and 3b (capture 1 `:37,69,97`; capture 2 `:19,:89,:145`; capture 3b `v2-capture-3b/events.sse:37`). Its meaning is not documented in any capture.
- v1 equivalent: reasoning parts through `message.part.updated` with `part.type === "reasoning"` (`src/events.ts:481`).
- Capture 3b repeats the sequence with the same `state.reasoningField` value (`v2-capture-3b/events.sse:37` started, `:45` ended). Capture 3 has no reasoning frame.

### 4.3 Steps, usage and cost

One assistant message per step.

Capture 1 step ids are `msg_1350d8922001Upjb4nJACI32IY` (`v2-capture/events.sse:35`), `msg_1350d9162001a87C2ZSylZLPHd` (`:67`) and `msg_1350d9499001MYaFsJiEIsV9HE` (`:95`).

```json
// v2-capture/events.sse:35  session.step.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","agent":"build","model":{"id":"glm-5.3-flash","providerID":"sohoai"},"assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","started":1791891441958}
// v2-capture/events.sse:55  session.step.streamed (data), whole payload
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY"}
// v2-capture/events.sse:63  session.step.ended (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":8019,"output":70,"reasoning":88,"cache":{"read":0,"write":0}}}
// v2-capture/events.sse:65  session.usage.updated (data, no location, non-durable)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","cost":0,"tokens":{"input":8019,"output":70,"reasoning":88,"cache":{"read":0,"write":0}}}
```

- Capture 1: `session.step.ended` at `v2-capture/events.sse:113` has `finish: "stop"`. The earlier two steps have `finish: "tool-calls"` (`:63`, `:91`).
- Capture 1: `session.usage.updated` carries running totals. The three `usage.updated` frames at `:65`, `:93`, `:115` have input 8019, 8296, 8563. These equal the per-step sums, and the final values equal `v2-capture/session-final.json:1` (`tokens.input` 8563, output 99, reasoning 148, cache read 16064).
- Capture 2: five steps. Parent steps are `msg_1352d03eb00172b9aW4MlJf5ai` (`v2-capture-2/events.sse:17`), `msg_1352d147a001pKAHKU0tp6Iol1` (`:87`) and `msg_1352d295d0015q2ewSTwacr2z1` (`:199`). Child steps are `msg_1352d1dca00120H1D2uE0vC05J` (`:143`) and `msg_1352d24f6001ooMS5OCysvLtvV` (`:177`). Their `finish` values are `tool-calls` (`:83`), `tool-calls` (`:195`), `stop` (`:209`) for the parent, and `tool-calls` (`:173`), `stop` (`:187`) for the child.
- Capture 2 usage is per session and is not rolled up from children. The parent's final totals equal the sum of its three steps exactly: `tokens.input` 8058 + 659 + 345 = 9062; `output` 27 + 118 + 3 = 148; `reasoning` 379 + 85 + 0 = 464; `cache.read` 0 + 7936 + 8512 = 16448. The child's 7296 input is not in these totals (`v2-capture-2/parent-session-final.json:1`, `v2-capture-2/parent-messages-page-1.json:1`). The child's own totals are in `v2-capture-2/child-1-session-final.json:1`.
- `cost` is `0` on every step, every usage frame and every session-final file in captures 1 and 2, and likewise in captures 3 and 3b (§4.3). Cost was not populated in any run.
- v1 equivalent: none in `src/events.ts`. A grep for `tokens`, `cost` and `step-finish` returns no matches.

**Model-failure path (capture 3).** Every model step failed with the same provider error. One assistant message produced 11 `session.step.started` frames, one before each attempt. Each `session.retry.scheduled` announces the next attempt number and its time, and comes between two attempts (attempts 2 to 11, 10 retries in total). `session.step.failed` follows the last attempt, then `session.execution.failed`. A turn took about 82 s from `session.inbox.enqueued` (`v2-capture-3/events.sse:27`) to `session.execution.failed` (`:95`).

```json
// v2-capture-3/events.sse:37  session.retry.scheduled (data), first retry
{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","assistantMessageID":"msg_135710caa001NFDuEMDwGdxICI","attempt":2,"at":1791897965584,"error":{"type":"provider.transport","message":"FailedToOpenSocket: Was there a typo in the url or port?"}}
// v2-capture-3/events.sse:93  session.step.failed (data), first turn
{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","assistantMessageID":"msg_135710caa001NFDuEMDwGdxICI","error":{"type":"provider.transport","message":"FailedToOpenSocket: Was there a typo in the url or port?"}}
```

- The step failure carries no `rawFinish`, `cost` or `tokens` in capture 3. In capture 3b, the step failure of an interrupt carries them (`v2-capture-3b/events.sse:237`, §4.4).
- The stored assistant item for the failed message has `finish: "error"`, `content: []`, `cost: null`, `tokens: null` and the same `error` (`v2-capture-3/p2-messages-final.json:1`). Its idle item has `outcome: "failed"`.

**Model select (capture 3).** A select of the model already in use returned HTTP 204 (`v2-capture-3/model-switch-response.json`). The body was `{"model": {"id": "glm-5.3-flash", "providerID": "sohoai"}}` (`v2-capture-3/model-switch-request.json:1`). The client route is `POST /api/session/{id}/model` (`node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:324`); the driver did not log the URL. It produced a durable `session.model.selected` and a stored `model-switched` item (`v2-capture-3/parent-messages-all.json:1`):

```json
// v2-capture-3/events.sse:365  session.model.selected (data), durable seq 80
{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","model":{"id":"glm-5.3-flash","providerID":"sohoai"}}
```

- The next `session.step.started` carries `model.variant: "default"` (`v2-capture-3/events.sse:495`). The earlier one does not (`v2-capture-3/events.sse:35`). The session object carries the same `variant` (`v2-capture-3/p2-resync-session.json:1`).

**Usage in capture 3b.** Model steps reported tokens and `cost` 0 (`v2-capture-3b/events.sse:51`, `:103`, `:117`). The step that ended in an interrupt reports `rawFinish`, `cost` and `tokens` with no `finish` (`v2-capture-3b/events.sse:237`). Every `cost` value in captures 3 and 3b is 0, including `session.usage.updated`, `session.step.ended`, `session.compaction.ended` and the stored assistant items (`v2-capture-3b/obs1-messages-after.json:1`). The reason is not recorded, so this is not evidence of a provider price policy.

### 4.4 Tool lifecycle

Tool events are keyed by `data.id`, which is a `call_…` id. Capture 1 has the `question` and `shell` sequences. Capture 2 has an approved shell call, a rejected shell call, and a `subagent` call. Capture 2 also has two tool calls in one step.

Observed approved `question` sequence (capture 1):

1. `session.tool.input.started`, `name: "question"` (`v2-capture/events.sse:47`)
2. `session.tool.input.ended`, raw JSON text (`:51`)
3. `session.tool.called`, parsed input, `executed: false` (`:53`)
4. form lifecycle, see §4.6 (`:57`, `:59`)
5. `session.tool.success` (`:61`)

Observed `shell` sequence (capture 1):

1. `session.tool.input.started`, `name: "shell"` (`v2-capture/events.sse:73`)
2. `session.tool.input.ended` (`:77`)
3. `session.tool.called` (`:79`)
4. shell side channel, see §4.5 (`:83`, `:85`, `:87`)
5. `session.tool.success` (`:89`)

Observed approved `shell` sequence with permission (capture 2, `call_x9y407un`):

1. `session.tool.input.started`, `name: "shell"` (`v2-capture-2/events.sse:49`)
2. `session.tool.input.ended` (`:55`)
3. `session.tool.called` (`:57`)
4. `permission.asked` (`:65`), see §4.7
5. `permission.replied`, `reply: "once"` (`:69`)
6. shell side channel, see §4.5 (`:71`, `:73`, `:75`)
7. `session.tool.success` (`:77`)

Observed rejected `shell` sequence (capture 2, `call_26cq43v3`). The command never ran:

1. `session.tool.input.started` (`v2-capture-2/events.sse:51`)
2. `session.tool.input.ended` (`:59`)
3. `session.tool.called` (`:61`)
4. `permission.asked` (`:67`), see §4.7
5. `permission.replied`, `reply: "reject"` (`:79`)
6. `session.tool.failed` (`:81`)

Observed `subagent` sequence (capture 2, `call_nja9hdcz`), see §4.9: `session.tool.input.started` (`:119`), `session.tool.input.ended` (`:123`), `session.tool.called` (`:125`), `session.tool.progress` with the child session id (`:133`), `session.tool.success` (`:193`).

Parallel tool calls in one step (capture 2). Both shell calls of the first assistant message were started before either input ended, and both were called before the step streamed. Both raised permission requests before either was answered:

```json
// v2-capture-2/events.sse:49  session.tool.input.started (data), call 1
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d03eb00172b9aW4MlJf5ai","id":"call_x9y407un","name":"shell"}
// v2-capture-2/events.sse:51  session.tool.input.started (data), call 2
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d03eb00172b9aW4MlJf5ai","id":"call_26cq43v3","name":"shell"}
```

The rejected call's failure frame (capture 2), copied from `v2-capture-2/events.sse:81`:

```json
// v2-capture-2/events.sse:81  session.tool.failed (data, durable seq 16, version 2)
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d03eb00172b9aW4MlJf5ai","id":"call_26cq43v3","error":{"type":"permission.rejected","message":"capture: rejected on purpose"},"executed":false}
```

The same call in the stored message (capture 2), copied from `v2-capture-2/parent-messages-page-1.json:1`:

```json
{"type":"tool","id":"call_26cq43v3","name":"shell","executed":false,"state":{"status":"error","input":{"command":"cat ./does-not-exist.txt"},"error":{"type":"permission.rejected","message":"capture: rejected on purpose"}},"time":{"created":1791893507490,"ran":1791893507610,"completed":1791893509232}}
```

- The tool is named `shell`, not `bash`, although the prompt asked for "your bash tool" (`v2-capture/prompt-request.json:2`, `v2-capture/events.sse:73`). Capture 2's prompt asked for "your shell tool" (`v2-capture-2/prompt-request.json:2`), and the model used `shell`.
- A rejected tool produces `session.tool.failed` and no `session.tool.success`. The failure carries `error.type` and `error.message` and no `content`. The stored state has `status: "error"` and keeps `time.ran`. The rejection happens before the tool runs, so this path does not show a tool that ran and then failed.
- `session.tool.called` has no `name`. The name appears only on `session.tool.input.started`.
- `executed` is `false` on `called` and `success` in captures 2 and 3b (and on every capture 1 call), including the approved shell calls that ran (`v2-capture-2/events.sse:57`, `:77`, `:171`, `:193`). It is also `false` on the rejected call (`:81`). Its meaning is not documented and it does not distinguish a run from a rejection.
- The approved shell input may carry `workdir` (`v2-capture-2/events.sse:157`, `"input":{"command":"pwd","workdir":"/tmp/octmux-v2-capture-2"}`).
- v1 equivalent: `message.part.updated` with `part.type === "tool"` (`src/events.ts:492`).

**Non-zero exit (capture 3b).** A model-driven `shell` call running `cat ./does-not-exist.txt` exited with code 1. The tool did not fail. Sequence: `session.tool.input.started` (`v2-capture-3b/events.sse:81`), `session.tool.input.ended` (`:85`), `session.tool.called` (`:87`), `permission.asked` (`:91`), `permission.replied` (`:93`), `shell.created` (`:95`), `session.tool.progress` with `metadata.shellID` (`:97`), `shell.exited` with `exit: 1` (`:99`), `session.tool.success` (`:101`). No `session.tool.failed` frame follows. The success frame carries the exit in `metadata` and an extra text part:

```json
// v2-capture-3b/events.sse:101  session.tool.success (data), durable seq 23, version 2
{"sessionID":"ses_eca4e5f6cffel0VZOQZzz5QKqf","assistantMessageID":"msg_135b27088001ctJReKGAsa2nGU","id":"call_hw22vd6l","content":[{"type":"text","text":"cat: ./does-not-exist.txt: No such file or directory\n"},{"type":"text","text":"Exited with code 1"}],"metadata":{"status":"completed","truncated":false,"exit":1},"executed":false}
```

- The stored tool part has `state.status: "completed"` and `metadata.exit: 1` (`v2-capture-3b/obs1-messages-after.json:1`). A non-zero exit is therefore a completed tool with an exit code, not an error state.
- The model's shell input carried `command` and `workdir`. A longer call also carried `timeout: 30000` (`v2-capture-3b/obs2b-messages-after.json:1`).

**Interrupt during a running tool (capture 3b).** `POST /api/session/{id}/interrupt` returned HTTP 200 `{"interrupted":true}` (`v2-capture-3b/obs2b-interrupt-response.json:1`). The frames that followed, in order:

1. `shell.deleted` (`v2-capture-3b/events.sse:233`).
2. `session.tool.failed` with `error.type: "aborted"` (`:235`).
3. `session.step.failed` with `error.type: "aborted"` (`:237`).
4. `session.usage.updated` (`:239`).
5. `session.execution.interrupted` with `reason: "user"` (`:241`, durable seq 59).
6. `shell.exited` with no `exit` field (`:243`), which arrives after the turn has already ended.

```json
// v2-capture-3b/events.sse:235  session.tool.failed (data), durable seq 57, version 2
{"sessionID":"ses_eca4e5f6cffel0VZOQZzz5QKqf","assistantMessageID":"msg_135b37db1001Cnul8re9aGK4pw","id":"call_2c5x770y","error":{"type":"aborted","message":"Tool execution interrupted"},"metadata":{"shellID":"sh_135b3822d001C94ii2eOS3P65G"},"executed":false}
```

- The stored tool part has `state.status: "error"` with `error.type: "aborted"`, no `content`, and `time.completed` (`v2-capture-3b/obs2b-messages-after.json:1`). The stored assistant item has `finish: "error"` and `rawFinish: "tool_calls"`. Its idle item has `outcome: "interrupted"`.
- `GET /api/session/active` returned `{"data":{}}` right after the interrupt (`v2-capture-3b/obs2b-active-right-after-interrupt.json:1`).
- `executed` is `false` on every `session.tool.called`, `session.tool.success` and `session.tool.failed` in capture 3b, including the completed runs and the interrupted run (§6). Capture 3 had no tool frames.

### 4.5 Shell side channel

Capture 1 example:

```json
// v2-capture/events.sse:83  shell.created (data), trimmed; file path redacted
{"info":{"id":"sh_1350d9489001NNw7i8Coz7irWf","status":"running","command":"ls -la","cwd":"/tmp/octmux-v2-capture","shell":"/bin/bash","file":"/Users/<user>/.local/share/opencode/shell/…/sh_1350d9489001NNw7i8Coz7irWf.out","metadata":{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ"},"time":{"started":1791891444873}}}
// v2-capture/events.sse:85  session.tool.progress (data), links tool call to shell
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9162001a87C2ZSylZLPHd","id":"call_ylrxajbp","metadata":{"shellID":"sh_1350d9489001NNw7i8Coz7irWf"}}
// v2-capture/events.sse:87  shell.exited (data), no sessionID
{"id":"sh_1350d9489001NNw7i8Coz7irWf","exit":0,"status":"exited"}
// v2-capture/events.sse:89  session.tool.success (data), shell metadata, trimmed
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9162001a87C2ZSylZLPHd","id":"call_ylrxajbp","content":[{"type":"text","text":"total 24\n…one.txt\n…three.csv\n…two.txt\n"}],"metadata":{"status":"completed","truncated":false,"exit":0},"executed":false}
```

Capture 2, parent `ls -la` (the `shell.created` frame is at `v2-capture-2/events.sse:71`, the progress frame at `:73`, the exit at `:75`; the success frame is at `:77` and its content is trimmed here):

```json
// v2-capture-2/events.sse:71  shell.created (data), trimmed; file path redacted
{"info":{"id":"sh_1352d145f001ub3SojHujD3yLh","status":"running","command":"ls -la","cwd":"/tmp/octmux-v2-capture-2","shell":"/bin/bash","file":"/Users/<user>/.local/share/opencode/shell/…/sh_1352d145f001ub3SojHujD3yLh.out","metadata":{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a"},"time":{"started":1791893509215}}}
// v2-capture-2/events.sse:73  session.tool.progress (data)
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d03eb00172b9aW4MlJf5ai","id":"call_x9y407un","metadata":{"shellID":"sh_1352d145f001ub3SojHujD3yLh"}}
// v2-capture-2/events.sse:75  shell.exited (data)
{"id":"sh_1352d145f001ub3SojHujD3yLh","exit":0,"status":"exited"}
```

Capture 2, child `pwd`. The `shell.created` frame carries the child's session id (`v2-capture-2/events.sse:165`), and the child's tool progress carries the child's session id too (`:167`):

```json
// v2-capture-2/events.sse:165  shell.created (data), child session, trimmed
{"info":{"id":"sh_1352d24e1001RG2dip9HPNAT81","status":"running","command":"pwd","cwd":"/tmp/octmux-v2-capture-2","shell":"/bin/bash","file":"/Users/<user>/.local/share/opencode/shell/…/sh_1352d24e1001RG2dip9HPNAT81.out","metadata":{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0"},"time":{"started":1791893513442}}}
```

- Shell output is written to a file on the MBP (`shell.created` `file`). Octmux does not receive it through the stream; it appears in `tool.success` content.
- `shell.exited` carries no session key in any capture (`v2-capture/events.sse:87`; `v2-capture-2/events.sse:75`, `:169`; `v2-capture-3b/events.sse:99`). It must be correlated through the `sh_…` id.
- v1 equivalent: none for shell processes in `src/events.ts`. Tool output arrives in `message.part.updated` tool parts (`src/events.ts:492`).

**User shell (capture 3).** `POST /api/session/{id}/shell` (client route `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:403`) runs a command outside any assistant turn. The body was `{"command": "cat ./does-not-exist.txt"}` (`v2-capture-3/p2-shell-fail-request.json:1`). The response was HTTP 204 and came only after the command ended, so the call blocked for the whole run (`v2-capture-3/p2-shell-sleep-response.json:2`, a 25 s `sleep`). Frames for the failing command:

```json
// v2-capture-3/events-p2.sse:5  shell.created (data), trimmed; file path redacted
{"info":{"id":"sh_13579b8d6001kqAeaynrDvHiES","status":"running","command":"cat ./does-not-exist.txt","cwd":"/tmp/octmux-v2-capture-3","shell":"/bin/bash","file":"/Users/<user>/.local/share/opencode/shell/…/sh_13579b8d6001kqAeaynrDvHiES.out","metadata":{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","background":true},"time":{"started":1791898532054}}}
// v2-capture-3/events-p2.sse:7  session.shell.started (data), durable seq 123
{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","shell":{"id":"sh_13579b8d6001kqAeaynrDvHiES","status":"running","command":"cat ./does-not-exist.txt","cwd":"/tmp/octmux-v2-capture-3","shell":"/bin/bash","file":"/Users/<user>/.local/share/opencode/shell/…/sh_13579b8d6001kqAeaynrDvHiES.out","metadata":{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","background":true},"time":{"started":1791898532054},"pid":12079}}
// v2-capture-3/events-p2.sse:11  shell.exited (data)
{"id":"sh_13579b8d6001kqAeaynrDvHiES","exit":1,"status":"exited"}
// v2-capture-3/events-p2.sse:13  session.shell.ended (data), durable seq 124, trimmed
{"sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","shell":{"id":"sh_13579b8d6001kqAeaynrDvHiES","status":"exited","command":"cat ./does-not-exist.txt",…,"time":{"started":1791898532054,"completed":1791898532081},"pid":12079,"exit":1},"output":{"output":"cat: ./does-not-exist.txt: No such file or directory\n","cursor":53,"size":53,"truncated":false}}
// v2-capture-3/events-p2.sse:15  session.inbox.enqueued (data), durable seq 125
{"inboxID":"msg_13579b8fe001i2oIIIwPcLWrb1","sessionID":"ses_eca8ef401ffeG520AuaU6mWafm","item":{"type":"synthetic","payload":{"text":"The following shell command was executed by the user:\n<shell id=\"sh_13579b8d6001kqAeaynrDvHiES\" state=\"completed\" command=\"cat ./does-not-exist.txt\">\ncat: ./does-not-exist.txt: No such file or directory\n\n\nExited with code 1\n</shell>","metadata":{"source":"shell","shellID":"sh_13579b8d6001kqAeaynrDvHiES","state":"completed","truncated":false,"exit":1}},"delivery":"steer"}}
```

- No `session.execution.*` frame, no assistant frame and no `permission.asked` accompanies a user shell in `v2-capture-3/events-p2.sse:5–15`. The shell ran although the session ruleset is `ask` for `shell`. The only `permission.asked` in that window was the API-created ask (`v2-capture-3/events-p2.sse:17`, §4.7).
- The `shell.created` frame has `metadata.background: true`. Its top-level keys are `id`, `type`, `location`, `created` and `data`. There is no top-level `sessionID`.
- A synthetic inbox item is the only record that the user shell reached the session. It is listed by `GET /api/session/{id}/inbox` (`v2-capture-3/p2-resync-inbox.json:1`). No `session.inbox.delivered` frame exists for any synthetic item in capture 3, because no prompt was sent after them. When or whether a later execution delivers them is not observed (§6).
- An interrupt during a running user shell returned `{"interrupted":false}` (`v2-capture-3/p2-interrupt-response.json:1`). The shell ran to completion (`v2-capture-3/events-p2b.sse:15`, `exit: 0`). Its synthetic item is at `v2-capture-3/events-p2b.sse:19`.
- `GET /api/session/active` returned `{"data":{}}` while the user shell was still running (`v2-capture-3/p2-resync-active.json:1`). This is one sample. It suggests that a user shell does not mark the session busy. Repeat before relying on it.
- Stored user-shell items appear in the message list as `type: "shell"`, with `shellID`, `command`, `status`, `exit` and `output` (`v2-capture-3/p2-resync-messages.json:1`; `v2-capture-3/p2-messages-final.json:1`). They are not assistant content.

**Shell output in capture 3b.** A model-driven `shell.created` has no top-level `sessionID` either; the session key is `data.info.metadata.sessionID` (`v2-capture-3b/events.sse:95`). On interrupt the running shell is removed by `shell.deleted` (`v2-capture-3b/events.sse:233`, `data.id` only), and a later `shell.exited` has no `exit` (`:243`).

### 4.6 Forms (questions)

Capture 1 only. Capture 2 had no question form.

```json
// v2-capture/form-1.json:2–32 / v2-capture/events.sse:57  form.created (data.form), trimmed
{"form":{"id":"frm_1350d8f9e001n3E9p9dgUMz16U","sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","title":"Questions","metadata":{"kind":"question","tool":{"messageID":"msg_1350d8922001Upjb4nJACI32IY","id":"call_ru7aormg"}},"fields":[{"key":"q0","title":"Your choice","description":"Please choose 'A' or 'B'.","type":"string","options":[{"value":"A","label":"A","description":"Choose option A"},{"value":"B","label":"B","description":"Choose option B"}],"custom":true}]}}
```

```json
// v2-capture/form-1-reply-request.json:1   POST /api/session/{sessionID}/form/{formID}/reply
{"answer":{"q0":"A"}}
// v2-capture/events.sse:59  form.replied (data)
{"id":"frm_1350d8f9e001n3E9p9dgUMz16U","sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","answer":{"q0":"A"}}
```

- `v2-capture/form-1-reply-response.json` is 0 bytes. The response body is empty. The status code was not recorded.
- `form.created` and `form.replied` are non-durable and carry no `assistantMessageID`. The tool link is `data.form.metadata.tool` (`messageID`, `id = call_…`).
- `form.replied` carries the form id (`frm_…`). The `session.tool.success` that follows carries the tool call id (`call_…`) and `metadata.answers` (`v2-capture/events.sse:61`).
- Answer key is the field key (`q0`). The answer value is the option `value`.
- v1 equivalent: `question.asked` (`src/events.ts:859`), `question.replied` (`:880`), `question.rejected` (`:894`). The v2 typed `form.cancelled` (`types.d.ts:2421`) was not observed.

**API-created form (capture 3).** `POST /api/session/{id}/form` (client route `service-probe-ecs5ftka.js:563`) with `{"title": "capture-3 probe form", "fields": [{"key": "ok", "type": "boolean", "title": "OK?"}]}` returned HTTP 200 with the form (`v2-capture-3/p2-form-create-response.json:1`). It raised a `form.created` frame whose form has no `metadata.tool` link (`v2-capture-3/events-p2.sse:19`). The reply `{"answer": {"ok": true}}` returned HTTP 204 (`v2-capture-3/p2-form-reply-request.json:1`, `p2-form-reply-response.json`), and `form.replied` carried the form id as `data.id` and the answer (`v2-capture-3/events-p2.sse:23`). The field type `boolean` is new; the answer value is a JSON boolean.

### 4.7 Permissions

Capture 2 observed the full permission path: session ruleset, `permission.asked`, list, reply, `permission.replied`, and the rejected-tool outcome. Capture 1 had no permission frame, because its shell calls ran without an ask.

**Ruleset on the session.** The create request carries a `permissions` array (`v2-capture-2/session-create-request.json:6–17`):

```json
{
  "title": "octmux-v2-capture-2",
  "location": {
    "directory": "/tmp/octmux-v2-capture-2"
  },
  "permissions": [
    {
      "action": "shell",
      "resource": "*",
      "effect": "ask"
    },
    {
      "action": "bash",
      "resource": "*",
      "effect": "ask"
    }
  ]
}
```

The server echoes the array in the create response (`v2-capture-2/session-create.json:1`), in `session.created` (`v2-capture-2/events.sse:5`, `data.permissions`), and on the child session (`v2-capture-2/events.sse:131`). The rule schema is `{action, resource, effect}` (client type `PermissionRule`, `node_modules/@opencode/client/dist/promise/generated/types.d.ts:519`), with `effect` of type `PermissionEffect` (`types.d.ts:34`), values `allow`, `deny`, `ask`.

**Request frame.** `permission.asked` (`v2-capture-2/events.sse:65`), copied from its `data`:

```json
{"id":"per_1352d0e21001NkUobNoMhpP9mw","sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","action":"shell","resources":["ls -la"],"save":["ls *"],"source":{"type":"tool","messageID":"msg_1352d03eb00172b9aW4MlJf5ai","id":"call_x9y407un"}}
```

- `id` is the request id (`per_…`), used in the reply path and in `permission.replied.requestID`.
- `action` is the permission action (`shell`). `resources` is the list of concrete resources the call asked for; here the command string.
- `save` is a list of glob-like patterns offered for saving a rule. Observed values: `ls *` (`v2-capture-2/events.sse:65`), `cat *` (`:67`), `pwd *` (`:161`). What saving does is not exercised.
- `source` links the request to the tool call: `type: "tool"`, `messageID` (the assistant message), `id` (the `call_…` id). The `source.id` equals the `session.tool.called` id for that call (`:57` ↔ `:65`).
- The frame is non-durable and has no `message` or `metadata` key in either example.
- v1 handler `permission.asked` (`src/events.ts:840`, properties `id`, `sessionID`, `permission`, `patterns`). The v2 frame uses `action` and `resources`, which differ from v1 field names.

**Two asks pending at once.** Both shell calls of the first assistant message raised a `permission.asked` (`v2-capture-2/events.sse:65`, `:67`) before either reply. The list at that time shows both (`v2-capture-2/permission-1-parent-list.json:1`).

**List.** `GET /api/session/{sessionID}/permission` returns the pending asks. Copied from `v2-capture-2/permission-1-parent-list.json:1`, with the second item trimmed:

```json
{"data":[{"id":"per_1352d0e21001NkUobNoMhpP9mw","sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","action":"shell","resources":["ls -la"],"save":["ls *"],"source":{"type":"tool","messageID":"msg_1352d03eb00172b9aW4MlJf5ai","id":"call_x9y407un"}},…]}
```

**Reply.** `POST /api/session/{sessionID}/permission/{requestID}/reply`. The response is HTTP 204 with an empty body (`v2-capture-2/driver.log:4,5,7`; `v2-capture-2/permission-1-parent-reply-response.json`, `permission-2-parent-reply-response.json`, `permission-3-child-reply-response.json` are 0 bytes). Request bodies:

```json
// v2-capture-2/permission-1-parent-reply-request.json:1   approve once
{"decision": "once"}
// v2-capture-2/permission-2-parent-reply-request.json:1   reject with message
{"decision": "reject", "message": "capture: rejected on purpose"}
```

**Reply frame.** `permission.replied` (`v2-capture-2/events.sse:69` for the approved call, `:79` for the rejected call):

```json
// v2-capture-2/events.sse:69  permission.replied (data), approved
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","requestID":"per_1352d0e21001NkUobNoMhpP9mw","reply":"once"}
// v2-capture-2/events.sse:79  permission.replied (data), rejected
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","requestID":"per_1352d0e220010vDEv9ZDGp6n9l","reply":"reject"}
```

- The reject message is not in the `permission.replied` frame. It appears in the failed tool call as `error.message` (`v2-capture-2/events.sse:81`, §4.4).
- Observed `reply` values: `once` and `reject`. Other values, and the saved-rule routes (`/api/permission/saved`, client `service-probe-ecs5ftka.js:917–925`), were not exercised.

**Child-session asks.** The subagent's shell call raised an ask on the child session (`v2-capture-2/events.sse:161`):

```json
// v2-capture-2/events.sse:161  permission.asked (data), child session
{"id":"per_1352d21df001CQmsCnD8UnWVu8","sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","action":"shell","resources":["pwd"],"save":["pwd *"],"source":{"type":"tool","messageID":"msg_1352d1dca00120H1D2uE0vC05J","id":"call_vvtiggb7"}}
```

- The child's ask is listed by `GET /api/session/ses_ecad2e243ffeRU5SRXXCTakYE0/permission` (`v2-capture-2/permission-3-child-list.json:1`). It was approved with `{"decision": "once"}` (`v2-capture-2/permission-3-child-reply-request.json:1`), and `permission.replied` followed (`v2-capture-2/events.sse:163`).
- The parent's permission list was not queried after the child ask appeared. Both parent lists (`v2-capture-2/permission-1-parent-list.json:1`, `permission-2-parent-list.json:1`) were taken before the child existed (`v2-capture-2/driver.log:3–6`). Whether the parent's list also includes child asks is not established by this capture.

**API-created ask (capture 3).** `POST /api/session/{id}/permission` (client route `service-probe-ecs5ftka.js:933`) with `{"action": "shell", "resources": ["echo perm-probe"], "save": ["echo *"]}` returned HTTP 200 with `{"data":{"id":"per_13579c91e001nT4zGcHMEVob0H","effect":"ask"}}` (`v2-capture-3/p2-permission-create-request.json:1`, `p2-permission-create-response.json:1`). The resulting `permission.asked` frame has no `source` key (`v2-capture-3/events-p2.sse:17`). The reply `{"decision": "once"}` returned HTTP 204 (`v2-capture-3/p2-permission-reply-request.json:1`), and `permission.replied` followed with `reply: "once"` (`v2-capture-3/events-p2.sse:21`). A list call while the ask was pending returned it (`v2-capture-3/p2-probe-session-permission.json:1`).

**Tool-raised asks (capture 3b).** The single `cat` ask carried `source` and `save: ["cat *"]` (`v2-capture-3b/events.sse:91`). The compound command `sleep 20 && echo finished` raised one ask with two `resources` and two `save` patterns, one per part of the command (`v2-capture-3b/events.sse:153` and `:223`). One `permission.asked` can therefore hold several resources. Every reply in capture 3b was `once`.

```json
// v2-capture-3b/events.sse:153  permission.asked (data), compound command, trimmed
{"id":"per_135b2bcfb001x0fCl5An4UeXsc","sessionID":"ses_eca4e5f6cffel0VZOQZzz5QKqf","action":"shell","resources":["sleep 20","echo finished"],"save":["sleep *","echo *"],"source":{"type":"tool","messageID":"msg_135b2b9140010riiSoJRGUF9A8","id":"call_sfzo96y8"}}
```

**Durability.** `permission.asked` and `permission.replied` are non-durable and carry no `seq`.

### 4.8 Busy and idle

```json
// v2-capture/events.sse:29  session.execution.started (data), no location, durable seq 2
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ"}
// v2-capture/events.sse:117  session.execution.succeeded (data), durable seq 30
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ"}
// v2-capture/active-sample.json:1   GET /api/session/active, sampled mid-run
{"data":{"ses_ecaf279a0fferfPEx4LQ1FsOrZ":{"type":"running"}}}
```

```json
// v2-capture/session-final.json:1   GET /api/session/{id}, after the turn
{"data":{"id":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","cost":0,"tokens":{"input":8563,"output":99,"reasoning":148,"cache":{"read":16064,"write":0}},"outcome":"succeeded","time":{"created":1791891441254,"updated":1791891445704,"idle":1791891445708},"title":"octmux-v2-capture"}}
```

Capture 2, parent and child, one per session:

```json
// v2-capture-2/events.sse:137  session.execution.started (data), child session, no location, durable seq 2
{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0"}
// v2-capture-2/events.sse:191  session.execution.succeeded (data), child session, no location, durable seq 19
{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0"}
// v2-capture-2/events.sse:213  session.execution.succeeded (data), parent session, durable seq 34
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a"}
// v2-capture-2/active-after.json:1   GET /api/session/active, after the parent's terminal event
{"data":{}}
```

```json
// v2-capture-2/parent-session-final.json:1   GET /api/session/{id}, after the turn, trimmed
{"data":{"id":"ses_ecad2fc3effeKko2WsNH68s41a","projectID":"…","cost":0,"tokens":{"input":9062,"output":148,"reasoning":464,"cache":{"read":16448,"write":0}},"outcome":"succeeded","time":{"created":1791893504965,"updated":1791893515217,"idle":1791893515221},"title":"octmux-v2-capture-2","subpath":"../../../tmp/octmux-v2-capture-2","permissions":[…],"location":{"directory":"/tmp/octmux-v2-capture-2"}}}
```

- No `session.idle` frame was observed in any capture (1, 2, 3, 3b). The end of the turn is `session.execution.succeeded` (`v2-capture/events.sse:117`; `v2-capture-2/events.sse:191`, `:213`). In each capture `time.idle` in the session-final file equals that frame's `created` (capture 1: 1791891445708; capture 2 parent: 1791893515221; capture 2 child: 1791893514576, `v2-capture-2/child-1-session-final.json:1`).
- The parent's `session.execution.succeeded` arrives after the child's (`v2-capture-2/events.sse:191` before `:213`).
- The last message in each message list has `type: "idle"` with `outcome: "succeeded"` (`v2-capture/messages-page-1.json:1`; `v2-capture-2/parent-messages-page-1.json:1`; `v2-capture-2/child-1-messages-page-1.json:1`).
- `/api/session/active` was sampled running in capture 1 (`v2-capture/active-sample.json:1`) and in capture 2 (`v2-capture-2/active-sample.json:1`, which lists only the parent). The capture 2 sample has no timestamp, so whether a running child appears in that list is not established.
- After the parent's terminal event (`v2-capture-2/driver.log:8`), `/api/session/active` returned an empty object (`v2-capture-2/active-after.json:1`). The file has no timestamp, so this is the post-idle shape as the driver sampled it.
- **Failed turn (capture 3).** Each turn that hit the provider outage ended with `session.execution.failed` (`v2-capture-3/events.sse:95`, `:227`, `:363`, `:579`; durable, no `location`), carrying `error` with `type: "provider.transport"`. The stored idle item has `outcome: "failed"` (`v2-capture-3/parent-messages-all.json:1`), and the session object's `outcome` is `failed` (`v2-capture-3/parent-session-final.json:1`).
- **Interrupted turn during a retry loop (capture 3).** `POST /api/session/{id}/interrupt` returned `{"interrupted":true}` (`v2-capture-3/retest-interrupt-response.json:1`). The next frame was `session.execution.interrupted` with `reason: "user"` (`v2-capture-3/events-retest.sse:25`, durable seq 122). The stored idle item has `outcome: "interrupted"` (`v2-capture-3/p2-messages-final.json:1`).
- **Interrupted turn during a running tool (capture 3b).** The sub-frames are in §4.4. The `session.execution.interrupted` frame is at `v2-capture-3b/events.sse:241` (durable seq 59).
- **Turn outcome with a failed compaction (capture 3).** `session.execution.succeeded` followed `session.compaction.failed` (`v2-capture-3/events.sse:477`, `:479`). The turn outcome does not reflect the failed compaction.
- **Operator interrupt during a user shell.** It produced no `session.execution.*` frame; the response was `{"interrupted":false}` (§4.5).
- v1 equivalents: `session.idle` (`src/events.ts:754`, `properties.sessionID`) and `session.status` (`:802`, `status.type`). The v2 `session.status` (`types.d.ts:2444`) was not observed. The v1 parent-turn-end reason `aborted` (`src/events.ts:42`, `:343–348`) corresponds to `session.execution.interrupted`. The v1 `session.error` (`src/events.ts:790`) corresponds to `session.execution.failed`.

### 4.9 Subagent child sessions

Capture 2 observed one subagent call. The child is a full session with its own event sequence, durable seq and messages.

**Invocation.** The parent calls a tool named `subagent` with input `{agent, description, prompt}`. Copied from `v2-capture-2/events.sse:125`:

```json
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d147a001pKAHKU0tp6Iol1","id":"call_nja9hdcz","input":{"agent":"general","description":"Run pwd and report output","prompt":"Run the shell command `pwd` using your shell tool in the current working directory (/tmp/octmux-v2-capture-2). Report back the exact output of the command."},"executed":false}
```

The tool name is `subagent` (`v2-capture-2/events.sse:119`, `"name":"subagent"`). The input keys are as above.

**Child creation.** `session.created` for the child (`v2-capture-2/events.sse:131`), copied from its `data`. It is durable under the child's own `aggregateID`, with `seq` 0:

```json
{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","slug":"sunny-nebula","version":"2.0.28","projectID":"3469694a534b0c65f8889ab3ecd1fe314c6eae2f","parentID":"ses_ecad2fc3effeKko2WsNH68s41a","location":{"directory":"/tmp/octmux-v2-capture-2"},"subpath":"../../../tmp/octmux-v2-capture-2","title":"Run pwd and report output","agent":"general","permissions":[{"action":"shell","resource":"*","effect":"ask"},{"action":"bash","resource":"*","effect":"ask"}]}
```

- `parentID` links the child to the parent. The child's `title` equals the invocation's `description` (`:125`). The child inherits the same `permissions` ruleset as the parent.
- The child's `agent` is `general` (`:131`). The parent's agent is `build`.

**Child prompt.** The child's prompt is delivered as an inbox item (`v2-capture-2/events.sse:135`). The server prepends a line to the prompt. The parent's tool input (`:125`) does not contain it, and the child's inbox item does:

```json
// v2-capture-2/events.sse:135  session.inbox.enqueued (data), child session, trimmed
{"inboxID":"msg_1352d1dc00013DjQX52DgoLsgt","sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","item":{"type":"user","payload":{"text":"You are a subagent spawned by another session.\nRun the shell command `pwd` using your shell tool in the current working directory (/tmp/octmux-v2-capture-2). Report back the exact output of the command."},"delivery":"steer"}}
```

The same text is the child's first user message (`v2-capture-2/child-1-messages-page-1.json:1`).

**Child lifecycle.** The child's frames carry only the child's `sessionID`. They follow the same shape as a parent turn: `session.execution.started` (`:137`), `session.instructions.updated` (`:139`), `session.inbox.delivered` (`:141`), `session.step.started` (`:143`, agent `general`, model `glm-5.3-flash`, provider `sohoai`), reasoning, a shell tool call with its own permission ask (`:161`), `session.tool.success` (`:171`), step ended, text, `session.step.ended` (`:187`), and `session.execution.succeeded` (`:191`). The child's durable seq runs 0 to 19 (`v2-capture-2/events.sse:131–191`).

**Parent-side link.** While the child runs, the parent emits `session.tool.progress` with the child's id in metadata (`v2-capture-2/events.sse:133`). This is the only live frame on the parent side that names the child:

```json
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d147a001pKAHKU0tp6Iol1","id":"call_nja9hdcz","metadata":{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","status":"running"}}
```

**Parent completion.** The parent's `session.tool.success` for the `subagent` call (`v2-capture-2/events.sse:193`, durable seq 27, version 2). Its `content` is the child's final text wrapped in a `<subagent>` element, and `metadata` carries the child's session id and status. Trimmed from the file:

```json
{"sessionID":"ses_ecad2fc3effeKko2WsNH68s41a","assistantMessageID":"msg_1352d147a001pKAHKU0tp6Iol1","id":"call_nja9hdcz","content":[{"type":"text","text":"<subagent sessionID=\"ses_ecad2e243ffeRU5SRXXCTakYE0\" state=\"completed\">\nThe exact output of `pwd` was:\n\n```\n/private/tmp/octmux-v2-capture-2\n```\n</subagent>"}],"metadata":{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","status":"completed","truncated":false},"executed":false}
```

The child's `session.execution.succeeded` (`:191`) comes before the parent's `session.tool.success` (`:193`) and before the parent's `session.step.ended` (`:195`).

**Stored subagent tool item.** In the parent's message list (`v2-capture-2/parent-messages-page-1.json:1`), trimmed:

```json
{"type":"tool","id":"call_nja9hdcz","name":"subagent","executed":false,"state":{"status":"completed","input":{"agent":"general","description":"Run pwd and report output","prompt":"…"},"content":[{"type":"text","text":"<subagent sessionID=\"ses_ecad2e243ffeRU5SRXXCTakYE0\" state=\"completed\">…"}],"metadata":{"sessionID":"ses_ecad2e243ffeRU5SRXXCTakYE0","status":"completed","truncated":false}},"time":{"created":1791893511473,"ran":1791893511605,"completed":1791893514580}}
```

**Child session state.** The child's messages are in `v2-capture-2/child-1-messages-page-1.json:1`: a user item, an assistant item with reasoning and a shell tool, an assistant item with text, and an idle item. The child's final state is `v2-capture-2/child-1-session-final.json:1` (outcome `succeeded`, `parentID` present). A list call made with the child's id returned an empty list (`v2-capture-2/child-1-children.json:1`). The driver did not log that URL, so the route used for it is not recorded.

**Child listing from the parent.** The child appears in a list filtered by `parentID`. Before the child existed the list was empty (`v2-capture-2/children-list-0.json:1`, `{"data":[],"cursor":{"previous":null,"next":null}}`). After, it held the child (`v2-capture-2/children-list-1.json:1`, trimmed):

```json
{"data":[{"id":"ses_ecad2e243ffeRU5SRXXCTakYE0","parentID":"ses_ecad2fc3effeKko2WsNH68s41a","projectID":"3469694a534b0c65f8889ab3ecd1fe314c6eae2f","agent":"general","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1791893511614,"updated":1791893512248},"title":"Run pwd and report output","subpath":"../../../tmp/octmux-v2-capture-2","permissions":[…],"location":{"directory":"/tmp/octmux-v2-capture-2"}}],"cursor":{"previous":"eyJ…","next":"eyJ…"}}
```

The query string of that call is not recorded in `driver.log`. The `parentID` filter matches the client route at `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:220–232`.

- The child's own totals are separate: input 7296, output 51 (`v2-capture-2/children-final.json:1`), and are not rolled into the parent (§4.3).

**Capture 3b subagent (same shape, second run).** The sequence matches the capture 2 subagent above.

- Invocation: `session.tool.input.started` with `name: "subagent"` (`v2-capture-3b/events.sse:265`). The stored input is `{"agent":"general","description":"Reply with pong","prompt":"Reply with the single word: pong"}` (`v2-capture-3b/obs3-messages-after.json:1`).
- Child creation: `session.created` with `parentID` (`v2-capture-3b/events.sse:275`). The child's `title` equals the invocation's `description`, and it inherits the same `permissions` ruleset.
- Child prompt: the child's inbox item begins with the server-prepended line, as in capture 2 (`v2-capture-3b/events.sse:279`): `"You are a subagent spawned by another session.\nReply with the single word: pong"`.
- Parent-side link: `session.tool.progress` with `metadata` `{"sessionID":"ses_eca4c2725ffenXtfxS1xSAe6Hx","status":"running"}` (`v2-capture-3b/events.sse:277`).
- Child lifecycle: its own `sessionID` and durable seq 0 to 12 (`v2-capture-3b/events.sse:275` to `:311`). `session.execution.succeeded` for the child is at `:311`.
- Parent completion: `session.tool.success` at `:313` (durable seq 70, version 2):

```json
// v2-capture-3b/events.sse:313  session.tool.success (data), durable seq 70, version 2
{"sessionID":"ses_eca4e5f6cffel0VZOQZzz5QKqf","assistantMessageID":"msg_135b3d380001mLpkWmG0iYsI4r","id":"call_s8nogw74","content":[{"type":"text","text":"<subagent sessionID=\"ses_eca4c2725ffenXtfxS1xSAe6Hx\" state=\"completed\">\npong\n</subagent>"}],"metadata":{"sessionID":"ses_eca4c2725ffenXtfxS1xSAe6Hx","status":"completed","truncated":false},"executed":false}
```

- Listing: `GET /api/session?parentID=…` returned the child with `outcome: "succeeded"` and `time.idle` (`v2-capture-3b/obs3-children-after.json:1`). The child's own `GET` returned `parentID`, `agent` and its totals (`v2-capture-3b/obs3-child-session-response.json:1`).

**Capture 3 child without a run.** `POST /api/session` with `parentID` created a child without any subagent call (`v2-capture-3/p2-child-create-request.json:1`). The response has `parentID` and no `agent` (`v2-capture-3/p2-child-create-response.json:1`). The child had no run and no messages. `GET /api/session?parentID=…` listed it (`v2-capture-3/p2-children-list.json:1`), with a `cursor` object.

### 4.10 Per-session filtering

- The capture subscribed to `/api/event` without query parameters in captures 1 and 2. Frames carry no SSE `id:` field in any capture.
- Filter on the attribution table in §2c.
- Global frames (no sessionID) and session frames interleave on one connection.
- Capture 2 exercised cross-session filtering. Parent and child frames interleave on the same stream (`v2-capture-2/events.sse:131–191`), and the parent's `session.tool.progress` at `:133` sits inside the child's range.
- Child attribution facts (capture 2):
  - Every child frame carries only the child's `sessionID`. The one child-range frame that names the parent is the child's own `session.created` (`v2-capture-2/events.sse:131`, `parentID`). The one parent-side frame in that range that names the child is `session.tool.progress` (`:133`, `metadata.sessionID`).
  - To attribute a child to its parent, use `session.created.parentID`. To attribute a parent's subagent call to its child, use `session.tool.progress.metadata.sessionID` with `id` equal to the `subagent` call id (`call_nja9hdcz`). The final `session.tool.success` (`:193`) repeats the child id in `metadata.sessionID`.
  - A shell event for the child carries the child's id in `shell.created.info.metadata.sessionID` (`:165`).
- Capture 3 stream: the global connection carried frames for sessions in other directories (for example `v2-capture-3/events.sse:303`, `:455`). Those frames were not used. Capture 3b carried only its own two sessions and global frames.
- v1 equivalent: handlers compare `properties.sessionID` against the current session and return `null` otherwise (for example `question.replied`, `src/events.ts:880`).

### 4.11 Reconnection and replay

- **`/api/event`:** the stream emits no SSE `id:` fields (`v2-capture-3/events.sse` has none). Capture 3 reconnected four times, with and without a `Last-Event-ID` request header:
  - Reconnect with `Last-Event-ID` set to the last frame seen before a short gap: the new connection sent one frame, `server.connected`, and no replayed frame (`v2-capture-3/events-p2-lastid.sse:1`; `driver-phase2.log:34`).
  - Reconnect with no events in the gap: no seq gap. `events-p2.sse` ends at durable seq 126 (`v2-capture-3/events-p2.sse:27`) and `events-p2b.sse` begins at seq 127 (`v2-capture-3/events-p2b.sse:17`).
  - Reconnect with `Last-Event-ID` after a shell ran while disconnected: only `server.connected` (`v2-capture-3/events-p3b-lastid.sse:1`).
  - Plain reconnect, no header: again only `server.connected` (`v2-capture-3/events-p3c-plain.sse:1`).
  - Gap: the last durable frame seen before the disconnect was seq 131 (`v2-capture-3/events-p3a.sse:13`). A shell (`echo gap-probe`) then ran while disconnected. The session log head is seq 134 (`v2-capture-3/p3-session-log.sse:1`), so seq 132 to 134 were emitted during the gap. No durable frame arrived after the reconnect, so the stream itself did not show the jump. The gap was established from the log head and the REST resync.
  - REST resync recovers the gap: `GET /api/session/{id}/inbox` lists the synthetic item for the gap shell (`v2-capture-3/p3-resync-inbox.json:1`), and `GET /api/session/{id}/message` lists its `shell` item (`v2-capture-3/p3-resync-messages.json:1`).
- **Session log** (`GET /api/experimental/session/{id}/log`, `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:523`):
  - The follow capture contains one line: `{"type":"log.synced","aggregateID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","seq":0}` (`v2-capture/session-log.sse:1`).
  - The replay response headers are HTTP 200 `text/event-stream` (`v2-capture/session-log-replay.headers:1`). The replays after 0 and after 25 each contained only `{"type":"log.synced",…,"seq":30}` (`v2-capture/session-log-replay.sse:1`, `v2-capture/session-log-replay-after0.sse:1`, `v2-capture/session-log-replay-after25.sse:1`).
  - `seq` 30 matches the final durable seq (`v2-capture/events.sse:117`).
  - Capture 3, `GET /api/experimental/session/{id}/log?after=0` and `?after=131` (`v2-capture-3/p3-session-log-after0.sse:1`, `p3-session-log-after131.sse:1`; headers `v2-capture-3/p3-session-log-after0.headers:1`): each returned one `log.synced` line with `seq` 134, the head at the time of the call. The log still carried no event bodies.
  - The log in 2.0.28, as observed, carries no event bodies. It is not usable as an event source in capture 1. Capture 2 did not call the session log.
- **Message history** (`GET /api/session/{id}/message`, `…chunks/service-probe-ecs5ftka.js:611`):
  - Capture 1: the cursor is opaque base64 JSON. `v2-capture/messages-page-1.json` `cursor.next` decodes to `{"id":"msg_1350d97cc001DQWVSX9dDdoK0K","order":"asc","direction":"next"}`. Page 2 is empty (`v2-capture/messages-page-2.json:1`).
  - Capture 2: `cursor.next` on the parent's first page decodes to `{"id":"msg_1352d2bd50017nX2RZm380iedS","order":"asc","direction":"next"}` (`v2-capture-2/parent-messages-page-1.json:1`). Requesting page 2 with `order=asc` together with the cursor returned `{"_tag":"InvalidCursorError","message":"Cursor cannot be combined with order"}` for both the parent (`v2-capture-2/parent-messages-page-2.json:1`) and the child (`v2-capture-2/child-1-messages-page-2.json:1`). The driver did not log URLs, so the request is as the driver issued it. The `order` and `cursor` query names are per the client route (`service-probe-ecs5ftka.js:613–614`).
  - Capture 3 tested each query parameter alone (`GET /api/session/{id}/message`, names per `service-probe-ecs5ftka.js:613–614`). The default order is `desc`. `limit` alone returned 3 items (`v2-capture-3/paging-limit3-default.json:1`). `cursor` alone works, because the cursor encodes its own order and direction. `cursor` next with no `limit` returned 12 items; the decoded `next` of that page is `{"id":"msg_octmuxcap3client0001","order":"desc","direction":"next"}` (`v2-capture-3/paging-cursor-next-nolimit.json:1`). `cursor` next with `limit=3` returned 3 items (`v2-capture-3/paging-cursor-next-only.json:1`, whose own decoded `next` is a different id). `order=asc` alone works (`v2-capture-3/paging-order-asc-only.json:1`). A `previous` cursor returns an empty `data` (`v2-capture-3/paging-cursor-previous-only.json:1`).
  - A forward chain with `order=asc` and `limit=3` covered 15 items over 6 pages, with no duplicate IDs (`v2-capture-3/paging-asc-chain-ids.json:1`). The same 15 IDs appear in the full list (`v2-capture-3/parent-messages-all.json:1`, 15 items). Capture 3 therefore shows the chain covers the whole list.
  - `order` combined with `cursor` returned `InvalidCursorError` in capture 2 (above). Capture 3 did not repeat that combination; use `cursor` alone.

### 4.12 Commands, compaction and model selection

**Session command (capture 3).** `GET /api/command` (optional `location` query) lists entries with `name` and `description` only (`v2-capture-3/command-list.json:1`, `command-list-location.json:1`). The list includes `init` and `review`, and also `brain`, `brain-abandon`, `duo-plan`, `duo-act`, `duo-abandon` and `rag` (`driver.log:6`). The response does not mark whether an entry is built in or custom; that grouping is inferred from the names.

`POST /api/session/{id}/command` with `{"name": "review", "text": "uncommitted"}` returned HTTP 204 (`v2-capture-3/command-request.json:1`, `command-response.json`). The expanded template arrived as an ordinary `session.inbox.enqueued` item of type `user`, with no command marker or command name (`v2-capture-3/events.sse:229`, durable seq 54). The turn then ran into the provider outage (§4.8). The stored `user` item has the expanded template as its `text` (`v2-capture-3/parent-messages-all.json:1`, id `msg_13573a021001R4qY74CKCFT7eD`).

**Compaction, manual, provider outage (capture 3).** `POST /api/session/{id}/compact` with `{}` returned HTTP 200 with a `compaction` inbox item (`v2-capture-3/compact-request.json:1`, `compact-response.json:1`). Frames, in order:

1. `session.inbox.enqueued` with `item.type: "compaction"` and an empty `payload` (`v2-capture-3/events.sse:369`).
2. `session.inbox.delivered` (`:373`).
3. `session.compaction.started` with `reason: "manual"`, `recent: ""` and `inputID` equal to the inbox id (`:375`).
4. `session.compaction.failed` with the provider error (`:477`).
5. `session.execution.succeeded` (`:479`).

No `session.step.*` frame appeared. The stored compaction item has `status: "failed"`, `reason: "manual"` and the same `error` (`v2-capture-3/p2-messages-final.json:1`).

**Compaction, success (capture 3b).** Frames, in order:

1. `session.compaction.started` (`v2-capture-3b/events.sse:349`, durable seq 83, `reason: "manual"`, `recent: ""`).
2. `session.compaction.delta` ×116, non-durable, each carrying a `text` chunk (first at `:351`, last at `:583`).

```json
// v2-capture-3b/events.sse:351  session.compaction.delta (data)
{"sessionID":"ses_eca4e5f6cffel0VZOQZzz5QKqf","text":"## Objective"}
```

3. `session.usage.updated` (`:585`).
4. `session.compaction.ended` (`:587`, durable seq 85) with `reason`, `model`, `text`, `recent`, `tokens` and `cost`.
5. `session.execution.succeeded` (`:589`, durable seq 86).

No `session.step.*` frame falls inside that window. The stored compaction item has `status: "completed"` and the summary text under `summary`, not `text` (`v2-capture-3b/obs4-messages-after-response.json:1`). It also has `recent`, `tokens` and `cost`.

- v1 analogues: the compaction message part (`src/events.ts:430–432`, kind `compaction-divider`) and `session.compacted` (`src/events.ts:722–725`, kind `session-compacted`).

**Model select.** See §4.3.

## 5. REST shapes observed

Route paths and methods come from `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js`. The drivers of captures 2, 3 and 3b logged HTTP statuses for most calls (`v2-capture-2/driver.log`, `v2-capture-3/driver.log`, `v2-capture-3/driver-phase2.log`, `v2-capture-3/driver-phase3.log`, `v2-capture-3b/driver.log`). Capture 3 also logged the query strings it used (`v2-capture-3/driver-phase2.log:7–8`, `:31`). Captures 1 and 2 did not record query strings, except where stated.

| Endpoint | Method | Request | Response (artefact) | Capture |
|---|---|---|---|---|
| `/api/session` (`service-probe-ecs5ftka.js:252`) | POST | capture 1: body not recorded. Capture 2: `{"title", "location", "permissions"}` (`v2-capture-2/session-create-request.json:1–17`) | capture 1: `v2-capture/session-create.json:1`: `{"data":{"id", "projectID", "cost":0, "tokens", "time", "title", "subpath", "location"}}`. Capture 2: same plus `permissions` (`v2-capture-2/session-create.json:1`). HTTP 200 (`v2-capture-2/driver.log:1`). | 1, 2 |
| `/api/session` with `parentID` filter (`service-probe-ecs5ftka.js:220–232`) | GET | query `parentID` (driver URL not logged) | `v2-capture-2/children-list-0.json:1` (empty, before child), `v2-capture-2/children-list-1.json:1` (one child) | 2 |
| `/api/session/{id}/prompt` (`:346`) | POST | `{"text": "…"}` (`v2-capture/prompt-request.json:2`; `v2-capture-2/prompt-request.json:2`) | `v2-capture/prompt-response.json:1`: `{"data":{"id", "sessionID", "time", "type":"user", "payload":{"text"}, "delivery":"steer"}}`. HTTP 200 in capture 2 (`v2-capture-2/driver.log:2`). | 1, 2 |
| `/api/session/{id}/prompt` with a client-supplied `id` (`:346`) | POST | `{"id": "msg_octmuxcap3client0001", "text": "…"}` (`v2-capture-3/prompt-1-request.json:1`) | HTTP 200 (`v2-capture-3/driver.log:2`). `data.id` equals the client id. The same id is the `inboxID` of `session.inbox.enqueued` and `session.inbox.delivered` (`v2-capture-3/events.sse:27`, `:33`) and the stored user item id (`v2-capture-3/p2-messages-final.json:1`). | 3 |
| `/api/session` with `parentID` on create (`:252`) | POST | `{"parentID", "title", "location"}` (`v2-capture-3/p2-child-create-request.json:1`) | HTTP 200. The child carries `parentID` and no `agent` (`v2-capture-3/p2-child-create-response.json:1`). | 3 |
| `/api/session?parentID=…` (`:220–232`) | GET | query `parentID` (`v2-capture-3/driver-phase2.log:31`) | one child, with a `cursor` object (`v2-capture-3/p2-children-list.json:1`) | 3 |
| `/api/session/{id}` (`:300`) | DELETE | — | HTTP 204 (`v2-capture-3/cleanup-delete-ses_eca8ef401ffeG520AuaU6mWafm.json:2`; `v2-capture-3b/cleanup-delete-ses_eca4e5f6cffel0VZOQZzz5QKqf-response.json`). A later GET returns 404 `SessionNotFoundError` (`v2-capture-3/cleanup-get-after-delete-ses_eca8ef401ffeG520AuaU6mWafm.json:1`). | 3, 3b |
| `/api/session/{id}/shell` (`:403`) | POST | `{"command": "…"}` (`v2-capture-3/p2-shell-fail-request.json:1`). The driver sent only `command`. | HTTP 204, returned only after the command ended (`v2-capture-3/p2-shell-sleep-response.json:2`). See §4.5. | 3 |
| `/api/session/{id}/interrupt` (`:531`) | POST | body not recorded; `resume` query not used | HTTP 200 with `{"interrupted":true}` or `{"interrupted":false}` (`v2-capture-3/retest-interrupt-response.json:1`, `v2-capture-3/p2-interrupt-response.json:1`, `v2-capture-3b/obs2b-interrupt-response.json:1`) | 3, 3b |
| `/api/session/{id}/command` (`:365`) | POST | `{"name": "review", "text": "uncommitted"}` (`v2-capture-3/command-request.json:1`) | HTTP 204 (`v2-capture-3/command-response.json`). The expanded template arrives as a `user` inbox item (§4.12). | 3 |
| `/api/command` (`:1010`) | GET | optional `location` query | entries with `name` and `description` only (`v2-capture-3/command-list.json:1`) | 3 |
| `/api/session/{id}/compact` (`:411`) | POST | `{}` (`v2-capture-3/compact-request.json:1`; `v2-capture-3b/obs4-compact-request.json:1`) | HTTP 200 with a `compaction` inbox item in `data` (`v2-capture-3/compact-response.json:1`) | 3, 3b |
| `/api/session/{id}/model` (`:324`) | POST | `{"model": {"id", "providerID"}}` (`v2-capture-3/model-switch-request.json:1`). The driver did not log the URL. | HTTP 204 (`v2-capture-3/model-switch-response.json`). See §4.3. | 3 |
| `/api/model/default` (`:631`) | GET | optional `location` | `data` with `id`, `modelID`, `providerID`, `name`, `settings`, `capabilities`, `variants` and `limit`. `settings.apiKey` is present and its value is shown as `<redacted>` in the artefact (`v2-capture-3/model-default.json:1`). Whether the server or the capture scrubbed it is not recorded. Do not log or persist this payload. | 3 |
| `/api/session/{id}/inbox` (`:466`) | GET | — | `data` with `synthetic` items for user shells (`v2-capture-3/p3-resync-inbox.json:1`) | 3 |
| `/api/session/{id}/form` (`:556` GET; `:563` POST) | GET, POST | POST: `{"title", "fields"}` (`v2-capture-3/p2-form-create-request.json:1`) | POST: HTTP 200 with the form (`v2-capture-3/p2-form-create-response.json:1`). GET: pending forms (`v2-capture-3/p2-probe-session-form.json:1`). | 3 |
| `/api/form` (`:896`) and `/api/permission/request` (`:907`) | GET | `location[directory]` query (`v2-capture-3/driver-phase2.log:7–8`) | With no location, the location is the server home directory and `data` is `[]` (`v2-capture-3/p2-probe-global-form.json:1`, `p2-probe-global-permission-request.json:1`). With the project directory, the pending items (`v2-capture-3/p2-probe-global-form-location.json:1`, `p2-probe-global-permission-request-location.json:1`). The per-session routes list the same items (`p2-probe-session-form.json:1`, `p2-probe-session-permission.json:1`). | 3 |
| `/api/session/active` (`:285`) | GET | — | `v2-capture/active-sample.json:1` (running). Capture 2: `v2-capture-2/active-sample.json:1` (running, parent only), `v2-capture-2/active-after.json:1` (`{"data":{}}`). Capture 3: `v2-capture-3/p2-resync-active.json:1` (`{"data":{}}`, sampled during a running user shell). Capture 3b: `v2-capture-3b/obs2b-active-right-after-interrupt.json:1` (`{"data":{}}`, right after an interrupt). | 1, 2, 3, 3b |
| `/api/session/{id}` (`:292`) | GET | — | `v2-capture/session-final.json:1`; `v2-capture-2/parent-session-final.json:1`; `v2-capture-2/child-1-session-final.json:1` | 1, 2 |
| `/api/session/{id}/message` paging, capture 3 (`:613–614`) | GET | `limit` alone; `cursor` alone; `order` alone; `order=asc` with `cursor` chained | `v2-capture-3/paging-*.json`, `v2-capture-3/paging-asc-chain-ids.json` (§4.11) | 3 |
| `/api/session/{id}/message` (`:611`) | GET | query `limit`, `order`, `cursor`, `type` (`service-probe-ecs5ftka.js:613–614`) | `v2-capture/messages-page-1.json:1`; page 2 `v2-capture/messages-page-2.json:1`. Capture 2: `v2-capture-2/parent-messages-page-1.json:1`, `v2-capture-2/child-1-messages-page-1.json:1`. `order` with `cursor` returned `InvalidCursorError` (`v2-capture-2/parent-messages-page-2.json:1`, `child-1-messages-page-2.json:1`). | 1, 2 |
| `/api/session/{id}/permission` (`service-probe-ecs5ftka.js:949`) | GET | — | `v2-capture-2/permission-1-parent-list.json:1`, `permission-2-parent-list.json:1`, `permission-3-child-list.json:1` | 2 |
| `/api/session/{id}/permission` (`:933`) | POST | capture 3: `{"action": "shell", "resources": ["echo perm-probe"], "save": ["echo *"]}` (`v2-capture-3/p2-permission-create-request.json:1`). Client body fields: `id, action, resources, save, metadata, source, agent`. | HTTP 200, `{"data":{"id","effect":"ask"}}` (`v2-capture-3/p2-permission-create-response.json:1`) | 3 |
| `/api/session/{id}/permission/{requestID}/reply` (`:963`) | POST | `{"decision": "once"}` (`v2-capture-2/permission-1-parent-reply-request.json:1`, `permission-3-child-reply-request.json:1`); `{"decision": "reject", "message": "…"}` (`v2-capture-2/permission-2-parent-reply-request.json:1`) | empty body, HTTP 204 (`v2-capture-2/driver.log:4,5,7`; `permission-*-reply-response.json` are 0 bytes). Capture 3: HTTP 204 for `{"decision": "once"}` (`v2-capture-3/driver-phase2.log:14`; `v2-capture-3/p2-permission-reply-request.json:1`). Capture 3b: HTTP 204 for `once` (`v2-capture-3b/driver.log:4`, `:7`, `:11`). | 2, 3, 3b |
| `/api/session/{id}/form/{formID}/reply` (`:576`) | POST | `{"answer":{"q0":"A"}}` (`v2-capture/form-1-reply-request.json:1`) | empty body (`v2-capture/form-1-reply-response.json`, 0 bytes). Capture 3: `{"answer":{"ok":true}}` (`v2-capture-3/p2-form-reply-request.json:1`), HTTP 204 (`v2-capture-3/driver-phase2.log:15`) | 1, 3 |
| `/api/event` (`service-probe-ecs5ftka.js:1039`) | GET (SSE) | none; capture 3 reconnects also sent a `Last-Event-ID` header (§4.11) | `v2-capture/events.sse`; `v2-capture-2/events.sse`; `v2-capture-3/events.sse` and its four segment files; `v2-capture-3b/events.sse` | 1, 2, 3, 3b |
| `/api/experimental/session/{id}/log` (`:523`) | GET | `follow=true`, `after=N` (per capture 1 file names) | `v2-capture/session-log*.sse`; capture 3: `v2-capture-3/p3-session-log*.sse` (`after=0`, `after=131`) | 1, 3 |

Note on the POST `/permission` row: the server creates asks itself during a turn (captures 2 and 3b). Capture 3 also created one through that route; its `permission.asked` frame has no `source` key (§4.7).

### 5a. Message list item shapes (`v2-capture/messages-page-1.json:1`, `v2-capture-2/parent-messages-page-1.json:1`, `v2-capture-2/child-1-messages-page-1.json:1`)

- **User item:** `{"id","time":{"created"},"text","type":"user"}`. The text is a top-level `text` field, not `payload.text` as in the event stream (`v2-capture/events.sse:27`). The child's user item carries the server-prepended subagent line (§4.9).
- **Assistant item:** `{"id","time":{"created","streamed","completed"},"type":"assistant","agent","model":{"id","providerID"},"content":[…],"finish","rawFinish","cost","tokens"}`. `content` items are:
  - `reasoning`: `{"type","text","state","time"}`
  - `tool`: `{"type","id","name","executed","state":{"status","input","content","metadata"},"time"}`. A tool that was rejected has `state.status: "error"` with `state.error` and no `content` (§4.4). `time.ran` is present on both the rejected and the approved calls.
  - `text`: `{"type","text"}`
- **Idle item:** `{"id","time":{"created"},"type":"idle","outcome":"succeeded"}`.
- `time.streamed` and `time.completed` match the `created` of `session.step.streamed` (`v2-capture/events.sse:55`, 1791891443611) and `session.step.ended` (`:63`, 1791891444056).
- Capture 2 parent `finish` values match the step frames: `tool-calls`, `tool-calls`, `stop` (§4.3).
- Capture 3 and 3b add item types beyond `user`, `assistant` and `idle`:
  - `shell` (a user shell), copied from `v2-capture-3/p2-resync-messages.json:1`: `{"id":"msg_13579b8e4001xF9kns5thFbgHD","metadata":{"background":true},"time":{"created":1791898532068,"completed":1791898532091},"type":"shell","shellID":"sh_13579b8d6001kqAeaynrDvHiES","command":"cat ./does-not-exist.txt","status":"exited","exit":1,"output":{"output":"cat: ./does-not-exist.txt: No such file or directory\n","cursor":53,"size":53,"truncated":false}}`. A shell that is still running has `status: "running"` and no `exit`.
  - `model-switched` (`v2-capture-3/parent-messages-all.json:1`): `{"id":"msg_13574fa650012i4VUJAC832Psd","time":{"created":1791898221157},"type":"model-switched","model":{"id":"glm-5.3-flash","providerID":"sohoai"}}`.
  - `compaction`, failed (`v2-capture-3/p2-messages-final.json:1`): `status: "failed"`, `reason: "manual"`, `error`. Completed (`v2-capture-3b/obs4-messages-after-response.json:1`): `status: "completed"`, `reason`, `model`, `summary`, `recent`, `cost`, `tokens`.
- Capture 3 and 3b failing assistant items: `content: []`, `finish: "error"`, `error` set, and `cost` and `tokens` `null` in capture 3 (`v2-capture-3/p2-messages-final.json:1`). The aborted assistant item in capture 3b has `finish: "error"`, `rawFinish: "tool_calls"`, `error.type: "aborted"`, and `cost` 0 with tokens (`v2-capture-3b/obs2b-messages-after.json:1`).
- Idle outcomes now include `failed` (with `error`) and `interrupted`, as well as `succeeded` (`v2-capture-3/paging-limit3-default.json:1`; `v2-capture-3/p2-messages-final.json:1`).
- A command's expanded template is a plain `user` item (`v2-capture-3/parent-messages-all.json:1`, id `msg_13573a021001R4qY74CKCFT7eD`). Synthetic inbox items from user shells are not in the message list; they are in `/inbox` (§4.5).

## 6. Gaps — not observed in captures 1 to 3b

- A tool error other than an abort or a permission rejection. A non-zero exit completes the tool (§4.4), and the only tool failures observed were a permission rejection (capture 2) and an abort (capture 3b).
- `session.idle` (end of turn is `session.execution.succeeded` in every capture).
- `session.tool.input.delta` (tool input arrived as one `input.ended` text in every capture).
- Form cancellation (`form.cancelled`).
- Revert and skill activation events, and the `session.synthetic` event name (the inbox item type `synthetic` is observed, §4.5).
- Non-zero cost (every `cost` in captures 1 to 3b is 0; the reason is not recorded).
- Reconnection under load. Resume without load was tested in capture 3 (§4.11).
- Session log with event bodies (captures 1 and 3 returned only `log.synced`; capture 2 did not call it).
- Permission replies other than `once` and `reject`, and the saved-rule routes (`/api/permission/saved`).
- Whether the parent's permission list includes child-session asks (§4.7).
- Whether an active child session appears in `/api/session/active` while running (§4.8). Capture 3b sampled only after the turn.
- Subagent calls with agents other than `general`, multiple concurrent subagents, and a subagent whose tool fails or is rejected. Capture 3b had one `general` subagent that made no tool call.
- Whether `order` combined with `cursor` still returns `InvalidCursorError` (capture 2 result; not repeated in capture 3).
- HTTP status codes and query strings for create and prompt calls in capture 1.
- Whether `ordinal` counts per kind or per message (`ordinal` 0 for reasoning and text in one message again in capture 3b).
- Meaning of `executed` (`false` on every call, including completed runs), `state.reasoningField`, the effect of `save` on a permission ask (patterns observed, saving not exercised), and the instruction-set hash values in `session.instructions.updated`.
- Whether a synthetic user-shell item is delivered by the next execution, and when. No execution followed the synthetic items in capture 3 (§4.5).
- Whether a stream client detects a durable seq gap after reconnect. Capture 3 had no durable frame after the gap reconnect (§4.11).
- Model select to a different model. Capture 3 selected the model already in use (§4.3).
- Session commands other than `review` with `uncommitted`, and commands with other arguments (§4.12).
- Whether a user shell marks the session busy in `/api/session/active`. One sample, taken during a running user shell, showed nothing (§4.5). Repeat before relying on it.
- Automatic compaction. Only `reason: "manual"` was observed (§4.12).
- Retry behaviour for error classes other than `provider.transport`, and how a retry loop ends other than by interrupt or the attempt limit (§4.3).
- A child session whose tool raises a permission ask. Capture 3b's child made no tool call.

Input to the native-v2 octmux stage — observations, not a design.
