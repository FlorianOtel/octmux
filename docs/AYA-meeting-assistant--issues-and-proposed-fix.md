---
title: "AYA meeting assistant -- octmux rendering issue and proposed fix"
created_at: 2026-09-06--12-16
created_by: Claude Code (Claude Opus 5)
updated_by: Claude Code (Claude Opus 5)
updated_at: 2026-09-06--13-35
context: >
  Written from the AYA project (`~/Gin-AI/projects/AYA--ai-assistant`) during stage v0.4-Phase B,
  which runs the four runtime experiments in that project's
  `docs/AYA--architectural-blueprint.md` Section 7.3. Experiment -1a was executed against the live
  OpenCode server on 2026-09-06 and FAILED its acceptance criterion; the cause is on the octmux
  side, in `src/events.ts`.

  This document is a handoff, not a patch. The AYA operator declined to have the fix written from
  the AYA session, on the grounds that octmux's message rendering has a long history of
  regressions and the fix belongs in octmux's own development context with its own testing
  discipline. That judgement is endorsed here: the first fix this author proposed would have
  broken an existing octmux test, and that is documented below rather than hidden.

  Everything stated as measured was measured against octmux HEAD `c959e0a` and the running
  OpenCode server on 2026-09-06. Everything stated as inferred is labelled as inferred.

  Section 0 was added after the fix was implemented in octmux, and records what was actually
  built, why it differs from the proposal in Section 5, and four issues found along the way.
  Sections 1-8 are preserved as the original handoff, unedited.
---

# AYA meeting assistant -- octmux rendering issue and proposed fix

## 0. Resolution -- what was implemented in octmux

Implemented on octmux `main` from HEAD `c959e0a`. Commit: `_pending -- backfill this hash_`.
Pipeline artefacts (research, plan, review) are at
`.claude/orchestra/sessions/20260906T104118Z-3198564/`.

### 0.1 The mechanism

**A per-messageID debounce, with the timer owned by the app layer rather than by `src/events.ts`.**

1. `src/events.ts` stays a pure synchronous filter. It gains a per-id export
   `classifyUserTurn(messageID)` -- a single-id variant of `classifyOpenUserTurns()` that reuses the
   same own-turn suppression, the same `ownCommandPrefixes` backstop and the same
   `classifiedUserMessageIDs` marking -- and a lightweight `ReplEvent` variant
   `{ kind: "foreign-user-part"; messageID }`, returned from the user-text branch in place of `null`
   when the part was accumulated, the id is not in `ownMessageIDs`, and the id is not already
   classified.
2. `src/user-turn-debouncer.ts` (new) owns the debounce. On `foreign-user-part` it (re)arms a
   `USER_TURN_DEBOUNCE_MS = 250` timer keyed on messageID; when the timer fires it calls
   `classifyUserTurn(id)` and hands the resulting events to `applyReplEvents` in `src/app.tsx` --
   the same pattern the Stage 4.5.3 reconciler already uses with `synthesizeSessionIdleEvents()`.
3. The two existing drains (assistant `message.updated`, `session.idle`) remain in place as
   backstops. They are no-ops for ids already emitted, because `classifyUserTurn` marks
   `classifiedUserMessageIDs`.
4. Flushes are **held while `isGenerating`** and released when the turn ends.

### 0.2 Why 250 ms, and why a debounce rather than the alternatives

The debounce window separates two cases that are two orders of magnitude apart. This was measured,
not assumed -- by reading the OpenCode fork and then probing the live daemon:

| Quantity | Value | Source |
|---|---|---|
| Intra-message part delivery (2 parts, one message) | 1 ms server-side, ~5.3 ms on the wire | live probe |
| Inter-utterance gap (AYA meeting cadence) | 3--10 s | AYA fixture |
| Chosen window | 250 ms | ~47x above the first, 12--40x below the second |

`packages/opencode/src/session/prompt.ts:1029-1030` does `updateMessage(info)` and then a plain
sequential `for (const part of parts) updatePart(part)`, and
`packages/opencode/src/session/session.ts:678-686` shows `updatePart` publishing exactly one event
carrying the already-populated part. **User text parts are never created-empty-then-filled**, unlike
assistant text parts. So a part event always carries its full text, and a debounce armed by a part
event always has text to flush. Caveat: the Effect runtime is cooperatively scheduled, so under
heavy concurrent load those part events could stretch; 250 ms is the margin that absorbs it.

Three alternatives were considered and rejected:

- **Emit per-part immediately** (the obvious fix, Section 5.1) -- breaks the `"\n"` join for
  multi-part turns and the existing test (c).
- **Flush on parent `session.updated`** -- about five lines and no async, but it keys on incidental
  server behaviour that is not contract, and risks marking an id classified before its text arrives,
  which would lose that utterance permanently.
- **Flush the previous messageID when a part for a new messageID arrives** -- no timers, but every
  utterance renders one utterance late and the final utterance stays invisible until a turn
  boundary, i.e. exactly when the meeting pauses and the operator looks at the screen.

The timer deliberately lives outside `src/events.ts`: the eight `foreign-user-turn` contract tests
are synchronous with no awaits, and putting timers in that module would put them at risk of
interference. Keeping `filterEvent` synchronous meant all eight passed unchanged.

### 0.3 Two behaviours worth knowing

**Transcript lines are held during a streaming answer.** `commitUserInput` force-flushes the active
text block (`src/renderer/block-buffer.ts:455-460`), so rendering a transcript line mid-stream is
safe but visibly *splits* the assistant's answer into chunks with transcript wedged between them.
Holding while `isGenerating` and releasing at turn end keeps the answer intact; buffered utterances
arrive immediately afterwards as a short catch-up burst. This satisfies the Section 7 acceptance
criterion literally -- no backlog burst *ahead of* the answer.

**The release is keyed on `isGenerating` state, not on a single event.** So it fires uniformly
whichever path ends the turn: `session-idle`, `parent-turn-end`, abort, error, Ctrl-C, or a session
switch. No held utterance is stranded by an unusual turn ending.

### 0.4 Section 5.3's invariants

All nine hold. The nine were the actual deliverable of this document and they were used verbatim as
the review checklist. Of note, invariant 7 (renderer/FIFO state) turned out to be **unreachable**
rather than merely respected: `TmuxWindowRenderer.commitUserInput` delegates to `_main`, and
`OUTPUT_KEY` routes only `thinking` / `tool-call` / `tool-result` to side windows, so the
side-window `_lineBufs` / `_openBlocks` state can never be touched by this code path.

Test count went from 245 pass / 1 fail to 263 pass / 1 fail (18 new tests; the 1 failure is
unrelated and pre-existing -- see 0.5.4).

---

## 0.5 Issues identified along the way

### 0.5.1 AYA's Blueprint §7.2 and Implementation-plan §v0.4 item 9 prescribe a fix that cannot work

Both AYA documents state the required octmux fix as:

> flush on `message.updated` for a foreign *user* message, not only at turn boundaries

**This is not implementable.** Section 4.2 of this document measured the ordering as
`message.updated` *before* `message.part.updated`, 5 out of 5, and the OpenCode source confirms why:
`prompt.ts:1029-1030` writes the message row first and its parts second. At the moment a user
`message.updated` arrives, `accumulatedUserTexts` for that id is **empty**. Flushing there would
either emit nothing, or -- worse -- mark the id classified with empty text, after which the real text
would arrive, accumulate, and never be drained. That is silent per-utterance data loss in the live
view.

The irony is that this document's own Section 4.2 already contains the refutation; the two AYA
documents were written before that measurement and were never reconciled with it.

**Suggested replacement wording for both AYA documents:**

> octmux must flush a foreign user turn on a short per-messageID debounce armed by
> `message.part.updated` -- not on `message.updated`, which the server emits before the message's
> text parts exist. The debounce window must sit well above intra-message part delivery
> (measured ~5 ms) and well below the inter-utterance gap (3--10 s); octmux uses 250 ms. The
> existing turn-boundary drains remain as backstops.

Two consequential edits follow from that:

- **Blueprint §7.1, capability 6** ("Third-party appends render *without* an inference turn --
  `[SOURCE-VERIFIED]` **MISSING**") should move to present, citing this section and the octmux
  commit, once experiment -1a has been re-run and passes.
- **Implementation-plan §v0.4 item 9** should keep filing the octmux work as an external task but
  restate what that task actually was, so that v1.2's live-transcript acceptance test depends on a
  description of something that exists.

### 0.5.2 `octmux --resume` was scoped to the launch directory, and -1a passed that by accident

`src/index.tsx` captured `cwd = process.cwd()` once and built the SDK client -- and therefore the
SSE subscription -- from it. None of `--resume`, `--resume-last` or `--fork` ever read the resolved
session's own `.directory`. Since a subscription to `/event` bound to the wrong project delivers
**nothing but heartbeats, with no error** (Section 6.2), resuming a session belonging to another
project would have rendered history and then appeared frozen forever.

Experiment -1a did not hit this only because the operator happened to launch octmux from the
session's own project directory. Had it been launched from anywhere else, -1a would have failed for
a completely different reason than the one this document diagnoses, and the buffering analysis in
Sections 3--5 would have been chasing a symptom that was not there.

**Fixed in the same commit.** The startup client is now `bootstrapClient`, used only to resolve the
session; the resolved session's own `.directory` is captured; and an `effectiveCwd` is derived and
used to rebind the client before the SSE subscription is opened. The `cwd` prop passed to `<App>`
moves with it, because five raw `fetch()` sites send `x-opencode-directory: props.cwd` and those
endpoints (`/question`, `/permission`, `/session`) return `[]` *silently* when mis-scoped.

**Consequence for the acceptance run in Section 7:** to exercise this fix at all, octmux must be
launched from a directory *different* from the one `aya-core` created the session in. Repeating
-1a's accidental match would leave the `--resume` half unverified.

Deliberately **not** fixed, and still open:

- `session.list()` for `--resume-last` has its own server-side directory scoping, so "most recent
  session" may not see sessions in other projects at all.
- `--fork` still creates the child with `query: { directory: cwd }`; only the post-hoc rebinding to
  whatever directory the server assigned is fixed.
- `OrchestraWatcher` matches on raw `process.cwd()`, not `effectiveCwd`, so resuming a
  foreign-directory session may leave the orchestra badge unresolved.

### 0.5.3 Section 5.4's incidental bug was real, and is fixed

`classifyOpenUserTurns` used `return events;` inside the `ownCommandPrefixes` loop where `continue`
was intended, abandoning every remaining unclassified id in that drain once one id matched a prefix.

It was fixed, but not as a one-line edit. The single-id classification body was extracted into a
private `classifyOneUserTurn(id)` returning `[]` for a suppressed id, shared by both
`classifyOpenUserTurns()` (whose loop now continues correctly) and the new `classifyUserTurn(id)`.
The extraction was needed anyway to share logic with the debounce path, so this is one change rather
than two divergent copies. A regression test reproduces the exact failure: two foreign ids where the
first is prefix-suppressed, asserting the second still emits.

This mattered more than Section 5.4 judged. With per-id debounce flushing there is no longer a
guaranteed "next drain" to pick up the abandoned ids.

### 0.5.4 Incidental, unrelated: `mintUserMessageID` truncates its timestamp

Found while establishing a test baseline; **out of scope, not fixed, and not caused by this work.**

`src/message-id.test.ts:73` ("hex-temporal ordering") fails at HEAD `c959e0a` and still fails after
this change. `src/message-id.ts` packs `Date.now() * 0x1000` -- a 53-bit value -- into 6 bytes
(48 bits), so the top 5 bits are truncated and minted ids render as `msg_05...` rather than the
server's `msg_ed...`.

It happens to still satisfy the server's `lastUser.id < lastAssistant.id` ordering check, which is
why the prefill-400 regression that commit `6daf785` set out to fix has not returned. It is working
by accident, and deserves its own pass. Recorded here because a reader running `bun test` against
this work will see the failure and should not attribute it to the flush fix.

---

## 1. What AYA is, and what it does to a session

AYA is a meeting-ingestion producer. It turns live meeting speech into a running transcript
inside an OpenCode session, so that the operator can ask an assistant questions about a meeting
while the meeting is still happening.

The component that matters here is `aya-core`, a Rust binary. Its ingestion behaviour:

| Property | Value |
|---|---|
| Route | `POST /session/{id}/prompt_async` with `noReply: true` |
| Response | **204 No Content** |
| Granularity | **one utterance = one message = one text part** |
| Text shape | `[TRANSCRIPT hh:mm:ss] Speaker N (name): <utterance text>` |
| Clock in the marker | UTC time-of-day, from the record's own `t_wall` |
| Cadence | real meeting speech -- an utterance every **3--10 s** |
| Volume | **408 utterances over a 45-minute meeting** (the standard synthetic fixture) |
| Append latency | p95 ~13 ms, mean ~6.5 ms (measured, release build, 408 appends) |
| Inference | **never triggered.** `noReply` returns at `session/prompt.ts:1122`, before `loop()` |

Two consequences worth internalising before reading the rest:

1. **AYA never produces an assistant turn.** A 45-minute meeting is 408 user messages and zero
   assistant messages, unless and until the operator asks a question.
2. **Every AYA message is "foreign" to octmux.** octmux did not send them, so they never enter
   `ownMessageIDs`.

The session may be created either by `aya-core` (operator then attaches with
`octmux --resume <id>`) or by the operator in octmux (`aya-core` then attaches with
`--session <id>`). Both are in scope; see Section 2.

## 2. What the operator expects

Three acceptance scenarios were specified by the AYA operator. Only the first two concern octmux.

1. **Real-time streaming, AYA-initiated session.** `aya-core` creates a session and prints its
   id; the operator attaches via `octmux --resume <id>`; `aya-core` streams the transcript; **the
   operator confirms receipt in real time.**
2. **Real-time streaming, operator-initiated session.** The operator starts a session in octmux
   and passes the id; `aya-core` attaches and streams; **the operator confirms receipt in real
   time.**
3. **Post-factum integrity.** `aya-core` streams into a fresh session unattended; the operator
   later reads the history and verifies integrity end to end. **This scenario is unaffected and
   passes** -- the messages are all in the store, correctly ordered and correctly labelled.

"Confirms receipt in real time" is the operative phrase and it is an acceptance criterion, not a
nicety: the product is an assistant you consult *during* a meeting. A transcript the operator
cannot see arriving is, for scenarios 1 and 2, a failed feature.

## 3. The observed failure

**Experiment v0.4-PhaseB-1a, 2026-09-06.** Session `ses_f89d9ea46ffevh9a1YBBrUXB4p` in project
`/mnt/nfs/Florian/Gin-AI/projects/AYA-meeting-transcripts`. 101 utterances plus one device event,
replayed at real meeting cadence over ~11 minutes, into a session the operator had attached to
with `octmux --single --resume <id>` before the first append.

Ingestion was flawless:

    lines_read=102 utterances=101 device_events=1 skipped_unparsable=0 invalid=0
    appends_ok=101 appends_failed=0 appends_with_noreply=101 last_append_status=Some(204)

Message store afterwards: **101 messages, all `role=user`, zero assistant messages.** The
operator independently confirmed the messages were visible in `oc-history`.

**In octmux, for the entire ~11 minutes, nothing rendered.** The session appeared empty. When the
operator finally issued a prompt, **the whole 101-line backlog burst in at once, immediately
ahead of the answer** -- which is the worst possible moment for it, because it buries the answer
the operator actually asked for under eleven minutes of transcript.

Verdict recorded on the AYA side: **-1a FAILED as specified.** Scenario 2 has not yet been run;
it is expected to fail identically, for reasons in Section 4.4.

## 4. Root cause

### 4.1 The events do reach octmux

This was verified rather than assumed, and one wrong turn is worth recording because it nearly
became a false finding.

Measured over a 30-second window while 5 appends landed, subscribed to
`/event?directory=<session's project directory>`:

| Event | Count |
|---|---|
| `message.updated` (role=user) | 5 |
| `message.part.updated` | 5 |
| `session.updated` | 10 |
| `session.idle` | **0** |
| `message.updated` (role=assistant) | **0** |

So the bus carries everything octmux needs. octmux is also **correctly scoped** in this scenario:
its cwd was the session's own project directory, so `createOpencodeClient({ baseUrl, directory:
cwd })` at `src/index.tsx:260` bound to the right project. **The failure is not a subscription
problem.** (But see Section 6.2 -- there is a latent scoping trap here that is worth fixing
separately.)

### 4.2 The exact per-append event signature

Identical for all 5 appends observed, and useful for designing a fix:

    message.updated       role=user   id=msg_…        <- message exists, NO text yet
    message.part.updated  type=text   messageID=msg_… <- the text arrives here
    session.updated       ×2                          <- append settles
    … 3--10 s gap …                                   <- next utterance

**Ordering is `message.updated` before `message.part.updated`, 5 out of 5.** This matters twice:

- It means `userMessageIDs` (`events.ts:295-299`) is always populated before the text part
  reaches `:412`, so AYA's lines are always correctly classified as *user* turns. They are never
  mis-rendered as assistant output.
- It means **a fix cannot flush on the user `message.updated`** -- at that moment there is no
  text to render.

### 4.3 Where it stops

In `src/events.ts` at HEAD `c959e0a`:

1. **`:411-423`** -- a `message.part.updated` of type `text` whose `messageID` is in
   `userMessageIDs` is pushed into `accumulatedUserTexts` and the handler **`return null`s**.
   Nothing is rendered at that moment. This is deliberate: it is the Mobile-Companion Part B
   accumulate-then-classify design.
2. **`classifyOpenUserTurns()` (`:179`)** is the **only** thing that drains
   `accumulatedUserTexts` into a `foreign-user-turn` event.
3. It has **exactly two callers**, confirmed by grep across `src/`:
   - `:306` -- inside the handler for an **assistant** `message.updated`
   - `:754` -- on **`session.idle`**
4. **A `noReply` append produces neither.** `prompt.ts:1122` returns before `loop()`;
   `status.set(sessionID, {type:"busy"})` at `prompt.ts:1142` is inside `loop()`; and
   `Event.Idle` is published only on a transition *to* idle (`status.ts:80-82`). No busy, no
   idle, no assistant message.
5. **The reconciler does not rescue it.** `synthesizeSessionIdleEvents()` (`:255`) was checked
   specifically because it would have refuted the analysis: it closes open parts and clears
   `openParts`/`seenPartIDs`, but it does **not** call `classifyOpenUserTurns`. A synthesised
   idle therefore does not flush foreign user turns either.

So the transcript accumulates in a `Map` for the whole meeting and is drained only when the
operator's own prompt eventually produces an assistant `message.updated` -- at `:306`, where
`userTurnEvents` are deliberately **prepended** so they render *before* the assistant turn. That
prepending is exactly the burst the operator observed.

### 4.4 Why scenario 2 is expected to fail identically

The buffering has nothing to do with who created the session. AYA's appends are foreign messages
either way, and `ownMessageIDs` only ever contains messages octmux itself sent. *(Inferred, not
yet measured -- scenario 2 has not been run.)*

## 5. Proposed fix

### 5.1 The naive fix is wrong -- stated first, because it is the obvious one

The obvious change is: at `:411-423`, after accumulating the text part, emit the
`foreign-user-turn` immediately instead of returning `null`.

**This breaks an existing, deliberate contract.** `src/events.test.ts` test (c),
*"foreign multi-part: synthetic/ignored excluded, order preserved, joined with newline"*, feeds
four parts for one message and expects **one** turn with text `"line 1\nline 2"`. Flushing
per-part emits two turns and loses the join. `renderer.commitUserInput(ev.text)`
(`src/app.tsx:940-945`) is one block per call, so this is visible breakage, not just a failing
assertion.

This is precisely the class of regression the operator was concerned about, and it is why this
document proposes a direction rather than shipping a patch.

### 5.2 The shape a correct fix needs

The requirement is to drain a foreign user turn **without waiting for a turn boundary**, while
still joining the parts of a genuinely multi-part turn.

The distinguishing fact is timing. Parts of one message arrive together, in one burst; separate
AYA utterances arrive 3--10 seconds apart. A **short debounce keyed on `messageID`** therefore
separates the two cases cleanly:

- on a user text part: accumulate as today, and (re)arm a short timer for that `messageID`;
- when the timer fires without a further part for that id, classify **just that id** and emit its
  `foreign-user-turn`;
- any existing drain (`:306`, `:754`) still runs and must be a no-op for ids already emitted.

A debounce in the low hundreds of milliseconds is two orders of magnitude below the inter-utterance
gap and comfortably above intra-message part delivery. The exact value is an octmux judgement.

An alternative that avoids timers: flush the *previous* message's accumulated parts when a part
for a **new** `messageID` arrives, with the existing turn-boundary drains as the backstop for the
last message. This renders each utterance one utterance late, which for a 3--10 s cadence is a
poor fit for "real time" but may be acceptable if timers are unwelcome in this code path.

*(A completion signal would be better than either, but none was found: the `session.updated` pair
following each append is not documented as a turn-complete marker and keying on it would be
guesswork.)*

### 5.3 Invariants a fix must not break

Drawn from the current code and its tests. This list is the actual deliverable of this document.

1. **Own turns stay suppressed.** `ownMessageIDs` entries are already optimistically rendered;
   `classifyOpenUserTurns` deletes their accumulated text and emits nothing (`:183-186`).
   Test (a) covers this.
2. **The command-prefix backstop still applies.** A foreign turn whose joined text starts with an
   `ownCommandPrefixes` entry is suppressed, so a custom command's full `.md` body is not rendered
   as user input (`:195-199`, `recordOwnCommandPrefix` at `:166`). Test (g),
   *"Slash-command expanded-template suppression"*, covers this.
3. **`synthetic` and `ignored` parts stay excluded** (`:414-417`). Test (d): a message with only
   such parts emits nothing at all.
4. **Multi-part turns still join with `"\n"`, in order.** Test (c). See 5.1.
5. **No double rendering.** `classifiedUserMessageIDs` must be marked when a turn is emitted, so
   the later `:306` / `:754` drains skip it. Test (h) -- *"Interleave -- foreign between two local
   turns: exactly one foreign-user-turn emitted"* -- is the guard here.
6. **`session.idle` remains a backstop**, for turns that arrived but were not otherwise flushed
   (`:753-755`). Test (e).
7. **Renderer/FIFO state stays consistent.** The comment at `:244-256` is explicit that
   block-end events flush `TmuxWindowRenderer._lineBufs` and clear `_openBlocks`, that
   over-emission is harmless but **under-emission corrupts FIFO state**, and that this matters
   for `--multi-window`. A new emission path must not open blocks it does not close.
8. **`resetEventState()` must clear any new state** (timers, pending ids) alongside the existing
   maps at `:141-142`. Test (f) covers reset behaviour for the existing state.
9. **Ordering against assistant turns.** Today `:306` prepends foreign turns so they precede the
   assistant's reply. Emitting them as they arrive makes ordering naturally chronological, which
   is the desired behaviour -- but any turn still pending at an assistant boundary must keep the
   existing prepend semantics.

### 5.4 An incidental bug, found while reading -- low priority, stated precisely

`classifyOpenUserTurns` at `:195-199` uses `return events;` inside the `ownCommandPrefixes` loop
where `continue` appears to be intended. The effect is that when one turn matches a prefix, the
function returns early and abandons the remaining unclassified ids in that drain.

**This is a deferral, not a loss:** those ids were never added to `classifiedUserMessageIDs`, so
they are picked up on the next drain. Reachability for AYA is nil -- `ownCommandPrefixes` is
populated only from app.tsx's custom-command branch, and AYA lines begin `[TRANSCRIPT `. Recorded
because it is in the function a fix will touch, not because it is urgent.

## 6. Two further findings for octmux

### 6.1 `/event` and `/api/event` are different endpoints

- `/event` -> events shaped `{"type":…, "properties":{…}}`, plus `server.heartbeat`. This is what
  `src/events.ts` reads (`(event as EventMessageUpdated).properties.info`).
- `/api/event` -> events shaped `{"type":…, "location":{…}, "data":{}}`, no heartbeats.

Noted because tooling written against the wrong one appears to work -- it connects and receives
`server.connected` -- while delivering nothing usable.

### 6.2 The event bus is project-scoped, silently -- a latent trap in `--resume`

A subscription to `/event` with **no** `?directory=` binds to the `global` project and delivers
**nothing** for sessions belonging to other projects. No error, no warning, just heartbeats
forever. Measured: 4 appends in a 30 s unscoped window produced 0 message events; 5 appends in a
30 s window scoped to the session's directory produced all 10 expected events.

octmux passes `directory: cwd` (`src/index.tsx:260`), captured once from `process.cwd()`. In the
-1a run this happened to be correct, because the operator ran octmux from the session's own
project directory.

**But `--resume <id>` does not constrain where it is run from.** Resuming a session whose project
differs from the invocation cwd should be expected to deliver no live events at all -- the
session would render its history and then appear frozen. *(Inferred from the scoping measurement
plus `index.tsx:260`; not directly tested.)* If that holds, `--resume` should derive the
subscription directory from the resumed session (`GET /session/{id}` returns `directory`) rather
than from cwd.

This is independent of the buffering issue and would not be fixed by fixing it.

## 7. How to reproduce, and how to know the fix works

`aya-core` and `aya-fake-producer` build from `~/Gin-AI/projects/AYA--ai-assistant`:

    PATH="$HOME/.cargo/bin:$PATH" cargo build --release -p aya-core -p aya-fake-producer

An ~11-minute arm at real cadence, containing one device event:

    head -102 fixtures/45min-synthetic.ndjson > /tmp/short.ndjson

Scenario 1. The `sleep 60` exists because `aya-core` prints the session id before it reads stdin,
giving a window to attach:

    ( sleep 60; ./target/release/aya-fake-producer --fixture /tmp/short.ndjson ) \
      | ./target/release/aya-core replay --new-session --title "octmux-fix-check"

then, in another terminal, `octmux --resume <printed id>`.

For a faster loop, `--fast-forward` on the producer removes the cadence sleeps and appends as
fast as the server accepts -- useful for exercising the code path, **not** representative of
meeting cadence and not a substitute for a real-cadence run.

**Acceptance:** transcript lines appear in octmux as they are appended, at roughly the append
cadence, rendered as *user* turns, in order, with no duplicates -- and a subsequent prompt
produces an answer that is **not** preceded by a backlog burst.

**Regression check:** `bun test src/events.test.ts` (or the project's usual runner) with
particular attention to the `foreign-user-turn detection` describe block at `:798` -- tests (a)
through (h) encode the contract enumerated in Section 5.3.

## 8. Status and what happens next

- **-1a: FAILED as specified.** Recorded on the AYA side; not closed, not reframed as a pass.
- **-1b (scenario 2): not run.** Expected to fail identically (Section 4.4).
- **Scenario 3 (post-factum): unaffected.**
- The AYA v0.4-Phase B session is **paused** pending an octmux fix. It will resume against
  whatever is actually implemented -- the AYA side re-runs both scenarios and records the result;
  it does not assume this document's proposal was the one adopted.

Full evidence, including the raw 30-second scoped event capture and the run's telemetry, is at
`~/Gin-AI/projects/AYA--ai-assistant/.claude/orchestra/sessions/20260905T160622Z-2802901/evidence/`.
