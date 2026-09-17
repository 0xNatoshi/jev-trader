/**
 * Deterministic market score, 0 to 100. Pure function of observable facts: the
 * same book always produces the same score. No model output, no clock, no
 * randomness.
 *
 * Why it exists (kept from NERVE's `nerve_score`): a maker bot needs a cheap,
 * testable opinion about whether this is a decent moment to quote BEFORE paying
 * for a decision model. It also gives us the baseline Jev has to beat: log both
 * and the divergence table says where the model adds value and where the
 * deterministic layer was right (JEV-ROLE.md, A/B proof rule).
 */

export interface ScoreFacts {
  spreadBps: number;
  /** Resting size within 25 bps of mid, per side, in MON. */
  depthBidMon: number;
  depthAskMon: number;
  /** -1 (all asks) to 1 (all bids) within 1 pct of mid. */
  bookImbalance: number;
  /** Mid move over the last 20 blocks, in bps. */
  ret20Bps: number;
  /** Our exposure after the order would land, in MON (absolute). */
  exposureMon: number;
  maxPositionMon: number;
  /** Size we quote, in MON. Depth is judged against it so the score is size-aware. */
  tradeSizeMon: number;
}

export interface ScorePart {
  name: string;
  delta: number;
  note: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function marketScore(f: ScoreFacts): { score: number; parts: ScorePart[] } {
  const parts: ScorePart[] = [];
  const add = (name: string, delta: number, note: string) => { if (delta !== 0) parts.push({ name, delta, note }); return delta; };
  let score = 50;

  // 1. Spread: our cost of crossing, and the width we can quote inside.
  const s = f.spreadBps;
  score += add("spread", s <= 1 ? 15 : s <= 2 ? 10 : s <= 4 ? 4 : s <= 8 ? -6 : s <= 15 ? -14 : -25, `${s.toFixed(2)} bps`);

  // 2. Depth: thin book on the side we would quote is adverse selection waiting.
  const thin = Math.min(f.depthBidMon, f.depthAskMon);
  const ratio = f.tradeSizeMon > 0 ? thin / f.tradeSizeMon : 0;
  score += add("depth", ratio >= 20 ? 14 : ratio >= 8 ? 7 : ratio >= 3 ? 0 : ratio >= 1.5 ? -8 : -18, `${ratio.toFixed(1)}x our size at 25 bps`);

  // 3. Balance: a two-sided book is a market; a one-sided book is a trend we would quote against.
  const imb = Math.abs(f.bookImbalance);
  score += add("balance", imb <= 0.2 ? 8 : imb <= 0.4 ? 3 : imb <= 0.6 ? -4 : -12, `imbalance ${f.bookImbalance.toFixed(2)}`);

  // 4. Recent move: a fast mid means the fill we get is not the fill we quoted.
  const move = Math.abs(f.ret20Bps);
  score += add("move", move <= 8 ? 5 : move <= 25 ? 0 : move <= 60 ? -10 : -18, `${f.ret20Bps.toFixed(1)} bps over 20 blocks`);

  // 5. Inventory: room to work beats being at the cap.
  const used = f.maxPositionMon > 0 ? Math.abs(f.exposureMon) / f.maxPositionMon : 1;
  score += add("inventory", used <= 0.3 ? 8 : used <= 0.6 ? 2 : used <= 0.9 ? -6 : -20, `${(used * 100).toFixed(0)} pct of the cap`);

  return { score: Math.round(clamp(score, 0, 100)), parts };
}
