import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { config } from "./config";
import { rpc } from "./chain";

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
}

export interface Fill {
  side: "buy" | "sell";
  size: number; // MON filled
  price: number; // average USDC per MON
  txHash: string | null;
  gasMon: number;
  simulated: boolean;
}

const ERC20_ABI = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

/** Kuru MON-USDC market: read the book, execute IOC market orders. */
export class Market {
  readonly provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, config.chainId);
  readonly wallet = config.privateKey ? new ethers.Wallet(config.privateKey, this.provider) : null;
  private params!: Kuru.MarketParams;
  private iface = new ethers.utils.Interface(OrderBookAbi.abi);
  private nonce = 0;
  private gasPrice = ethers.BigNumber.from(0);

  get address() { return this.wallet?.address ?? null; }

  async init() {
    this.params = await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    await this.refreshGasPrice();
    if (!this.wallet) return;
    this.nonce = await this.provider.getTransactionCount(this.wallet.address);
    const usdc = new ethers.Contract(this.params.quoteAssetAddress, ERC20_ABI, this.wallet);
    const allowance: ethers.BigNumber = await usdc.allowance(this.wallet.address, config.market);
    if (allowance.lt(ethers.utils.parseUnits("1000000", 6))) {
      const tx = await usdc.approve(config.market, ethers.constants.MaxUint256, { nonce: this.nonce++ });
      await tx.wait(1);
    }
  }

  async refreshGasPrice() { this.gasPrice = await this.provider.getGasPrice(); }

  async readBook(): Promise<Book> {
    const b = await Kuru.OrderBook.getFormattedL2OrderBook(this.provider, config.market, this.params);
    // SDK sorts both sides descending by price: best ask is last, best bid is first.
    const ask = b.asks.at(-1)![0]!;
    const bid = b.bids[0]![0]!;
    const mid = (bid + ask) / 2;
    const near = (levels: number[][]) => levels.filter((l) => Math.abs(l[0]! - mid) / mid < 0.01).reduce((s, l) => s + l[1]!, 0);
    const bidDepth = near(b.bids), askDepth = near(b.asks);
    return {
      block: b.blockNumber, bid, ask, mid,
      spreadBps: ((ask - bid) / mid) * 10_000,
      imbalance: bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0,
    };
  }

  /** IOC market order for `sizeMon`. Partial fills allowed; 0.5% slippage guard. */
  async execute(side: "buy" | "sell", sizeMon: number, book: Book): Promise<Fill> {
    if (!this.wallet) return { side, size: sizeMon, price: side === "buy" ? book.ask : book.bid, txHash: null, gasMon: 0, simulated: true };

    const txOptions = { gasPrice: this.gasPrice, nonce: this.nonce };
    const tx = side === "buy"
      ? await Kuru.IOC.constructMarketBuyTransaction(
          this.wallet, config.market, this.params,
          (sizeMon * book.ask * 1.003).toFixed(6),                       // USDC to spend
          ethers.utils.parseUnits((sizeMon * 0.995).toFixed(6), 18).toString(), // min MON out
          false, false, txOptions)
      : await Kuru.IOC.constructMarketSellTransaction(
          this.wallet, config.market, this.params,
          sizeMon.toFixed(4),                                             // MON to sell
          ethers.utils.parseUnits((sizeMon * book.bid * 0.995).toFixed(6), 6).toString(), // min USDC out
          false, false, txOptions);

    const signed = await this.wallet.signTransaction({ ...tx, chainId: config.chainId });
    let receipt: any;
    try {
      receipt = await rpc<any>("eth_sendRawTransactionSync", [signed]);
      this.nonce++;
    } catch (e) {
      this.nonce = await this.provider.getTransactionCount(this.wallet.address); // resync and surface
      throw e;
    }

    // Sum our Trade events. price / pricePrecision, filledSize / sizePrecision.
    const pp = this.params.pricePrecision.toNumber(), sp = this.params.sizePrecision.toNumber();
    let base = 0, quote = 0;
    for (const log of receipt.logs ?? []) {
      let ev; try { ev = this.iface.parseLog(log); } catch { continue; }
      if (ev.name !== "Trade" || ev.args.taker.toLowerCase() !== this.wallet.address.toLowerCase()) continue;
      const size = Number(ev.args.filledSize) / sp, price = Number(ev.args.price) / pp;
      base += size; quote += size * price;
    }
    // Monad charges gas on the limit, not gas used.
    const gasMon = Number(ethers.utils.formatEther(ethers.BigNumber.from(tx.gasLimit).mul(this.gasPrice)));
    return { side, size: base, price: base ? quote / base : 0, txHash: receipt.transactionHash, gasMon, simulated: false };
  }
}
