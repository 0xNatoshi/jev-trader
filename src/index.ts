import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";

const market = new Market();
await market.init();
const model = createModel();

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
);
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late && e.decision.action !== "hold") {
      const p = e.decision.probabilities;
      const f = e.fill;
      const fill = !f ? "" : f.confirmed
        ? ` FILL ${f.side} ${f.size} @ ${f.price.toFixed(6)}${f.simulated ? " (sim)" : ` ${f.txHash}`}`
        : ` SENT ${f.side} ${f.size} ${f.txHash}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} ${e.decision.action.padEnd(4)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} h${(p.hold * 100).toFixed(0)} ${e.decision.latencyMs}ms${fill} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} CONFIRMED ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)} gas ${fill.gasMon.toFixed(6)} MON ${fill.txHash}`);
  },
);
trader.attachTradeFeed(log10(market.params.sizePrecision));

console.log(`jev-trader · model=${model.name} · decide every ${config.decideEveryBlocks} blocks · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · read ${config.readRpcUrl} · :${config.port}`);
startBlockFeed((block) => trader.onBlock(block));
