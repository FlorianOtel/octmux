import { test, expect, describe } from "bun:test";
import { createPasteFilter } from "./paste-filter";
import { Readable, PassThrough } from "node:stream";

describe("createPasteFilter", () => {
  function runTest(
    chunks: Buffer[],
    expectedCallbackText?: string,
    expectedDownstream?: string,
  ): Promise<{ callbackText: string | null; downstreamText: string }> {
    return new Promise((resolve) => {
      const mockStdin = new PassThrough();
      const filter = createPasteFilter(mockStdin);

      let callbackText: string | null = null;
      let downstreamText = "";

      filter.setPasteCallback((text) => {
        callbackText = text;
      });

      filter.stream.on("data", (chunk: Buffer) => {
        downstreamText += chunk.toString();
      });

      filter.stream.on("end", () => {
        resolve({ callbackText, downstreamText });
      });

      // Send chunks and end the stream
      for (const chunk of chunks) {
        mockStdin.write(chunk);
      }
      mockStdin.end();
    });
  }

  test("single-line paste", async () => {
    const result = await runTest([Buffer.from("\x1b[200~hello world\x1b[201~")]);
    expect(result.callbackText).toBe("hello world");
    expect(result.downstreamText).toBe("");
  });

  test("multi-line paste", async () => {
    const result = await runTest([Buffer.from("\x1b[200~line1\nline2\x1b[201~")]);
    expect(result.callbackText).toBe("line1\nline2");
    expect(result.downstreamText).toBe("");
  });

  test("\\r\\n normalization", async () => {
    const result = await runTest([Buffer.from("\x1b[200~a\r\nb\x1b[201~")]);
    expect(result.callbackText).toBe("a\nb");
  });

  test("marker split across chunks", async () => {
    const result = await runTest([
      Buffer.from("\x1b[20"),
      Buffer.from("0~hi\x1b[201~"),
    ]);
    expect(result.callbackText).toBe("hi");
    expect(result.downstreamText).toBe("");
  });

  test("non-paste passthrough", async () => {
    const result = await runTest([Buffer.from("hello")]);
    expect(result.callbackText).toBeNull();
    expect(result.downstreamText).toBe("hello");
  });

  test("control-byte strip", async () => {
    const result = await runTest([Buffer.from("\x1b[200~te\x01xt\x1b[201~")]);
    expect(result.callbackText).toBe("text");
  });

  test("tab and newline preserved", async () => {
    const result = await runTest([Buffer.from("\x1b[200~a\tb\nc\x1b[201~")]);
    expect(result.callbackText).toBe("a\tb\nc");
  });

  test("truncation recovery", async () => {
    // Test: IN_PASTE state with orphan \x1b at chunk boundary
    // The orphan \x1b is held in lookAheadBuf; next chunk shows it's not the end marker
    const result = await runTest([
      Buffer.from("\x1b[200~paste\x1b"),  // paste ends with orphan \x1b
      Buffer.from("[123"),                 // starts with [, not the continuation of end marker
    ]);
    // The orphan \x1b is held. Next chunk: \x1b[123 is not \x1b[201~.
    // Since no end marker is ever found, pasteBuf accumulates: "paste" + "[123"
    // No callback fires (no end marker, no flush). All goes to pasteBuf.
    // Since stream ends without closing marker, callback never fires.
    expect(result.callbackText).toBeNull();
  });

  test("bare \\r normalization", async () => {
    const result = await runTest([Buffer.from("\x1b[200~a\rb\x1b[201~")]);
    expect(result.callbackText).toBe("a\nb");
  });

  test("multiple pastes in sequence", async () => {
    let callCount = 0;
    let lastText = "";

    return new Promise((resolve) => {
      const mockStdin = new PassThrough();
      const filter = createPasteFilter(mockStdin);

      filter.setPasteCallback((text) => {
        callCount++;
        lastText = text;
      });

      let downstreamText = "";
      filter.stream.on("data", (chunk: Buffer) => {
        downstreamText += chunk.toString();
      });

      filter.stream.on("end", () => {
        expect(callCount).toBe(2);
        expect(lastText).toBe("second paste");
        expect(downstreamText).toBe("between");
        resolve(undefined);
      });

      mockStdin.write(Buffer.from("\x1b[200~first paste\x1b[201~"));
      mockStdin.write(Buffer.from("between"));
      mockStdin.write(Buffer.from("\x1b[200~second paste\x1b[201~"));
      mockStdin.end();
    });
  });

  test("empty paste", async () => {
    const result = await runTest([Buffer.from("\x1b[200~\x1b[201~")]);
    expect(result.callbackText).toBe("");
    expect(result.downstreamText).toBe("");
  });

  // Stage 3E.7.1 — paste atomicity hotfixes

  test("Fix #2 — trailing whitespace per line is stripped from paste", async () => {
    const result = await runTest([Buffer.from("\x1b[200~line1   \t  \nline2\t\nline3   \x1b[201~")]);
    expect(result.callbackText).toBe("line1\nline2\nline3");
    expect(result.downstreamText).toBe("");
  });

  test("Fix #4 — StringDecoder reassembles multi-byte UTF-8 split across chunks", async () => {
    // The em-dash "—" is U+2014, UTF-8 bytes E2 80 94 (3 bytes).
    // Split paste across two chunks where the em-dash straddles the boundary.
    const result = await runTest([
      Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0x61, 0xe2, 0x80]), // "\x1b[200~a" + first 2 bytes of em-dash
      Buffer.from([0x94, 0x62, 0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]),        // last byte of em-dash + "b\x1b[201~"
    ]);
    expect(result.callbackText).toBe("a—b");
    expect(result.downstreamText).toBe("");
  });
});

// Lone-ESC release (Stage 15.2 F-a). A held NORMAL-state ESC must reach downstream when no
// continuation arrives, while real markers and escape sequences keep their existing handling.
describe("createPasteFilter: lone ESC release", () => {
  // Short timeout keeps these tests fast; the wait below is comfortably longer than it.
  const ESC_TIMEOUT_MS = 30;
  const WAIT_PAST_TIMEOUT_MS = 90;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Builds a filter over a PassThrough and collects downstream bytes and paste callbacks. */
  function setup() {
    const mockStdin = new PassThrough();
    const filter = createPasteFilter(mockStdin as unknown as NodeJS.ReadStream, { escTimeoutMs: ESC_TIMEOUT_MS });
    const pastes: string[] = [];
    let downstream = "";
    filter.setPasteCallback((text) => pastes.push(text));
    filter.stream.on("data", (chunk: Buffer) => {
      downstream += chunk.toString();
    });
    return {
      mockStdin,
      filter,
      pastes,
      downstream: () => downstream,
    };
  }

  test("a lone ESC is flushed downstream after the timeout", async () => {
    const { mockStdin, downstream } = setup();
    mockStdin.write(Buffer.from("\x1b"));
    // Nothing is forwarded while the ESC is still held inside the timeout window.
    await sleep(5);
    expect(downstream()).toBe("");
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(downstream()).toBe("\x1b");
    mockStdin.end();
  });

  test("ESC followed quickly by a bracketed paste is handled as a paste", async () => {
    const { mockStdin, pastes, downstream } = setup();
    mockStdin.write(Buffer.from("\x1b"));
    mockStdin.write(Buffer.from("[200~hello\x1b[201~"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(pastes).toEqual(["hello"]);
    expect(downstream()).toBe("");
    mockStdin.end();
  });

  test("ESC followed quickly by an arrow key is forwarded unchanged", async () => {
    const { mockStdin, pastes, downstream } = setup();
    mockStdin.write(Buffer.from("\x1b"));
    mockStdin.write(Buffer.from("[A"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(pastes).toEqual([]);
    expect(downstream()).toBe("\x1b[A");
    mockStdin.end();
  });

  test("ESC then Ctrl-C after the timeout: both forwarded, in order", async () => {
    const { mockStdin, downstream } = setup();
    mockStdin.write(Buffer.from("\x1b"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    mockStdin.write(Buffer.from("\x03"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(downstream()).toBe("\x1b\x03");
    mockStdin.end();
  });

  test("ESC then a non-matching byte within the timeout: both forwarded, nothing dropped", async () => {
    const { mockStdin, downstream } = setup();
    mockStdin.write(Buffer.from("\x1b"));
    mockStdin.write(Buffer.from("x"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(downstream()).toBe("\x1bx");
    mockStdin.end();
  });

  test("a held partial marker (ESC [ 2) is released after the timeout too", async () => {
    const { mockStdin, downstream } = setup();
    mockStdin.write(Buffer.from("\x1b[2"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(downstream()).toBe("\x1b[2");
    mockStdin.end();
  });

  test("ESC held at stream end is emitted before the stream ends, and no timer fires after", async () => {
    const mockStdin = new PassThrough();
    const filter = createPasteFilter(mockStdin as unknown as NodeJS.ReadStream, { escTimeoutMs: ESC_TIMEOUT_MS });
    let downstream = "";
    // Captured as an array so TypeScript does not narrow a single variable to null.
    const downstreamAtEnd: string[] = [];
    filter.stream.on("data", (chunk: Buffer) => {
      downstream += chunk.toString();
    });
    filter.stream.on("end", () => {
      downstreamAtEnd.push(downstream);
    });
    mockStdin.write(Buffer.from("\x1b"));
    mockStdin.end();
    await sleep(WAIT_PAST_TIMEOUT_MS);
    // The ESC is emitted exactly once, by flush(), before end; the timer never double-pushes.
    expect(downstreamAtEnd).toEqual(["\x1b"]);
    expect(downstream).toBe("\x1b");
  });

  test("ESC held while a paste is in progress is not released by the timeout", async () => {
    const { mockStdin, pastes, downstream } = setup();
    // The paste opens, then its tail holds an orphan ESC (state IN_PASTE). The timeout must not
    // release it, because the next chunk may complete the end marker.
    mockStdin.write(Buffer.from("\x1b[200~abc\x1b"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    mockStdin.write(Buffer.from("[201~"));
    await sleep(WAIT_PAST_TIMEOUT_MS);
    expect(pastes).toEqual(["abc"]);
    expect(downstream()).toBe("");
    mockStdin.end();
  });
});
