import { expect, test } from "bun:test";
import { horizonVolBps, quotePlan, type QuoteTuning } from "../src/quoting";

const T: QuoteTuning = {
  gamma: 0.6, horizonBlocks: 100, liqHalfSpreadBps: 1.5, minHalfSpreadBps: 0.5,
  maxDistanceBps: 6, insideTicks: 1, tickSize: 100, priceDec: 8,
};
const base = {
  mid: 0.023, bestBid: 0.022975, bestAsk: 0.023025,
  inventoryMon: 0, maxPositionMon: 1000, sigmaBps: 2,
};

test("flat and calm: the ladder steps one tick inside the touch", () => {
  const p = quotePlan(base, T);
  expect(p.bid).toBeCloseTo(base.bestBid + 0.000001, 9);
  expect(p.ask).toBeCloseTo(base.bestAsk - 0.000001, 9);
  expect(p.skewBps).toBe(0);
});

test("long inventory shifts the ladder down, short inventory up", () => {
  const long = quotePlan({ ...base, inventoryMon: 800 }, T);
  const short = quotePlan({ ...base, inventoryMon: -800 }, T);
  expect(long.reservation).toBeLessThan(base.mid);
  expect(short.reservation).toBeGreaterThan(base.mid);
  expect(long.ask).toBeLessThanOrEqual(quotePlan(base, T).ask);
  expect(short.bid).toBeGreaterThanOrEqual(quotePlan(base, T).bid);
});

test("volatility widens the half-spread and backs us off the touch", () => {
  const calm = quotePlan({ ...base, sigmaBps: 1 }, T);
  const wild = quotePlan({ ...base, sigmaBps: 30 }, T);
  expect(wild.deltaBps).toBeGreaterThan(calm.deltaBps);
  expect(wild.bid).toBeLessThan(calm.bid);
  expect(wild.ask).toBeGreaterThan(calm.ask);
});

test("never crosses and never leaves the maxDistance band, whatever the state", () => {
  const maxD = (T.maxDistanceBps / 1e4) * base.mid;
  for (const inventoryMon of [-1000, -100, 0, 100, 1000]) {
    for (const sigmaBps of [0, 2, 50, 1000]) {
      const p = quotePlan({ ...base, inventoryMon, sigmaBps }, T);
      expect(p.bid).toBeLessThan(p.ask);
      expect(p.bid).toBeLessThanOrEqual(base.bestAsk - 1e-9);
      expect(p.ask).toBeGreaterThanOrEqual(base.bestBid + 1e-9);
      expect(base.bestBid - p.bid).toBeLessThanOrEqual(maxD + 1e-9);
      expect(p.ask - base.bestAsk).toBeLessThanOrEqual(maxD + 1e-9);
    }
  }
});

test("horizon volatility: zero without a tape, positive with one", () => {
  expect(horizonVolBps([0.023, 0.023], 100)).toBe(0);
  const wobble = [0.023, 0.0231, 0.0229, 0.0232, 0.023, 0.0233];
  expect(horizonVolBps(wobble, 2)).toBeGreaterThan(0);
  // A series that always returns to the same level has no horizon volatility at
  // that horizon, however much it jitters block by block.
  expect(horizonVolBps([0.023, 0.024, 0.023, 0.024, 0.023, 0.024], 2)).toBe(0);
  expect(horizonVolBps([0.023, 0.023, 0.023, 0.023, 0.023], 2)).toBe(0);
});
