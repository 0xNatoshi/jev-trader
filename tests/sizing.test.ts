import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Trader } from "../src/trader";

process.env.DECISIONS_DB = `data/test-sizing-${Date.now()}.db`;

const trader: any = new Trader({ wallet: null } as any, { name: "stub", decide: async () => ({}) } as any);

const base: any = {
  block: 1, mid: 0.023, bid: 0.0229, ask: 0.0231, spreadBps: 4, imbalance: 0,
  depthBps: { "10": { bid: 0, ask: 0 }, "25": { bid: 0, ask: 0 }, "50": { bid: 0, ask: 0 } },
};

test("a thin near-touch book keeps the base (disposable) size", () => {
  const thin = { ...base, depthBps: { ...base.depthBps, "10": { bid: 150, ask: 400 } } };
  expect(trader.quoteSize(thin, "buy")).toBe(200); // 150/200 < deepDepthRatio
  expect(trader.quoteSize(thin, "sell")).toBe(200);
});

test("a deep near-touch book earns the larger size", () => {
  const deep = { ...base, depthBps: { ...base.depthBps, "10": { bid: 100_000, ask: 100_000 } } };
  expect(trader.quoteSize(deep, "buy")).toBe(400);
});

test("the side matters: only the depth we would quote against is read", () => {
  const skewed = { ...base, depthBps: { ...base.depthBps, "10": { bid: 100_000, ask: 10 } } };
  expect(trader.quoteSize(skewed, "buy")).toBe(400);
  expect(trader.quoteSize(skewed, "sell")).toBe(200);
});

test("a missing 10 bps band falls back to the base size, never a guess", () => {
  const noBands = { ...base, depthBps: {} };
  expect(trader.quoteSize(noBands, "buy")).toBe(200);
});

test("cleanup", () => {
  rmSync(process.env.DECISIONS_DB!, { force: true });
  expect(true).toBe(true);
});
