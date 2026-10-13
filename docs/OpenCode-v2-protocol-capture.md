---
title: "OpenCode v2 protocol — live capture characterisation"
created_at: 2026-10-13--13-46
created_by: Claude Code (Claude Haiku 5.5)
updated_by: Claude Code (Claude Haiku 5.5)
updated_at: 2026-10-13--14-16
context: >
  Phase B step B9 of the Stage 14 orchestra run. Two live captures of the OpenCode 2.0.28 v2 server
  on the MBP desktop shared service. Capture 1: one session, one prompt (question tool, then shell `ls -la`,
  then reply "done"), outcome succeeded in about 4.5 s. Raw artefacts live in the session directory
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/20261013T104013Z-1717914/v2-capture/.
  Capture 2: a second session on the same server, created with a per-session `permissions` ruleset
  (effect `ask` for `shell` and `bash`) so that shell calls required approval, with a prompt that drove two
  parallel shell calls (one approved, one rejected) and one subagent call. Outcome succeeded in about 10.3 s.
  Raw artefacts live in the same session directory under v2-capture-2/. Neither capture is committed.
  This document describes what was observed and maps it onto octmux concepts. It is input for the
  native-v2 octmux stage (Stage C), not a design.
---

# OpenCode v2 protocol — live capture characterisation

Citations name their capture. `v2-capture/<file>:N` refers to the capture 1 artefact directory, and
`v2-capture-2/<file>:N` to the capture 2 artefact directory, both inside the session directory named in
the frontmatter. A bare `events.sse:N` is not used. Every payload example below is copied from those
artefacts; long strings are trimmed with "…". Paths for the MBP home directory and username are redacted
to `/Users/<user>` and `<user>`. Client-type and route citations (`node_modules/@opencode/client/...`) and
v1 citations (`src/events.ts`) refer to the files named in each case.

## 1. Capture setup

Two captures were made against the same server. They differ in prompt and in one server-visible setting.

- **Server:** OpenCode 2.0.28 on the MBP desktop shared service. The server requires Basic auth; no credential appears in any artefact. Neither capture changed server configuration.

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

## 2. Event stream envelope (`GET /api/event`)

### 2a. Frame format

- Frames are plain `data: <json>` lines. There are no SSE `event:` or `id:` fields (`v2-capture/events.sse` and `v2-capture-2/events.sse` contain none).
- Keep-alives are `: heartbeat` comment lines. Capture 1 has 21 (`v2-capture/events.sse:3,119,121,127–161`, odd lines). Capture 2 has 2 (`v2-capture-2/events.sse:3,215`).
- Totals. Capture 1: 62 `data:` frames, 21 heartbeat comments. Capture 2: 106 `data:` frames, 2 heartbeat comments.

| Field | Presence | Observed |
|---|---|---|
| `id` | every data frame | `evt_` plus a time-ordered suffix. Lexicographic order equals stream order in both captures (capture 2: 106 ids, sorted). |
| `created` | every frame except `server.connected` | epoch milliseconds |
| `type` | every frame | dotted name, for example `session.text.delta` |
| `location` | absent on `server.connected` (`v2-capture/events.sse:1`, `v2-capture-2/events.sse:1`), `session.execution.started` (`v2-capture/events.sse:29`, `v2-capture-2/events.sse:11,137`), `session.execution.succeeded` (`v2-capture/events.sse:117`, `v2-capture-2/events.sse:191,213`), `session.usage.updated` (`v2-capture/events.sse:65,93,115`; `v2-capture-2/events.sse:85,175,189,197,211`) | `{"directory": …}`. Session frames carry the project directory. Some global frames carry the MBP home directory (`v2-capture/events.sse:123,125`). |
| `metadata` | only `session.instructions.updated` | `{"instructions":{"initial":true}}` (`v2-capture/events.sse:31`; `v2-capture-2/events.sse:13,139`) |
| `data` | every frame | payload. Empty `{}` for most global `*.updated` frames. |
| `durable` | durable session events only | `{aggregateID, seq, version}`. `aggregateID` equals the sessionID. |

### 2b. Durable versus non-durable

- Durable frames carry `durable.seq`. Capture 1 seq runs 0 to 30 with no gaps (`v2-capture/events.sse:5` seq 0 through `v2-capture/events.sse:117` seq 30). Capture 2 parent seq runs 0 to 34 with no gaps (`v2-capture-2/events.sse:5`, `:213`). Capture 2 child seq runs 0 to 19 under its own `aggregateID` (`v2-capture-2/events.sse:131`, `:191`).
- Non-durable frames carry no `seq`.
- `durable.version` is 1 for most frames. It is 2 for `session.instructions.updated` (`v2-capture/events.sse:31`; `v2-capture-2/events.sse:13,139`), for `session.tool.success` (`v2-capture/events.sse:61,89`; `v2-capture-2/events.sse:77,171,193`), and for `session.tool.failed` (`v2-capture-2/events.sse:81`). Do not assume a fixed value.
- Durable in capture 1: `session.created`, `session.inbox.enqueued`, `session.execution.started`, `session.instructions.updated`, `session.inbox.delivered`, `session.step.started`, `session.reasoning.started`, `session.reasoning.ended`, `session.tool.input.started`, `session.tool.input.ended`, `session.tool.called`, `session.step.streamed`, `session.tool.success`, `session.step.ended`, `session.text.started`, `session.text.ended`, `session.execution.succeeded`.
- Durable in capture 2: the same set, plus `session.tool.failed`. `session.tool.progress`, `permission.asked`, `permission.replied`, `shell.created` and `shell.exited` are non-durable there, as in capture 1 for the shell and progress frames.
- Non-durable in capture 1: `server.connected`, all global `*.updated`, `session.reasoning.delta`, `session.text.delta`, `session.tool.progress`, `session.usage.updated`, `form.created`, `form.replied`, `shell.created`, `shell.exited`.
- Non-durable in capture 2: `server.connected`, `project.updated`, `session.reasoning.delta`, `session.text.delta`, `session.tool.progress`, `session.usage.updated`, `permission.asked`, `permission.replied`, `shell.created`, `shell.exited`.

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

## 3. Event catalogue (observed)

"Capture" names the capture(s) in which the type appeared. First line columns give the first occurrence
in each capture's `events.sse`. Count columns are occurrences in that capture. Rows follow capture 1's
first-occurrence order; the three types seen only in capture 2 are at the end.

| Type | Capture | First line c1 | First line c2 | Count c1 | Count c2 | Durable | sessionID location | octmux concept (v1 analogue in `src/events.ts`) |
|---|---|---|---|---|---|---|---|---|
| `server.connected` | 1, 2 | 1 | 1 | 1 | 1 | no | none | connection banner |
| `session.created` | 1, 2 | 5 | 5 | 1 | 2 | yes (seq 0) | `data.sessionID` | session created (`session.created`, line 639). Capture 2 child carries `parentID` (§4.9). |
| `project.updated` | 1, 2 | 7 | 7 | 1 | 1 | no | none | global, ignored |
| `integration.updated` | 1 | 9 | — | 1 | 0 | no | none | global, ignored |
| `provider.updated` | 1 | 11 | — | 3 | 0 | no | none | global, ignored |
| `model.updated` | 1 | 13 | — | 3 | 0 | no | none | global, ignored |
| `agent.updated` | 1 | 15 | — | 1 | 0 | no | none | global, ignored |
| `command.updated` | 1 | 17 | — | 1 | 0 | no | none | global, ignored |
| `skill.updated` | 1 | 19 | — | 1 | 0 | no | none | global, ignored |
| `websearch.updated` | 1 | 21 | — | 1 | 0 | no | none | global, ignored |
| `reference.updated` | 1 | 23 | — | 1 | 0 | no | none | global, ignored |
| `plugin.updated` | 1 | 25 | — | 1 | 0 | no | none | global, ignored |
| `session.inbox.enqueued` | 1, 2 | 27 | 9 | 1 | 2 | yes (seq 1) | `data.sessionID` | user message queued |
| `session.execution.started` | 1, 2 | 29 | 11 | 1 | 2 | yes (seq 2) | `data.sessionID` | busy begins (no v1 analogue; see §4.8) |
| `session.instructions.updated` | 1, 2 | 31 | 13 | 1 | 2 | yes (v2) | `data.sessionID` | instruction set hashes, not interpreted |
| `session.inbox.delivered` | 1, 2 | 33 | 15 | 1 | 2 | yes (seq 4) | `data.sessionID` | queued user message delivered |
| `session.step.started` | 1, 2 | 35 | 17 | 3 | 5 | yes | `data.sessionID` | one per assistant message (§4.3) |
| `session.reasoning.started` | 1, 2 | 37 | 19 | 3 | 3 | yes | `data.sessionID` | reasoning part begins (§4.2) |
| `session.reasoning.delta` | 1, 2 | 39 | 21 | 7 | 24 | no | `data.sessionID` | reasoning chunk (§4.2) |
| `session.reasoning.ended` | 1, 2 | 49 | 53 | 3 | 3 | yes | `data.sessionID` | reasoning part ends, full text (§4.2) |
| `session.tool.input.started` | 1, 2 | 47 | 49 | 2 | 4 | yes | `data.sessionID` | tool call begins, carries `name` (§4.4) |
| `session.tool.input.ended` | 1, 2 | 51 | 55 | 2 | 4 | yes | `data.sessionID` | raw input JSON as text (§4.4) |
| `session.tool.called` | 1, 2 | 53 | 57 | 2 | 4 | yes | `data.sessionID` | parsed input, ready to run (§4.4) |
| `session.step.streamed` | 1, 2 | 55 | 63 | 3 | 5 | yes | `data.sessionID` | step output streaming marker, no payload (§4.3) |
| `form.created` | 1 | 57 | — | 1 | 0 | no | `data.form.sessionID` | question form (v1 `question.asked`, line 859) (§4.6) |
| `form.replied` | 1 | 59 | — | 1 | 0 | no | `data.sessionID` | question answered (v1 `question.replied`, line 880) (§4.6) |
| `session.tool.success` | 1, 2 | 61 | 77 | 2 | 3 | yes (v2) | `data.sessionID` | tool completed (§4.4) |
| `session.step.ended` | 1, 2 | 63 | 83 | 3 | 5 | yes | `data.sessionID` | step finished, finish reason and tokens (§4.3) |
| `session.usage.updated` | 1, 2 | 65 | 85 | 3 | 5 | no | `data.sessionID` | running cost and token totals, per session (§4.3) |
| `shell.created` | 1, 2 | 83 | 71 | 1 | 2 | no | `data.info.metadata.sessionID` | shell process started (§4.5) |
| `session.tool.progress` | 1, 2 | 85 | 73 | 1 | 3 | no | `data.sessionID` | tool metadata, shell id (§4.5); child session id for subagent (§4.9) |
| `shell.exited` | 1, 2 | 87 | 75 | 1 | 2 | no | none | shell process exited (§4.5) |
| `session.text.started` | 1, 2 | 103 | 107 | 1 | 3 | yes | `data.sessionID` | text part begins (§4.1) |
| `session.text.delta` | 1, 2 | 107 | 109 | 1 | 7 | no | `data.sessionID` | text chunk (v1 `message.part.delta`) (§4.1) |
| `session.text.ended` | 1, 2 | 109 | 127 | 1 | 3 | yes | `data.sessionID` | text part ends, full text (§4.1) |
| `session.execution.succeeded` | 1, 2 | 117 | 191 | 1 | 2 | yes | `data.sessionID` | turn finished, idle equivalent (§4.8). Capture 2 has one per session (child at `:191`, parent at `:213`). |
| `permission.asked` | 2 | — | 65 | 0 | 3 | no | `data.sessionID` | permission request (§4.7). v1 `permission.asked` at `src/events.ts:840`. |
| `permission.replied` | 2 | — | 69 | 0 | 3 | no | `data.sessionID` | permission answer (§4.7) |
| `session.tool.failed` | 2 | — | 81 | 0 | 1 | yes (v2) | `data.sessionID` | tool failure, here a permission rejection (§4.4) |

Observed types with no row above: none.

Capture 2 had no `form.*` frame and no `*.updated` frame other than `project.updated`. Counts of 0 in the
c2 column mean the type did not occur in capture 2.

### 3b. Known from client types, not observed in either capture

These names come from the typed union `V2Event` (`node_modules/@opencode/client/dist/promise/generated/types.d.ts:3418`). None appeared in either capture. Their shapes are client-type declarations only.

| Type | Declared at (`types.d.ts`) | Relevance |
|---|---|---|
| `session.idle` | 2457 | typed end-of-turn event. Data: `sessionID`. Not observed; see §4.8. |
| `session.status` | 2444 | status change event. Not observed. |
| `session.forked` | 1388–1403 | fork event, data includes `parentID`. Not observed. |
| `form.cancelled` | 2421 | form dismissed. Data: `id`, `sessionID`. Not observed. |
| `session.shell.started` / `session.shell.ended` | 1610 / 1628 | durable shell events, distinct from the observed `shell.created` / `shell.exited`. Not observed. |
| `shell.deleted` | 2409 | shell removed. Not observed. |
| `session.execution.failed` / `session.execution.interrupted` | 1511 / 1529 | turn failure or interrupt. Not observed. |
| `session.step.failed` | 1717 | step failure. Not observed. |
| `session.tool.input.delta` | 2151 | streamed tool-input chunks. Not observed; tool input arrived only as `input.started` then `input.ended`. |
| `session.retry.scheduled`, `session.compaction.*`, `session.revert.*`, `session.skill.activated`, `session.synthetic` | 1888, 1909, 1568, 1590 (others in union) | not observed. |

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
- `ordinal` 0 is used for both reasoning and text in the same message in both captures (`v2-capture/events.sse:97` reasoning, `:103` text; `v2-capture-2/events.sse:89` reasoning, `:107` text, same message `msg_1352d147a001pKAHKU0tp6Iol1`). Whether ordinal counts per kind or per message cannot be determined from either capture.
- `session.text.ended` carries the full text.
- Capture 2 shows the same reasoning/text overlap: `session.text.started` (`v2-capture-2/events.sse:107`) precedes `session.reasoning.ended` (`:121`) for the same message.
- v1 equivalent: `message.part.delta` (`src/events.ts:381`, keyed by `partID` and `field`) and `message.part.updated` with `part.type === "text"` (`src/events.ts:410`, `:436`). v2 has no part id.

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

- `state.reasoningField` is `reasoning_content` in every reasoning start in both captures (capture 1 `:37,69,97`; capture 2 `:19,:89,:145`). Its meaning is not documented in either capture.
- v1 equivalent: reasoning parts through `message.part.updated` with `part.type === "reasoning"` (`src/events.ts:481`).

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
- `cost` is `0` on every step, every usage frame and every session-final file in both captures. Cost was not populated by this provider in either run.
- v1 equivalent: none in `src/events.ts`. A grep for `tokens`, `cost` and `step-finish` returns no matches.

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
- `executed` is `false` on `called` and `success` in both captures, including the approved shell calls that ran (`v2-capture-2/events.sse:57`, `:77`, `:171`, `:193`). It is also `false` on the rejected call (`:81`). Its meaning is not documented and it does not distinguish a run from a rejection.
- The approved shell input may carry `workdir` (`v2-capture-2/events.sse:157`, `"input":{"command":"pwd","workdir":"/tmp/octmux-v2-capture-2"}`).
- v1 equivalent: `message.part.updated` with `part.type === "tool"` (`src/events.ts:492`).

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
- `shell.exited` carries no session key in either capture (`v2-capture/events.sse:87`; `v2-capture-2/events.sse:75`, `:169`). It must be correlated through the `sh_…` id.
- v1 equivalent: none for shell processes in `src/events.ts`. Tool output arrives in `message.part.updated` tool parts (`src/events.ts:492`).

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

- No `session.idle` frame was observed in either capture. The end of the turn is `session.execution.succeeded` (`v2-capture/events.sse:117`; `v2-capture-2/events.sse:191`, `:213`). In each capture `time.idle` in the session-final file equals that frame's `created` (capture 1: 1791891445708; capture 2 parent: 1791893515221; capture 2 child: 1791893514576, `v2-capture-2/child-1-session-final.json:1`).
- The parent's `session.execution.succeeded` arrives after the child's (`v2-capture-2/events.sse:191` before `:213`).
- The last message in each message list has `type: "idle"` with `outcome: "succeeded"` (`v2-capture/messages-page-1.json:1`; `v2-capture-2/parent-messages-page-1.json:1`; `v2-capture-2/child-1-messages-page-1.json:1`).
- `/api/session/active` was sampled running in capture 1 (`v2-capture/active-sample.json:1`) and in capture 2 (`v2-capture-2/active-sample.json:1`, which lists only the parent). The capture 2 sample has no timestamp, so whether a running child appears in that list is not established.
- After the parent's terminal event (`v2-capture-2/driver.log:8`), `/api/session/active` returned an empty object (`v2-capture-2/active-after.json:1`). The file has no timestamp, so this is the post-idle shape as the driver sampled it.
- v1 equivalents: `session.idle` (`src/events.ts:754`, `properties.sessionID`) and `session.status` (`:802`, `status.type`). The v2 `session.status` (`types.d.ts:2444`) was not observed.

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

### 4.10 Per-session filtering

- The capture subscribed to `/api/event` without query parameters in both captures. Frames carry no SSE `id:` field.
- Filter on the attribution table in §2c.
- Global frames (no sessionID) and session frames interleave on one connection.
- Capture 2 exercised cross-session filtering. Parent and child frames interleave on the same stream (`v2-capture-2/events.sse:131–191`), and the parent's `session.tool.progress` at `:133` sits inside the child's range.
- Child attribution facts (capture 2):
  - Every child frame carries only the child's `sessionID`. The one child-range frame that names the parent is the child's own `session.created` (`v2-capture-2/events.sse:131`, `parentID`). The one parent-side frame in that range that names the child is `session.tool.progress` (`:133`, `metadata.sessionID`).
  - To attribute a child to its parent, use `session.created.parentID`. To attribute a parent's subagent call to its child, use `session.tool.progress.metadata.sessionID` with `id` equal to the `subagent` call id (`call_nja9hdcz`). The final `session.tool.success` (`:193`) repeats the child id in `metadata.sessionID`.
  - A shell event for the child carries the child's id in `shell.created.info.metadata.sessionID` (`:165`).
- v1 equivalent: handlers compare `properties.sessionID` against the current session and return `null` otherwise (for example `question.replied`, `src/events.ts:880`).

### 4.11 Reconnection and replay

- **`/api/event`:** the stream emits no SSE `id:` fields, so there is no `Last-Event-ID` to resume from. Reconnect behaviour was not tested in either capture.
- **Session log** (`GET /api/experimental/session/{id}/log`, `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:523`):
  - The follow capture contains one line: `{"type":"log.synced","aggregateID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","seq":0}` (`v2-capture/session-log.sse:1`).
  - The replay response headers are HTTP 200 `text/event-stream` (`v2-capture/session-log-replay.headers:1`). The replays after 0 and after 25 each contained only `{"type":"log.synced",…,"seq":30}` (`v2-capture/session-log-replay.sse:1`, `v2-capture/session-log-replay-after0.sse:1`, `v2-capture/session-log-replay-after25.sse:1`).
  - `seq` 30 matches the final durable seq (`v2-capture/events.sse:117`).
  - The log in 2.0.28, as observed, carries no event bodies. It is not usable as an event source in capture 1. Capture 2 did not call the session log.
- **Message history** (`GET /api/session/{id}/message`, `…chunks/service-probe-ecs5ftka.js:611`):
  - Capture 1: the cursor is opaque base64 JSON. `v2-capture/messages-page-1.json` `cursor.next` decodes to `{"id":"msg_1350d97cc001DQWVSX9dDdoK0K","order":"asc","direction":"next"}`. Page 2 is empty (`v2-capture/messages-page-2.json:1`).
  - Capture 2: `cursor.next` on the parent's first page decodes to `{"id":"msg_1352d2bd50017nX2RZm380iedS","order":"asc","direction":"next"}` (`v2-capture-2/parent-messages-page-1.json:1`). Requesting page 2 with `order=asc` together with the cursor returned `{"_tag":"InvalidCursorError","message":"Cursor cannot be combined with order"}` for both the parent (`v2-capture-2/parent-messages-page-2.json:1`) and the child (`v2-capture-2/child-1-messages-page-2.json:1`). The driver did not log URLs, so the request is as the driver issued it. The `order` and `cursor` query names are per the client route (`service-probe-ecs5ftka.js:613–614`).
  - The working shape for paging with a cursor is not established by capture 2.

## 5. REST shapes observed

Route paths and methods come from `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js`. The driver of capture 2 logged HTTP statuses for create, prompt and permission replies (`v2-capture-2/driver.log`). Request query strings are not recorded in the artefacts, except where stated. Other status codes were not recorded.

| Endpoint | Method | Request | Response (artefact) | Capture |
|---|---|---|---|---|
| `/api/session` (`service-probe-ecs5ftka.js:252`) | POST | capture 1: body not recorded. Capture 2: `{"title", "location", "permissions"}` (`v2-capture-2/session-create-request.json:1–17`) | capture 1: `v2-capture/session-create.json:1`: `{"data":{"id", "projectID", "cost":0, "tokens", "time", "title", "subpath", "location"}}`. Capture 2: same plus `permissions` (`v2-capture-2/session-create.json:1`). HTTP 200 (`v2-capture-2/driver.log:1`). | 1, 2 |
| `/api/session` with `parentID` filter (`service-probe-ecs5ftka.js:220–232`) | GET | query `parentID` (driver URL not logged) | `v2-capture-2/children-list-0.json:1` (empty, before child), `v2-capture-2/children-list-1.json:1` (one child) | 2 |
| `/api/session/{id}/prompt` (`:346`) | POST | `{"text": "…"}` (`v2-capture/prompt-request.json:2`; `v2-capture-2/prompt-request.json:2`) | `v2-capture/prompt-response.json:1`: `{"data":{"id", "sessionID", "time", "type":"user", "payload":{"text"}, "delivery":"steer"}}`. HTTP 200 in capture 2 (`v2-capture-2/driver.log:2`). | 1, 2 |
| `/api/session/active` (`:285`) | GET | — | `v2-capture/active-sample.json:1` (running). Capture 2: `v2-capture-2/active-sample.json:1` (running, parent only), `v2-capture-2/active-after.json:1` (`{"data":{}}`). | 1, 2 |
| `/api/session/{id}` (`:292`) | GET | — | `v2-capture/session-final.json:1`; `v2-capture-2/parent-session-final.json:1`; `v2-capture-2/child-1-session-final.json:1` | 1, 2 |
| `/api/session/{id}/message` (`:611`) | GET | query `limit`, `order`, `cursor`, `type` (`service-probe-ecs5ftka.js:613–614`) | `v2-capture/messages-page-1.json:1`; page 2 `v2-capture/messages-page-2.json:1`. Capture 2: `v2-capture-2/parent-messages-page-1.json:1`, `v2-capture-2/child-1-messages-page-1.json:1`. `order` with `cursor` returned `InvalidCursorError` (`v2-capture-2/parent-messages-page-2.json:1`, `child-1-messages-page-2.json:1`). | 1, 2 |
| `/api/session/{id}/permission` (`service-probe-ecs5ftka.js:949`) | GET | — | `v2-capture-2/permission-1-parent-list.json:1`, `permission-2-parent-list.json:1`, `permission-3-child-list.json:1` | 2 |
| `/api/session/{id}/permission` (`:933`) | POST | route used by the server to raise asks; not called by the driver. Body fields `id, action, resources, save, metadata, source, agent` (client route). | not observed as a driver call | — |
| `/api/session/{id}/permission/{requestID}/reply` (`:963`) | POST | `{"decision": "once"}` (`v2-capture-2/permission-1-parent-reply-request.json:1`, `permission-3-child-reply-request.json:1`); `{"decision": "reject", "message": "…"}` (`v2-capture-2/permission-2-parent-reply-request.json:1`) | empty body, HTTP 204 (`v2-capture-2/driver.log:4,5,7`; `permission-*-reply-response.json` are 0 bytes) | 2 |
| `/api/session/{id}/form/{formID}/reply` (`:576`) | POST | `{"answer":{"q0":"A"}}` (`v2-capture/form-1-reply-request.json:1`) | empty body (`v2-capture/form-1-reply-response.json`, 0 bytes) | 1 |
| `/api/event` (`service-probe-ecs5ftka.js:1037`) | GET (SSE) | none | `v2-capture/events.sse`; `v2-capture-2/events.sse` | 1, 2 |
| `/api/experimental/session/{id}/log` (`:523`) | GET | `follow=true`, `after=N` (per capture 1 file names) | `v2-capture/session-log*.sse` | 1 |

Note on the POST `/permission` row: the server creates asks itself during the turn. The driver did not call that route, so no artefact shows a client-side create.

### 5a. Message list item shapes (`v2-capture/messages-page-1.json:1`, `v2-capture-2/parent-messages-page-1.json:1`, `v2-capture-2/child-1-messages-page-1.json:1`)

- **User item:** `{"id","time":{"created"},"text","type":"user"}`. The text is a top-level `text` field, not `payload.text` as in the event stream (`v2-capture/events.sse:27`). The child's user item carries the server-prepended subagent line (§4.9).
- **Assistant item:** `{"id","time":{"created","streamed","completed"},"type":"assistant","agent","model":{"id","providerID"},"content":[…],"finish","rawFinish","cost","tokens"}`. `content` items are:
  - `reasoning`: `{"type","text","state","time"}`
  - `tool`: `{"type","id","name","executed","state":{"status","input","content","metadata"},"time"}`. A tool that was rejected has `state.status: "error"` with `state.error` and no `content` (§4.4). `time.ran` is present on both the rejected and the approved calls.
  - `text`: `{"type","text"}`
- **Idle item:** `{"id","time":{"created"},"type":"idle","outcome":"succeeded"}`.
- `time.streamed` and `time.completed` match the `created` of `session.step.streamed` (`v2-capture/events.sse:55`, 1791891443611) and `session.step.ended` (`:63`, 1791891444056).
- Capture 2 parent `finish` values match the step frames: `tool-calls`, `tool-calls`, `stop` (§4.3).

## 6. Gaps — not observed

- A tool that runs and then fails (non-zero exit, execution error). The only failure observed was a permission rejection, which happened before the tool ran.
- `session.execution.failed`, `session.execution.interrupted`, `session.step.failed`.
- `session.idle` (end of turn is `session.execution.succeeded` in both captures).
- `session.tool.input.delta` (tool input arrived as one `input.ended` text).
- Form cancellation (`form.cancelled`).
- Durable shell events (`session.shell.started`, `session.shell.ended`) and `shell.deleted`.
- Retry, compaction, revert, skill activation, synthetic messages.
- Non-zero cost (every `cost` in both captures is 0).
- Reconnection behaviour on `/api/event` (no resume test in either capture) and under load.
- Session log with event bodies (capture 1's log carried only `log.synced`; capture 2 did not call it).
- Permission replies other than `once` and `reject`, and the saved-rule routes (`/api/permission/saved`).
- Whether the parent's permission list includes child-session asks (§4.7).
- Whether an active child session appears in `/api/session/active` while running (§4.8).
- Subagent calls with agents other than `general`, multiple concurrent subagents, and a subagent whose tool fails or is rejected.
- Valid cursor-based paging for `/api/session/{id}/message` (§4.11).
- HTTP status codes and query strings for create and prompt calls in capture 1, and the form-reply status.
- Whether `ordinal` counts per kind or per message.
- Meaning of `executed`, `state.reasoningField`, `save` on a permission ask, and the instruction-set hash values in `session.instructions.updated`.

Input to the native-v2 octmux stage — observations, not a design.
