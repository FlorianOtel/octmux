---
title: "OpenCode v2 protocol — live capture characterisation"
created_at: 2026-10-13--13-46
created_by: Claude Code (Claude Haiku 5.5)
context: >
  Phase B step B9 of the Stage 14 orchestra run. One live capture of the OpenCode 2.0.28 v2 server
  on the MBP desktop shared service: one session, one prompt (question tool, then shell `ls -la`,
  then reply "done"), outcome succeeded in about 4.5 s. Raw artefacts live in the session directory
  /mnt/nfs/Florian/Gin-AI/projects/octmux/.claude/orchestra/sessions/20261013T104013Z-1717914/v2-capture/
  and are not committed. This document describes what was observed and maps it onto octmux concepts.
  It is input for the native-v2 octmux stage (Stage C), not a design.
---

# OpenCode v2 protocol — live capture characterisation

Citations of the form `events.sse:N` refer to `v2-capture/events.sse` line N in the session directory
named in the frontmatter. Other artefacts are cited by file name. Every payload example below is copied
from those artefacts; long strings are trimmed with "…". Paths for the MBP home directory and username are
redacted to `/Users/<user>` and `<user>`.

## 1. Capture setup

- **Server:** OpenCode 2.0.28 on the MBP desktop shared service. The server requires Basic auth; no credential appears in any artefact.
- **Session:** `ses_ecaf279a0fferfPEx4LQ1FsOrZ`, title `octmux-v2-capture`, project directory `/tmp/octmux-v2-capture` on the MBP (`session-create.json:1`).
- **Model:** not requested. The server chose agent `build` and model `sohoai/glm-5.3-flash` (`events.sse:35`).
- **Prompt** (`prompt-request.json:2`): "Step 1: use your question tool to ask me to choose 'A' or 'B'. Step 2: after I answer, run the shell command `ls -la` in the current directory using your bash tool. Step 3: reply with the single word done."
- **Result:** three assistant steps. Tools used were `question` (rendered as a form) and `shell`. Final text was `done`. Outcome `succeeded` (`session-final.json:1`). Turn ran from `created` 1791891441254 to `execution.succeeded` 1791891445708 epoch ms, that is 2026-10-13T11:37:21Z to 11:37:25Z (`events.sse:5`, `events.sse:117`).
- **Artefacts** (`v2-capture/`): `events.sse` (live `/api/event` stream), `session-create.json`, `prompt-request.json`, `prompt-response.json`, `form-1.json`, `form-1-reply-request.json`, `form-1-reply-response.json`, `active-sample.json`, `session-final.json`, `messages-page-1.json`, `messages-page-2.json`, `session-log.sse`, `session-log-replay.headers`, `session-log-replay.sse`, `session-log-replay-after0.sse`, `session-log-replay-after25.sse`.

## 2. Event stream envelope (`GET /api/event`)

### 2a. Frame format

- Frames are plain `data: <json>` lines. There are no SSE `event:` or `id:` fields (`events.sse` contains none).
- Keep-alives are `: heartbeat` comment lines: 21 in this capture (`events.sse:3,119,121,127–161`, odd lines).
- Totals in this capture: 62 `data:` frames, 21 heartbeat comments.

| Field | Presence | Observed |
|---|---|---|
| `id` | every data frame | `evt_` plus a time-ordered suffix. Lexicographic order equals stream order in this capture. |
| `created` | every frame except `server.connected` | epoch milliseconds |
| `type` | every frame | dotted name, for example `session.text.delta` |
| `location` | absent on `server.connected` (`events.sse:1`), `session.execution.started` (`:29`), `session.usage.updated` (`:65,93,115`) | `{"directory": …}`. Session frames carry the project directory. Some global frames carry the MBP home directory (`:123,125`). |
| `metadata` | only `session.instructions.updated` (`:31`) | `{"instructions":{"initial":true}}` |
| `data` | every frame | payload. Empty `{}` for most global `*.updated` frames. |
| `durable` | durable session events only | `{aggregateID, seq, version}`. `aggregateID` equals the sessionID. |

### 2b. Durable versus non-durable

- Durable frames carry `durable.seq`. In this capture the seq values run 0 to 30 with no gaps (`events.sse:5` seq 0 through `events.sse:117` seq 30).
- Non-durable frames carry no `seq`.
- `durable.version` is 1 for most frames. It is 2 for `session.instructions.updated` (`events.sse:31`) and `session.tool.success` (`events.sse:61,89`). Do not assume a fixed value.
- Durable in this capture: `session.created`, `session.inbox.enqueued`, `session.execution.started`, `session.instructions.updated`, `session.inbox.delivered`, `session.step.started`, `session.reasoning.started`, `session.reasoning.ended`, `session.tool.input.started`, `session.tool.input.ended`, `session.tool.called`, `session.step.streamed`, `session.tool.success`, `session.step.ended`, `session.text.started`, `session.text.ended`, `session.execution.succeeded`.
- Non-durable in this capture: `server.connected`, all global `*.updated`, `session.reasoning.delta`, `session.text.delta`, `session.tool.progress`, `session.usage.updated`, `form.created`, `form.replied`, `shell.created`, `shell.exited`.

### 2c. Session attribution (where the sessionID sits)

The stream is global and unfiltered. Frames for other locations arrive on the same connection (`events.sse:123,125` for the home directory, `:163,165` for the project directory). Attribution differs by event:

| Frame | Session key | Example line |
|---|---|---|
| most session events | `data.sessionID` | `:27`, `:35`, `:39` |
| `form.created` | `data.form.sessionID` (the tool link is in `data.form.metadata.tool`) | `:57` |
| `shell.created` | `data.info.metadata.sessionID` | `:83` |
| `shell.exited` | none. Correlate by `data.id` (`sh_…`) to `shell.created` `data.info.id`. | `:87` |
| `session.execution.started`, `session.usage.updated` | `data.sessionID`, but no `location` | `:29`, `:65` |
| global `*.updated`, `server.connected` | none | `:1`, `:7–25`, `:123`, `:125` |

## 3. Event catalogue (observed)

First line is the first occurrence in `events.sse`. Count is occurrences in this capture.

| Type | First line | Count | Durable | sessionID location | octmux concept (v1 analogue in `src/events.ts`) |
|---|---|---|---|---|---|
| `server.connected` | 1 | 1 | no | none | connection banner |
| `session.created` | 5 | 1 | yes (seq 0) | `data.sessionID` | session created (`session.created`, line 639) |
| `project.updated` | 7 | 1 | no | none | global, ignored |
| `integration.updated` | 9 | 1 | no | none | global, ignored |
| `provider.updated` | 11 | 3 | no | none | global, ignored |
| `model.updated` | 13 | 3 | no | none | global, ignored |
| `agent.updated` | 15 | 1 | no | none | global, ignored |
| `command.updated` | 17 | 1 | no | none | global, ignored |
| `skill.updated` | 19 | 1 | no | none | global, ignored |
| `websearch.updated` | 21 | 1 | no | none | global, ignored |
| `reference.updated` | 23 | 1 | no | none | global, ignored |
| `plugin.updated` | 25 | 1 | no | none | global, ignored |
| `session.inbox.enqueued` | 27 | 1 | yes (seq 1) | `data.sessionID` | user message queued |
| `session.execution.started` | 29 | 1 | yes (seq 2) | `data.sessionID` | busy begins (no v1 analogue; see §4.8) |
| `session.instructions.updated` | 31 | 1 | yes (v2) | `data.sessionID` | instruction set hashes, not interpreted |
| `session.inbox.delivered` | 33 | 1 | yes (seq 4) | `data.sessionID` | queued user message delivered |
| `session.step.started` | 35 | 3 | yes | `data.sessionID` | one per assistant message (§4.3) |
| `session.reasoning.started` | 37 | 3 | yes | `data.sessionID` | reasoning part begins (§4.2) |
| `session.reasoning.delta` | 39 | 7 | no | `data.sessionID` | reasoning chunk (§4.2) |
| `session.reasoning.ended` | 49 | 3 | yes | `data.sessionID` | reasoning part ends, full text (§4.2) |
| `session.tool.input.started` | 47 | 2 | yes | `data.sessionID` | tool call begins, carries `name` (§4.4) |
| `session.tool.input.ended` | 51 | 2 | yes | `data.sessionID` | raw input JSON as text (§4.4) |
| `session.tool.called` | 53 | 2 | yes | `data.sessionID` | parsed input, ready to run (§4.4) |
| `session.step.streamed` | 55 | 3 | yes | `data.sessionID` | step output streaming marker, no payload (§4.3) |
| `form.created` | 57 | 1 | no | `data.form.sessionID` | question form (v1 `question.asked`, line 859) (§4.6) |
| `form.replied` | 59 | 1 | no | `data.sessionID` | question answered (v1 `question.replied`, line 880) (§4.6) |
| `session.tool.success` | 61 | 2 | yes (v2) | `data.sessionID` | tool completed (§4.4) |
| `session.step.ended` | 63 | 3 | yes | `data.sessionID` | step finished, finish reason and tokens (§4.3) |
| `session.usage.updated` | 65 | 3 | no | `data.sessionID` | running cost and token totals (§4.3) |
| `shell.created` | 83 | 1 | no | `data.info.metadata.sessionID` | shell process started (§4.5) |
| `session.tool.progress` | 85 | 1 | no | `data.sessionID` | tool metadata, here the shell id (§4.5) |
| `shell.exited` | 87 | 1 | no | none | shell process exited (§4.5) |
| `session.text.started` | 103 | 1 | yes | `data.sessionID` | text part begins (§4.1) |
| `session.text.delta` | 107 | 1 | no | `data.sessionID` | text chunk (v1 `message.part.delta`) (§4.1) |
| `session.text.ended` | 109 | 1 | yes | `data.sessionID` | text part ends, full text (§4.1) |
| `session.execution.succeeded` | 117 | 1 | yes (seq 30) | `data.sessionID` | turn finished, idle equivalent (§4.8) |

Observed types with no row above: none.

### 3b. Known from client types, NOT observed

These names come from the typed union `V2Event` (`node_modules/@opencode/client/dist/promise/generated/types.d.ts:3418`). None appeared in this capture. Their shapes are client-type declarations only.

| Type | Declared at (`types.d.ts`) | Relevance |
|---|---|---|
| `session.tool.failed` | 2605 | tool failure path. Data: `sessionID`, `assistantMessageID`, `id`, `error`, optional `content`, `metadata`, `executed`. |
| `permission.asked` | 2219 | permission request. Data: `id`, `sessionID`, `action`, `resources[]`, optional `save`, `metadata`, `source`, `message`. |
| `permission.replied` | 2240 | permission answer. Data: `sessionID`, `requestID`, `reply`. |
| `session.idle` | 2457 | typed end-of-turn event. Data: `sessionID`. Not observed; see §4.8. |
| `session.status` | 2444 | status change event. Not observed. |
| `session.created` with `parentID` | 2896–2908 | subagent child session (`data.parentID?`). Not observed; see §4.9. |
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

Observed sequence: `session.text.started` (`events.sse:103`), `session.text.delta` (`:107`), `session.text.ended` (`:109`).

```json
// events.sse:103  session.text.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9499001MYaFsJiEIsV9HE","ordinal":0}
// events.sse:107  session.text.delta (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9499001MYaFsJiEIsV9HE","ordinal":0,"delta":"done"}
// events.sse:109  session.text.ended (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9499001MYaFsJiEIsV9HE","ordinal":0,"text":"done"}
```

- No part id. The key is `assistantMessageID` plus `ordinal`, and the kind comes from the event type.
- `ordinal` 0 is used for both reasoning and text in the same message (`events.sse:97` reasoning, `:103` text). Whether ordinal counts per kind or per message cannot be determined from this capture.
- `session.text.ended` carries the full text.
- v1 equivalent: `message.part.delta` (`src/events.ts:381`, keyed by `partID` and `field`) and `message.part.updated` with `part.type === "text"` (`src/events.ts:410`, `:436`). v2 has no part id.

### 4.2 Reasoning

Observed sequence: `session.reasoning.started` (`events.sse:37`), `session.reasoning.delta` (`:39,41,43,45`), `session.reasoning.ended` (`:49`).

```json
// events.sse:37  session.reasoning.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","ordinal":0,"state":{"reasoningField":"reasoning_content"}}
// events.sse:39  session.reasoning.delta (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","ordinal":0,"delta":"The user wants a simple three-step sequence: first, ask them to choose between '"}
// events.sse:49  session.reasoning.ended (data), trimmed
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","ordinal":0,"text":"The user wants a simple three-step sequence: first, ask them to choose between 'A' or 'B' using the question tool; …"}
```

- `state.reasoningField` is `reasoning_content` in every reasoning start (`:37,69,97`). Its meaning is not documented in the capture.
- Reasoning and text overlap. `session.text.started` (`:103`) arrives before `session.reasoning.ended` (`:105`) for the same message.
- v1 equivalent: reasoning parts through `message.part.updated` with `part.type === "reasoning"` (`src/events.ts:481`).

### 4.3 Steps, usage and cost

One assistant message per step. The three step ids are `msg_1350d8922001Upjb4nJACI32IY` (`events.sse:35`), `msg_1350d9162001a87C2ZSylZLPHd` (`:67`) and `msg_1350d9499001MYaFsJiEIsV9HE` (`:95`).

```json
// events.sse:35  session.step.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","agent":"build","model":{"id":"glm-5.3-flash","providerID":"sohoai"},"assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","started":1791891441958}
// events.sse:55  session.step.streamed (data), whole payload
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY"}
// events.sse:63  session.step.ended (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":8019,"output":70,"reasoning":88,"cache":{"read":0,"write":0}}}
// events.sse:65  session.usage.updated (data, no location, non-durable)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","cost":0,"tokens":{"input":8019,"output":70,"reasoning":88,"cache":{"read":0,"write":0}}}
```

- `session.step.ended` at `:113` has `finish: "stop"`. The earlier two steps have `finish: "tool-calls"` (`:63`, `:91`).
- `session.usage.updated` carries running totals. The three `usage.updated` frames at `:65`, `:93`, `:115` have input 8019, 8296, 8563. These equal the per-step sums, and the final values equal `session-final.json:1` (`tokens.input` 8563, output 99, reasoning 148, cache read 16064).
- `cost` is `0` on every step, every usage frame and `session-final.json:1`. Cost was not populated by this provider in this run.
- v1 equivalent: none in `src/events.ts`. A grep for `tokens`, `cost` and `step-finish` returns no matches.

### 4.4 Tool lifecycle

Tool events are keyed by `data.id`, which is a `call_…` id. Two complete sequences were captured.

Observed `question` sequence:

1. `session.tool.input.started`, `name: "question"` (`events.sse:47`)
2. `session.tool.input.ended`, raw JSON text (`:51`)
3. `session.tool.called`, parsed input, `executed: false` (`:53`)
4. form lifecycle, see §4.6 (`:57`, `:59`)
5. `session.tool.success` (`:61`)

Observed `shell` sequence:

1. `session.tool.input.started`, `name: "shell"` (`events.sse:73`)
2. `session.tool.input.ended` (`:77`)
3. `session.tool.called` (`:79`)
4. shell side channel, see §4.5 (`:83`, `:85`, `:87`)
5. `session.tool.success` (`:89`)

```json
// events.sse:47  session.tool.input.started (data)
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","id":"call_ru7aormg","name":"question"}
// events.sse:51  session.tool.input.ended (data), text is raw JSON as a string
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","id":"call_ru7aormg","text":"{\"questions\":[{\"header\":\"Your choice\",\"multiple\":false,\"options\":[…],\"question\":\"Please choose 'A' or 'B'.\"}]}"}
// events.sse:53  session.tool.called (data), parsed input
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","id":"call_ru7aormg","input":{"questions":[{"header":"Your choice","multiple":false,"options":[…],"question":"Please choose 'A' or 'B'."}]},"executed":false}
// events.sse:61  session.tool.success (data, durable version 2), trimmed
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d8922001Upjb4nJACI32IY","id":"call_ru7aormg","content":[{"type":"text","text":"User has answered your questions: \"Please choose 'A' or 'B'.\"=\"A\". You can now continue with the user's answers in mind."}],"metadata":{"answers":[["A"]],"truncated":false},"executed":false}
```

- The tool is named `shell`, not `bash`, although the prompt asked for "your bash tool" (`prompt-request.json:2`, `events.sse:73`).
- `session.tool.called` has no `name`. The name appears only on `session.tool.input.started`.
- `executed` is `false` on both `called` and `success` in this run. Its meaning is not documented in the capture.
- v1 equivalent: `message.part.updated` with `part.type === "tool"` (`src/events.ts:492`).

### 4.5 Shell side channel

```json
// events.sse:83  shell.created (data), trimmed; file path redacted
{"info":{"id":"sh_1350d9489001NNw7i8Coz7irWf","status":"running","command":"ls -la","cwd":"/tmp/octmux-v2-capture","shell":"/bin/bash","file":"/Users/<user>/.local/share/opencode/shell/…/sh_1350d9489001NNw7i8Coz7irWf.out","metadata":{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ"},"time":{"started":1791891444873}}}
// events.sse:85  session.tool.progress (data), links tool call to shell
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9162001a87C2ZSylZLPHd","id":"call_ylrxajbp","metadata":{"shellID":"sh_1350d9489001NNw7i8Coz7irWf"}}
// events.sse:87  shell.exited (data), no sessionID
{"id":"sh_1350d9489001NNw7i8Coz7irWf","exit":0,"status":"exited"}
// events.sse:89  session.tool.success (data), shell metadata, trimmed
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","assistantMessageID":"msg_1350d9162001a87C2ZSylZLPHd","id":"call_ylrxajbp","content":[{"type":"text","text":"total 24\n…one.txt\n…three.csv\n…two.txt\n"}],"metadata":{"status":"completed","truncated":false,"exit":0},"executed":false}
```

- Shell output is written to a file on the MBP (`shell.created` `file`). Octmux does not receive it through the stream; it appears in `tool.success` content.
- `shell.exited` carries no session key. It must be correlated through the `sh_…` id.
- v1 equivalent: none for shell processes in `src/events.ts`. Tool output arrives in `message.part.updated` tool parts (`src/events.ts:492`).

### 4.6 Forms (questions)

```json
// form-1.json:2–32 / events.sse:57  form.created (data.form), trimmed
{"form":{"id":"frm_1350d8f9e001n3E9p9dgUMz16U","sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","title":"Questions","metadata":{"kind":"question","tool":{"messageID":"msg_1350d8922001Upjb4nJACI32IY","id":"call_ru7aormg"}},"fields":[{"key":"q0","title":"Your choice","description":"Please choose 'A' or 'B'.","type":"string","options":[{"value":"A","label":"A","description":"Choose option A"},{"value":"B","label":"B","description":"Choose option B"}],"custom":true}]}}
```

```json
// form-1-reply-request.json:1   POST /api/session/{sessionID}/form/{formID}/reply
{"answer":{"q0":"A"}}
// events.sse:59  form.replied (data)
{"id":"frm_1350d8f9e001n3E9p9dgUMz16U","sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","answer":{"q0":"A"}}
```

- `form-1-reply-response.json` is 0 bytes. The response body is empty. The status code was not recorded.
- `form.created` and `form.replied` are non-durable and carry no `assistantMessageID`. The tool link is `data.form.metadata.tool` (`messageID`, `id = call_…`).
- `form.replied` carries the form id (`frm_…`). The `session.tool.success` that follows carries the tool call id (`call_…`) and `metadata.answers` (`:61`).
- Answer key is the field key (`q0`). The answer value is the option `value`.
- v1 equivalent: `question.asked` (`src/events.ts:859`), `question.replied` (`:880`), `question.rejected` (`:894`). The v2 typed `form.cancelled` (`types.d.ts:2421`) was not observed.

### 4.7 Permissions — NOT OBSERVED

No permission frame or permission REST call appeared in this run. The shell tool ran without a permission request.

Client-type shapes only, from `types.d.ts:2219` (`permission.asked`) and `types.d.ts:2240` (`permission.replied`). Client-type routes, from `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:931` (`POST /api/session/{id}/permission`) and `:963` (`POST /api/session/{id}/permission/{requestID}/reply`). The v1 handler is `permission.asked` (`src/events.ts:840`, properties `id`, `sessionID`, `permission`, `patterns`). The v2 type uses `action` and `resources`, which differ from v1 field names.

### 4.8 Busy and idle

```json
// events.sse:29  session.execution.started (data), no location, durable seq 2
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ"}
// events.sse:117  session.execution.succeeded (data), durable seq 30
{"sessionID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ"}
// active-sample.json:1   GET /api/session/active, sampled mid-run
{"data":{"ses_ecaf279a0fferfPEx4LQ1FsOrZ":{"type":"running"}}}
```

```json
// session-final.json:1   GET /api/session/{id}, after the turn
{"data":{"id":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","cost":0,"tokens":{"input":8563,"output":99,"reasoning":148,"cache":{"read":16064,"write":0}},"outcome":"succeeded","time":{"created":1791891441254,"updated":1791891445704,"idle":1791891445708},"title":"octmux-v2-capture"}}
```

- No `session.idle` frame was observed. The end of the turn is `session.execution.succeeded` (`:117`). `time.idle` in `session-final.json:1` equals that frame's `created` (1791891445708).
- The last message in `messages-page-1.json:1` has `type: "idle"` with `outcome: "succeeded"`.
- Only the running sample of `/api/session/active` was captured. The post-idle shape was not sampled.
- v1 equivalents: `session.idle` (`src/events.ts:754`, `properties.sessionID`) and `session.status` (`:802`, `status.type`). The v2 `session.status` (`types.d.ts:2444`) was not observed.

### 4.9 Subagent child sessions — NOT OBSERVED

Only one session existed in this run. The `session.created` data has no `parentID` key (`events.sse:5`; keys are `sessionID`, `slug`, `version`, `projectID`, `location`, `subpath`, `title`). Client-type shape only: `session.created` declares optional `parentID` (`types.d.ts:2908`). The v1 handler for `session.created` is at `src/events.ts:639`.

### 4.10 Per-session filtering

- The capture subscribed to `/api/event` without query parameters. Frames carry no SSE `id:` field.
- Filter on the attribution table in §2c.
- Global frames (no sessionID) and session frames interleave on one connection.
- No frame for a second session appeared, so cross-session filtering was not exercised.
- v1 equivalent: handlers compare `properties.sessionID` against the current session and return `null` otherwise (for example `question.replied`, `src/events.ts:880`).

### 4.11 Reconnection and replay

- **`/api/event`:** the stream emits no SSE `id:` fields, so there is no `Last-Event-ID` to resume from. Reconnect behaviour was not tested.
- **Session log** (`GET /api/experimental/session/{id}/log`, `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js:523`):
  - The follow capture contains one line: `{"type":"log.synced","aggregateID":"ses_ecaf279a0fferfPEx4LQ1FsOrZ","seq":0}` (`session-log.sse:1`).
  - The replay response headers are HTTP 200 `text/event-stream` (`session-log-replay.headers:1`). The replays after 0 and after 25 each contained only `{"type":"log.synced",…,"seq":30}` (`session-log-replay.sse:1`, `session-log-replay-after0.sse:1`, `session-log-replay-after25.sse:1`).
  - `seq` 30 matches the final durable seq (`events.sse:117`).
  - The log in 2.0.28, as observed, carries no event bodies. It is not usable as an event source in this capture.
- **Message history** (`GET /api/session/{id}/message`, `…chunks/service-probe-ecs5ftka.js:611`): the cursor is opaque base64 JSON. `messages-page-1.json` `cursor.next` decodes to `{"id":"msg_1350d97cc001DQWVSX9dDdoK0K","order":"asc","direction":"next"}`. Page 2 is empty (`messages-page-2.json:1`).

## 5. REST shapes observed

Route paths and methods come from `node_modules/@opencode/client/dist/chunks/service-probe-ecs5ftka.js`. Request query strings and HTTP status codes were not recorded in the artefacts, except where stated.

| Endpoint | Method | Request | Response (artefact) |
|---|---|---|---|
| `/api/session` (`:252`) | POST | body not recorded | `session-create.json:1`: `{"data":{"id", "projectID", "cost":0, "tokens", "time", "title", "subpath", "location"}}` |
| `/api/session/{id}/prompt` (`:346`) | POST | `{"text": "…"}` (`prompt-request.json:2`) | `prompt-response.json:1`: `{"data":{"id", "sessionID", "time", "type":"user", "payload":{"text"}, "delivery":"steer"}}` |
| `/api/session/active` (`:285`) | GET | — | `active-sample.json:1` (running sample only) |
| `/api/session/{id}` (`:292`) | GET | — | `session-final.json:1` |
| `/api/session/{id}/message` (`:611`) | GET | — | `messages-page-1.json:1`; page 2 `messages-page-2.json:1` |
| `/api/session/{id}/form/{formID}/reply` (`:576`) | POST | `{"answer":{"q0":"A"}}` (`form-1-reply-request.json:1`) | empty body (`form-1-reply-response.json`, 0 bytes) |
| `/api/event` (`service-probe-ecs5ftka.js:1037`) | GET (SSE) | none | `events.sse` |
| `/api/experimental/session/{id}/log` (`:523`) | GET | `follow=true`, `after=N` (per capture file names) | `session-log*.sse` |

### 5a. Message list item shapes (`messages-page-1.json:1`)

- **User item:** `{"id","time":{"created"},"text","type":"user"}`. The text is a top-level `text` field, not `payload.text` as in the event stream (`events.sse:27`).
- **Assistant item:** `{"id","time":{"created","streamed","completed"},"type":"assistant","agent","model":{"id","providerID"},"content":[…],"finish","rawFinish","cost","tokens"}`. `content` items are:
  - `reasoning`: `{"type","text","state","time"}`
  - `tool`: `{"type","id","name","executed","state":{"status","input","content","metadata"},"time"}`
  - `text`: `{"type","text"}`
- **Idle item:** `{"id","time":{"created"},"type":"idle","outcome":"succeeded"}`.
- `time.streamed` and `time.completed` match the `created` of `session.step.streamed` (`events.sse:55`, 1791891443611) and `session.step.ended` (`:63`, 1791891444056).

## 6. Gaps — not observed

- Permission request and reply (`permission.asked`, `permission.replied`, REST permission routes).
- Tool failure (`session.tool.failed`).
- Subagent child sessions (no `parentID` anywhere).
- `session.idle` (end of turn is `session.execution.succeeded`).
- `session.execution.failed`, `session.execution.interrupted`, `session.step.failed`.
- `session.tool.input.delta` (tool input arrived as one `input.ended` text).
- Form cancellation (`form.cancelled`).
- Durable shell events (`session.shell.started`, `session.shell.ended`) and `shell.deleted`.
- Retry, compaction, revert, skill activation, synthetic messages.
- Non-zero cost (every `cost` is 0).
- Reconnection behaviour on `/api/event` (no resume test).
- Session log with event bodies (log carried only `log.synced`).
- Cross-session filtering (only one session).
- HTTP status codes and query strings (`directory`) for create and prompt calls, and the form-reply status.
- Post-idle shape of `/api/session/active`.
- Whether `ordinal` counts per kind or per message.
- Meaning of `executed`, `state.reasoningField`, and the instruction-set hash values in `session.instructions.updated`.

Input to the native-v2 octmux stage — observations, not a design.
