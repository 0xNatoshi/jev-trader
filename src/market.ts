import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { config } from "./config";
import { rpc } from "./chain";
import { readBook as fetchBook, readVaultParams, vaultActive, log10 } from "./book";

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative MON depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
}

export interface Fill {
  side: "buy" | "sell";
  size: number; // MON: intended before confirmation, actually filled after
  price: number; // USDC per MON: touch price before confirmation, average fill after
  txHash: string | null;
  gasMon: number; // gasLimit x gas price — Monad charges the limit, not gasUsed
  simulated: boolean;
  /** false on the block event of a live send; true once the receipt is in (or in dry run). */
  confirmed: boolean;
}

/** A resolved fill, tagged with the block whose decision produced it. */
export interface ConfirmedFill { block: number; fill: Fill }

const ERC20_ABI = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const gwei = (n: number) => ethers.utils.parseUnits(String(n), "gwei");
const BN = ethers.BigNumber;
const ZERO_ADDRESS = ethers.constants.AddressZero;

interface Pending { block: number; side: "buy" | "sell"; gasLimit: ethers.BigNumber }

/** Kuru MON-USDC market: read the book, fire IOC market orders, confirm them asynchronously. */
export class Market {
  readonly provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, config.chainId);
  /** null in a dry run (no key, or DRY_RUN=true): nothing is signed, nothing is sent. */
  readonly wallet = config.dryRun ? null : new ethers.Wallet(config.privateKey!, this.provider);
  params!: Kuru.MarketParams; // public so scripts can build txs without init()
  private iface = new ethers.utils.Interface(OrderBookAbi.abi);
  private nonce = 0;
  private feeWei = gwei(102); // base + priority, last known; Monad's floor is 100 + 2
  private gasLimit = { buy: BN.from(config.gasLimitFallback), sell: BN.from(config.gasLimitFallback) };
  private useVault = false;
  private pending = new Map<string, Pending>();

  get address() { return this.wallet?.address ?? null; }

  async init() {
    this.params = await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    await this.refresh();
    if (!this.wallet) return;
    await this.resyncNonce();
    const usdc = new ethers.Contract(this.params.quoteAssetAddress, ERC20_ABI, this.wallet);
    const allowance: ethers.BigNumber = await usdc.allowance(this.wallet.address, config.market);
    if (allowance.lt(ethers.utils.parseUnits("1000000", 6))) {
      const tx = await usdc.approve(config.market, ethers.constants.MaxUint256, { nonce: this.nonce++ });
      await tx.wait(1);
    }
    await this.initGasLimits();
  }

  /** Every `config.refreshBlocks`: the fee estimate and whether the Kuru AMM vault went live. */
  async refresh() {
    const [fee, vault] = await Promise.allSettled([
      rpc<string>("eth_gasPrice"),
      readVaultParams(config.readRpcUrl, config.market),
    ]);
    if (fee.status === "fulfilled") this.feeWei = BN.from(fee.value);
    if (vault.status === "fulfilled") this.useVault = vaultActive(vault.value);
  }

  /** One eth_call (two batched into one HTTP request once the vault is live). */
  readBook(): Promise<Book> {
    return fetchBook(config.readRpcUrl, config.market, this.params, { vault: this.useVault });
  }

  /**
   * Sign and fire an IOC market order. Returns as soon as the RPC has the hash: the fill values here
   * are the intent (size asked for, touch price, expected gas). `pollPending` resolves the real ones.
   */
  async send(block: number, side: "buy" | "sell", sizeMon: number, book: Book): Promise<Fill> {
    const price = side === "buy" ? book.ask : book.bid;
    if (!this.wallet) return { side, size: sizeMon, price, txHash: null, gasMon: 0, simulated: true, confirmed: true };

    const tx = this.buildTx(side, sizeMon, book);
    const signed = await this.wallet.signTransaction(tx);

    let hash: string;
    try {
      hash = await rpc<string>("eth_sendRawTransaction", [signed]);
      this.nonce++;
    } catch (e) {
      await this.resyncNonce().catch(() => {});
      throw e;
    }
    this.pending.set(hash, { block, side, gasLimit: this.gasLimit[side] });
    return { side, size: sizeMon, price, txHash: hash, gasMon: this.gasMon(this.gasLimit[side], this.feeWei), simulated: false, confirmed: false };
  }

  /** One eth_getTransactionReceipt per in-flight tx. Returns whatever resolved (or timed out). */
  async pollPending(block: number): Promise<ConfirmedFill[]> {
    if (!this.pending.size) return [];
    const out: ConfirmedFill[] = [];
    let lost = false;
    await Promise.all([...this.pending].map(async ([hash, p]) => {
      const receipt = await rpc<any>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (!this.pending.has(hash)) return; // an overlapping poll already resolved it
      if (receipt) {
        this.pending.delete(hash);
        out.push({ block: p.block, fill: this.parseReceipt(receipt, p) });
      } else if (block - p.block >= config.pendingBlocks) {
        this.pending.delete(hash);
        lost = true;
        out.push({ block: p.block, fill: { side: p.side, size: 0, price: 0, txHash: hash, gasMon: 0, simulated: false, confirmed: true } });
      }
    }));
    if (lost) await this.resyncNonce().catch(() => {});
    return out;
  }

  /** The exact transaction the hot loop signs: no pre-send RPC, hardcoded gas limit, static type-2 fees. */
  buildTx(side: "buy" | "sell", sizeMon: number, book: Book): ethers.providers.TransactionRequest {
    return {
      type: 2, chainId: config.chainId, to: config.market, nonce: this.nonce, gasLimit: this.gasLimit[side],
      maxFeePerGas: gwei(config.maxFeeGwei), maxPriorityFeePerGas: gwei(config.priorityFeeGwei),
      ...this.encode(side, sizeMon, book),
    };
  }

  /** Calldata and value for an IOC market order — same bytes the SDK's IOC helpers build, minus the RPC. */
  private encode(side: "buy" | "sell", sizeMon: number, book: Book) {
    const p = this.params;
    if (side === "buy") {
      const quote = (sizeMon * book.ask * 1.003).toFixed(6); // USDC to spend, 0.3% buffer
      const minOut = ethers.utils.parseUnits((sizeMon * 0.995).toFixed(6), p.baseAssetDecimals.toNumber()); // min MON out
      return {
        data: this.iface.encodeFunctionData("placeAndExecuteMarketBuy", [ethers.utils.parseUnits(quote, log10(p.pricePrecision)), minOut, false, false]),
        value: p.quoteAssetAddress === ZERO_ADDRESS ? ethers.utils.parseUnits(quote, p.quoteAssetDecimals.toNumber()) : BN.from(0),
      };
    }
    const size = sizeMon.toFixed(4); // MON to sell
    const minOut = ethers.utils.parseUnits((sizeMon * book.bid * 0.995).toFixed(6), p.quoteAssetDecimals.toNumber()); // min USDC out
    return {
      data: this.iface.encodeFunctionData("placeAndExecuteMarketSell", [ethers.utils.parseUnits(size, log10(p.sizePrecision)), minOut, false, false]),
      value: p.baseAssetAddress === ZERO_ADDRESS ? ethers.utils.parseUnits(size, p.baseAssetDecimals.toNumber()) : BN.from(0), // MON is native
    };
  }

  /** Sum our Trade events. price / pricePrecision, filledSize / sizePrecision. */
  private parseReceipt(r: any, p: Pending): Fill {
    if (r.effectiveGasPrice) this.feeWei = BN.from(r.effectiveGasPrice);
    const gasMon = this.gasMon(p.gasLimit, BN.from(r.effectiveGasPrice ?? this.feeWei));
    let base = 0, quote = 0;
    if (r.status !== "0x0") {
      const pp = this.params.pricePrecision.toNumber(), sp = this.params.sizePrecision.toNumber();
      for (const log of r.logs ?? []) {
        let ev; try { ev = this.iface.parseLog(log); } catch { continue; }
        if (ev.name !== "Trade" || ev.args.taker.toLowerCase() !== this.wallet!.address.toLowerCase()) continue;
        const size = Number(ev.args.filledSize) / sp, price = Number(ev.args.price) / pp;
        base += size; quote += size * price;
      }
    }
    return { side: p.side, size: base, price: base ? quote / base : 0, txHash: r.transactionHash, gasMon, simulated: false, confirmed: true };
  }

  /** One eth_estimateGas per side at startup, x1.25. Never in the hot loop. */
  private async initGasLimits() {
    const book = await this.readBook().catch(() => null);
    for (const side of ["buy", "sell"] as const) {
      const override = side === "buy" ? config.gasLimitBuy : config.gasLimitSell;
      if (override) { this.gasLimit[side] = BN.from(override); continue; }
      try {
        if (!book) throw new Error("no book");
        const { data, value } = this.encode(side, config.tradeSizeMon, book);
        const est = await this.provider.estimateGas({ to: config.market, from: this.wallet!.address, data, value });
        this.gasLimit[side] = est.mul(125).div(100);
      } catch (e) {
        console.warn(`gas estimate ${side} failed (${(e as Error).message.slice(0, 120)}); using ${config.gasLimitFallback}`);
      }
    }
    console.log(`gas limits · buy ${this.gasLimit.buy} · sell ${this.gasLimit.sell} · maxFee ${config.maxFeeGwei} gwei · priority ${config.priorityFeeGwei} gwei`);
  }

  private gasMon(limit: ethers.BigNumber, feeWei: ethers.BigNumber) {
    return Number(ethers.utils.formatEther(limit.mul(feeWei)));
  }

  private async resyncNonce() {
    this.nonce = parseInt(await rpc<string>("eth_getTransactionCount", [this.wallet!.address, "latest"]), 16);
  }
}
