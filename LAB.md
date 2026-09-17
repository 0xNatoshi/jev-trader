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

## Maker edge: the PnL split we judge the strategy by

Directional accuracy is not the question a maker answers (see `docs/INSIGHTS.md`,
arXiv 2607.11888). Every fill is decomposed, `MARKOUT_BLOCKS` (default 100) after
it lands, and the three terms live in `totals.mm`, the journal (`markout`
transition), the console and the daily report:

- `quoted` (capture): sign x (mid at fill - our price) x size. What we sold the
  option to trade for.
- `markout`: sign x (mid after H - mid at fill) x size. Negative means the flow
  knew something we did not. The adverse selection term, in bps of the mid.
- `carry`: mark-to-market of the inventory we hold between fills. The part that is
  not market making.
- **net edge = quoted + markout.** A maker with a positive quote and a negative
  net is being picked off, not paid. `dashboard` shows it as MAKER EDGE.

## Quoting: reservation price, skew, volatility-scaled spread

`src/quoting.ts` is a deterministic two-line version of Avellaneda-Stoikov:

- `sigma` is the **realised horizon volatility**: the stdev of overlapping
  `HORIZON_BLOCKS` returns in our own mid series. Measuring the horizon return
  directly matters: extrapolating one-block noise by sqrt(T) inflated sigma on a
  tick-quantised book and priced our quotes ~9 bps off mid, behind the touch, with
  zero fills.
- `r = mid x (1 - qNorm x gamma x sigma)`: long inventory shifts the whole ladder
  **down**, so we sell eagerly and buy reluctantly.
- `delta = max(min, gamma x sigma + liq)`: a faster tape widens the half-spread,
  which is the direct answer to the markout we measure.
- The ladder is clamped to the touch (`INSIDE_TICKS` inside at most, `MM_MAX_DISTANCE_BPS`
  behind at worst) and never crosses. With a calm tape it lands one tick inside the
  touch exactly as the previous rule did; with a fast one it backs off.

## Sizing and toxicity (from the 17 Sep sweep)

- **Sizing is a function of depth** (`Trader.quoteSize`): the base `TRADE_SIZE_MON`
  (the venue minimum) on a near-touch book thinner than `DEEP_DEPTH_RATIO` x our size,
  `MAX_QUOTE_MON` when it is deeper. `poly-maker`'s field guide ranks this first: on a
  thin book a fill should be small and disposable, because a gapped market can shove a
  resting order into a directional bag we never wanted.
- **Toxicity gates a side, not the whole market.** `FlowToxicity` measures net over
  gross taker volume across `FLOW_WINDOW_BLOCKS`. It replaced a VPIN implementation:
  volume buckets saturate on this market because a single MON-USDC print is larger
  than any sane bucket (measured live: VPIN pinned at 0.99 and blocked every quote).
  Two reflexes use it: `toxic_side` stands down on the side the flow is running over
  (buy-heavy flow fills our ask and keeps going), `stressed_flow` pauses everything
  above `MAX_TOXICITY_EXTREME`.
- **Market facts read on-chain**: `makerFeeBps = 0` and `takerFeeBps = 0` on MON-USDC,
  so the maker's revenue is the spread alone and no reward scheme needs sizing for
  (Kuru's `RewardVault` is signer-driven campaign infrastructure, not a standing
  maker-reward program).

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
