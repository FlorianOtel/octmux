import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Uses a regular temp file (not a FIFO) so tail -f works reliably.
// O_RDWR on a FIFO causes libuv to monitor the fd for readability, silently consuming
// data before tail can read it. A regular append-mode file has no such issue.

export type FifoHandle = {
  path: string;
  write: (data: string) => void;
  close: () => void;
};

export function makeFifo(role: string, pid: number): FifoHandle {
  const p = path.join(os.tmpdir(), `octmux-${pid}-${role}.log`);
  // Create/truncate the file at startup so each session starts clean.
  fs.writeFileSync(p, "");
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  return {
    path: p,
    write: (data: string) => { try { fs.writeSync(fd, data); } catch {} },
    close: () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(p); } catch {}
    },
  };
}
