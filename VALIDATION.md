# VALIDATION - lab to prod ladder (per market)

A strategy earns production only by climbing three stages, per market, in order.
No stage skipped; no market inherits another market's validation.

## Stage 1 - Backtest (historical data)
- Dataset: the market's full on-chain history (Kuru MON-USDC: 268 days,
  event-level: every order/cancel/trade since deployment; book reconstructable).
- Method: walk-forward (rolling train/test), no look-ahead, costs included
  (fees, gas, spread capture and exit crossing, simulated queue).
- Exit criteria to stage 2: net PnL >= 0 across the full period AND in the
  out-of-sample folds; the behavior is understood (not one lucky regime).

## Stage 2 - Forward test (dry-run on the live market)
- The bot runs dry (real market, simulated fills) with the strategy frozen.
- Duration: medium-long - target >= 4 weeks of continuous run, covering varied
  regimes (calm, volatile, macro event, incident if any).
- Exit criteria to stage 3 (proposed defaults - adjust together):
  * net PnL > 0 after all measured costs;
  * consistency: positive on >= 60% of days, and no single day > 40% of the
    period's total PnL;
  * max drawdown < 20% of the bankroll reference;
  * fill realism: live fill behavior does not diverge from the backtest.
- If criteria fail: back to the lab, change ONE variable, restart the clock.

## Stage 3 - Production, tiny size
- Real funds, minimum size (1 clip), strategy frozen, hard risk caps (position,
  daily loss, kill switch), full logging.
- Scale only after >= 2 more weeks of live positive medium-term results.

## Standing rules
- One market climbs at a time; data collection may run in parallel.
- Every stage's metrics live in the repo (data/ + reports). No vibes: if it is
  not measured, it did not happen.
- The dry-run gate from LAB.md always applies: no real funds before stage 3.

## Current positions
- Kuru MON-USDC: stage 1 (backtest) - data backfill in progress (268 days).
  Forward (dry) already collecting in parallel: the lab bot runs continuously.
- Polymarket / sports / memecoins: not started (data collection can start any
  time, in parallel).
