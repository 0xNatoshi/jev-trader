/**
 * Flow toxicity: how one-sided the taker flow has been lately, in [0, 1].
 *
 * The literature's VPIN buckets trades by volume (Easley/Lopez de Prado/O'Hara
 * 2012) and that is what `market-maker-rs` implements. On this market it does not
 * survive contact with the tape: MON-USDC prints run from the 200 MON venue
 * minimum to tens of thousands, so a print routinely fills a bucket on its own and
 * every bucket reads as maximally imbalanced. Measured live, VPIN sat at 0.99 and
 * blocked every quote.
 *
 * So the measure here is the same idea without the artefact: net over gross taker
 * volume across a rolling block window. It is what `poly-maker` calls `flowz`, and
 * the Kalshi evidence (41.6M trades) is about one-sided flow, not about bucketing.
 */
export interface FlowPrint {
  block: number;
  sizeMon: number;
  side: "buy" | "sell";
}

export class FlowToxicity {
  /** Window length in blocks. */
  readonly windowBlocks: number;
  /** Below this gross volume the reading is noise, and null is returned. */
  readonly minVolumeMon: number;
  private prints: FlowPrint[] = [];
  private buyMon = 0;
  private sellMon = 0;

  constructor(windowBlocks: number, minVolumeMon: number) {
    this.windowBlocks = Math.max(1, windowBlocks);
    this.minVolumeMon = Math.max(0, minVolumeMon);
  }

  /** One taker print. Prints outside the window are dropped as the window slides. */
  add(print: FlowPrint, currentBlock?: number) {
    if (!(print.sizeMon > 0)) return;
    this.prints.push(print);
    if (print.side === "buy") this.buyMon += print.sizeMon;
    else this.sellMon += print.sizeMon;
    this.evict(currentBlock ?? print.block);
  }

  /** Drop everything older than the window. Called on every add and read. */
  private evict(currentBlock: number) {
    const floor = currentBlock - this.windowBlocks;
    let drop = 0;
    while (drop < this.prints.length && this.prints[drop].block <= floor) {
      const p = this.prints[drop++];
      if (p.side === "buy") this.buyMon -= p.sizeMon;
      else this.sellMon -= p.sizeMon;
    }
    if (drop) this.prints.splice(0, drop);
  }

  /**
   * |net flow| / gross flow over the window, in [0, 1]. Null when there is not
   * enough traded volume to judge: absence of evidence is not evidence of calm.
   */
  value(currentBlock?: number): number | null {
    if (currentBlock !== undefined) this.evict(currentBlock);
    const gross = this.buyMon + this.sellMon;
    if (gross < this.minVolumeMon || this.prints.length < 3) return null;
    return Math.abs(this.buyMon - this.sellMon) / gross;
  }

  /**
   * Signed imbalance in [-1, 1]: positive means taker BUYING dominates (our resting
   * ask is the side being run over), negative means selling dominates. Null when
   * there is not enough traded volume to judge.
   */
  signed(currentBlock?: number): number | null {
    if (currentBlock !== undefined) this.evict(currentBlock);
    const gross = this.buyMon + this.sellMon;
    if (gross < this.minVolumeMon || this.prints.length < 3) return null;
    return (this.buyMon - this.sellMon) / gross;
  }

  get printCount() {
    return this.prints.length;
  }

  get grossMon() {
    return this.buyMon + this.sellMon;
  }
}
