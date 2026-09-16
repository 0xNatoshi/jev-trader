# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. Every block trades. Fills are real IOC market orders. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

## Endpoints

Deployed (dry run, mock model): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block

Every event (see `src/trader.ts` for types):

    {
      "block": 105424978, "ts": 1789593630676,
      "mid": 0.0222735, "bestBid": 0.022265, "bestAsk": 0.022282, "spreadBps": 7.63,
      "decision": { "action": "hold", "probabilities": { "buy": 0.15, "sell": 0.05, "hold": 0.80 }, "upIn10": 0.57, "latencyMs": 81, "late": false },
      "fill": null,
      "position": { "side": "short", "size": 1000, "entryPrice": 0.0222642, "unrealizedUsd": -0.0093, "unrealizedMon": -0.42 },
      "totals": { "blocks": 69, "decisions": 69, "trades": 5, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0, "gasUsd": 0, "realizedUsd": 0, "pnlUsd": -0.0093, "pnlMon": -0.42, "pnlPct": -0.009 }
    }

`fill`, when present: `{ side, size, price, txHash, gasMon, simulated }`. `decision.action` is `buy` or `sell`; `hold` appears only with `decision.late: true`, when the model missed the block and no trade happened. When the position cap blocks a side, the trade flips to the other side and `probabilities` still show the model's intent. `upIn10` equals the buy probability.

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop), raw RPC
    src/market.ts   Kuru: read book, IOC buy/sell via eth_sendRawTransactionSync, local nonce
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE
