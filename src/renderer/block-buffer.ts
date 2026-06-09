import { EventEmitter } from "node:events";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import type { Block, Role } from "../blocks.ts";
import { formatLine } from "../blocks.ts";
import { Visibility } from "./visibility.ts";
import type { Renderer, CommittedLine } from "./types.ts";
import { OUTPUT_KEY, OUTPUT_KEYS } from "./output-keys.ts";

// Stage 10.2 — Markdown engine integration.
//
// API notes verified empirically against marked@15.0.0 + marked-terminal@7.3.0:
//   - `marked.parse(text)` and `Marked#parse(text)` are SYNCHRONOUS by default
//     in v15+ (no need to pass `{ async: false }`). They return a `string`.
//   - `markedTerminal` is a NAMED export (factory) — `import { markedTerminal }`.
//     The default export is the underlying `Renderer` class.
//   - `markedTerminal({...})` does NOT take a `width` option that affects
//     output unless `reflowText: true`; we use `reflowText: false`, so the
//     `width` field on `BlockBufferRenderer` is informational only (the
//     `ActiveBlock` Ink component handles wrapping via Box's width prop).
//   - We use a per-instance `Marked` (not the global singleton) so that the
//     extension config doesn't leak across renderers or affect the test file's
//     own marked usage.
//
// chalk-fallback heuristic (constructor-time, defensive — there is no
// `--no-block-render` escape hatch on this branch):
//   if `FORCE_COLOR` env unset AND `process.stdout.isTTY === false`, log a
//   one-time warning and set `chalk.level = 0` (no-color path). marked-terminal
//   still renders structurally; chalk-applied styles emit no escape codes.

let _chalkFallbackWarned = false;

function _setupChalkLevel(): void {
  const forceColor = process.env.FORCE_COLOR;
  const isTTY = process.stdout.isTTY === true;
  if (!forceColor && !isTTY) {
    if (!_chalkFallbackWarned) {
      _chalkFallbackWarned = true;
      process.stderr.write(
        "octmux: chalk auto-detected no TTY; falling back to no-color markdown render (text-only, no styling). To force colors, set FORCE_COLOR=1.\n"
      );
    }
    chalk.level = 0;
  } else {
    chalk.level = 3;
  }
}

function _makeMarkedInstance(): Marked {
  const m = new Marked();
  // NB: chalk.level MUST be set BEFORE markedTerminal({...}) is called.
  // markedTerminal captures chalk-styled functions at construction time;
  // setting chalk.level later has no effect on already-constructed styles.
  m.use(markedTerminal({
    heading: chalk.cyan.bold,
    firstHeading: chalk.cyan.bold,
    codespan: chalk.rgb(147, 161, 199),
    code: chalk.reset,
    listitem: chalk.reset,
    blockquote: chalk.gray.italic,
    hr: chalk.dim,
    link: chalk.reset,
    href: chalk.blue.underline,
    strong: chalk.bold,
    em: chalk.italic,
    del: chalk.strikethrough,
    reflowText: false,
    tab: 2,
    unescape: true,
    emoji: true,
  }) as any);
  return m;
}

export class BlockBufferRenderer extends EventEmitter implements Renderer {
  readonly kind = "block-buffer" as const;
  readonly visibility: Visibility;

  private _committed: CommittedLine[] = [];
  private _nextId = 0;
  private _openBlocks = new Map<string, Role>();
  private _activeTextPartID: string | null = null;
  private _activeTextBuf = "";
  private _activeBlockAnsi = "";
  private _activeBlockRole: Role | null = null;
  private _nonTextTail: { role: Role; text: string } | null = null;
  private _width = 80;
  private _outputEnabled = new Map<string, boolean>();
  private _marked: Marked;
  // Stage 10.4 — 100 ms trailing-edge debounce for text-role intra-line bursts.
  // Newlines flush immediately (operators see new lines as they complete); the
  // trailing-edge timer covers intra-line burst storms without over-rendering.
  // Non-text roles are unchanged (per-line streaming is already fast).
  // C1.4 invariant: every lifecycle method that may commit (endBlock text,
  // commitTurnEnd, commitUserInput, commitSystemMessage, commitError, clearAll,
  // dispose) pre-flushes this timer + re-renders synchronously so the SAME
  // `_activeBlockAnsi` that `_commitActiveText()` splits is the latest live ANSI.
  private _textDebounce: ReturnType<typeof setTimeout> | null = null;

  // Stage 10.7 — render throttle clock. Tracks the wall-clock time of the
  // most-recent immediate render (flush-on-\n branch) AND the trailing-edge
  // timer body so the two share one rate-limit budget. Bounds the immediate
  // render path to ~12 Hz max during high-rate token streams (model-generated
  // markdown), preventing the bursty visual cadence the unthrottled path
  // produced. Low-rate streams (tool output) are unaffected — the elapsed
  // gap between consecutive \n-bearing deltas exceeds the throttle window.
  private _lastEmitMs: number = 0;

  // Stage 10.6 — memoised active-block wrapper.
  // getActiveBlock() is called by React's useSyncExternalStore twice per
  // reconciler cycle for identity comparison (Object.is). Returning a new
  // `{role, text}` literal on every call makes Object.is return false on
  // every cycle, triggering an unconditional forceStoreRerender storm that
  // saturates NESTED_PASSIVE_UPDATE_LIMIT, flickers the screen, and
  // starves libuv stdin — making Ctrl-C undeliverable.
  //
  // Fix: cache the wrapper. JS strings are immutable; `+=` always creates a
  // new string reference, so `_activeTextBuf` identity change is the correct
  // cache-invalidation key. When the buf reference hasn't changed, return the
  // same wrapper object — Object.is(A, A) === true → no storm.
  //
  // The `_activeTextPartID === null` early-return at the top of getActiveBlock()
  // already nulls out the active block on every lifecycle path
  // (_commitActiveText, endBlock, commitTurnEnd, commitUserInput,
  // commitSystemMessage, commitError, clearAll, dispose) — no per-method
  // cache-null logic is needed.
  private _activeBlockCache: { role: Role; text: string } | null = null;
  // The _activeTextBuf value that was current when _activeBlockCache was built.
  // String identity (===) is the invalidation key.
  private _activeBlockCacheBuf: string | null = null;

  // Stage 10.8 — per-message demarcation. Tracks the messageID of the most recently
  // opened text block. When a new text block opens with a different messageID, one
  // blank CommittedLine (" ") is injected before the block starts, producing a visible
  // blank-line separator between consecutive assistant messages in the scrollback.
  // Reset in clearAll() and dispose() for session-switch hygiene.
  private _lastTextMessageID: string | null = null;

  constructor(visibility: Visibility) {
    super();
    this.visibility = visibility;
    for (const key of OUTPUT_KEYS) {
      this._outputEnabled.set(key, true);
    }
    // C1.4 prerequisite: chalk.level must be pinned BEFORE _makeMarkedInstance
    // so the captured chalk-styled functions in markedTerminal use the right level.
    _setupChalkLevel();
    this._marked = _makeMarkedInstance();
  }

  private _renderActiveTextAnsi(): string {
    if (!this._activeBlockRole) return "";
    // Text role: render the FULL multi-line buffer through marked + marked-terminal.
    // C1.4: the SAME `_activeBlockAnsi` string is then split on \n at commit time;
    // we do NOT re-render at endBlock. This makes the live and commit paths
    // byte-equal by construction.
    if (this._activeBlockRole === "text") {
      const out = this._marked.parse(this._activeTextBuf) as string;
      // marked-terminal output typically has trailing newline(s) (one per block).
      // Strip them so the committed-line split doesn't produce spurious empty
      // trailing lines. This applies uniformly to live and commit paths
      // (the C1.4 invariant test's "commit path" reconstruction must also strip).
      return out.replace(/\n+$/, "");
    }
    // C1.5 fence: non-text roles continue to use per-line formatLine.
    const lines = this._activeTextBuf.split("\n");
    return lines.map(line => formatLine(this._activeBlockRole!, line, false)).join("\n");
  }

  beginBlock(partID: string, role: Role, meta?: Block["meta"]): void {
    if (!this.visibility.isVisible(role)) return;
    const _outKey = OUTPUT_KEY[role];
    if (_outKey && !this.isOutputEnabled(_outKey)) return;
    this._openBlocks.set(partID, role);

    // Block transition: if we're entering a new text block while another is open,
    // auto-flush the prior text block as a side-effect (defensive).
    if (this._activeTextPartID !== null && this._activeTextPartID !== partID && role === "text") {
      // Stage 10.4: pre-flush debounce so the prior block's commit uses its
      // latest live ANSI.
      this._flushDebounce();
      this._commitActiveText();
    }

    // Stage 10.8 — inter-message blank line for text role.
    // OCTMUX_DEBUG_RENDER=1 instrumentation: prints to stderr at every text-role
    // beginBlock — distinguishes Hypothesis A (messageID undefined at runtime →
    // GUARD-FAILED) from Hypothesis B (inject fires but Ink does not render it).
    if (role === "text" && meta?.messageID != null) {
      if (process.env.OCTMUX_DEBUG_RENDER === "1") {
        const willInject = this._lastTextMessageID !== null && this._lastTextMessageID !== meta.messageID;
        process.stderr.write(`[octmux-render] beginBlock TEXT  partID=${partID}  messageID=${meta.messageID}  _lastTextMessageID=${this._lastTextMessageID}  willInject=${willInject}\n`);
      }
      if (this._lastTextMessageID !== null && this._lastTextMessageID !== meta.messageID) {
        // Stage 10.8.1: format local time YYYY-MM-DD--HH-MM and inject as
        // the demarcation row. Substantive content is required because Ink
        // collapses single-whitespace <Text> rows arriving as standalone
        // Static appends (empirically verified at commit 3127a51).
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}--${pad(d.getHours())}-${pad(d.getMinutes())}`;
        this._committed = [...this._committed, { id: this._nextId++, role: "text", ansi: ts }];
        this.emit("changed");
        if (process.env.OCTMUX_DEBUG_RENDER === "1") {
          process.stderr.write(`[octmux-render]   → INJECT FIRED. committed.length now ${this._committed.length}\n`);
        }
      }
      this._lastTextMessageID = meta.messageID;
    } else if (role === "text" && process.env.OCTMUX_DEBUG_RENDER === "1") {
      process.stderr.write(`[octmux-render] beginBlock TEXT  partID=${partID}  meta=${JSON.stringify(meta)}  messageID-GUARD-FAILED (meta?.messageID was null/undef)\n`);
    }
  }

  appendToBlock(partID: string, text: string): void {
    const role = this._openBlocks.get(partID);
    if (!role) return;

    if (!this.visibility.isVisible(role)) {
      this.visibility.increment(role);
      return;
    }

    const _outKey = OUTPUT_KEY[role];
    if (_outKey && !this.isOutputEnabled(_outKey)) return;

    if (role === "text") {
      // Stage 10.4 — debounce + flush-on-\n. Clear any pending trailing-edge
      // timer (a fresh delta resets the 100 ms window).
      if (this._textDebounce !== null) {
        clearTimeout(this._textDebounce);
        this._textDebounce = null;
      }
      // First delta of a new text block
      if (this._activeTextPartID === null) {
        this._activeTextPartID = partID;
        this._activeBlockRole = role;
      }
      // Append to the FULL buffer — do NOT split or commit during appendToBlock
      this._activeTextBuf += text;
      // Flush-on-\n: if this delta completes one or more lines, render + emit
      // so operators see new lines as soon as they complete (C1.8 + UX
      // requirement). Intra-line bursts (no \n in delta) skip this and rely
      // on the trailing-edge timer below.
      //
      // Stage 10.7 — throttle. The unthrottled immediate path produced a
      // bursty visual cadence on high-rate token streams (model-generated
      // markdown): every \n-bearing delta drove a full-buffer re-parse +
      // emit, often dozens per second. Skip the immediate render when the
      // previous one fired < 80 ms ago — the trailing-edge timer is the
      // safety net and will fire 100 ms after the last delta regardless.
      // Low-rate streams (tool output) skip the throttle in practice
      // because the inter-delta gap exceeds 80 ms.
      if (text.includes("\n")) {
        const now = Date.now();
        if (now - this._lastEmitMs >= 80) {
          this._activeBlockAnsi = this._renderActiveTextAnsi();
          this._lastEmitMs = now;
          this.emit("changed");
        }
      }
      // Always schedule a trailing-edge timer — handles the burst case AND
      // catches the final intra-line tail when the operator stops typing /
      // the stream stops mid-line. The timer fires at most once per 100 ms
      // because the next delta clears it.
      this._textDebounce = setTimeout(() => {
        this._textDebounce = null;
        // Defensive: only render if the active text block still exists.
        // Lifecycle methods always pre-flush + clear the timer before
        // resetting state, so this should always be true when the timer
        // fires — but guard anyway in case of an unexpected ordering.
        if (this._activeBlockRole === null) return;
        this._activeBlockAnsi = this._renderActiveTextAnsi();
        // Stage 10.7: share the throttle clock with the immediate path.
        this._lastEmitMs = Date.now();
        this.emit("changed");
      }, 100);
    } else {
      // Non-text roles: replicate StdoutRenderer's line-streaming
      let buf = text;
      let nl = buf.indexOf("\n");
      const newLines: CommittedLine[] = [];
      while (nl !== -1) {
        newLines.push({ id: this._nextId++, role, ansi: formatLine(role, buf.slice(0, nl), false) });
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      // Process the remaining partial line
      if (buf.length > 0) {
        newLines.push({ id: this._nextId++, role, ansi: formatLine(role, buf, false) });
      }
      this._nonTextTail = buf ? { role, text: buf } : null;
      if (newLines.length > 0) this._committed = [...this._committed, ...newLines];
      this.emit("changed");
    }
  }

  endBlock(partID: string, _status?: "ok" | "error"): void {
    const role = this._openBlocks.get(partID);
    const _outKey = role ? OUTPUT_KEY[role] : undefined;
    if (_outKey && !this.isOutputEnabled(_outKey)) {
      this._openBlocks.delete(partID);
      return;
    }
    if (role && this.visibility.isVisible(role) && this._activeTextPartID === partID) {
      // Stage 10.4: pre-flush any pending debounce so `_activeBlockAnsi` is the
      // latest live render before _commitActiveText splits it. C1.4 invariant
      // is preserved: the commit uses the SAME (now-current) live ANSI; no
      // re-render at commit time.
      this._flushDebounce();
      this._commitActiveText();
    }
    this._openBlocks.delete(partID);
    this.emit("changed");
  }

  commitTurnEnd(): void {
    // Stage 10.4: pre-flush debounce + flush active text block.
    this._flushDebounce();
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._activeTextPartID = null;
    this._activeBlockRole = null;
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._committed = [...this._committed,
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitUserInput(text: string): void {
    // Stage 10.4: pre-flush debounce + flush active text block.
    this._flushDebounce();
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._committed = [...this._committed,
      { id: this._nextId++, role: "user", ansi: formatLine("user", text, true) },
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitSystemMessage(text: string): void {
    // Stage 10.4: pre-flush debounce + flush active text block.
    this._flushDebounce();
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._committed = [...this._committed,
      { id: this._nextId++, role: "text", ansi: `→ ${text}` },
      { id: this._nextId++, role: "text", ansi: " " },
      { id: this._nextId++, role: "text", ansi: " " },
    ];
    this.emit("changed");
  }

  commitError(message: string): void {
    // Stage 10.4: pre-flush debounce + flush active text block.
    this._flushDebounce();
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._activeTextPartID = null;
    this._activeBlockRole = null;
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._committed = [...this._committed, {
      id: this._nextId++, role: "error",
      ansi: formatLine("error", message, true),
    }];
    this.emit("changed");
  }

  // Stage 10.4 — debounce pre-flush. Called from every lifecycle method that
  // may commit, clear, or dispose the active text block. Cancels any pending
  // trailing-edge timer and synchronously updates `_activeBlockAnsi` to reflect
  // the latest `_activeTextBuf`. This is the load-bearing piece for the C1.4
  // invariant: the SAME `_activeBlockAnsi` that `_commitActiveText()` splits is
  // the latest live ANSI, guaranteed byte-equal-by-construction to what an
  // immediate full re-render would produce.
  private _flushDebounce(): void {
    if (this._textDebounce !== null) {
      clearTimeout(this._textDebounce);
      this._textDebounce = null;
      // Re-render synchronously so `_activeBlockAnsi` is up-to-date.
      // Guard: only render if there is still an active text block (defensive).
      if (this._activeBlockRole !== null) {
        this._activeBlockAnsi = this._renderActiveTextAnsi();
      }
    }
  }

  private _commitActiveText(): void {
    if (this._activeTextPartID === null || this._activeBlockRole === null) return;
    // Array-replace (not in-place push) so getCommitted() returns a new reference,
    // reliably signalling <Static> to pick up the new lines without depending on a
    // sibling store (activeBlock) changing on the same tick. Matches the pattern
    // already used in commitTurnEnd / commitUserInput / commitSystemMessage / commitError.
    const newLines = this._activeBlockAnsi.split("\n").map(line => ({
      id: this._nextId++,
      role: this._activeBlockRole!,
      ansi: line,
    }));
    this._committed = [...this._committed, ...newLines];
    // Reset active state
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._activeBlockRole = null;
    this._activeTextPartID = null;
    this.emit("changed");
  }

  clearAll(): void {
    // Stage 10.4: pre-flush debounce so no stale timer fires after clearAll.
    this._flushDebounce();
    if (this._activeTextPartID !== null) {
      this._commitActiveText();
    }
    this._committed = [];
    this._activeTextPartID = null;
    this._activeBlockRole = null;
    this._activeTextBuf = "";
    this._activeBlockAnsi = "";
    this._nonTextTail = null;
    this._openBlocks.clear();
    this._lastTextMessageID = null;
    this.emit("changed");
  }

  async dispose(): Promise<void> {
     // Stage 10.4: pre-flush debounce + flush active text block. No stale
     // timer should fire after dispose.
     this._flushDebounce();
     if (this._activeTextPartID !== null) {
       this._commitActiveText();
     }
     this._lastTextMessageID = null;
     return Promise.resolve();
   }

  rename(_newLabel: string): void { /* no-op for block-buffer backend */ }

  isOutputEnabled(key: string): boolean { return this._outputEnabled.get(key) ?? true; }

  setOutputEnabled(key: string, on: boolean): void { this._outputEnabled.set(key, on); }

  getCommitted(): CommittedLine[] { return this._committed; }
  getActiveBlock(): { role: Role; text: string } | null {
    // Early-return null covers every lifecycle path that clears the active
    // block (_commitActiveText, endBlock, commitTurnEnd, commitUserInput,
    // commitSystemMessage, commitError, clearAll, dispose).
    if (this._activeTextPartID === null) return null;

    if (this._activeBlockRole === "text") {
      // Memoisation: return the cached wrapper when the buffer string reference
      // hasn't changed. JS strings are immutable — `+=` always produces a new
      // string, so reference equality is a safe and cheap invalidation key.
      // This prevents React's useSyncExternalStore from seeing a new object
      // on every call and firing forceStoreRerender unconditionally (the
      // streaming-freeze root cause fixed in Stage 10.6).
      if (
        this._activeBlockCache !== null &&
        this._activeBlockCacheBuf === this._activeTextBuf
      ) {
        return this._activeBlockCache;
      }
      this._activeBlockCache = { role: this._activeBlockRole, text: this._activeTextBuf };
      this._activeBlockCacheBuf = this._activeTextBuf;
      return this._activeBlockCache;
    }

    // Non-text roles: _nonTextTail is already an instance-level object that is
    // only reassigned during appendToBlock, so two consecutive snapshot reads
    // return the same reference — no memoisation needed here.
    return this._nonTextTail ?? null;
  }
  getActiveBlockAnsi(): string {
    if (this._activeTextPartID === null || this._activeBlockRole === null) return "";
    // For text role, return the live-rendered ANSI. Stage 10.7 — force-flush
    // any pending debounce timer here so the returned value is ALWAYS
    // synchronised with `_activeTextBuf`, regardless of whether the throttle
    // (immediate path) or the trailing-edge timer last won. `_flushDebounce`
    // is a no-op when no timer is pending, so the React useSyncExternalStore
    // hot path (called on every `changed` emit) is unchanged in steady state
    // — the lazy render only fires when a throttle-skipped delta is the
    // newest state. Preserves C1.4 (live == commit-path render) as a
    // call-time invariant rather than an asymptotic one.
    if (this._activeBlockRole === "text") {
      this._flushDebounce();
      return this._activeBlockAnsi;
    }
    // For non-text roles, render the partial tail
    if (this._nonTextTail) {
      return formatLine(this._nonTextTail.role, this._nonTextTail.text, false);
    }
    return "";
  }
  setWidth(width: number): void { this._width = width; }
}
