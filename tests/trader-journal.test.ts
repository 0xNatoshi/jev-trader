import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Trader } from "../src/trader";
import type { Fill } from "../src/market";

// Isolate the journal: the Store path is read when the Trader is constructed.
process.env.DECISIONS_DB = `data/test-trader-journal-${Date.now()}.db`;

/** A Trader with stub collaborators: these tests only exercise the journalling paths. */
const trader: any = new Trader({ wallet: null } as any, { name: "stub" } as any);
const book: any = { mid: 0.023, bid: 0.0229, ask: 0.0231, spreadBps: 4, bookImbalance: 0, depthBps: { "25bps": { bid: 1000, ask: 1000 } } };
const state: any = { returnsBps: { last20: 0 } };

/** Place an impulse, register a resting order for it, and journal the given fill against it. */
function fillOn(orderId: number, remainingMon: number, size = 200): { id: string; fill: Fill } {
  const i = trader.newImpulse(1000, book, state);
  trader.store.save(i);
  trader.store.openIntent(i, { side: "buy", sizeMon: size, price: 0.0229, txHash: null, nonce: null, orderId, status: "placed" });
  trader.impulseByOrder.set(orderId, i.id);
  if (remainingMon > 0) trader.orders.set(orderId, { side: "buy", price: 0.0229, size: remainingMon, block: 1000 });
  else trader.orders.delete(orderId);
  const fill = { side: "buy", size, price: 0.0229, txHash: null, orderId, simulated: true } as Fill;
  trader.journalFill(fill);
  return { id: i.id, fill };
}

test("a full fill closes the impulse with a fill transition and a filled intent", () => {
  const { id } = fillOn(-101, 0);
  const back = trader.store.impulse(id)!;
  expect(back.history.map((h: any) => h.node)).toEqual(["scan", "fill"]);
  expect(back.history.at(-1).note).toContain("buy 200.0 MON");
  expect(trader.store.intent(id)?.status).toBe("filled");
  expect(trader.impulseByOrder.has(-101)).toBe(false); // the order is gone from the book
});

test("a partial fill keeps the order on the book and says how much is left", () => {
  const { id } = fillOn(-102, 50, 150);
  const back = trader.store.impulse(id)!;
  expect(back.history.at(-1).note).toContain("50.0 MON left");
  expect(trader.store.intent(id)?.status).toBe("partial");
  expect(trader.store.placedIntents().some((r: any) => r.order_id === -102)).toBe(true);
});

test("a fill for an order we never journalled changes nothing", () => {
  const before = trader.store.counts().transitions;
  trader.journalFill({ side: "sell", size: 10, price: 0.023, txHash: null, orderId: -999, simulated: true } as Fill);
  expect(trader.store.counts().transitions).toBe(before);
});

test("cleanup", () => {
  trader.store.close();
  rmSync(process.env.DECISIONS_DB!, { force: true });
  expect(true).toBe(true);
});
