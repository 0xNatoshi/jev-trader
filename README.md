# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and chooses buy, sell, or hold every ~300 ms. Fills are real IOC market orders. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

## Endpoints

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block

Every event: `{ block, ts, mid, bestBid, bestAsk, spreadBps, decision, fill, position, totals }`. See `src/trader.ts` for the exact shape.

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop), raw RPC
    src/market.ts   Kuru: read book, IOC buy/sell via eth_sendRawTransactionSync, local nonce
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE
