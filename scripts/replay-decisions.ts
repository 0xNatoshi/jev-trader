#!/usr/bin/env bun
/**
 * Replay logged TradeStates and evaluate Jev's directional signal offline.
 *
 *   bun scripts/replay-decisions.ts [--file data/states.jsonl] [--horizons 1,5,10,20,50,100]
 *       [--tolerance 3] [--cost-mult 2]
 *
 * For every logged block with a future mid within `tolerance` blocks, compares
 * p(buy) with the forward mid move and reports:
 *   - calibration buckets: n, %up, mean forward move in bps
 *   - an idealized crossed round-trip policy sweep: trade when |p-0.5| > t,
 *     cost = spread * cost-mult (entry + exit crossing), PnL in bps of notional.
 * Offline research only; never touches the exchange.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const FILE = opt("file", "data/states.jsonl");
const HORIZONS = opt("horizons", "1,5,10,20,50,100").split(",").map(Number);
const TOLERANCE = Number(opt("tolerance", "3"));
const COST_MULT = Number(opt("cost-mult", "2"));

type Row = { block: number; mid: number; pBuy: number; spreadBps: number };
const rows: Row[] = [];
for (const line of readFileSync(FILE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const d = JSON.parse(line);
    const pBuy = d?.probabilities?.buy;
    const mid = d?.state?.mid;
    if (typeof pBuy === "number" && typeof mid === "number" && typeof d?.block === "number") {
      rows.push({ block: d.block, mid, pBuy, spreadBps: d?.state?.spreadBps ?? 0 });
    }
  } catch {}
}
rows.sort((a, b) => a.block - b.block);
if (rows.length < 50) {
  console.error(`pas assez d'échantillons (${rows.length}) — le bot doit tourner plus longtemps`);
  process.exit(1);
}

const blocks = rows.map((r) => r.block);
const nearestIndexAtOrAfter = (b: number) => {
  let lo = 0, hi = blocks.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (blocks[m]! >= b) { best = m; hi = m - 1; } else lo = m + 1;
  }
  return best;
};

const avgSpread = rows.reduce((s, r) => s + r.spreadBps, 0) / rows.length;
console.log(`samples: ${rows.length} | blocks ${rows[0]!.block}..${rows[rows.length - 1]!.block} | spread moyen: ${avgSpread.toFixed(2)} bps`);
const decisive = rows.filter((r) => Math.abs(r.pBuy - 0.5) > 0.2).length / rows.length;
console.log(`décisions tranchées (|p-0.5|>0.2): ${(decisive * 100).toFixed(1)}%\n`);

const BUCKETS = [
  [0, 0.05], [0.05, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 0.95], [0.95, 1.01],
] as const;

for (const H of HORIZONS) {
  const samples: { p: number; fwd: number; cost: number }[] = [];
  for (const r of rows) {
    const i = nearestIndexAtOrAfter(r.block + H);
    if (i < 0) continue;
    const future = rows[i]!;
    if (future.block - (r.block + H) > TOLERANCE) continue;
    samples.push({ p: r.pBuy, fwd: ((future.mid - r.mid) / r.mid) * 1e4, cost: r.spreadBps * COST_MULT });
  }
  if (samples.length < 30) { console.log(`--- horizon ${H}: pas assez de futur (${samples.length})\n`); continue; }

  const n = samples.length;
  const up = samples.filter((s) => s.fwd > 0).length / n;
  const meanFwd = samples.reduce((s, x) => s + x.fwd, 0) / n;
  console.log(`--- horizon ${H} blocs (n=${n}) | %up ${(up * 100).toFixed(1)} | move moyen ${meanFwd.toFixed(2)} bps | écart-type ${stdev(samples.map((s) => s.fwd)).toFixed(2)}`);

  for (const [lo, hi] of BUCKETS) {
    const b = samples.filter((s) => s.p >= lo && s.p < hi);
    if (b.length < 5) continue;
    const bu = b.filter((s) => s.fwd > 0).length / b.length;
    const bm = b.reduce((s, x) => s + x.fwd, 0) / b.length;
    console.log(`   p∈[${lo.toFixed(2)},${hi.toFixed(2)}) n=${String(b.length).padStart(5)} | %up ${(bu * 100).toFixed(0).padStart(3)} | move ${bm.toFixed(2).padStart(6)} bps | excès ${(bm - meanFwd).toFixed(2).padStart(6)} bps`);
  }

  console.log(`   sweep seuil (coût = spread×${COST_MULT} par aller-retour croisé):`);
  for (const t of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4]) {
    const trades = samples.filter((s) => Math.abs(s.p - 0.5) > t);
    if (trades.length < 5) { console.log(`     t=${t.toFixed(2)} n=${String(trades.length).padStart(5)} (trop peu)`); continue; }
    const pnl = trades.reduce((s, x) => s + (x.p > 0.5 ? x.fwd : -x.fwd) - x.cost, 0);
    const per = pnl / trades.length;
    console.log(`     t=${t.toFixed(2)} n=${String(trades.length).padStart(5)} | net total ${pnl.toFixed(0).padStart(7)} bps | ${per.toFixed(2).padStart(6)} bps/trade`);
  }
  console.log();
}

function stdev(xs: number[]) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}
