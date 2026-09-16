import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { Market, type Book, type Fill } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  fill: Fill | null;
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
}

export interface Totals {
  blocks: number;
  decisions: number;
  trades: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

/** One decision per block, one request in flight, hold when late. */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private lastDecision: { action: Action; block: number } | null = null;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private totals: Totals = { blocks: 0, decisions: 0, trades: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };

  constructor(private market: Market, private model: Model, private onEvent: (e: BlockEvent) => void) {
    mkdirSync("data", { recursive: true });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, null, true);
      return;
    }
    this.busy = true;
    try {
      const book = await this.market.readBook();
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 100) this.mids.shift();

      const decision = await this.model.decide(this.buildState(block, book));
      if (decision.action !== "hold" && !this.allowed(decision.action)) decision.action = "hold"; // position limit; probabilities still show intent
      this.totals.decisions++;
      this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;
      this.lastDecision = { action: decision.action, block };

      let fill: Fill | null = null;
      if (decision.action !== "hold") {
        fill = await this.market.execute(decision.action, config.tradeSizeMon, book);
        if (fill.size > 0) this.applyFill(fill);
      }
      if (block % 200 === 0) this.market.refreshGasPrice().catch(() => {});
      this.emit(block, book, decision, fill, false);
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private allowed(action: Action) {
    const next = this.position.mon + (action === "buy" ? config.tradeSizeMon : -config.tradeSizeMon);
    return Math.abs(next) <= config.maxPositionMon;
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    return {
      market: "MON-USDC",
      block,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2) },
      recentMids: m.slice(-20).map((x) => x.toFixed(6)).join(" "),
      position: { mon: this.position.mon, entryPrice: this.entryPrice(), unrealizedUsd: round(this.unrealizedUsd(book.mid), 4) },
      lastDecision: this.lastDecision ? { action: this.lastDecision.action, blocksAgo: block - this.lastDecision.block } : null,
      allowed: { buy: this.allowed("buy"), sell: this.allowed("sell") },
    };
  }

  private applyFill(f: Fill) {
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    this.totals.trades++;
    this.totals.gasMon += f.gasMon;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, fill: Fill | null, late: boolean) {
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd;
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      fill,
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3) },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    appendFileSync("data/events.jsonl", JSON.stringify(event) + "\n");
    this.onEvent(event);
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
