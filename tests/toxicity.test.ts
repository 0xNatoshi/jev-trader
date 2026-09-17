import { expect, test } from "bun:test";
import { FlowToxicity } from "../src/toxicity";

const p = (block: number, sizeMon: number, side: "buy" | "sell") => ({ block, sizeMon, side });

test("one-sided flow reads as toxic, two-sided flow reads as calm", () => {
  const toxic = new FlowToxicity(100, 10);
  for (let i = 0; i < 10; i++) toxic.add(p(1, 20, "buy"));
  expect(toxic.value(1)).toBeCloseTo(1, 6);

  const calm = new FlowToxicity(100, 10);
  for (let i = 0; i < 10; i++) {
    calm.add(p(1, 20, "buy"));
    calm.add(p(1, 20, "sell"));
  }
  expect(calm.value(1)!).toBeLessThan(0.05);
});

test("a large single print no longer saturates the reading (the VPIN artefact)", () => {
  const f = new FlowToxicity(100, 10);
  f.add(p(1, 5000, "buy")); // one whale print
  f.add(p(1, 5000, "sell"));
  f.add(p(1, 5000, "buy"));
  expect(f.value(1)!).toBeLessThan(0.4); // net 5000 over gross 15000
});

test("null until there is enough tape, and until three prints exist", () => {
  const f = new FlowToxicity(100, 1000);
  expect(f.value(1)).toBeNull();
  f.add(p(1, 400, "buy"));
  expect(f.value(1)).toBeNull(); // volume below the floor
  f.add(p(1, 400, "buy"));
  f.add(p(1, 400, "buy"));
  expect(f.value(1)).not.toBeNull();
});

test("the window slides: old prints stop counting", () => {
  const f = new FlowToxicity(100, 10);
  for (let i = 0; i < 5; i++) f.add(p(10, 20, "buy"));
  expect(f.value(50)!).toBeCloseTo(1, 6);
  // 150 blocks later the window has moved past all of them
  expect(f.value(200)).toBeNull();
  expect(f.printCount).toBe(0);
});

test("the signed reading tells which side the flow favours", () => {
  const f = new FlowToxicity(100, 10);
  f.add(p(1, 30, "buy"));
  f.add(p(1, 10, "sell"));
  f.add(p(1, 10, "buy"));
  expect(f.signed(1)!).toBeCloseTo((40 - 10) / 50, 6);
  expect(f.value(1)).toBeCloseTo(Math.abs(40 - 10) / 50, 6);
});

test("zero or negative sizes are ignored", () => {
  const f = new FlowToxicity(100, 10);
  f.add(p(1, 0, "buy"));
  f.add(p(1, -5, "sell"));
  expect(f.printCount).toBe(0);
  expect(f.value(1)).toBeNull();
});
