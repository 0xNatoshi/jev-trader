import { expect, test } from "bun:test";
import { RegimeMachine, type RegimeConfig } from "../src/regime";

const CFG: RegimeConfig = {
  jumpBps: 15, jumpWindowBlocks: 20, sweepRatio: 5, cooloffBlocks: 60,
  stressSpreadMult: 2.5, cooloffSpreadMult: 1.6,
};
const flat = (n: number, v = 0.023) => Array.from({ length: n }, () => v);

test("a quiet tape stays calm", () => {
  const m = new RegimeMachine(CFG, 200);
  expect(m.onBlock(1000, flat(50))).toBe("calm");
  expect(m.spreadMult).toBe(1);
  expect(m.isAcute).toBe(false);
});

test("a fast move inside the window is a jump: pause, then cool off, then calm", () => {
  const m = new RegimeMachine(CFG, 200);
  const moved = flat(30);
  moved.push(0.023 * 1.002);
  expect(m.onBlock(1000, moved)).toBe("jump");
  expect(m.isAcute).toBe(true);
  expect(m.spreadMult).toBe(2.5);

  // The jump scrolls out of the window: no new event, but the cool-off holds.
  const after = [...moved, ...flat(25, 0.023 * 1.002)];
  expect(m.onBlock(1030, after)).toBe("cooloff");
  expect(m.spreadMult).toBe(1.6);
  expect(m.isAcute).toBe(false);

  expect(m.onBlock(1061, after)).toBe("calm");
  expect(m.spreadMult).toBe(1);
});

test("a print worth many of our sizes is a sweep", () => {
  const m = new RegimeMachine({ ...CFG, sweepRatio: 5 }, 200);
  expect(m.onPrints(500, [{ size: 900, side: "buy" }])).toBe("calm"); // under 5x
  expect(m.onPrints(501, [{ size: 1500, side: "sell" }])).toBe("sweep"); // 7.5x
  expect(m.isAcute).toBe(true);
  expect(m.spreadMult).toBe(2.5);
});

test("small prints never fire, and calm prints do not disturb a cool-off", () => {
  const m = new RegimeMachine(CFG, 200);
  expect(m.onPrints(10, [{ size: 199, side: "buy" }, { size: 50, side: "sell" }])).toBe("calm");
});
