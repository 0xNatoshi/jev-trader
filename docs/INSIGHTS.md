# INSIGHTS — single-pass scrape (2026-09-17)

One deep pass over every source that carries signal for this lab: **X** (26 queries
via `xread`, 159 posts kept), **GitHub** (40+ searches via `gh api`, 5 repos read at
code level), **arXiv** (8 queries, 35 papers), and the **venue's own docs** (Kuru,
`docs.kuru.io/llms-full.txt`). It is a sweep, not a cron: re-run it when we decide
to (the reusable script is `~/.hermes/scripts/quant-veille.py`, run on demand).

Anything without a LICENSE is **ideas only, never code**.

---

## 0. The five levers, in the order I would pull them

1. **Size against depth, not a constant.** `poly-maker`'s TIPS.md ranks this as their
   single biggest loss: on a thin or gapped book a resting order gets shoved into and
   filled into a directional bag ("a seller gapped the market, filled our whole bid,
   an oversized -$5 long we never wanted"). Their rule: **rest the minimum size on
   thin or manipulable books, big size only where you can offload into it.** We quote
   a flat 200 MON every block, whatever the depth.
2. **Quote a reservation price with inventory skew** instead of "1 tick inside the
   touch". Standard: `r = s - q·γ·σ²·(T-t)`, `δ = γσ²(T-t) + (2/γ)·ln(1+γ/κ)`
   (Avellaneda-Stoikov), in **logit space** when the instrument is a probability:
   `logit(p) = ln(p/(1-p))`. Implementations: `warproxxx/poly-maker` (`gamma`,
   `delta_min_ticks`, `c_vol`), `joaquinbejar/market-maker-rs` (A-S + GLFT),
   `holypolyfoundation/bs-p`, `tfrmma/prediction-market-maker`.
3. **Toxicity as a live input.** VPIN, volume-bucketed: `imbalance_i = |V_buy -
   V_sell| / V_total`, `VPIN = mean of the last N buckets` in [0,1], alert around
   **0.7** (Easley/López de Prado/O'Hara 2012; formula in
   `market-maker-rs/src/analytics/vpin.rs`). `poly-maker` carries a `c_tox` spread
   coefficient and logs `tox=` on every requote: when flow turns one-sided, widen or
   pull. The Kalshi evidence says one-sided flow predicts maker losses exactly where
   the book is thin and the market single-name.
4. **Check whether we can be paid to quote.** Kuru's own docs: "instead of taking a
   percentage from each trade, **your fee is the spread** between your buy and sell
   orders" — our venue *is* the zero-maker-fee case arXiv 2607.11888 is written for.
   A **$1.225M Kuru incentive program** has been advertised to bootstrap liquidity,
   and reward schemes have mechanical rules (a minimum order size, a maximum distance
   from mid: `rewardsMinSize` / `rewardsMaxSpread`, ±10% bands on TRUF). Those rules
   would decide sizing as much as our edge does. **Verified on-chain, 17 Sep: there is
   no program to size for.** MON-USDC has `makerFeeBps = 0` and `takerFeeBps = 0`, and
   Kuru's `RewardVault` is signer-driven campaign infrastructure rather than a standing
   maker-reward scheme. The maker's revenue here is the spread alone, which is exactly
   the zero-fee case the paper studies.
5. **Stop simulating fills brutally.** We treat every print through our price as a
   full fill. The taxonomy to implement, rising realism: immediate / **queue
   position** / **probabilistic** / market impact
   (`market-maker-rs/src/backtest/fill_models.rs`). Until the sim models queue
   position, every backtest we run is optimistic in the dimension that decides maker PnL.

---

## 1. Papers worth implementing (not just citing)

- **arXiv 2606.09454 — Axiomatic Market Making.** Axiomatizes the quoting rule: state
  = (inventory, belief, variance, trade intensity, **informed-trader fraction**) → a
  bid-ask pair. That is a specification for a quoter we do not have yet.
- **arXiv 2607.11888 — Optimal Adaptive MM, zero maker fees.** PnL decomposition
  (now implemented in this repo: `totals.mm`), Master APY formula, five dimensionless
  parameters, optimal entry-exit thresholds.
- **arXiv 2608.04373 — Public Trader Identity: Adverse Selection and Return
  Predictability.** "A decentralized exchange now publishes the counterparty. Every
  committed order, cancellation, rejection…" Our book is on-chain and our quotes are
  public: whoever wants to pick us off can watch us set up. Read before scaling size.
- **arXiv 2606.05882 — Market Informedness and MM Profitability** (adverse selection
  vs price discovery) and **2609.11614 — Robust MM under Regime-Switching Order
  Flow**: why A-S/GLFT break when the flow regime changes.
- **arXiv 2606.15715 — Market Impact and Adverse Selection on Hyperliquid**: the same
  question on another on-chain book, with real data.
- **arXiv 2602.00776 — Explainable Patterns in Cryptocurrency Microstructure**:
  cross-asset LOB features with stable SHAP importance → a shopping list for what our
  decision layer should see.
- **arXiv 2510.27334 — When AI Trading Agents Compete**: RL market makers adversely
  select slower agents. On point for "can a model's decisions trade profitably".
- **arXiv 2607.06166 — When do prophets profit in prediction markets?**: forecasting
  accuracy and trading profit are not the same thing (our A/B finding, in theory form).
- **arXiv 2609.14038 / 2607.17428 / 2607.18299** — seed-capital recovery, uniform-loss
  AMMs, parlay markets: prediction-market venue mechanics, for later.
- **Bartlett & O'Hara, *Adverse Selection in Prediction Markets* (Kalshi, 41.6M
  trades).** Single-name markets show a **larger informed price impact**, yet makers
  earn **twice as much per contract**: traders **systematically overbet YES in markets
  that settle NO**, a behavioural surplus that cross-subsidises adverse selection.
  Adapting VPIN, one-sided flow predicts maker losses in **single-name markets only**.
  → prefer broad-based markets; the durable edge is selling the YES side of longshots.

## 2. Market making / microstructure repos

| repo | licence | what it gives us |
|---|---|---|
| `warproxxx/poly-maker` (1.5k★) | MIT | Maker-only Polymarket bot. `config/strategy.toml` is a tuned profile with exactly the knobs we lack: `gamma` (inventory skew), `delta_min_ticks`, `c_vol`, `c_tox`, `q_max_usdc` + `q_soft_frac` (stop adding at 60% of the cap, exits get urgent), `layers`, `reprice_ticks` (ignore 1-tick fair-value flicker to hold queue position), `min_edge_ticks`, a **regime machine** (event jump, sweep detection, `event_cooloff_s`) and a `MarkoutTracker`. Its TIPS.md is an operator's field guide: **run exactly ONE engine** (two engines on one wallet race and double-order), watch the stream not the snapshot, and "liveness is not quiet" — probe open orders on-chain. |
| `joaquinbejar/market-maker-rs` (101★) | MIT | A-S + GLFT + grid, adaptive spread from book imbalance, **VPIN**, order-intensity estimation to calibrate λ(δ)=A·e^(−kδ), event-driven backtester with the **four fill models**. |
| `holypolyfoundation/bs-p` (162★) | MIT | Avellaneda-Stoikov in **logit space** for prediction markets (Logit Jump-Diffusion), shipped as Rust/Bun/PyPI. |
| `tfrmma/prediction-market-maker` | MIT | A-S pricing adapted to **binary** markets (Polymarket CLOB v2 + Kalshi), feed/resolver split per venue. Small, recent, readable. |
| `truflation/liquidity-provider-bot` | none | Quotes **inside rewards-eligible bounds**; volume-weighted pricing; time decay for stale orders. The rewards mechanics in code. |
| `mbordash/DRADIS` (AGPL-3.0) | AGPL | Low-latency Rust prediction-market bot, 9 strategies (momentum, maker, arb, ML). AGPL: read, do not copy. |
| `rodlaf/KalshiMarketMaker` (393★) | MIT | Working A-S Kalshi worker with explicit safety controls. |
| `HarrierOnChain/Prediction-Markets-Trading-Bot-Toolkits` (451★) | MIT | Venue-agnostic **adapter stack** (Polymarket, Kalshi, Limitless) — the shape our multi-market playbook needs. |
| `guzus/dr-manhattan` (201★) | none | CCXT for prediction markets (Polymarket, Kalshi, Limitless, Opinion, PredictFun). |
| `nkaz001/hftbacktest` | MIT | Order-book backtester with queue-position modelling — the reference for our fill sim. |
| `godzilla-foundation/godzilla-community` (373★) | Apache-2.0 | C++/Python funding-rate arbitrage + MM infrastructure. |
| `Hummingbot` (20k★) | Apache-2.0 | The reference open-source MM bot; exchange-centric, good reconciliation patterns. |

## 3. Decision layer / agents

| repo | licence | what it gives us |
|---|---|---|
| `Oft3r/agentic-trading-desk` (292★) | MIT | The doctrine in one line: *the AI fetches data and talks to the user; scripts do the deterministic maths; the human approves execution.* A three-pillar deterministic score next to the model — our reflexes/journal split, arrived at independently. |
| `howdymary/autopredict` (110★) | MIT | **Proper scoring rules, calibration summaries**, and a harness that promotes improvements on **held-out** data only; strict data policy (no silent synthetic fallbacks). The evaluation surface our A/B lacks: calibration, not just edge. |
| `TauricResearch/TradingAgents` (107k★) | Apache-2.0 | Multi-agent research/decision patterns (analyst → debate → trader → risk). Its changelog is a catalogue of **look-ahead bugs** — a warning for anyone backtesting with LLM agents. |
| `alsk1992/CloddsBot` (2.7k★) | MIT | One agent across 1 000+ markets: agent-side plumbing, not an edge. |

## 4. Our own upstream

`jarrodwatts/jev-trader` (415★, 81 forks, MIT). Its commits of 16-17 September
converge on what the lab concluded: *post-only limit orders every block (earn the
spread instead of paying it)*, *side hysteresis (flip only above FLIP_THRESHOLD)*,
*decide every 10 blocks on a 100-block horizon*, *keep the model market-only, keep
inventory in the deterministic layer*. And its issue **#1 "It's losing money"** is
open — the whole segment's problem in one line.

## 5. Warnings collected on the way

- **Look-ahead bias is the default failure mode** (TradingAgents changelog; the X
  thread "STOP USELESS AI BACKTESTING" — 74% win rate, bleeds live from day one).
- **Measure real costs early** (@bored2boar: "backtested it, looked like a winner,
  then I actually measured real costs"). Our A/B already nets one spread out, and
  that turned a flat edge negative.
- **Short-term trend following has decayed** (arXiv 2607.01550): do not bolt a trend
  filter on and call it edge.
- **Two engines on one wallet double-order** (poly-maker TIPS). Our keepalive checks
  the port, which is weaker than "exactly one `engine_started`".
- **Rewards metadata goes stale** (their `rewardsMinSize` changed 50→100 live): a
  stale floor silently under-sizes orders into zero rewards.

## 6. Backlog this pass generates

| # | Item | Where it lands | Cost |
|---|---|---|---|
| 1 | Size from depth (minimum on thin books, larger on deep ones) | done: `Trader.quoteSize`, `MAX_QUOTE_MON` |
| 2 | Flow toxicity as a reflex, logged per decision | done: `FlowToxicity` + `toxic_side` / `stressed_flow` (VPIN abandoned, see §0.3) |
| 3 | Kuru rewards eligibility for MON-USDC | done: zero fees both sides, nothing to size for |
| 4 | Reservation price + inventory skew (`gamma`) instead of tick-inside-the-touch | `src/market.ts` `quotePrice` | M |
| 5 | Queue-position fill model in the dry-run sim | `src/trader.ts` `simFills` | M |
| 6 | Regime machine (jump / sweep / cooloff) as a reflex | `src/reflexes.ts` | M |
| 7 | Single-engine guard (one `engine_started` per wallet, not just a port check) | keepalive script | S |
