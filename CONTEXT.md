# CONTEXT - Kuru MON-USDC (living dossier)

The elements to keep in mind to take a trading decision on this market.
Not a scraper and not a cron: a curated reference, updated when the situation
changes. The bot's decision layer should carry the flags below in its state.

## 1. The market
- Kuru: fully on-chain CLOB on Monad. 12 live markets; ours is MON_USDC
  `0x065c9d28e428a0db40191a54d33d5b7c71a9c394` (plus V3/V4 vault variants on
  the same pair: MON_USDC_V3_30, V3_5, V4_5).
- Liquidity is mixed: CLOB + vaults (market-making vaults) + backstop AMM. The
  MON/USDC market-making vault is LIVE: part of the book we trade against is
  programmatic and observable on-chain (track it as the main local competitor).
- Margined orders: margin account balances, min order 200 MON, tick 0.000001,
  post-only supported. No maker/taker fee at the moment (takerFeeBps=0).
- History: market deployed ~late Dec 2025; every order/cancel/trade is on-chain
  (we backfill locally, scripts/backfill-logs.py).

## 2. Technical events (market-specific watchlist)
- Halt/incident risk: precedent - XAUT0/USDC incident -> Kuru paused
  deposits/withdrawals across markets during the investigation. If a halt
  happens mid-position we may be stuck -> stay flat / wider margins when the
  book shows anomaly patterns.
- Vault & incentive changes: Kuru incentive programs and vault launches change
  flow and book shape (watch x.com/KuruExchange and docs when behavior shifts).
- Token waves: Monad memecoin rotations pull retail in/out (vol and flow spikes).
- Chain level: Monad upgrades/maintenance, RPC rate limits (affects our data
  pulls and the bot), block cadence changes (the 300ms loop assumes ~0.4s blocks).
- Consensus states: proposed / voted / finalized / committed. We read
  committed; `proposed` is fresher but can revert on reorg.

## 3. Macro events (calendar to keep in mind)
- FOMC 2026: Sep 15-16 (JUST PASSED - inside our backfill window), Oct 27-28,
  Dec 8-9. Rate decision ~14:00 ET (~20:00 CET).
- CPI: 08:30 ET (~14:30 CET). Recent: Sep 11, 2026; upcoming: Oct 14, Nov 10,
  Dec 10, 2026.
- NFP: usually the first Friday of the month, 08:30 ET.
- Crypto beta: BTC regime (risk-on/off widens alt spreads), funding rates on
  majors, weekends (thinner books), US vs Asia session transitions.
- Stablecoin rails: USDC/AUSD flows, depeg headlines.

## 4. Behaviors to quantify on our own data (30d backfill)
- Spread & depth by hour/day (session map) - which hours are tradable.
- Around macro prints (e.g. FOMC Sep 16): spread/depth/flow before vs after.
- Who trades: wallet clustering (vault vs retail vs bots), trade sizes.
- Adverse selection: post-fill drift by regime (when maker fills bleed).
- Order-book life: quote flicker, cancel bursts, spoof-like patterns.

## 5. Decision-layer implications
- The Jev state should carry: session/time-of-day, market health (spread,
  depth, imbalance), event proximity (FOMC/CPI windows), market status flags
  (incident mode), and position context (side, TP/SL, time in position).
- Decompose Jev questions (TypeSafe docs): direction, toxicity, regime,
  quote on/off, sizing - combined in code, never one blob question.
- The bot's logging (STATE_LOG) already records the per-block state; extend it
  with the flags above so every decision is auditable against context.
