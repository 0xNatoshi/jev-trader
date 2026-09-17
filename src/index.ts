import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";
import { acquireLock, releaseLock } from "./engine-lock";

// One engine per host: refuse to start over a live one, take over a stale lock.
// Nothing is initialised (no margin, no state write) before this check passes.
const LOCK_PATH = process.env.ENGINE_LOCK ?? "data/engine.lock";
const holder = acquireLock(LOCK_PATH, `jev-trader :${config.port}`);
if (holder) {
  console.error(
    `engine already running: pid ${holder.pid} (started ${new Date(holder.startedAt).toISOString()}, ${holder.label}). ` +
    `Refusing to start a second engine on the same state. Kill it first, or point ENGINE_LOCK elsewhere.`,
  );
  process.exit(1);
}
const release = () => releaseLock(LOCK_PATH);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { release(); process.exit(0); });
process.on("exit", release);

const market = new Market();
await market.init();
const model = createModel();

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
  {
    recent: (n) => trader.store.recent(n),
    counts: () => trader.store.counts(),
    reflexHits: () => trader.reflexHits,
    score: () => trader.score,
    scoreParts: () => trader.scoreParts,
    unresolved: () => trader.unresolvedCount,
  },
);
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms score ${e.score}${e.reflex ? ` reflex ${e.reflex}` : ""}${quote} pnl $${e.totals.pnlUsd}${t ? ` | read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
  },
);

// Reconcile whatever the ledger left open BEFORE the loop trades: a send whose
// receipt never arrived is unresolved, not failed, and it locks new entries.
await trader.recover();
trader.attachTradeFeed(log10(market.params.sizePrecision));

const counts = trader.store.counts();
console.log(`ENGINE_STARTED pid=${process.pid} lock=${LOCK_PATH}`);
console.log(`jev-trader | model=${model.name} | post-only ${config.quoteInsideTicks} tick inside the touch | horizon ${config.horizonBlocks} blocks | ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} | market ${config.market} | read ${config.readRpcUrl} | journal ${counts.impulse} impulses / ${counts.transitions} transitions | :${config.port}`);
console.log(`reflexes | min score ${config.minScore} | max spread ${config.maxSpreadBps} bps | min liquidity ${config.minLiquidityMon} MON | session loss ${config.sessionLossLimitUsd} USD | kill switch ${config.killSwitchFile} | console http://127.0.0.1:${config.port}/dashboard`);
startBlockFeed((block) => trader.onBlock(block));
