import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { startServer } from "./server";

const market = new Market();
await market.init();
const model = createModel();

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
);
const trader = new Trader(market, model, (e) => {
  server.broadcast(e);
  if (e.decision && !e.decision.late) {
    const p = e.decision.probabilities;
    console.log(`#${e.block} ${e.mid.toFixed(6)} ${e.decision.action.padEnd(4)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} h${(p.hold * 100).toFixed(0)} ${e.decision.latencyMs}ms${e.fill ? ` FILL ${e.fill.side} ${e.fill.size} @ ${e.fill.price.toFixed(6)}${e.fill.simulated ? " (sim)" : ` ${e.fill.txHash}`}` : ""} pnl $${e.totals.pnlUsd}`);
  }
});

console.log(`jev-trader · model=${model.name} · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · :${config.port}`);
startBlockFeed((block) => trader.onBlock(block));
