import { Transform } from "node:stream";

type WheelDir = "up" | "down";
type WheelHandler = (dir: WheelDir) => void;

const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Intercepts SGR mouse sequences from `source`, fires onWheel for wheel events,
// and passes cleaned bytes (sequences stripped) downstream for Ink to read.
export function attachMouseStream(
  source: NodeJS.ReadStream,
  onWheel: WheelHandler,
): NodeJS.ReadStream {
  const t = new Transform({
    transform(chunk, _enc, cb) {
      const s = chunk.toString("utf8");
      let cleaned = "";
      let lastIdx = 0;
      for (const m of s.matchAll(MOUSE_RE)) {
        cleaned += s.slice(lastIdx, m.index);
        const btn = parseInt(m[1], 10);
        if (m[4] === "M") {
          if (btn === 64) onWheel("up");
          else if (btn === 65) onWheel("down");
        }
        lastIdx = m.index! + m[0].length;
      }
      cleaned += s.slice(lastIdx);
      cb(null, cleaned);
    },
  });

  // Copy TTY properties and methods from source to transform
  const tAny = t as any;
  const sourceAny = source as any;

  tAny.isTTY = sourceAny.isTTY ?? false;
  tAny.isRaw = sourceAny.isRaw ?? false;

  // Forward setRawMode calls to the underlying source
  if (typeof sourceAny.setRawMode === "function") {
    tAny.setRawMode = (mode: boolean) => {
      sourceAny.setRawMode(mode);
      tAny.isRaw = mode;
      return t;
    };
  }

  source.pipe(t);
  return t as unknown as NodeJS.ReadStream;
}
