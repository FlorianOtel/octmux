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
});
