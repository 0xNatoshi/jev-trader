import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Store, type Impulse } from "../src/store";

const impulse = (id: string, block = 1): Impulse => ({
  id, block, ts: Date.now(), facts: { mid: 0.02, spreadBps: 3 }, score: 55,
  status: "pass", reflex: null, jev: null, intent: null, history: [],
});

function scratch(name: string) {
  const path = `data/test-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.db`;
  return { path, done: () => rmSync(path, { force: true }) };
}

test("transitions append in order and survive a reopen", () => {
  const { path, done } = scratch("journal");
  const s = new Store(path);
  const i = impulse("abc123def456");
  s.save(i);
  s.advance(i, "scan", "pass", "score 55");
  s.advance(i, "jev", "pass", "p(buy) 61.0 pct");
  s.close();

  const again = new Store(path);
  const back = again.impulse("abc123def456");
  expect(back?.history.map((h) => h.node)).toEqual(["scan", "jev"]);
  expect(back?.history[1]?.note).toBe("p(buy) 61.0 pct");
  expect(again.counts().transitions).toBe(2);
  again.close();
  done();
});

test("the send ledger reports a send as open until the chain explains it", () => {
  const { path, done } = scratch("ledger");
  const s = new Store(path);
  const i = impulse("ledger000001");
  s.save(i);
  s.openIntent(i, { side: "buy", sizeMon: 200, price: 0.0231, txHash: null, nonce: 7, status: "sent" });
  expect(s.openIntents().length).toBe(1);

  s.updateIntent(i.id, { status: "placed", txHash: "0xdead" });
  expect(s.openIntents().length).toBe(0);
  expect(s.intent(i.id)?.nonce).toBe(7);

  s.updateIntent(i.id, { status: "unknown" });
  expect(s.openIntents().length).toBe(1);
  s.close();
  done();
});

test("the impulse payload round trips the Jev answer and the intent", () => {
  const { path, done } = scratch("payload");
  const s = new Store(path);
  const i = impulse("payload00001");
  i.jev = { action: "buy", pBuy: 0.71, pSell: 0.29, latencyMs: 812, usd: 0.0004 };
  s.save(i);
  const back = s.impulse(i.id);
  expect(back?.jev?.pBuy).toBe(0.71);
  expect(back?.score).toBe(55);
  s.close();
  done();
});

test("reflex counters aggregate by name over the recent window", () => {
  const { path, done } = scratch("reflex");
  const s = new Store(path);
  for (const [id, name] of [["r1", "low_score"], ["r2", "low_score"], ["r3", "max_spread"]] as const) {
    const i = impulse(id);
    i.reflex = name;
    s.save(i);
  }
  expect(s.reflexCounts()).toEqual({ low_score: 2, max_spread: 1 });
  s.close();
  done();
});

test("placedIntents returns exactly the orders the recovery path must verify", () => {
  const { path, done } = scratch("placed");
  const s = new Store(path);
  const i = impulse("placed000001");
  s.save(i);
  s.openIntent(i, { side: "sell", sizeMon: 200, price: 0.0231, txHash: "0xabc", nonce: 9, status: "sent" });
  expect(s.placedIntents().length).toBe(0); // sent is not placed
  s.updateIntent(i.id, { status: "placed", orderId: 4242 });
  const placed = s.placedIntents();
  expect(placed.length).toBe(1);
  expect(placed[0].order_id).toBe(4242);
  s.updateIntent(i.id, { status: "filled" });
  expect(s.placedIntents().length).toBe(0); // a filled order is off the book
  s.close();
  done();
});
