import { existsSync } from "node:fs";
import { config } from "./config";

/**
 * Reflexes: deterministic checks that run BEFORE the decision model and again
 * BEFORE anything is signed. Pure code, no model, no clock of its own.
 *
 * They are the cheap guard rail the labs asked for: a rug, a stale quote, a gas
 * spike or an exhausted risk budget must stop a turn without paying for an
 * inference and without touching a wallet. The first reflex that fires ends the
 * impulse with a `reject` transition, and its name is logged, so a locked-out
 * strategy is visible instead of silent.
 */

export interface ReflexFacts {
  killSwitchActive: boolean;
  /** Realised + unrealised, in USD, for the current session. */
  sessionPnlUsd: number;
  /** Effective gas price for the next send (base + priority), in gwei. */
  gasGwei: number;
  /** Resting MON within 25 bps of mid, both sides. */
  liquidityMon: number;
  spreadBps: number;
  score: number;
  /** True when our size already rests on the side we are about to quote. */
  alreadyQuotingSide: boolean;
  /** Exposure after the order would land, absolute MON. */
  exposureMon: number;
  /** Live only: margin can fund the order. */
  fundsOk: boolean;
  /** Sends the chain has not explained yet. Above zero, new entries stay locked. */
  unresolvedSends: number;
  /** True while a repricing jump or a liquidity sweep is in progress. */
  regimeAcute: boolean;
  /** Toxicity: absolute one-sidedness of the flow over the window, null when too thin. */
  toxicity: number | null;
  /** Signed flow in [-1, 1]: positive = taker buying dominates. */
  flowSigned: number | null;
  /** The side this pass is about to quote, null in the pre-model pass. */
  intendedSide: "buy" | "sell" | null;
}

export interface Reflex {
  name: string;
  note: string;
  check: (f: ReflexFacts) => boolean;
}

export function defaultReflexes(cfg = config): Reflex[] {
  return [
    { name: "kill_switch", note: "kill switch file present", check: (f) => f.killSwitchActive },
    { name: "recovery_pending", note: "a previous send is still unreconciled", check: (f) => f.unresolvedSends > 0 },
    { name: "daily_loss", note: `session pnl below -${cfg.sessionLossLimitUsd} USD`, check: (f) => f.sessionPnlUsd <= -cfg.sessionLossLimitUsd },
    { name: "gas_cap", note: `gas above ${cfg.maxFeeGwei} gwei`, check: (f) => f.gasGwei > cfg.maxFeeGwei },
    { name: "min_liquidity", note: `book thinner than ${cfg.minLiquidityMon} MON at 25 bps`, check: (f) => f.liquidityMon < cfg.minLiquidityMon },
    { name: "max_spread", note: `spread above ${cfg.maxSpreadBps} bps`, check: (f) => f.spreadBps > cfg.maxSpreadBps },
    { name: "low_score", note: `book score below ${cfg.minScore}`, check: (f) => f.score < cfg.minScore },
    // A repricing jump or a sweep means the book we quoted is gone.
    { name: "regime_pause", note: "jump or sweep in progress", check: (f) => f.regimeAcute },
    // Circuit breaker: the tape is screaming one way (Kalshi: one-sided flow is what
    // predicts maker losses). Everything pauses.
    { name: "stressed_flow", note: `flow one-sided beyond ${cfg.maxToxicityExtreme}`, check: (f) => f.toxicity !== null && f.toxicity >= cfg.maxToxicityExtreme },
    // Side aware: quote the side the flow is NOT running over. Buy-heavy flow fills
    // our ask and then keeps going, so stand down there and keep bidding.
    { name: "toxic_side", note: "flow is running over that side", check: (f) => f.flowSigned !== null && f.intendedSide !== null && ((f.intendedSide === "sell" && f.flowSigned >= cfg.maxToxicity) || (f.intendedSide === "buy" && f.flowSigned <= -cfg.maxToxicity)) },
    { name: "duplicate_side", note: "our size already rests on that side", check: (f) => f.alreadyQuotingSide },
    { name: "max_exposure", note: `exposure beyond ${cfg.maxPositionMon} MON`, check: (f) => Math.abs(f.exposureMon) > cfg.maxPositionMon },
    { name: "funds", note: "margin cannot fund the order", check: (f) => !f.fundsOk },
  ];
}

/** Market-wide checks: safe to run before the model, no intended side needed. */
const PRE_MODEL = new Set(["kill_switch", "recovery_pending", "daily_loss", "gas_cap", "min_liquidity", "max_spread", "low_score", "regime_pause", "stressed_flow"]);

/**
 * Which reflexes apply in each phase. The pre-model pass never guesses a side, so
 * the side-dependent checks (duplicate, exposure, funds) only run before signing.
 */
export function reflexesFor(phase: "pre" | "post", reflexes: Reflex[] = defaultReflexes()): Reflex[] {
  return reflexes.filter((r) => (phase === "pre" ? PRE_MODEL.has(r.name) : !PRE_MODEL.has(r.name)));
}

/** The first reflex that fires, or null. Order matters: cheapest and hardest limits first. */
export function checkReflexes(f: ReflexFacts, phase: "pre" | "post" = "pre", reflexes: Reflex[] = defaultReflexes()): Reflex | null {
  for (const r of reflexesFor(phase, reflexes)) if (r.check(f)) return r;
  return null;
}

/**
 * Kill switch: a file on disk, checked per block. Delete it to resume. It is
 * read from the filesystem on every call so an operator does not have to restart
 * the process (or have a shell) to stop trading.
 */
export function killSwitchActive(): boolean {
  return existsSync(config.killSwitchFile);
}
