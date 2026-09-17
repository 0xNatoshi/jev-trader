import { expect, test } from "bun:test";
import { queueAheadAt, simulateFills, type SimOrder } from "../src/fills";

const TICK = 1e-6;
const print = (block: number, price: number, size: number, side: "buy" | "sell") => ({ block, price, size, side });

test("the queue in front of us trades first", () => {
  const orders = new Map<number, SimOrder>([[1, { side: "buy", price: 0.023, size: 200, block: 10, queueAheadMon: 500 }]]);
  expect(simulateFills([print(11, 0.023, 200, "sell")], orders, TICK).length).toBe(0);
  expect(orders.get(1)!.queueAheadMon).toBe(300);

  const fills = simulateFills([print(12, 0.023, 400, "sell")], orders, TICK);
  expect(fills.length).toBe(1);
  expect(fills[0].size).toBe(100);
  expect(orders.get(1)!.queueAheadMon).toBe(0);
  expect(orders.get(1)!.size).toBe(100);
});

test("a print through our price sweeps the level, queue or not", () => {
  const orders = new Map<number, SimOrder>([[1, { side: "buy", price: 0.023, size: 200, block: 10, queueAheadMon: 5000 }]]);
  const fills = simulateFills([print(11, 0.0229, 150, "sell")], orders, TICK);
  expect(fills.length).toBe(1);
  expect(fills[0].size).toBe(150);
  expect(orders.get(1)!.queueAheadMon).toBe(0);
});

test("we cannot be filled before our own block", () => {
  const orders = new Map<number, SimOrder>([[1, { side: "sell", price: 0.023, size: 200, block: 10 }]]);
  expect(simulateFills([print(10, 0.0231, 500, "buy")], orders, TICK).length).toBe(0);
  expect(simulateFills([print(11, 0.0231, 500, "buy")], orders, TICK).length).toBe(1);
});

test("a fully filled order leaves the book", () => {
  const orders = new Map<number, SimOrder>([[7, { side: "sell", price: 0.023, size: 100, block: 1 }]]);
  simulateFills([print(2, 0.024, 500, "buy")], orders, TICK);
  expect(orders.size).toBe(0);
});

test("queueAheadAt reads the resting size at our price, and only there", () => {
  const bids: [number, number][] = [[0.023, 900], [0.02299, 400], [0.02298, 100]];
  expect(queueAheadAt(bids, 0.023, TICK)).toBe(900);
  expect(queueAheadAt(bids, 0.0230005, TICK)).toBe(900);
  expect(queueAheadAt(bids, 0.023001, TICK)).toBe(0);
  expect(queueAheadAt(bids, 0.022985, TICK)).toBe(0);
});
