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

## Deterministic layer (reflexes, score, journal)

Pattern borrowed in spirit from NERVE (`github.com/h100envy/nerve`, no LICENSE
file: ideas only, never code). The doctrine it confirms: the model writes a
thesis and a confidence, and it cannot move a size, pick a side the reflexes
forbid, or send anything.

- `src/reflexes.ts`, 9 pure checks in two passes. Market wide ones (kill switch,
  unreconciled send, session loss, gas cap, liquidity, spread, score) run BEFORE
  the model, so a locked-out strategy costs nothing. Side dependent ones
  (duplicate side, max exposure, funds) run BEFORE signing.
- `src/score.ts`, deterministic 0 to 100 book score (spread, depth, balance,
  move, inventory). Same facts, same score, always. Its job is to gate broken
  books and to give the model something to be measured against.
- `src/store.ts`, SQLite journal (`data/decisions.db`): one impulse per event
  worth remembering (a reflex fired, an order went out, a position closed, plus
  a sampled share of holds), each with its typed transition history. The full
  per block record stays in `states.jsonl`.
- Exactly once: the send is journalled BEFORE the signature, with its nonce. A
  receipt that never arrives is `unknown`, never a failed send, and nothing is
  re-sent. `Trader.recover()` reconciles open sends at boot by hash then nonce;
  `recovery_pending` locks new entries while anything is unexplained.

## Runbook

- Run: `bun run src/index.ts` (dry-run by default). JSON on `:3000`, console on
  `:3000/dashboard` (three columns, live over SSE), raw journal on
  `:3000/api/journal`.
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
