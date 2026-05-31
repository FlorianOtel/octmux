import type { Key } from "ink";
import type { LineEditor } from "./editor.ts";

// =============================================================================
// INK 5 KEY-EVENT QUIRKS
// =============================================================================
//
// Ink 5 parses raw terminal byte sequences in parse-keypress.js, then wraps
// the result in a `Key` object before handing it to useInput handlers.
// Several mappings are non-obvious and have caused real bugs; they are
// documented here so future editors know exactly what to expect.
//
// QUIRK 1 — Backspace key sends \x7f, but Ink calls it key.DELETE.
//   Most modern terminals (xterm, kitty, alacritty, macOS Terminal, tmux)
//   send the DEL character (\x7f = 127) when the user presses Backspace.
//   Ink 5 maps \x7f → key.delete = true (NOT key.backspace).
//   key.backspace only fires for \x08 (BS / Ctrl-H), which older terminals
//   and some emulators send instead.
//   The Ink source has a comment: "TODO: enquirer detects delete key as
//   backspace, but I had to split them up to avoid breaking changes in Ink.
//   Merge them back together in the next major version."
//
//   The physical Delete key sends \x1b[3~ (VT100 sequence), which Ink also
//   maps to key.delete = true with input = '' — identical to Backspace.
//   The ONLY way to distinguish them is via the raw stdin byte sequence,
//   captured before Ink processes it (see PromptInput.tsx rawSeqRef).
//   → key.delete + rawSeq==='\x1b[3~' → deleteForward (physical Delete key)
//   → key.delete + other rawSeq, or key.backspace → backspace (delete-left)
//
// QUIRK 2 — Alt-Enter does NOT set key.return.
//   Alt-Enter sends the sequence \x1b\r (ESC + CR).
//   Ink's metaKeyCodeRe only matches \x1b + single alphanumeric, so \x1b\r
//   falls through all the specific cases and is returned with name = '',
//   key.return = false, key.meta = false.
//   The leading ESC is then stripped by useInput (lines 73-75 in use-input.js),
//   leaving input = '\r' with no key flags set.
//   → Detect Alt-Enter as: !key.return && (input === '\r' || input === '\n').
//   Plain Enter, by contrast, sends \r → key.return = true, input = '\r'.
//
// QUIRK 3 — Ctrl-letter is delivered as (key.ctrl=true, input="<letter>").
//   When the user presses e.g. Ctrl-A, the terminal sends \x01.
//   Ink's parseKeypress converts it: key.ctrl = true, key.name = "a".
//   useInput then sets:  input = keypress.name = "a"  (the letter string).
//   Checking input === "\x01" for Ctrl-A therefore NEVER matches.
//   The correct check is:  key.ctrl && input === "a".
//
// =============================================================================
// BINDING TABLE
// =============================================================================
//
// The dispatch order below matters for a handful of overlapping cases:
//
//   key.return must be checked BEFORE the input === '\r' Alt-Enter fallback,
//   because plain Enter also delivers input = '\r' (just with key.return set).
//
//   key.backspace / key.delete must be checked BEFORE the Ctrl-letter block so
//   that \x08 (→ key.backspace) isn't also caught by the catch-all insert guard.
//
//   Ctrl arrow keys (key.leftArrow && key.ctrl, etc.) must come BEFORE plain
//   arrow keys so the more-specific binding wins.
//
//   The printable-character fallback at the bottom guards !key.ctrl && !key.meta
//   to prevent unhandled Ctrl/Alt combos from inserting letters into the buffer.
//
// To add a new binding:
//   1. Identify the raw byte(s) your terminal sends (run `cat -v` or a raw-mode
//      test to see what arrives).
//   2. Check how Ink 5's parseKeypress converts it (parse-keypress.js in
//      node_modules/ink/build/).  Map the raw byte(s) to the Key flags and
//      the `input` string that useInput will deliver.
//   3. Add an `else if` branch here, in the appropriate group.
//   4. Add the corresponding method to LineEditor if it doesn't exist yet.
//
// Documented keybindings:
//   Ctrl-H   → /help (live keybinding, not in config file or status line)
//   Ctrl-T   → toggle tools-output gate
//   Ctrl-Shift-T → toggle thinking-output gate
//
// =============================================================================

/**
 * Dispatch one Ink 5 key event to the appropriate LineEditor action.
 *
 * Call from a useInput handler; pass lastEscTime from a ref and store the
 * returned value back into the same ref so double-Esc detection works across
 * calls. Also pass rawSeq (the raw stdin byte sequence captured before Ink
 * processes it) so that the physical Delete key can be distinguished from
 * physical Backspace — both produce key.delete=true in Ink 5's API.
 *
 *   useInput((input, key) => {
 *     lastEscRef.current = handleKey(input, key, editor, lastEscRef.current, rawSeqRef.current, overlayOpen, callbacks);
 *   });
 *
 * Returns lastEscTime unchanged for every key except Escape, where it returns
 * the current timestamp so the next Escape within 500 ms triggers clearBuffer.
 */
export function handleKey(
  input: string,
  key: Key,
  editor: LineEditor,
  lastEscTime: number,
  rawSeq: string = '',
  overlayOpen: boolean = false,
  callbacks: {
    onCyclePermMode?: () => void;
    onHelp?: () => void;
    onToggleTools?: () => void;
    onToggleThinking?: () => void;
    onResync?: () => void;
  } = {},
): number {

  // ── Enter / newline ─────────────────────────────────────────────────────────

  if (key.return) {
    // Plain Enter: \r → key.return = true, input = '\r'.
    // At the last row of a multi-line buffer: submit. Otherwise: move down.
    if (editor.isAtBottomRow()) editor.enterOnLastRow();
    else editor.moveDownRow();

  } else if (input === "\r" || input === "\n") {
    // Alt-Enter (QUIRK 2): Ink strips ESC from \x1b\r, leaving key.return=false
    // and input='\r'. Insert a literal newline inside the buffer.
    editor.insertNewline();

  // ── Delete / backspace ───────────────────────────────────────────────────────

  } else if (key.backspace) {
    // QUIRK 1: \x08 (Ctrl-H) → key.backspace on modern terminals where physical
    // Backspace sends \x7f → key.delete instead. Repurposed as the /help shortcut.
    callbacks.onHelp?.();

  } else if (key.delete) {
    // QUIRK 1: \x7f (Backspace) → key.delete; physical Delete (\x1b[3~) also
    // gives key.delete=true. Use rawSeq to tell them apart.
    if (rawSeq === '\x1b[3~') {
      editor.deleteForward();   // physical Delete key → delete right
    } else {
      editor.backspace();       // Backspace (\x7f) → delete left
    }

  } else if (key.ctrl && input === "d") {
    // Ctrl-D: Emacs delete-char (forward delete), alternative to Delete key.
    editor.deleteForward();

  // ── Application-level keys (handled outside this module) ────────────────────

  } else if (key.ctrl && input === "c") {
    // Ctrl-C belongs to the App shell, which implements a double-press-to-exit
    // guard.  Silently ignore it here so it doesn't fall through to the insert
    // catch-all and accidentally type 'c' into the buffer.

  // ── Arrow-key navigation ─────────────────────────────────────────────────────

  } else if (key.leftArrow && key.ctrl) {
    // Ctrl-← : jump one word to the left (xterm / most terminals)
    editor.wordBackward();
  } else if (key.rightArrow && key.ctrl) {
    // Ctrl-→ : jump one word to the right
    editor.wordForward();
  } else if (key.leftArrow) {
    editor.moveBackward();   // ← : move one character left
  } else if (key.rightArrow) {
    editor.moveForward();    // → : move one character right

  } else if (key.upArrow) {
    // ↑ : at top row → recall previous history entry; otherwise move cursor up
    if (!overlayOpen) {
      if (editor.isAtTopRow()) editor.histPrev();
      else editor.moveUpRow();
    }
  } else if (key.downArrow) {
    // ↓ : at bottom row → recall next history entry; otherwise move cursor down
    if (!overlayOpen) {
      if (editor.isAtBottomRow()) editor.histNext();
      else editor.moveDownRow();
    }

  // ── Escape ───────────────────────────────────────────────────────────────────

  } else if (key.escape) {
    // Single Esc: record the timestamp.
    // Double Esc (two presses within 500 ms): clear the entire buffer.
    // This mirrors the Ctrl-G / double-Esc "abort" convention in many REPLs.
    if (!overlayOpen) {
      const now = Date.now();
      if (now - lastEscTime < 500) editor.clearBuffer();
      return now;  // propagate updated time back to the caller's ref
    }

  // ── Meta (Alt) word-movement / kill ─────────────────────────────────────────
  //
  // Ink delivers Alt-X as key.meta = true, input = "x" for most alphanumerics.
  // (Exception: Alt-Enter is QUIRK 2 above — it doesn't set key.meta.)

  } else if (key.meta && input === "b") {
    editor.wordBackward();     // Alt-B : word-backward (Emacs standard)
  } else if (key.meta && input === "f") {
    editor.wordForward();      // Alt-F : word-forward
  } else if (key.meta && input === "d") {
    editor.killWordForward();  // Alt-D : kill word forward into kill ring

  // ── Emacs / readline Ctrl bindings ──────────────────────────────────────────
  //
  // QUIRK 3: Ctrl-X → key.ctrl = true, input = "x" (the letter).
  // Do NOT use input === "\x01" etc. — those never match in Ink 5.
  //
  // Movement:
  } else if (key.ctrl && input === "a") {
    editor.moveLineStart();    // Ctrl-A : beginning of line
  } else if (key.ctrl && input === "e") {
    editor.moveLineEnd();      // Ctrl-E : end of line
  } else if (key.ctrl && input === "b") {
    editor.moveBackward();     // Ctrl-B : back one character (redundant with ←)
  } else if (key.ctrl && input === "f") {
    editor.moveForward();      // Ctrl-F : forward one character (redundant with →)
  } else if (key.ctrl && input === "p") {
    editor.histPrev();         // Ctrl-P : previous history (redundant with ↑)
  } else if (key.ctrl && input === "n") {
    editor.histNext();         // Ctrl-N : next history (redundant with ↓)

  // Kill / yank (kill ring):
  } else if (key.ctrl && input === "k") {
    editor.killToEnd();        // Ctrl-K : kill from cursor to end of line
  } else if (key.ctrl && input === "u") {
    editor.killToStart();      // Ctrl-U : kill from start of line to cursor
  } else if (key.ctrl && input === "w") {
    editor.killWordBackward(); // Ctrl-W : kill word backward into kill ring
  } else if (key.ctrl && input === "y") {
    editor.yank();             // Ctrl-Y : yank (paste) from kill ring
  } else if (key.ctrl && input === "t") {
    callbacks.onToggleTools?.();    // Ctrl-t: toggle tools output gate
  } else if (key.ctrl && input === "T") {
    callbacks.onToggleThinking?.(); // Ctrl-T: toggle thinking output gate
  } else if (key.ctrl && input === "r") {
    callbacks.onResync?.();         // Ctrl-R: manual full resync (Stage 4.5.3)

  // ── Permission mode toggle ──────────────────────────────────────────────────

  } else if (key.tab && key.shift) {
    // Shift-TAB: cycle permission mode (ask → allow → deny → ask)
    callbacks.onCyclePermMode?.();

  // ── Printable character insertion ────────────────────────────────────────────

  } else if (!key.ctrl && !key.meta && input && input >= " ") {
    // Insert any printable character.  The guards prevent unhandled Ctrl/Meta
    // combos (e.g. an unmapped Ctrl-Z) from accidentally inserting their letter
    // representation into the buffer.
    editor.insert(input);
  }

  return lastEscTime;
}
