import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Bracketed-paste filter: intercepts paste sequences and routes them to a callback.
 *
 * Paste markers: `\x1b[200~` (start, 6 chars) and `\x1b[201~` (end, 6 chars)
 * State machine: NORMAL ↔ IN_PASTE
 *   - NORMAL: scan for start marker; route bytes before it downstream
 *   - IN_PASTE: accumulate bytes; scan for end marker; on match, normalize and invoke callback
 * Normalization: \r\n → \n, bare \r → \n, drop [\\x00-\\x08\\x0b-\\x1f\\x7f] (keep \\t=0x09, \\n=0x0a)
 * Truncation recovery: orphan \\x1b mid-paste → flush accumulated data and re-process
 * Lone-ESC release: in NORMAL state a held prefix (a lone \\x1b, or a partial marker such
 *   as \\x1b[2) is flushed downstream after `escTimeoutMs` with no further bytes. Real
 *   paste markers and escape sequences arrive in one read, so the timeout only fires for
 *   a bare Esc keypress. Without it the Esc key never reaches Ink's useInput.
 */

/** Default wait for the rest of an escape sequence before a held ESC is released. */
const DEFAULT_ESC_TIMEOUT_MS = 40;

export function createPasteFilter(
  realStdin: NodeJS.ReadStream,
  options: { escTimeoutMs?: number } = {},
): {
  stream: Transform;
  setPasteCallback: (cb: (text: string) => void) => void;
} {
  const escTimeoutMs = options.escTimeoutMs ?? DEFAULT_ESC_TIMEOUT_MS;
  let pasteCallback: (text: string) => void = () => {};
  let state: "NORMAL" | "IN_PASTE" = "NORMAL";
  let pasteBuf = "";
  let lookAheadBuf = "";

  // Lone-ESC release timer: armed while NORMAL state holds bytes in lookAheadBuf.
  let heldTimer: ReturnType<typeof setTimeout> | null = null;

  // Fix #8: byte-rate paste-detection fallback state
  let candidateBuf = "";
  let candidateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastByteTime = 0;

  const MARKER_START = "\x1b[200~"; // 6 characters
  const MARKER_END = "\x1b[201~";   // 6 characters
  const decoder = new StringDecoder("utf8");

  /** Cancels the lone-ESC release timer if one is pending. */
  function clearHeldTimer(): void {
    if (heldTimer) {
      clearTimeout(heldTimer);
      heldTimer = null;
    }
  }

  /**
   * Pushes the NORMAL-state held bytes downstream as plain input. Any pending paste-fallback
   * candidate is drained first so the held bytes keep their arrival order. No-op in IN_PASTE
   * state: there the held byte may be part of a paste that is still arriving.
   */
  function flushHeldBytes(): void {
    if (state !== "NORMAL" || lookAheadBuf.length === 0) return;
    if (candidateTimer) {
      clearTimeout(candidateTimer);
      candidateTimer = null;
    }
    if (candidateBuf.length > 0) {
      stream.push(candidateBuf);
      candidateBuf = "";
    }
    stream.push(lookAheadBuf);
    lookAheadBuf = "";
  }

  /** (Re)arms the release timer; when it fires with no new bytes, the held bytes are flushed. */
  function armHeldTimer(): void {
    clearHeldTimer();
    heldTimer = setTimeout(() => {
      heldTimer = null;
      flushHeldBytes();
    }, escTimeoutMs);
  }

  const stream = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
      // A new chunk arrived in time: the held bytes will be re-processed with it below.
      clearHeldTimer();
      const chunkStr = decoder.write(chunk);
      let input = lookAheadBuf + chunkStr;
      lookAheadBuf = "";

      // Fix #8: track inter-byte timing for paste-detection fallback
      const now = Date.now();
      const interByteGap = now - lastByteTime;
      lastByteTime = now;

      let outputBuf = "";

      while (input.length > 0) {
        if (state === "NORMAL") {
          // Scan for start marker
          const startIdx = input.indexOf(MARKER_START);
          if (startIdx === -1) {
            // No marker found; check if we end with a potential start of marker
            let holdLen = 0;
            // Check for partial markers: \x1b, \x1b[, \x1b[2, \x1b[20, \x1b[200
            if (input.endsWith("\x1b")) holdLen = 1;
            else if (input.endsWith("\x1b[")) holdLen = 2;
            else if (input.endsWith("\x1b[2")) holdLen = 3;
            else if (input.endsWith("\x1b[20")) holdLen = 4;
            else if (input.endsWith("\x1b[200")) holdLen = 5;
            else if (input.endsWith("\x1b[200~")) holdLen = 6; // full marker (shouldn't happen)

            if (holdLen > 0) {
              outputBuf += input.slice(0, input.length - holdLen);
              lookAheadBuf = input.slice(input.length - holdLen);
            } else {
              outputBuf += input;
            }
            break;
          }
          // Marker found at position startIdx
          // Output everything before the marker
          if (startIdx > 0) {
            outputBuf += input.slice(0, startIdx);
          }
          state = "IN_PASTE";
          pasteBuf = "";
          // Skip marker and continue processing what comes after
          input = input.slice(startIdx + MARKER_START.length);
        } else {
          // IN_PASTE: scan for end marker
          const endIdx = input.indexOf(MARKER_END);
          if (endIdx === -1) {
            // No end marker yet; check for orphan \x1b (truncation recovery)
            const orphanIdx = input.lastIndexOf("\x1b");
            if (orphanIdx > 0) {
              // Safe: has content before orphan
              pasteBuf += input.slice(0, orphanIdx);
              lookAheadBuf = input.slice(orphanIdx);
              break;
            } else if (orphanIdx === 0) {
              // Orphan at start: might be start of marker in next chunk
              lookAheadBuf = input;
              break;
            } else {
              // No orphan: accumulate everything
              pasteBuf += input;
              break;
            }
          }
          // End marker found at position endIdx
          pasteBuf += input.slice(0, endIdx);
          state = "NORMAL";
          // Normalize: \r\n → \n, bare \r → \n, strip control bytes (0x00-0x08, 0x0b-0x1f, 0x7f)
          // Keep 0x09 (tab) and 0x0a (newline)
          const normalized = pasteBuf
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
            .split("\n")
            .map(l => l.trimEnd())
            .join("\n");
          pasteCallback(normalized);
          pasteBuf = "";
          // Continue processing after the marker
          input = input.slice(endIdx + MARKER_END.length);
        }
      }

      if (outputBuf.length > 0) {
        // Fix #8: byte-rate paste-detection fallback. If bytes arrive faster than
        // a human types (5ms inter-byte) AND total accumulation > 10 bytes, treat
        // the burst as a paste rather than per-character input. Drain through
        // pasteCallback on a 20ms quiet-gap timer.
        const shouldBuffer = state === "NORMAL" && interByteGap < 5 && (candidateBuf.length + outputBuf.length) > 10;
        if (shouldBuffer) {
          candidateBuf += outputBuf;
          if (candidateTimer) clearTimeout(candidateTimer);
          candidateTimer = setTimeout(() => {
            candidateTimer = null;
            if (candidateBuf.length > 10) {
              // Normalize same as bracketed-paste: line endings + control bytes + trim trailing whitespace per line
              const normalized = candidateBuf
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n")
                .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
                .split("\n")
                .map(l => l.trimEnd())
                .join("\n");
              pasteCallback(normalized);
            } else {
              // Below threshold on drain: pass through as normal stdin bytes.
              stream.push(candidateBuf);
            }
            candidateBuf = "";
          }, 20);
        } else {
          // If we have a pending candidateBuf but this byte breaks the rate, drain it normally first.
          if (candidateBuf.length > 0) {
            if (candidateTimer) { clearTimeout(candidateTimer); candidateTimer = null; }
            stream.push(candidateBuf);
            candidateBuf = "";
          }
          stream.push(outputBuf);
        }
      }
      // Bytes still held in NORMAL state wait for a continuation; release them if none comes.
      if (state === "NORMAL" && lookAheadBuf.length > 0) armHeldTimer();
      cb();
    },
    flush(cb: (err?: Error | null) => void) {
      // The stream is ending: no release timer may fire after this point.
      clearHeldTimer();
      // Drain pending paste-detection candidate first (best-effort)
      if (candidateTimer) {
        clearTimeout(candidateTimer);
        candidateTimer = null;
        if (candidateBuf.length > 0) {
          stream.push(candidateBuf);
          candidateBuf = "";
        }
      }
      // A held NORMAL-state byte (e.g. a lone ESC) is real input: emit it before ending.
      flushHeldBytes();
      const tail = decoder.end();
      if (tail) this.push(tail);
      cb();
    },
  });

  // Delegate TTY methods to realStdin so Ink can call setRawMode, isTTY, etc.
  Object.defineProperty(stream, "isTTY", {
    get() { return (realStdin as any).isTTY; },
  });
  Object.defineProperty(stream, "isRaw", {
    get() { return (realStdin as any).isRaw; },
  });

  stream.setRawMode = function (mode: boolean) {
    (realStdin as any).setRawMode?.(mode);
    return stream;
  };

  stream.setEncoding = function (encoding: BufferEncoding) {
    (realStdin as any).setEncoding?.(encoding);
    return stream;
  };

  stream.ref = function () {
    (realStdin as any).ref?.();
    return stream;
  };

  stream.unref = function () {
    (realStdin as any).unref?.();
    return stream;
  };

  // Pipe the real stdin into the Transform so it sees all input.
  realStdin.pipe(stream);

  return {
    stream,
    setPasteCallback: (cb: (text: string) => void) => {
      pasteCallback = cb;
    },
  };
}
