/**
 * Regime machine: is this a normal tape, a repricing jump, a liquidity sweep, or the
 * cool-off right after one?
 *
 * Why it exists (poly-maker's field guide): most maker losses are not from being
 * wrong about direction, they are from quoting into an event. A mid that moves X bps
 * inside a few blocks is a repricing; a taker print that eats many times our size at
 * the touch is a sweep; both mean the book we quoted is gone. The machine says so and
 * the caller widens or pauses.
 *
 * Pure and deterministic: same mid series and same prints give the same regime.
 */

export type Regime = "calm" | "jump" | "sweep" | "cooloff";

export interface RegimeConfig {
  /** A mid move of at least this many bps inside the window is a jump. */
  jumpBps: number;
  jumpWindowBlocks: number;
  /** A print at least this many times our reference size is a sweep. */
  sweepRatio: number;
  /** Blocks to stay cautious after the event. */
  cooloffBlocks: number;
  /** Half-spread multiplier while the event is fresh, and during the cool-off. */
  stressSpreadMult: number;
  cooloffSpreadMult: number;
}

export class RegimeMachine {
  private state: Regime = "calm";
  private since = 0;
  private note = "";
  private lastBlock = 0;

  constructor(private cfg: RegimeConfig, private referenceSizeMon: number) {}

  onBlock(block: number, mids: number[]): Regime {
    this.lastBlock = block;
    const win = this.cfg.jumpWindowBlocks;
    if (mids.length > win) {
      const then = mids[mids.length - 1 - win];
      const now = mids[mids.length - 1];
      if (then > 0) {
        const moveBps = Math.abs(((now - then) / then) * 1e4);
        if (moveBps >= this.cfg.jumpBps) return this.fire(block, "jump", `mid moved ${moveBps.toFixed(1)} bps in ${win} blocks`);
      }
    }
    return this.settle(block);
  }

  /** A taker print worth many of our sizes at the touch is liquidity being taken. */
  onPrints(block: number, prints: { size: number; side: "buy" | "sell" }[]): Regime {
    const threshold = this.referenceSizeMon * this.cfg.sweepRatio;
    for (const p of prints) {
      if (p.size >= threshold) return this.fire(block, "sweep", `${p.side} print of ${Math.round(p.size)} MON`);
    }
    return this.state;
  }

  private fire(block: number, regime: Regime, note: string): Regime {
    this.state = regime;
    this.since = block;
    this.note = note;
    return regime;
  }

  /** Cool-off while the event is fresh, calm after that. */
  private settle(block: number): Regime {
    if (this.state === "calm") return this.state;
    if (block - this.since < this.cfg.cooloffBlocks) {
      this.state = "cooloff";
      return this.state;
    }
    this.state = "calm";
    this.note = "";
    return this.state;
  }

  get current(): Regime { return this.state; }
  get detail(): string { return this.note; }
  get blocksSinceEvent(): number { return this.lastBlock - this.since; }
  get isAcute(): boolean { return this.state === "jump" || this.state === "sweep"; }

  /** How much wider to quote right now. */
  get spreadMult(): number {
    if (this.isAcute) return this.cfg.stressSpreadMult;
    if (this.state === "cooloff") return this.cfg.cooloffSpreadMult;
    return 1;
  }
}
