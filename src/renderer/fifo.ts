import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type FifoHandle = {
  path: string;
  writer: fs.WriteStream;
  close: () => Promise<void>;
};

export function makeFifo(role: string, pid: number): FifoHandle {
  const p = path.join(os.tmpdir(), `octmux-${pid}-${role}.fifo`);
  try { fs.unlinkSync(p); } catch {}
  // mkfifo not in Bun/Node stdlib; use system binary (available on all Linux distros).
  execFileSync("mkfifo", [p]);
  // O_RDWR avoids blocking when no reader is attached yet (opening O_WRONLY would block).
  const fd = fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const writer = fs.createWriteStream("", { fd, autoClose: false });
  // Swallow EPIPE — the side pane may be killed by the user at any time.
  writer.on("error", () => {});
  return {
    path: p,
    writer,
    close: async () => {
      await new Promise<void>((res) => writer.end(() => res()));
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(p); } catch {}
    },
  };
}
