# Multi-market playbook - one kernel, N markets

How the same trading system extends across markets without rewriting everything:
what is common, what changes, and how to parallelize (or not).

## The kernel (common to every market)
1. **Data**: behaviors + events collected for the specific market (never generic).
   On-chain where possible (full replayable history), + technical/macro context.
2. **Decision**: Jev as the judgment layer - decomposed questions combined in
   code, driven by a state that carries the "elements in mind" (context flags:
   session, event proximity, market health, position).
3. **Execution**: disciplined placement (maker-first, hysteresis, inventory
   caps, TP/SL, time stop, kill switch) via a per-market adapter.
4. **Measurement**: dry-run gate until profitable net of costs, then tiny live
   size. Simulation realism validated against real prints.

## What changes per market
- **Crypto CLOB (Kuru MON-USDC, Bitcoin)**: edge = spread capture + selection +
  inventory control; events = chain/technical (incidents, upgrades, vaults,
  incentives) + macro; latency matters; data = full on-chain history.
  STATUS: in flight (the lab).
- **Memecoins**: edge = flow/event driven - momentum + anti-extremes, small
  size, fast exits; events = launches, socials, liquidity pulls; data =
  on-chain + social (X via xmesh). Jev = "is this flow informed? fake pump?"
  gating, exit discipline.
- **Prediction markets (Polymarket)**: edge = probability errors (longshot
  bias, basket arbitrage, convergence bands), resolution logic; events = the
  news being priced + resolution dates; execution = CLOB API (maker-friendly);
  data = market APIs. Fair values partly computable in code; Jev = information
  state + gating. Natural fit #2.
- **Sports (Betfair, Polymarket sports)**: edge = live probability vs price
  (in-play scalping, green-up); events = match events (goals, points, cards);
  data = live stats feeds; Jev = live probability model (its natural shape) +
  event gating (red card, momentum shift).

## Parallelization - the honest version
- **Data collection**: genuinely parallel across markets - cheap, start anytime,
  no conflict. (E.g. Polymarket book/trades archive can run alongside Kuru.)
- **Strategy development**: effectively serial - prove the kernel on ONE market
  before porting. Kuru first (in flight), Polymarket = natural #2 (API access,
  best Jev fit, CLOB mechanics already understood).
- **Code**: when market #2 starts, refactor the lab into `kernel/` (state,
  decision, execution, sim, metrics) + `markets/<name>/` adapters. Do NOT
  over-abstract before then.
- **Capital**: one small bankroll per market once live; never cross-margin the
  strategies. Dry-run gate applies per market.
