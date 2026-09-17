import { expect, test } from "bun:test";
import { checkReflexes, defaultReflexes, reflexesFor, type ReflexFacts } from "../src/reflexes";

const base: ReflexFacts = {
  killSwitchActive: false, sessionPnlUsd: 0, gasGwei: 102, liquidityMon: 10_000,
  spreadBps: 3, score: 60, alreadyQuotingSide: false, exposureMon: 200, fundsOk: true, unresolvedSends: 0,
  toxicity: null, flowSigned: null, intendedSide: null,
};

test("a healthy block passes both passes", () => {
  expect(checkReflexes(base, "pre")).toBeNull();
  expect(checkReflexes(base, "post")).toBeNull();
});

test("the kill switch and an unreconciled send stop an impulse before the model", () => {
  expect(checkReflexes({ ...base, killSwitchActive: true }, "pre")?.name).toBe("kill_switch");
  expect(checkReflexes({ ...base, unresolvedSends: 1 }, "pre")?.name).toBe("recovery_pending");
});

test("session loss and gas cap are hard limits", () => {
  expect(checkReflexes({ ...base, sessionPnlUsd: -50 }, "pre")?.name).toBe("daily_loss");
  expect(checkReflexes({ ...base, gasGwei: 900 }, "pre")?.name).toBe("gas_cap");
});

test("market quality gates: thin book, wide spread, low score", () => {
  expect(checkReflexes({ ...base, liquidityMon: 10 }, "pre")?.name).toBe("min_liquidity");
  expect(checkReflexes({ ...base, spreadBps: 40 }, "pre")?.name).toBe("max_spread");
  expect(checkReflexes({ ...base, score: 5 }, "pre")?.name).toBe("low_score");
});

test("a screaming one-way tape pauses every quote, before the model", () => {
  expect(checkReflexes({ ...base, toxicity: 0.95 }, "pre")).toBeNull();
  expect(checkReflexes({ ...base, toxicity: 0.999 }, "pre")?.name).toBe("stressed_flow");
  // null means "not enough tape to judge", never "stressed".
  expect(checkReflexes({ ...base, toxicity: null }, "pre")).toBeNull();
});

test("side-aware: we stand down on the side the flow is running over, not the other", () => {
  const buyHeavy = { ...base, flowSigned: 0.9, toxicity: 0.9 };
  // taker buying dominates: our ask is the one being run over
  expect(checkReflexes({ ...buyHeavy, intendedSide: "sell" }, "post")?.name).toBe("toxic_side");
  expect(checkReflexes({ ...buyHeavy, intendedSide: "buy" }, "post")).toBeNull();

  const sellHeavy = { ...base, flowSigned: -0.9, toxicity: 0.9 };
  expect(checkReflexes({ ...sellHeavy, intendedSide: "buy" }, "post")?.name).toBe("toxic_side");
  expect(checkReflexes({ ...sellHeavy, intendedSide: "sell" }, "post")).toBeNull();

  // moderate one-sidedness does not stand us down, in either direction
  expect(checkReflexes({ ...base, flowSigned: 0.4, intendedSide: "sell" }, "post")).toBeNull();
});

test("side dependent checks only run before signing", () => {
  const f = { ...base, alreadyQuotingSide: true };
  expect(checkReflexes(f, "pre")).toBeNull();
  expect(checkReflexes(f, "post")?.name).toBe("duplicate_side");
});

test("exposure and funds are post-model gates", () => {
  expect(checkReflexes({ ...base, exposureMon: 5000 }, "post")?.name).toBe("max_exposure");
  expect(checkReflexes({ ...base, fundsOk: false }, "post")?.name).toBe("funds");
});

test("the two passes partition the reflex list, so nothing is skipped", () => {
  const all = defaultReflexes().map((r) => r.name).sort();
  const split = [...reflexesFor("pre").map((r) => r.name), ...reflexesFor("post").map((r) => r.name)].sort();
  expect(split).toEqual(all);
});
