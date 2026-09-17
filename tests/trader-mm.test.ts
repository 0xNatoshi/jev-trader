import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { config } from "../src/config";

// Isolated journal, same trick as the fill tests.
process.env.DECISIONS_DB = `data/test-mm-${Date.now()}.db`;
const { Trader } = await import("../src/trader");

const trader: any = new Trader({ wallet: null } as any, { name: "stub" } as any);

test("a buy fill is decomposed into capture and markout", () => {
  trader.markoutQueue.push({ block: 100, side: "buy", price: 0.0228, size: 200, mid: 0.023, impulseId: null });
  trader.resolveMarkouts(100 + config.markoutBlocks, 0.0231);
  const mm = trader.totals.mm;
  expect(mm.n).toBe(1);
  expect(mm.captureUsd).toBeCloseTo((0.023 - 0.0228) * 200, 8); // 0.04 USD quoted below the mid
  expect(mm.markoutUsd).toBeCloseTo((0.0231 - 0.023) * 200, 8); // +0.02 USD: the mid drifted our way
  expect(mm.captureBps).toBeCloseTo(((0.023 - 0.0228) / 0.023) * 1e4, 4);
  expect(mm.markoutBps).toBeCloseTo(((0.0231 - 0.023) / 0.023) * 1e4, 4);
});

test("a sell fill run over by the flow shows as negative markout", () => {
  const before = trader.totals.mm.markoutUsd;
  trader.markoutQueue.push({ block: 100, side: "sell", price: 0.0232, size: 100, mid: 0.023, impulseId: null });
  trader.resolveMarkouts(100 + config.markoutBlocks, 0.0235); // the mid rose against our short
  const delta = trader.totals.mm.markoutUsd - before;
  expect(delta).toBeCloseTo(-(0.0235 - 0.023) * 100, 8);
});

test("nothing is resolved before the markout horizon", () => {
  trader.markoutQueue.push({ block: 500, side: "buy", price: 0.0229, size: 200, mid: 0.023, impulseId: null });
  const n = trader.totals.mm.n;
  trader.resolveMarkouts(500 + config.markoutBlocks - 1, 0.03);
  expect(trader.totals.mm.n).toBe(n); // too early: the markout is not known yet
  expect(trader.markoutQueue.length).toBe(1);
  trader.resolveMarkouts(500 + config.markoutBlocks, 0.03);
  expect(trader.totals.mm.n).toBe(n + 1);
});

test("inventory carry is marked block by block and skips the first block", () => {
  trader.position.mon = 100;
  trader.markCarry(0.02);
  expect(trader.totals.mm.carryUsd).toBe(0); // no previous mid: nothing to mark
  trader.markCarry(0.0201);
  expect(trader.totals.mm.carryUsd).toBeCloseTo(100 * 0.0001, 8);
});

test("cleanup", () => {
  rmSync(process.env.DECISIONS_DB!, { force: true });
  expect(true).toBe(true);
});
