import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type FifoHandle = {
  path: string;
  // Synchronous write — more reliable than WriteStream for O_RDWR|O_NONBLOCK FIFOs in Bun.
  write: (data: string) => void;
  close: () => void;
};

export function makeFifo(role: string, pid: number): FifoHandle {
  const p = path.join(os.tmpdir(), `octmux-${pid}-${role}.fifo`);
  try { fs.unlinkSync(p); } catch {}
  // mkfifo not in Bun/Node stdlib; use system binary (available on all Linux distros).
  execFileSync("mkfifo", [p]);
  // O_RDWR avoids blocking when no reader is attached yet (O_WRONLY would block until reader opens).
  const fd = fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  return {
    path: p,
    // fs.writeSync directly invokes the write() syscall — no stream buffering, no silent drops.
    write: (data: string) => { try { fs.writeSync(fd, data); } catch {} },
    close: () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(p); } catch {}
    },
  };
}
