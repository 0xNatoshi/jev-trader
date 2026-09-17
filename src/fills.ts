/**
 * Fill simulation for the dry run, with a queue-position model.
 *
 * The previous model filled us the moment a print touched our price, which is
 * optimistic on the one dimension that decides a maker's PnL: a maker joins the
 * queue at its price, and the size already resting there trades first. Here an
 * order carries `queueAheadMon`, and a print consumes that queue before it reaches
 * us. A print strictly THROUGH our price swept the level, so the queue does not
 * protect us; a print exactly at our price only fills what is left after it.
 */

export interface SimOrder {
  side: "buy" | "sell";
  price: number;
  size: number;
  block: number;
  /** Resting size ahead of us at our price when we joined. */
  queueAheadMon?: number;
}

export interface SimPrint {
  block: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

export interface SimFill {
  orderId: number;
  side: "buy" | "sell";
  price: number;
  size: number;
  block: number;
}

/**
 * The queue we join: resting size at our price on our side, read from the top
 * levels (best first). Our price is usually inside the touch, i.e. a level that does
 * not exist yet, in which case nobody is ahead of us.
 */
export function queueAheadAt(levels: [number, number][], price: number, tick: number): number {
  for (const [p, s] of levels) {
    if (Math.abs(p - price) < tick / 2 + 1e-12) return s; // levels are tick aligned; the epsilon absorbs float error
    if (p < price) break; // best first: once the level price is below ours, we passed it
  }
  return 0;
}

/** One block of prints against our resting orders: fills out, orders mutated in place. */
export function simulateFills(prints: SimPrint[], orders: Map<number, SimOrder>, tick: number): SimFill[] {
  const out: SimFill[] = [];
  for (const p of prints) {
    for (const [id, o] of orders) {
      if (p.block <= o.block || o.size <= 0) continue;
      const touches = o.side === "buy" ? p.side === "sell" && p.price <= o.price : p.side === "buy" && p.price >= o.price;
      if (!touches) continue;
      const through = o.side === "buy" ? p.price < o.price : p.price > o.price;
      let available = p.size;
      const ahead = o.queueAheadMon ?? 0;
      if (through) {
        o.queueAheadMon = 0; // the level was swept: the queue in front of us is gone
      } else if (ahead > 0) {
        const eaten = Math.min(ahead, available);
        o.queueAheadMon = ahead - eaten;
        available -= eaten;
      }
      if (available <= 0) continue;
      const size = Math.min(o.size, available);
      o.size -= size;
      out.push({ orderId: id, side: o.side, price: o.price, size, block: p.block });
      if (o.size <= 1e-9) orders.delete(id);
    }
  }
  return out;
}
