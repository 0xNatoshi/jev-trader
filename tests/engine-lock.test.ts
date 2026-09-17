import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { acquireLock, pidAlive, releaseLock } from "../src/engine-lock";

const path = (name: string) => `data/test-lock-${name}-${Date.now()}.json`;

test("a live pid refuses the start, and reports who holds it", () => {
  const p = path("live");
  // pid 1 (init) always exists and we may not signal it: a live holder we must respect.
  writeFileSync(p, JSON.stringify({ pid: 1, startedAt: 1, label: "other" }));
  const held = acquireLock(p, "mine");
  expect(held?.pid).toBe(1);
  expect(held?.label).toBe("other");
  rmSync(p, { force: true });
});

test("our own pid is not a conflict: a restart keeps its lock", () => {
  const p = path("self");
  writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: 1, label: "me" }));
  expect(acquireLock(p, "me")).toBeNull();
  rmSync(p, { force: true });
});

test("a stale lock is taken over, a corrupt one too", () => {
  const p = path("stale");
  // 999999 is beyond any pid a real process can hold on macOS, so it is dead.
  writeFileSync(p, JSON.stringify({ pid: 999_999, startedAt: 1, label: "ghost" }));
  expect(acquireLock(p, "me")).toBeNull();
  expect(JSON.parse(require("node:fs").readFileSync(p, "utf8")).pid).toBe(process.pid);

  writeFileSync(p, "{ not json");
  expect(acquireLock(p, "me")).toBeNull();
  rmSync(p, { force: true });
});

test("release removes our lock, and never someone else's", () => {
  const p = path("release");
  expect(acquireLock(p, "me")).toBeNull();
  releaseLock(p);
  expect(require("node:fs").existsSync(p)).toBe(false);

  writeFileSync(p, JSON.stringify({ pid: 999_999, startedAt: 1, label: "other" }));
  releaseLock(p);
  expect(require("node:fs").existsSync(p)).toBe(true);
  rmSync(p, { force: true });
});

test("pidAlive rejects nonsense", () => {
  expect(pidAlive(0)).toBe(false);
  expect(pidAlive(-1)).toBe(false);
  expect(pidAlive(process.pid)).toBe(true);
});
