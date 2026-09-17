# INSIGHTS — veille GitHub + X

Maintained by Wilson (Hermes). Sources that matter for this lab: **X and GitHub**.
The recurring scanner is `~/.hermes/scripts/quant-veille.py` (Hermes cron, silent
unless something new shows up); this file is the curated digest, newest first.

Segments we watch: (1) maker market making on an order book, (2) decision layer
(a model over structured signals, and how to measure it), (3) prediction markets,
(4) validation: backtests, fill models, calibration, (5) execution and recovery.

---

## 0. Our own upstream

`jarrodwatts/jev-trader` (415 stars, 81 forks, MIT) — the demo this lab forks.
Its commits on 16-17 September converge on exactly what the lab concluded:

- *Post-only limit orders every block: earn the spread instead of paying it* →
  maker-only, same conclusion we reached.
- *Side hysteresis: flip only when the other side's probability clears
  FLIP_THRESHOLD* → the churn problem we solved with `displaced`.
- *Decide every 10 blocks on a 100-block horizon* → the per-block decision is
  noise; our `horizonBlocks` already does this, our score should follow.
- *Model state: drop position and last decision so Jev judges the market only* →
  keep the decision model market-only, keep inventory in the deterministic layer.
- Issue **#1 "It's losing money"** (open, one jokey comment): the whole segment's
  problem in one line.

## 1. Papers that change how we measure

**Bartlett & O'Hara, *Adverse Selection in Prediction Markets: Evidence from
Kalshi*** (Stanford/Cornell, 41.6M trades, SSRN 6615739).
Single-name markets show a **larger informed price impact** than broad-based
markets, yet effective spreads are only modestly wider and **market makers earn
twice as much per contract**. The puzzle resolves through a frequency-magnitude
decomposition: traders **systematically overbet YES in markets that mostly settle
NO**, and that behavioural surplus cross-subsidises adverse selection. Adapting
**VPIN**, one-sided order flow predicts maker losses in **single-name markets
only**.

→ Take: prefer broad-based markets; the durable maker edge in probability markets
is selling the YES side of longshots, not predicting direction; and *one-sided
flow* (not volatility) is the toxicity signal to gate on.

**arXiv 2607.11888 — *Optimal Adaptive Market Making … in Perpetual Futures
Markets* (Apr 2026, zero maker fees).** Gives a **PnL decomposition theorem**:
revenue = spread income − adverse selection loss − inventory carrying cost −
hedging friction − funding exposure; a **Master APY Formula** with five
dimensionless parameters bounding the profitable region; and **optimal entry-exit
thresholds** for zero-fee DEXes.

→ Take: report our PnL as that decomposition instead of one number. Kuru is
literally the zero-fee case the paper studies.

Also read: *Reinforcement learning for automated market making in crypto
perpetual futures* (Elsevier, funding-rate aware), *Backtesting Market Making
Strategies in Crypto Landscapes* (Roll vs GARCH volatility, custom simulator).

## 2. Market making / microstructure — what to steal

| repo | licence | what it gives us |
|---|---|---|
| `warproxxx/poly-maker` (1.5k★) | MIT | Maker-only Polymarket bot: fair value + inventory skew, **churn tolerances** when reconciling target quotes against live orders, per-regime strategy profiles, SQLite state, paper mode, and a **two-step live self-test** (deep post-only order, then a real fill round-trip for cents) before enabling size. |
| `joaquinbejar/market-maker-rs` (101★) | MIT | The feature list we should copy: A-S + GLFT, adaptive spread from book imbalance, depth-based size, **VPIN toxicity**, **order-intensity estimation** to calibrate λ(δ)=A·e^(−kδ), and an event-driven backtester with four **fill models** (immediate, queue position, probabilistic, market impact). Our flow sim is the brutal "immediate" one. |
| `holypolyfoundation/bs-p` (162★) | MIT | Avellaneda-Stoikov in **logit space** for prediction markets (Logit Jump-Diffusion), shipped as Rust/Bun/PyPI. Probability markets are not price markets: quote in logit. |
| `javifalces/HFTFramework` (307★) | Apache-2.0 | Backtest → paper → live ladder with market-making algorithm docs; useful as a shape for our validation stages. |
| `rodlaf/KalshiMarketMaker` (393★) | MIT | Working A-S Kalshi worker with explicit safety controls: operational tooling around a single strategy, not a framework. |
| `guzus/dr-manhattan` (201★) | none | CCXT for prediction markets (Polymarket, Kalshi, Limitless, Opinion, PredictFun) — the adapter layer our multi-market playbook needs. |
| `Hummingbot` (20k★) | Apache-2.0 | The reference open-source MM bot; exchange-centric, but a good source for execution/reconciliation patterns. |

## 3. Decision layer and agents — what to steal

| repo | licence | what it gives us |
|---|---|---|
| `Oft3r/agentic-trading-desk` (292★) | MIT | The doctrine in one line: *the AI fetches data and talks to the user; scripts do the deterministic maths; the human approves execution.* A three-pillar deterministic score next to the model. This is our reflexes/journal split, arrived at independently. |
| `howdymary/autopredict` (110★) | MIT | **Proper scoring rules, calibration summaries**, and a meta-harness that promotes improvements on **held-out** data only; strict data policy (no silent synthetic fallbacks, missing stays missing). The evaluation surface our A/B script lacks: calibration, not just edge. |
| `TauricResearch/TradingAgents` (107k★) | Apache-2.0 | Multi-agent research/decision patterns (analyst → debate → trader → risk). Its changelog is a catalogue of **look-ahead bugs** fixed release after release — a warning for anyone backtesting with LLM agents. |
| `alsk1992/CloddsBot` (2.7k★) | MIT | One agent across 1 000+ markets (Polymarket, Kalshi, Binance, Hyperliquid): agent-side plumbing, not an edge. |

## 4. What I recommend we do with it

1. **PnL decomposition** (paper 2) in the dashboard and the daily report: spread
   income, adverse-selection loss, inventory cost. Our A/B measures *direction*;
   a maker is paid for providing liquidity, so that is the number that decides.
2. **A toxicity reflex**: one-sided flow / VPIN-lite as a gate, per the Kalshi
   evidence, instead of relying only on spread and depth.
3. **A real fill model** (queue position / probabilistic) before any tiny-live —
   our current simulation is optimistically brutal in the wrong direction.
4. **Market selection**: broad-based over single-name; logit-space A-S for
   probability markets; prediction markets as the second market after Kuru.
5. **A cheap live self-test** (poly-maker pattern): a deep post-only order, then a
   cents-sized round trip, before risking size.

## 5. How the recurring scan works

`~/.hermes/scripts/quant-veille.py` runs on a Hermes cron: `xread` searches for
the segment queries plus `gh api` repository searches, deduplicated against
`~/.hermes/state/quant-veille.json`, and prints **only new items** (silent when
there is nothing). Engagement and star thresholds keep the noise out; every entry
carries its stars, licence and last push date, because a repo with no licence is
read for ideas and never copied.
