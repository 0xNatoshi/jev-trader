# LAB - decision-quality fork

This fork line (`lab/decision-quality`) turns the demo bot into a decision-quality
laboratory. The demo optimizes for a 20-second clip. The lab optimizes for a
strategy that eventually makes money.

## Policy (Thibault)

- **Lab -> prod ladder, per market** (see `VALIDATION.md`): backtest ->
  forward dry-run (medium-long term) -> tiny live. No stage skipped; no market
  inherits another market's validation.
- **No real funds until the forward stage shows medium-long-term profit, net of
  costs.** Dry-run only (`DRY_RUN=true`) until then.

## What the lab changed vs the demo

- Entries only on a clear signal (`ENTRY_MIN_PROB`). "Hold" is a real answer.
- One position at a time. No per-block flips, no cancel/replace churn
  (a resting quote is refreshed only when the touch moves past it).
- Position management: take-profit (`TP_BPS`), stop-loss (`SL_BPS`), time stop
  (`TIME_STOP_BLOCKS`).
- Per-block `TradeState` + decision logged to `data/states.jsonl` when
  `STATE_LOG=true`.

## Runbook

- Run: `bun run src/index.ts` (dry-run by default). JSON + dashboard on :3000.
- Offline replay of logged decisions:
  `bun scripts/replay-decisions.ts [--horizons 10,50,100]`.
- Online demo archive (Jarrod's railway build): Hermes cron every 5 min writes
  `data/online-archive.jsonl`.
- Keepalive + daily report: Hermes crons `jev-trader-keepalive` (hourly, restarts
  the bot if :3000 stops answering) and `jev-trader-lab-report` (daily, 20:30).

## Findings so far

- Crossing the spread costs about 2x spread per round trip. Every-block market
  orders explain the online demo's -270%. Maker-only execution is mandatory.
- Extreme `p(buy)` (>= 0.95) underperforms at H=50..100 (-2 to -10 bps vs the
  window mean): flow extremes fade. Moderate signals (0.6..0.95) carry a small
  momentum edge. Small samples: keep collecting, re-run the replay.

## Data pipeline (order flow)

- Backfill on-chain: `scripts/backfill-logs.py` -> `data/history/raw/seg_<block>.jsonl.gz`
  (resumable, 100-block chunks, 4 workers; ~4 min per day of chain). Events:
  OrderCreated / OrdersCanceled / Trade (plus one undecoded topic to identify).
- Scope: FULL history of MON-USDC events (268 days, since deployment). Old-era
  cancellations dropped to save space (everything is re-downloadable on-chain).
- Next: decode -> compact parquet, behavior analyses, live WS capture.
