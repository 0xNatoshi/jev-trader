import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { Market, type Book, type Fill } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";
import { TradeFeed } from "./trades";

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

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

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

/**
 * One decision every `config.decideEveryBlocks` blocks, one request in flight. Decided blocks trade; every
 * other block reads the book, polls trade prints, and re-emits the standing buy/sell with no fill.
 * The decision is always binary; `hold` only appears on late blocks.
 * Live sends are fire-and-forget: the block event carries the intent, and the fill is applied to the
 * position when its receipt turns up on a later block (`onFill`). Dry runs apply fills immediately.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private lastDecision: { action: Action; block: number; decision: Decision } | null = null;
  private trades: TradeFeed | null = null;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private inFlightMon = 0; // signed size of live sends not yet confirmed; counts toward the position cap
  private totals: Totals = { blocks: 0, decisions: 0, trades: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
  }

  /** Call once the market params are known. Without it `trades` in the state is all zeros. */
  attachTradeFeed(sizeDec: number) {
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh().catch(() => {}); // fee estimate + vault check
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, null, true);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = await this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.trades?.poll(block); // off the hot path: eth_getLogs for prints since the last poll

      const due = !this.lastDecision || block - this.lastDecision.block >= config.decideEveryBlocks;
      if (!due) {
        this.emit(block, book, this.lastDecision!.decision, null, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
        return;
      }
      const decision = await this.model.decide(this.buildState(block, book));
      let side: "buy" | "sell" = decision.action === "sell" ? "sell" : "buy";
      if (!this.allowed(side)) side = side === "buy" ? "sell" : "buy"; // position cap flips the side; probabilities still show intent
      decision.action = side;
      this.totals.decisions++;
      this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;
      this.lastDecision = { action: decision.action, block, decision };

      const fill = await this.market.send(block, side, config.tradeSizeMon, book);
      if (fill.confirmed) this.applyFill(fill); // dry run only; live fills land in confirmPending
      else this.inFlightMon += side === "buy" ? fill.size : -fill.size;
      this.emit(block, book, decision, fill, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((fills) => {
      for (const { block: b, fill } of fills) {
        this.inFlightMon -= fill.side === "buy" ? config.tradeSizeMon : -config.tradeSizeMon;
        this.applyFill(fill);
        this.onFill(b, fill);
      }
    }).catch(() => {});
  }

  private allowed(action: Action) {
    const next = this.position.mon + this.inFlightMon + (action === "buy" ? config.tradeSizeMon : -config.tradeSizeMon);
    return Math.abs(next) <= config.maxPositionMon;
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const empty = { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null };
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    return {
      market: "MON-USDC",
      block,
      horizonBlocks: H,
      blockMs: 300,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : empty,
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      allowed: { buy: this.allowed("buy"), sell: this.allowed("sell") },
    };
  }

  /** Gas is charged whether or not anything filled (reverts and drops included). */
  private applyFill(f: Fill) {
    this.totals.gasMon += f.gasMon;
    if (f.size <= 0) return;
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
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, fill: Fill | null, late: boolean, timing?: Timing) {
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
    this.onEvent(event, timing);
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
