import { expect, test } from "bun:test";
import { marketScore, type ScoreFacts } from "../src/score";

const tight: ScoreFacts = {
  spreadBps: 1, depthBidMon: 8000, depthAskMon: 8000, bookImbalance: 0.05,
  ret20Bps: 2, exposureMon: 100, maxPositionMon: 1000, tradeSizeMon: 200,
};

test("a tight, deep, balanced book beats a wide, thin, one sided one", () => {
  const good = marketScore(tight).score;
  const bad = marketScore({ spreadBps: 20, depthBidMon: 100, depthAskMon: 100, bookImbalance: 0.9, ret20Bps: 120, exposureMon: 950, maxPositionMon: 1000, tradeSizeMon: 200 }).score;
  expect(good).toBeGreaterThan(70);
  expect(bad).toBeLessThan(25);
});

test("the score is deterministic: same facts, same score and same parts", () => {
  const a = marketScore(tight), b = marketScore(tight);
  expect(a.score).toBe(b.score);
  expect(a.parts).toEqual(b.parts);
});

test("the score stays inside 0..100 whatever the book does", () => {
  const extremes: ScoreFacts[] = [
    tight,
    { ...tight, spreadBps: 100, depthBidMon: 0, depthAskMon: 0, bookImbalance: 1, ret20Bps: 900, exposureMon: 5000 },
    { ...tight, spreadBps: 0.1, depthBidMon: 1e6, depthAskMon: 1e6, bookImbalance: 0, ret20Bps: 0, exposureMon: 0 },
  ];
  for (const f of extremes) {
    const s = marketScore(f).score;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  }
});

test("the parts explain the score: base 50 plus their deltas, clamped", () => {
  for (const f of [tight, { ...tight, spreadBps: 12, ret20Bps: 60, exposureMon: 900 }]) {
    const r = marketScore(f);
    const sum = r.parts.reduce((s, p) => s + p.delta, 0);
    expect(r.score).toBe(Math.max(0, Math.min(100, 50 + sum)));
  }
});

test("size awareness: the same book scores lower when we quote bigger", () => {
  const small = marketScore({ ...tight, tradeSizeMon: 100 }).score;
  const big = marketScore({ ...tight, tradeSizeMon: 5000 }).score;
  expect(big).toBeLessThan(small);
});
