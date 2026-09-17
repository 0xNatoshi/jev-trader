/**
 * A/B: does Jev's signal beat the deterministic score on the same blocks?
 *
 * Reads `data/states.jsonl` (STATE_LOG=true) and answers one question per block:
 * given the direction the signal pointed, what did the mid actually do H blocks
 * later, net of what a maker pays? Cohorts are cut by Jev's confidence and by the
 * deterministic score, so the table says whether the model adds anything over a
 * pure book-quality gate.
 *
 * Honest limits, on purpose: this is not a PnL simulation. It measures the
 * prediction (signed forward move in bps) and subtracts one spread as the exit
 * cost a maker would pay, it does not model queue position, fills or inventory.
 * The point is to compare signals, not to claim a strategy.
 *
 *   bun scripts/ab-score-vs-jev.ts [--file data/states.jsonl] [--horizons 10,50,100]
 */
import { readFileSync } from "node:fs";
import { marketScore, type ScoreFacts } from "../src/score";

/**
 * Rows logged before the score existed: recompute it from the logged book with the
 * same formula. The inventory term assumes a flat book, the one fact the state log
 * does not carry; rows logged from now on carry their real score.
 */
function scoreFromState(state: any): number | null {
  const depth = state?.depth?.["25bps"] ?? state?.depth?.["25"];
  if (!depth) return null;
  const facts: ScoreFacts = {
    spreadBps: state.spreadBps ?? 0,
    depthBidMon: depth.bid ?? 0,
    depthAskMon: depth.ask ?? 0,
    bookImbalance: state.bookImbalance ?? 0,
    ret20Bps: state.returnsBps?.last20 ?? 0,
    exposureMon: 0,
    maxPositionMon: Number(process.env.MAX_POSITION_MON ?? 1000),
    tradeSizeMon: Number(process.env.TRADE_SIZE_MON ?? 200),
  };
  return marketScore(facts).score;
}

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const FILE = opt("file", "data/states.jsonl");
const HORIZONS = opt("horizons", "10,50,100").split(",").map(Number);
const STRONG = Number(opt("strong", "0.15")); // same default as ENTRY_MIN_PROB

interface Row {
  block: number;
  mid: number;
  spreadBps: number;
  score: number | null;
  pBuy: number;
}

const rows: Row[] = [];
for (const line of readFileSync(FILE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let r: any;
  try { r = JSON.parse(line); } catch { continue; }
  const mid = r?.state?.mid;
  const pBuy = r?.probabilities?.buy;
  if (typeof mid !== "number" || typeof pBuy !== "number") continue;
  rows.push({ block: r.block, mid, spreadBps: r.state.spreadBps ?? 0, score: typeof r.score === "number" ? r.score : scoreFromState(r.state), pBuy });
}
rows.sort((a, b) => a.block - b.block);

const scored = rows.filter((r) => r.score !== null);
const firstBlock = rows[0]?.block ?? 0;

/** Index of the first row at or after a block, so an uneven log does not distort the horizon. */
function indexAtOrAfter(block: number): number {
  let lo = 0, hi = rows.length - 1, out = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].block >= block) { out = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return out;
}

interface Stat { n: number; mean: number; median: number; hit: number }
const stats = (xs: number[]): Stat => {
  if (!xs.length) return { n: 0, mean: 0, median: 0, hit: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { n: xs.length, mean, median, hit: xs.filter((x) => x > 0).length / xs.length };
};

/** Signed forward move in bps: positive when the signal's direction was right. */
function edge(r: Row, horizon: number): number | null {
  const j = indexAtOrAfter(r.block + horizon);
  if (j >= rows.length || j === 0) return null;
  const past = rows[j - 1].block - r.block;
  const after = rows[j].block - r.block;
  const target = after <= horizon || past === after ? j : j - 1;
  const fwd = (rows[target].mid - r.mid) / r.mid * 1e4;
  return (r.pBuy >= 0.5 ? 1 : -1) * fwd;
}

const cohorts: { name: string; match: (r: Row) => boolean; rows: Row[] }[] = [
  { name: "all decisions", match: () => true, rows: [] },
  { name: `jev strong (|p-.5| >= ${STRONG})`, match: (r) => Math.abs(r.pBuy - 0.5) >= STRONG, rows: [] },
  { name: "jev weak (|p-.5| < 0.15)", match: (r) => Math.abs(r.pBuy - 0.5) < STRONG, rows: [] },
  { name: "jev extreme (p >= 0.95 or <= 0.05)", match: (r) => r.pBuy >= 0.95 || r.pBuy <= 0.05, rows: [] },
  { name: "score high (>= 60)", match: (r) => (r.score ?? -1) >= 60, rows: [] },
  { name: "score low (< 40)", match: (r) => r.score !== null && r.score < 40, rows: [] },
  { name: "jev strong AND score high", match: (r) => Math.abs(r.pBuy - 0.5) >= STRONG && (r.score ?? -1) >= 60, rows: [] },
  { name: "jev strong AND score low", match: (r) => Math.abs(r.pBuy - 0.5) >= STRONG && r.score !== null && r.score < 40, rows: [] },
];
for (const c of cohorts) for (const r of rows) if (c.match(r)) c.rows.push(r);

const dec = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
console.log(`# A/B signal vs score\n`);
console.log(`file            ${FILE}`);
console.log(`decisions       ${rows.length} (with score: ${scored.length})`);
console.log(`blocks          ${rows.length ? `${firstBlock} to ${rows[rows.length - 1].block}` : "-"}`);
console.log(`mean spread     ${rows.length ? (rows.reduce((s, r) => s + r.spreadBps, 0) / rows.length).toFixed(2) : "0"} bps`);
console.log(`horizons        ${HORIZONS.join(", ")} blocks\n`);

console.log(`cohort                            n     ` + HORIZONS.map((h) => `H=${h} edge  hit   net`).join("   "));
console.log("-".repeat(64 + HORIZONS.length * 22));
for (const c of cohorts) {
  const cells = HORIZONS.map((h) => {
    const e = c.rows.map((r) => edge(r, h)).filter((x): x is number => x !== null);
    const s = stats(e);
    if (!s.n) return `-`.padEnd(20);
    const cost = c.rows.reduce((a, r) => a + r.spreadBps, 0) / c.rows.length;
    return `${dec(s.mean).padStart(7)} bps  ${(s.hit * 100).toFixed(0).padStart(3)}%  ${dec(s.mean - cost).padStart(6)}`;
  });
  console.log(`${c.name.padEnd(32)} ${String(c.rows.length).padStart(6)}   ${cells.join("   ")}`);
}

console.log(`\nread: "edge" is the signed move in bps (positive = the signal's direction was right).`);
console.log(`"net" subtracts one mean spread, the exit a maker pays, and excludes entry cost.`);
console.log(`a cohort whose edge is no better than "all decisions" adds no information.`);
