import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: "MON-USDC";
  block: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids)
  returnsBps: { last1: number; last5: number; last20: number };
  recentMids: string; // oldest..newest, space separated
  position: { mon: number; entryPrice: number | null; unrealizedUsd: number };
  lastDecision: { action: Action; blocksAgo: number } | null;
  allowed: { buy: boolean; sell: boolean };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  action: {
    type: "choice",
    instructions: {
      question: "What should the trader do this block?",
      goal: "Trade MON-USDC on Kuru every 300ms block. Capture short-term moves; respect `allowed`.",
      timing: "A trade executes as an immediate-or-cancel market order in the next block.",
      rules: "If `allowed.buy` is false, do not choose buy. If `allowed.sell` is false, do not choose sell.",
    },
    criteria: {
      buy: "Buy MON now. Only when momentum, book imbalance, or mean reversion favor a rise within ~10 blocks and `allowed.buy` is true.",
      sell: "Sell MON now. Only when a fall within ~10 blocks looks likely, or to take profit on an open long, and `allowed.sell` is true.",
      hold: "Do nothing this block. The default when the picture is unclear or the spread would eat the edge.",
    },
  },
  up: {
    type: "boolean",
    instructions: "Will the mid price be higher than `mid` ten blocks (~3 seconds) from now?",
  },
} as const;

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel implements Model {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const a = r.answers.action;
    const p = a.probabilities ?? { buy: 0, sell: 0, hold: 0, [a.choice]: 1 };
    return {
      action: a.choice as Action,
      probabilities: { buy: p.buy ?? 0, sell: p.sell ?? 0, hold: p.hold ?? 0 },
      upIn10: r.answers.up.probability,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Deterministic stand-in: momentum + imbalance through a softmax, hold-biased. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const signal = state.returnsBps.last5 / 4 + state.bookImbalance * 2 + this.noise(state.block);
    const logits = { buy: signal, sell: -signal, hold: 2.2 };
    const z = Object.values(logits).reduce((s, v) => s + Math.exp(v), 0);
    const probabilities = {
      buy: Math.exp(logits.buy) / z,
      sell: Math.exp(logits.sell) / z,
      hold: Math.exp(logits.hold) / z,
    };
    const action = (Object.keys(probabilities) as Action[]).reduce((a, b) => (probabilities[a] >= probabilities[b] ? a : b));
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: 1 / (1 + Math.exp(-signal / 2)),
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(block: number) {
    let h = block * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
