export type Action = "buy" | "sell" | "hold";
export interface Fill { side: "buy" | "sell"; size: number; price: number; txHash: string | null; gasMon: number; simulated: boolean; confirmed: boolean }
export interface Decision { action: Action; probabilities: { buy: number; sell: number; hold: number }; upIn10: number; latencyMs: number; late: boolean }
export interface Position { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number }
export interface Totals { blocks: number; decisions: number; trades: number; lateBlocks: number; jevUsd: number; gasMon: number; gasUsd: number; realizedUsd: number; pnlUsd: number; pnlMon: number; pnlPct: number }
export interface BlockEvent { block: number; ts: number; mid: number; bestBid: number; bestAsk: number; spreadBps: number; decision: Decision | null; fill: Fill | null; position: Position; totals: Totals }
export interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number }
export type ConnectionState = "connecting" | "live" | "reconnecting";
export interface FeedState { meta: Meta | null; events: BlockEvent[]; latest: BlockEvent | null; connection: ConnectionState; avgLatencyMs: number }
