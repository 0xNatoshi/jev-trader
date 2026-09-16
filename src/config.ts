const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

export const config = {
  rpcUrl: env("RPC_URL", "https://rpc.monad.xyz")!,
  wsUrl: env("WS_URL"), // optional; polling backstop always runs
  chainId: 143,
  market: env("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")!, // Kuru MON-USDC
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true" || !env("PRIVATE_KEY"),
  tradeSizeMon: Number(env("TRADE_SIZE_MON", "200")), // Kuru MON-USDC minimum order is 200 MON
  maxPositionMon: Number(env("MAX_POSITION_MON", "1000")),
  bankrollUsd: Number(env("BANKROLL_USD", "100")), // used for pnlPct
  model: env("MODEL", "mock") as "mock" | "jev",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
};
