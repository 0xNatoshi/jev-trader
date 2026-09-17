import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";
import { checkReflexes, killSwitchActive, type ReflexFacts } from "./reflexes";
import { marketScore, type ScorePart } from "./score";
import { Store, type Impulse, type Node, type Verdict } from "./store";
import { TradeFeed, type MakerFill, type TradePrint } from "./trades";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  /** Position exit this block (lab: TP / SL / time stop), null otherwise. */
  exit?: { reason: "tp" | "sl" | "time"; price: number; size: number } | null;
  /** Deterministic market score for this block, 0 to 100 (src/score.ts). */
  score: number;
  /** Name of the reflex that stopped this block's entry, null when none fired. */
  reflex: string | null;
  /** Id of this block's impulse in the decision journal. */
  impulseId: string | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  /** Blocks with no entry (weak signal): first-class abstention. */
  holds: number;
  /** Impulses a deterministic reflex stopped, before the model or before signing. */
  reflexRejects: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

interface Resting { side: Side; price: number; size: number; block: number }

/**
 * Every block: read the book, ask the model buy or sell, and post one post-only limit order on
 * that side (`quoteInsideTicks` inside the touch), cancelling whatever we had resting. One request
 * in flight; a block that arrives while the previous one is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its receipt
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the Trade log feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills when a real print crosses its price.
 */
/** One hold out of this many is journalled: states.jsonl keeps the full per-block record. */
const HOLDS_SAMPLED = 30;

export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  /** Orders we know are resting on the book (live: from receipts; dry run: last block's simulated order). */
  private orders = new Map<number, Resting>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote>();
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  /** Open-position plan: side, fill price reference, TP/SL levels, entry block. */
  private entry: { side: Side; block: number; ref: number; tp: number; sl: number } | null = null;
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, holds: 0, reflexRejects: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };
  /** Typed decision journal: impulses, their transitions, and the send ledger. */
  readonly store = new Store();
  readonly startedAt = Date.now();
  /** Deterministic market score of the last book read, 0 to 100. */
  score = 0;
  /** Breakdown of that score, newest first, for the console. */
  scoreParts: ScorePart[] = [];
  /** Sends the chain has not explained yet, as the dashboard shows it. */
  get unresolvedCount() { return this.unresolved; }
  /** Impulses each reflex stopped this session, by reflex name. */
  readonly reflexHits: Record<string, number> = {};
  /** Sends the chain has not explained yet. Above zero, the recovery reflex locks new entries. */
  private unresolved = 0;
  /** tx hash to impulse id, so a receipt arriving on a later block lands on the right journal row. */
  private impulseByTx = new Map<string, string>();

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
  }

  /** Call once the market params are known. Without it `trades` in the state is all zeros and no fills are ever seen. */
  attachTradeFeed(sizeDec: number) {
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec, maker: this.market.address });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh().catch(() => {}); // fee estimate + margin + vault check
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
      this.trades?.poll(block).then(() => this.harvest()); // off the hot path: eth_getLogs for prints (and our fills) since the last poll

      let decision: Decision | null = null;
      let quote: Quote | null = null;
      let exit: BlockEvent["exit"] = null;
      let impulseId: string | null = null;
      let journalReflex: string | null = null;

      if (this.position.mon !== 0) {
        // In a position: manage it (TP / SL / time stop). No flips, no new entry.
        if (!this.entry) {
          const side: Side = this.position.mon > 0 ? "buy" : "sell";
          const ref = book.mid;
          this.entry = {
            side, block, ref,
            tp: side === "buy" ? ref * (1 + config.tpBps / 1e4) : ref * (1 - config.tpBps / 1e4),
            sl: side === "buy" ? ref * (1 - config.slBps / 1e4) : ref * (1 + config.slBps / 1e4),
          };
        }
        const e = this.entry!;
        const hitTp = e.side === "buy" ? book.mid >= e.tp : book.mid <= e.tp;
        const hitSl = e.side === "buy" ? book.mid <= e.sl : book.mid >= e.sl;
        const timedOut = e.block > 0 && block - e.block >= config.timeStopBlocks;
        if (hitTp || hitSl || timedOut) {
          const reason = hitTp ? "tp" : hitSl ? "sl" : "time";
          const impulse = this.newImpulse(block, book, this.buildState(block, book));
          impulseId = impulse.id;
          exit = this.closePosition(book, reason);
          this.journal(impulse, "exit", "fill", `${reason} at ${exit.price.toFixed(6)} for ${exit.size.toFixed(1)} MON`);
        }
      } else {
        const state = this.buildState(block, book);
        const impulse = this.newImpulse(block, book, state);
        impulseId = impulse.id;
        // Reflex pass 1, before the model: hard limits and market quality. A fired
        // reflex ends the impulse here, so a locked-out strategy costs nothing.
        const pre = checkReflexes(this.reflexFacts(book, "buy"), "pre");
        if (pre) {
          this.hitReflex(impulse, pre.name);
          journalReflex = pre.name;
          this.journal(impulse, "reflex", "reject", pre.note);
        } else {
          const d = await this.model.decide(state);
          if (process.env.STATE_LOG === "true") {
            try {
              appendFileSync("data/states.jsonl", JSON.stringify({
                block, ts: Date.now(), state,
                action: d.action, probabilities: d.probabilities,
                latencyMs: Math.round(d.latencyMs),
              }) + "\n");
            } catch {}
          }
          this.totals.decisions++;
          const usd = (d.inputTokens / 1e6) * config.jevUsdPerMTok;
          this.totals.jevUsd += usd;
          impulse.jev = { action: d.action, pBuy: d.probabilities.buy ?? 0, pSell: d.probabilities.sell ?? 0, latencyMs: Math.round(d.latencyMs), usd };

          const pUp = d.probabilities.buy ?? 0;
          const wanted: Side = d.action === "sell" ? "sell" : "buy";
          const strong = Math.abs(pUp - 0.5) >= config.entryMinProb;
          const jevNote = `p(buy) ${(pUp * 100).toFixed(1)} pct, ${Math.round(d.latencyMs)} ms, $${usd.toFixed(6)}`;
          const restingSameSide = [...this.orders.values()].find((o) => o.side === wanted);
          // Hysteresis: keep the resting quote unless the touch moved past it (displaced).
          const displaced = !!restingSameSide && (wanted === "buy" ? restingSameSide.price < book.bid : restingSameSide.price > book.ask);
          if (!strong) {
            d.action = "hold"; // weak signal: first-class abstention, no order
            this.totals.holds++;
            if (!this.market.wallet) this.orders.clear(); // drop stale resting quotes (sim)
            // Sampled hold: the divergence baseline without a row per block.
            if (block % HOLDS_SAMPLED === 0) this.journal(impulse, "jev", "hold", jevNote);
          } else {
            // Reflex pass 2, before signing: the checks that need the intended side and size.
            const post = checkReflexes(this.reflexFacts(book, wanted), "post");
            if (post) {
              d.action = "hold";
              this.hitReflex(impulse, post.name);
              journalReflex = post.name;
              // A duplicate side is normal market making (one quote per side), not an
              // incident: sampled like holds, while the safety reflexes always journal.
              if (post.name !== "duplicate_side" || block % HOLDS_SAMPLED === 0) {
                this.journal(impulse, "jev", "pass", jevNote);
                this.journal(impulse, "risk", "reject", post.note);
              }
            } else if (!restingSameSide || displaced) {
              // only (re)quote when nothing rests on this side, or the touch moved past ours: no cancel/replace churn
              d.action = wanted;
              const cancel = [...this.orders.keys()].filter((id) => id > 0); // simulated orders have negative ids
              // The send is journalled BEFORE the signature: a crash in between leaves a row recovery can reconcile.
              this.store.openIntent(impulse, {
                side: wanted, sizeMon: config.tradeSizeMon, price: this.market.quotePrice(wanted, book),
                txHash: null, nonce: this.market.wallet ? this.market.nextNonce : null,
                status: this.market.wallet ? "sent" : "sim",
              });
              try {
                quote = await this.market.send(block, wanted, config.tradeSizeMon, book, cancel, false);
                this.totals.quotes++;
                this.store.openIntent(impulse, { ...impulse.intent!, txHash: quote.txHash, price: quote.price, status: quote.status === "sim" ? "sim" : "sent" });
                this.journal(impulse, "jev", "pass", jevNote);
                this.journal(impulse, "exec", "execute", `${quote.side} ${quote.size} MON at ${quote.price.toFixed(6)}${quote.status === "sim" ? " (sim)" : ` tx ${quote.txHash}`}`);
                if (quote.status === "sim") {
                  this.orders.clear(); // the simulated cancel
                  this.orders.set(--this.simId, { side: wanted, price: quote.price, size: quote.size, block });
                } else if (quote.txHash) {
                  this.inflight.set(quote.txHash, quote);
                  this.impulseByTx.set(quote.txHash, impulse.id);
                }
              } catch (e) {
                // A send that threw is not a send that did not happen: the ledger keeps
                // it open and recovery reconciles it by nonce before trading resumes.
                this.store.updateIntent(impulse.id, { status: "unknown" });
                this.journal(impulse, "exec", "unknown", (e as Error).message);
                this.unresolved++;
              }
            }
          }
          decision = d;
        }
      }
      this.emit(block, book, decision, quote, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) }, exit, { impulseId, reflex: journalReflex });
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, canceled }: QuoteResult) {
    const impulseId = quote.txHash ? this.impulseByTx.get(quote.txHash) : null;
    if (quote.txHash) { this.inflight.delete(quote.txHash); this.impulseByTx.delete(quote.txHash); }
    this.totals.gasMon += quote.gasMon; // charged on reverts too
    if (quote.status === "reverted") this.totals.reverted++;
    // No receipt after `pendingBlocks`: unresolved until the chain explains it,
    // never treated as a failed send (the transaction may well have landed).
    if (quote.status === "lost") this.unresolved++;
    for (const id of canceled) this.orders.delete(id);
    if (quote.status === "placed" && quote.orderId !== null) this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    if (impulseId) this.journalQuote(impulseId, block, quote);
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    this.onQuote(block, quote);
  }

  /** Land a receipt on its impulse: the send ledger moves and the transition records the outcome. */
  private journalQuote(impulseId: string, block: number, quote: Quote) {
    const status = quote.status === "placed" ? "placed" : quote.status === "reverted" ? "reverted" : "unknown";
    this.store.updateIntent(impulseId, { status, txHash: quote.txHash });
    const i = this.store.impulse(impulseId);
    if (!i) return;
    this.store.advance(i, "exec", status === "placed" ? "execute" : status === "reverted" ? "reverted" : "unknown",
      quote.orderId !== null ? `order ${quote.orderId} on the book` : `no receipt after block ${block}`);
  }

  /** After each trade-log poll: apply our maker fills (live) or simulate them against the new prints (dry run). */
  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    const fills: Fill[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      const b = (f as Fill & { block: number }).block;
      byBlock.set(b, [...(byBlock.get(b) ?? []), f]);
    }
    for (const [block, fs] of byBlock) {
      const fill = aggregate(fs);
      const e = this.history.find((h) => h.block === block);
      if (e) e.fill = fill;
      this.onFill(block, fill);
    }
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.size = f.updatedSize;
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, block: f.block });
    }
    return out;
  }

  /**
   * A simulated order placed at block N is on the book from N+1. A taker sell printing at or below
   * our bid (or a taker buy at or above our ask) would have taken us first: fill up to the print's size.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        const hit = o.side === "buy" ? p.side === "sell" && p.price <= o.price : p.side === "buy" && p.price >= o.price;
        if (!hit) continue;
        const size = Math.min(o.size, p.size);
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        out.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, block: p.block });
      }
    }
    return out;
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const q of this.inflight.values()) if (q.side === side) mon += q.size;
    return mon;
  }

  /** Would this order, and everything already resting on its side, keep us inside the cap and (live) inside margin funds? */
  private allowed(side: Side, book: Book) {
    const size = config.tradeSizeMon;
    const exposure = side === "buy" ? this.position.mon + this.restingMon("buy") + size : this.position.mon - this.restingMon("sell") - size;
    if (Math.abs(exposure) > config.maxPositionMon) return false;
    if (!this.market.wallet) return true;
    // Kuru debits margin when an order is placed, so the balance already excludes what is resting.
    return side === "buy" ? this.market.margin.usdc >= size * book.ask : this.market.margin.mon >= size;
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
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    const wasFlat = p.mon === 0;
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
    if (wasFlat && p.mon !== 0) {
      // a fill opened a position: arm TP/SL around the fill price
      const side: Side = p.mon > 0 ? "buy" : "sell";
      const ref = f.price;
      const tp = side === "buy" ? ref * (1 + config.tpBps / 1e4) : ref * (1 - config.tpBps / 1e4);
      const sl = side === "buy" ? ref * (1 - config.slBps / 1e4) : ref * (1 + config.slBps / 1e4);
      this.entry = { side, block: (f as Fill & { block?: number }).block ?? 0, ref, tp, sl };
      if (!this.market.wallet) this.orders.clear(); // entry filled: nothing else should rest (live: cancel TODO)
    }
    if (p.mon === 0) this.entry = null;
    this.totals.fills++;
  }

  /**
   * Lab position management: close the whole position at market (cross to the
   * touch) on TP, SL or time stop. The sim path is realized immediately; the
   * live path still needs a reducing order + receipt handling (TODO).
   */
  private closePosition(book: Book, reason: "tp" | "sl" | "time") {
    const size = Math.abs(this.position.mon);
    const side: Side = this.position.mon > 0 ? "sell" : "buy";
    const price = side === "sell" ? book.bid : book.ask;
    this.orders.clear();
    if (!this.market.wallet) {
      this.applyFill({ side, size, price, txHash: null, orderId: 0, simulated: true } as Fill);
    }
    this.entry = null;
    return { reason, price, size };
  }

  /**
   * Reconcile every send the ledger left open, before the block loop starts: ask
   * the chain about each one, by hash first then by nonce. A send we cannot
   * explain keeps `unresolved` above zero, which locks new entries through the
   * recovery reflex instead of trading on a book state we cannot prove.
   */
  async recover() {
    const open = this.store.openIntents();
    for (const row of open) {
      const r = await this.market.recoverSend({ txHash: row.tx_hash, nonce: row.nonce, block: row.block, side: row.side as Side, sizeMon: row.size_mon, price: row.price }).catch(() => null);
      if (!r) { this.unresolved++; continue; }
      this.store.updateIntent(row.id, { status: r.status, txHash: r.hash });
      const i = this.store.impulse(row.id);
      if (i) {
        this.store.advance(i, "exec",
          r.status === "placed" ? "execute" : r.status === "lost" ? "reverted" : "unknown",
          r.status === "placed" ? `recovery: order ${r.orderId} on the book`
            : r.status === "lost" ? "recovery: nonce still free, nothing was spent"
            : "recovery: mined without a receipt, verify the book");
      }
      if (r.status === "placed" && r.orderId !== null) this.orders.set(r.orderId, { side: row.side as Side, price: row.price, size: row.size_mon, block: row.block });
      if (r.status === "unknown") this.unresolved++;
    }
    if (open.length) console.log(`recovery: ${open.length} open send(s) reconciled, ${this.unresolved} unresolved${this.unresolved ? " (new entries locked by the recovery reflex)" : ""}`);
  }

  /** Everything the reflexes read, assembled from live state. No model involved. */
  private reflexFacts(book: Book, side: Side): ReflexFacts {
    const depth = book.depthBps["25"] ?? { bid: 0, ask: 0 };
    const resting = [...this.orders.values()].find((o) => o.side === side);
    // A resting quote the touch has moved past is a replacement, not a duplicate:
    // the send cancels it in the same transaction. Only a quote that still sits
    // where we put it (or one still in flight, fate unknown) blocks a new send.
    const displaced = !!resting && (side === "buy" ? resting.price < book.bid : resting.price > book.ask);
    const inflightSameSide = [...this.inflight.values()].some((q) => q.side === side);
    return {
      killSwitchActive: killSwitchActive(),
      sessionPnlUsd: this.totals.pnlUsd,
      gasGwei: this.market.effectiveGasGwei,
      liquidityMon: Math.min(depth.bid, depth.ask),
      spreadBps: book.spreadBps,
      score: this.score,
      alreadyQuotingSide: inflightSameSide || (!!resting && !displaced),
      exposureMon: side === "buy" ? this.position.mon + this.restingMon("buy") + config.tradeSizeMon : this.position.mon - this.restingMon("sell") - config.tradeSizeMon,
      fundsOk: this.allowed(side, book),
      unresolvedSends: this.unresolved,
    };
  }

  /** One impulse per block we act on: deterministic facts, the score, an opening transition. */
  private newImpulse(block: number, book: Book, state: TradeState): Impulse {
    const depth = book.depthBps["25"] ?? { bid: 0, ask: 0 };
    const scored = marketScore({
      spreadBps: book.spreadBps, depthBidMon: depth.bid, depthAskMon: depth.ask,
      bookImbalance: book.imbalance, ret20Bps: state.returnsBps.last20,
      exposureMon: this.position.mon, maxPositionMon: config.maxPositionMon, tradeSizeMon: config.tradeSizeMon,
    });
    this.score = scored.score;
    this.scoreParts = scored.parts;
    const impulse: Impulse = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      block, ts: Date.now(), score: scored.score, status: "pass", reflex: null, jev: null, intent: null, history: [],
      facts: {
        mid: book.mid, spreadBps: round(book.spreadBps, 2), imbalance: round(book.imbalance, 3),
        depth25BidMon: round(depth.bid, 1), depth25AskMon: round(depth.ask, 1), ret20Bps: state.returnsBps.last20,
        positionMon: round(this.position.mon, 2), unresolvedSends: this.unresolved,
        scoreParts: scored.parts.map((p) => `${p.name} ${p.delta > 0 ? "+" : ""}${p.delta}`).join(" "),
      },
    };
    return impulse;
  }

  /**
   * Write one transition, opening the impulse with its `scan` step on the first
   * write. Journals are written only when something happened (a reflex fired, an
   * order went out, a position closed) plus a sampled share of plain holds: the
   * per-block decision record for research is `states.jsonl`, and journalling
   * every block would add a quarter of a million rows a day for nothing.
   */
  private journal(i: Impulse, node: Node, verdict: Verdict, note = "") {
    if (!i.history.length) this.store.advance(i, "scan", "pass", `score ${i.score}`);
    return this.store.advance(i, node, verdict, note);
  }

  /** Count a reflex stop: the impulse carries the name, the session keeps the tally. */
  private hitReflex(impulse: Impulse, name: string) {
    impulse.reflex = name;
    this.reflexHits[name] = (this.reflexHits[name] ?? 0) + 1;
    this.totals.reflexRejects++;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, late: boolean, timing?: Timing, exit: BlockEvent["exit"] = null, journal: { impulseId: string | null; reflex: string | null } | null = null) {
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
      quote,
      fill: null,
      exit,
      score: this.score,
      reflex: journal?.reflex ?? null,
      impulseId: journal?.impulseId ?? null,
      resting: { bidMon: round(this.restingMon("buy"), 1), askMon: round(this.restingMon("sell"), 1) },
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

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[]): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
