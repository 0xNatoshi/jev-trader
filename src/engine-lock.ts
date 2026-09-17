import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * One engine per host, enforced instead of hoped for.
 *
 * poly-maker's field guide lists this first among self-inflicted losses: two
 * processes quoting the same market double the orders, fight over the same cancel
 * sets and make every log line ambiguous. A port check is not enough (a second
 * instance dies on the bind AFTER it has already written state). This is a pid file:
 * a live pid refuses the start, a stale one is taken over.
 */

export interface LockInfo {
  pid: number;
  startedAt: number;
  label: string;
}

const readLock = (path: string): LockInfo | null => {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.pid === "number") return raw as LockInfo;
  } catch {
    // Corrupt lock: treat as stale rather than blocking forever.
  }
  return null;
};

/** Is that pid still running? Signal 0 probes without touching it. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and we are simply not allowed to signal it.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Try to become the engine. Returns the previous holder when another live process
 * owns the lock, null when we now own it (a stale lock is overwritten).
 */
export function acquireLock(path: string, label = "engine"): LockInfo | null {
  const held = readLock(path);
  if (held && held.pid !== process.pid && pidAlive(held.pid)) return held;
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now(), label } satisfies LockInfo));
  return null;
}

/** Release only our own lock: never delete a lock a newer process took over. */
export function releaseLock(path: string): void {
  const held = readLock(path);
  if (held && held.pid === process.pid) rmSync(path, { force: true });
}
