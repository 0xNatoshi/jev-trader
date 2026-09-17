# JEV-ROLE - where the decision model plugs into the trading stack

Jev = the judgment layer: it reads a structured state and answers narrow
questions (choice + confidence + probabilities). The code computes and executes;
Jev judges. Keep that boundary clean.

## 1. Live decision (the main performance lever)
Per block (or per event): decomposed questions, combined in code.
- direction + conviction (buy/sell/hold with probabilities),
- "is this flow toxic?" (yes/no gate -> quote or pull),
- regime (trend vs range -> which style),
- "stay quoted?" (gate),
- size bucket.
The state must carry the context: session, macro/event proximity, incident
flags, position (side, TP/SL, time in position), book + flow features.

## 2. Lab loop (iteration speed)
- Error attribution: give Jev windows of trades/states ("what do these losing
  fills have in common: hour? regime? flow?") -> classify, fix real causes.
- State labeling: turn raw state descriptions into labeled regimes/patterns
  to enrich features.

## 3. Ops (loss tails)
- Incident/anomaly detection on live windows -> safety mode (reduced size,
  quotes pulled).
- Drift detection: "does the market still look like what we validated?" ->
  back to dry-run instead of white-knuckling.

## 4. Portability
Same judgment core across markets; only execution adapters change. The
marginal cost of market #2 is a fraction of market #1.

## Non-goals (code, not Jev)
- arithmetic (prices, sizes, PnL), execution mechanics (cancel/replace,
  TP/SL), statistics/parameter search (backtest tooling).

## The proof rule
Every Jev contribution must survive an A/B in the backtest (same rules, with
vs without the Jev layer) measured in net PnL / drawdown over the full history.
If the delta is not positive, rewire it - or drop it.
