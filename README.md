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
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus a `fill` event whenever a live order's receipt lands

Every event (see `src/trader.ts` for types):

    {
      "block": 105424978, "ts": 1789593630676,
      "mid": 0.0222735, "bestBid": 0.022265, "bestAsk": 0.022282, "spreadBps": 7.63,
      "decision": { "action": "hold", "probabilities": { "buy": 0.15, "sell": 0.05, "hold": 0.80 }, "upIn10": 0.57, "latencyMs": 81, "late": false },
      "fill": null,
      "position": { "side": "short", "size": 1000, "entryPrice": 0.0222642, "unrealizedUsd": -0.0093, "unrealizedMon": -0.42 },
      "totals": { "blocks": 69, "decisions": 69, "trades": 5, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0, "gasUsd": 0, "realizedUsd": 0, "pnlUsd": -0.0093, "pnlMon": -0.42, "pnlPct": -0.009 }
    }

`fill`, when present: `{ side, size, price, txHash, gasMon, simulated, confirmed }`. `decision.action` is `buy` or `sell`; `hold` appears only with `decision.late: true`, when the model missed the block and no trade happened. When the position cap blocks a side, the trade flips to the other side and `probabilities` still show the model's intent. `upIn10` equals the buy probability.

Live orders are fired and forgotten, so the `block` event carries the **intent**: `confirmed: false`, `size` is the size asked for, `price` is the touch price, `gasMon` is `gasLimit x (last known base fee + priority)`. The position, P&L and `trades` are untouched until the receipt lands — up to a few blocks later — which arrives as its own SSE event:

    event: fill
    data: { "block": 105424978, "fill": { "side": "buy", "size": 199.4, "price": 0.022018, "txHash": "0x…", "gasMon": 0.0000255, "simulated": false, "confirmed": true } }

`block` is the block whose decision produced the order, so a client can go back and correct that row. A revert, or no receipt after 10 blocks, gives `size: 0` (gas is still charged on a revert). In a dry run there is no `fill` event: the `block` event's fill is already `simulated: true, confirmed: true` and is applied immediately.

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/market.ts   Kuru: read book, hand-encoded IOC buy/sell, local nonce, async confirmation
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE

## The 300 ms budget

A decision and an order have to fit in one block, so the hot loop makes exactly two RPC round trips:
one `eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and one `eth_sendRawTransaction`
(`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path — no
`eth_estimateGas` (Monad charges gas on the limit, so the limit is hardcoded or derived once at
startup), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price lookup
(static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK
