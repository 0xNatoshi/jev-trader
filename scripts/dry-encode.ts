// Prove the hand-encoded IOC calldata matches the Kuru SDK's, without sending anything.
// Builds + signs a buy and a sell with a random wallet, decodes the calldata back, and asserts
// `data` and `value` equal what IOC.constructMarket*Transaction produces for the same inputs.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run scripts/dry-encode.ts [rpcUrl]
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";

// A throwaway key, and never a dry run: this script signs (locally) but never sends. Set before
// src/config is imported, so these imports must stay dynamic (static ones are hoisted above this).
process.env.PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
process.env.DRY_RUN = "false";
const { config } = await import("../src/config");
const { Market } = await import("../src/market");

const RPC = process.argv[2] ?? config.readRpcUrl;
const provider = new ethers.providers.StaticJsonRpcProvider(RPC, config.chainId);
const iface = new ethers.utils.Interface(OrderBookAbi.abi);

const market = new Market();
market.params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
const book = await market.readBook();
const size = config.tradeSizeMon;
console.log(`market ${config.market} · block ${book.block} · bid ${book.bid} ask ${book.ask} · size ${size} MON`);
console.log(`wallet ${market.address} (random, unfunded)\n`);

// The SDK path, with gasLimit + gasPrice supplied so buildTransactionRequest makes no RPC call.
const sdkTx = (side: "buy" | "sell") => {
  const opts = { gasLimit: ethers.BigNumber.from(200_000), gasPrice: ethers.BigNumber.from(1) };
  return side === "buy"
    ? Kuru.IOC.constructMarketBuyTransaction(market.wallet!, config.market, market.params,
        (size * book.ask * 1.003).toFixed(6),
        ethers.utils.parseUnits((size * 0.995).toFixed(6), 18).toString(), false, false, opts)
    : Kuru.IOC.constructMarketSellTransaction(market.wallet!, config.market, market.params,
        size.toFixed(4),
        ethers.utils.parseUnits((size * book.bid * 0.995).toFixed(6), 6).toString(), false, false, opts);
};

let failed = false;
for (const side of ["buy", "sell"] as const) {
  const tx = market.buildTx(side, size, book);
  const raw = await market.wallet!.signTransaction(tx);
  const parsed = ethers.utils.parseTransaction(raw);
  const args = iface.parseTransaction({ data: String(tx.data) });
  const sdk = await sdkTx(side);

  const okData = String(tx.data) === String(sdk.data);
  const okValue = ethers.BigNumber.from(tx.value!).eq(ethers.BigNumber.from(sdk.value ?? 0));
  failed ||= !okData || !okValue;

  console.log(`== ${side}`);
  console.log(`  ${args.name}(${args.args.map((a) => a.toString()).join(", ")})`);
  console.log(`  value ${ethers.utils.formatEther(tx.value!)} MON (${ethers.BigNumber.from(tx.value!).toString()} wei)`);
  console.log(`  type ${parsed.type} gasLimit ${parsed.gasLimit} maxFee ${ethers.utils.formatUnits(parsed.maxFeePerGas!, "gwei")} gwei` +
              ` priority ${ethers.utils.formatUnits(parsed.maxPriorityFeePerGas!, "gwei")} gwei nonce ${parsed.nonce} · signed ${raw.length / 2 - 1} bytes, from ${parsed.from}`);
  console.log(`  vs SDK: data ${okData ? "MATCH" : "DIFF!"} · value ${okValue ? "MATCH" : "DIFF!"}\n`);
}
console.log(failed ? "FAILED" : "all encodings match the SDK");
process.exit(failed ? 1 : 0);
