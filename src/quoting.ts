/**
 * Quoting: reservation price and an inventory-aware half-spread, the practical
 * shape of Avellaneda-Stoikov (2008) on a discrete-tick book.
 *
 *   r      = mid * (1 - skewBps/1e4),  skewBps = qNorm * gamma * sigmaH
 *   delta  = max(minHalfSpread, gamma * sigmaH + liqHalfSpread)
 *   bid/ask = r -/+ delta, rounded to ticks, then clamped to the touch.
 *
 * sigmaH is the horizon volatility in bps. Sign convention: long inventory
 * (q > 0) shifts the whole ladder DOWN, so we sell eagerly and buy reluctantly.
 */

export interface QuoteTuning {
  gamma: number;
  horizonBlocks: number;
  liqHalfSpreadBps: number;
  minHalfSpreadBps: number;
  maxDistanceBps: number;
  insideTicks: number;
  tickSize: number;
  priceDec: number;
  /** Regime multiplier on the half-spread (1 = calm). */
  spreadMult?: number;
}

export interface QuoteInput {
  mid: number;
  bestBid: number;
  bestAsk: number;
  inventoryMon: number;
  maxPositionMon: number;
  sigmaBps: number;
}

export interface QuotePlan {
  reservation: number;
  skewBps: number;
  deltaBps: number;
  volBps: number;
  bid: number;
  ask: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Realised horizon volatility in bps: stdev of overlapping H-block returns in the
 * mid series. Measuring the horizon return directly avoids the sqrt(T) blow-up of
 * extrapolating one-block noise, which on a tick-quantised book is mostly rounding:
 * that mistake priced our quotes 9 bps off mid and stopped every fill.
 */
export function horizonVolBps(mids: number[], horizonBlocks: number): number {
  const h = Math.max(1, Math.floor(horizonBlocks));
  if (mids.length <= h + 2) return 0;
  const rets: number[] = [];
  for (let i = h; i < mids.length; i++) {
    const base = mids[i - h];
    if (base > 0) rets.push(((mids[i] - base) / base) * 1e4);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr);
}

/**
 * The ladder for this block. Never crosses the touch, never steps more than
 * `insideTicks` inside the best quote, and never posts further than
 * `maxDistanceBps` from it (a maker quoting miles away is not a maker).
 */
export function quotePlan(i: QuoteInput, t: QuoteTuning): QuotePlan {
  const qNorm = i.maxPositionMon > 0 ? clamp(i.inventoryMon / i.maxPositionMon, -1, 1) : 0;
  const skewBps = qNorm * t.gamma * i.sigmaBps;
  const deltaBps = Math.max(t.minHalfSpreadBps, (t.gamma * i.sigmaBps + t.liqHalfSpreadBps) * (t.spreadMult ?? 1));
  const reservation = i.mid * (1 - skewBps / 1e4);
  const scale = 10 ** t.priceDec;
  const tick = t.tickSize / scale;
  const round = (p: number) => Math.round(p / tick) * tick;
  const maxD = (t.maxDistanceBps / 1e4) * i.mid;
  const inside = t.insideTicks * tick;

  let bid = round(reservation * (1 - deltaBps / 1e4));
  let ask = round(reservation * (1 + deltaBps / 1e4));

  // Never cross, and stay on our own side of the touch.
  bid = clamp(bid, i.bestBid - maxD, Math.min(i.bestAsk - tick, i.bestBid + inside));
  ask = clamp(ask, Math.max(i.bestBid + tick, i.bestAsk - inside), i.bestAsk + maxD);
  if (bid >= ask) {
    // Degenerate book: fall back to the touch itself rather than crossing.
    bid = Math.min(bid, i.bestBid);
    ask = Math.max(ask, i.bestAsk);
  }
  return { reservation, skewBps, deltaBps, volBps: i.sigmaBps, bid, ask };
}
