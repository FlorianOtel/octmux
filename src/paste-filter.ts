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
 */
export function createPasteFilter(realStdin: NodeJS.ReadStream): {
  stream: Transform;
  setPasteCallback: (cb: (text: string) => void) => void;
} {
  let pasteCallback: (text: string) => void = () => {};
  let state: "NORMAL" | "IN_PASTE" = "NORMAL";
  let pasteBuf = "";
  let lookAheadBuf = "";

  // Fix #8: byte-rate paste-detection fallback state
  let candidateBuf = "";
  let candidateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastByteTime = 0;

  const MARKER_START = "\x1b[200~"; // 6 characters
  const MARKER_END = "\x1b[201~";   // 6 characters
  const decoder = new StringDecoder("utf8");

  const stream = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
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
      cb();
    },
    flush(cb: (err?: Error | null) => void) {
      // Drain pending paste-detection candidate first (best-effort)
      if (candidateTimer) {
        clearTimeout(candidateTimer);
        candidateTimer = null;
        if (candidateBuf.length > 0) {
          stream.push(candidateBuf);
          candidateBuf = "";
        }
      }
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
