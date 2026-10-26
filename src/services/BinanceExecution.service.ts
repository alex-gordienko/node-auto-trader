import crypto from "crypto";
import fs from "fs";
import path from "path";

import axios from "axios";

import cryptoConfig from "../config/crypto.config";
import { Colors, createLogger } from "../utils/colored-console";
import { floorToStep, refuseBaseUrl, roundToTick, slippageBps } from "../utils/binance-execution";

const log = createLogger("execution");

export interface IOrderRequest {
  strategy: string; // whose paper fill this mirrors: vote, horizon-<track>
  symbol: string; // BTCUSDT, ETHUSDT
  side: "BUY" | "SELL";
  usd: number; // notional the paper book traded
  all?: boolean; // a sell that closes the strategy's position: sell everything it bought
  refPrice: number; // market price the paper book used, before its assumed slippage
  paperCostBps: number; // fee + slippage the paper book assumed per side
}

export interface ILedgerEntry extends IOrderRequest {
  at: number;
  status: "filled" | "partial" | "skipped" | "refused" | "failed";
  note?: string;
  orders: { id: number; type: string }[];
  qty: number; // base asset executed
  quote: number; // USDT moved
  avgPrice: number;
  feeUsd: number; // commissions converted to USDT
  slippageBps: number; // average fill vs refPrice (positive = worse)
  feeBps: number;
}

type Http = (req: { method: "GET" | "POST" | "DELETE"; url: string; headers?: Record<string, string> }) => Promise<unknown>;

interface IFilters {
  step: string;
  tick: string;
  minNotional: number;
}

const axiosHttp: Http = async (req) => (await axios(req)).data;

/**
 * Mirrors the paper books' fills as real orders on Binance Demo Trading / Spot Testnet (fake money) when
 * EXECUTION_MODE=testnet. The paper books stay the reference: their stop-crane decides every entry before a fill
 * reaches this adapter, and an exit is never blocked. Orders go out one at a time (a queue), as LIMIT_MAKER at the
 * best bid / ask with a timeout and a market order for the rest, or as market orders (EXECUTION_ORDER_TYPE=market).
 * Each strategy only ever sells what it bought here (execution-holdings.json), so strategies sharing the account
 * cannot sell each other's coins. Every request lands in src/Storage/trading/execution-ledger.jsonl, filled or not —
 * `yarn execution:report` compares fills with the paper prices. Any non-testnet URL is refused (utils/binance-execution).
 */
export class BinanceExecution {
  private queue: Promise<void> = Promise.resolve();
  private pendingBy = new Map<string, number>();
  private filters = new Map<string, IFilters>();

  constructor(
    private readonly opts: {
      baseUrl: string;
      key?: string;
      secret?: string;
      dir: string; // trading state folder
      orderType: "limit-maker" | "market";
      makerTimeoutMs: number;
      pollMs: number;
      http?: Http;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {}

  private get http() {
    return this.opts.http ?? axiosHttp;
  }
  private sleep(ms: number) {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }
  private get ledgerFile() {
    return path.join(this.opts.dir, "execution-ledger.jsonl");
  }
  private get holdingsFile() {
    return path.join(this.opts.dir, "execution-holdings.json");
  }

  /** null when this adapter may send orders, otherwise why not. */
  public refusal(): string | null {
    const confirmFile = path.join(this.opts.dir, "LIVE_TRADING_CONFIRMED");
    const confirmation = fs.existsSync(confirmFile) ? fs.readFileSync(confirmFile, "utf-8") : null;
    const url = refuseBaseUrl(this.opts.baseUrl, process.env.LIVE_TRADING, confirmation);
    if (url) return url;
    if (!this.opts.key || !this.opts.secret) return "BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET are not set";
    return null;
  }

  private async signed<T>(method: "GET" | "POST" | "DELETE", endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const refused = this.refusal();
    if (refused) throw new Error(refused);
    const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
    const signature = crypto.createHmac("sha256", this.opts.secret as string).update(query).digest("hex");
    try {
      return (await this.http({ method, url: `${this.opts.baseUrl}${endpoint}?${query}&signature=${signature}`, headers: { "X-MBX-APIKEY": this.opts.key as string } })) as T;
    } catch (error) {
      const body = axios.isAxiosError(error) ? JSON.stringify(error.response?.data) : String(error);
      throw new Error(`${method} ${endpoint} failed: ${body}`);
    }
  }

  private async publicGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    return (await this.http({ method: "GET", url: `${this.opts.baseUrl}${endpoint}?${new URLSearchParams(params)}` })) as T;
  }

  private async symbolFilters(symbol: string): Promise<IFilters> {
    const cached = this.filters.get(symbol);
    if (cached) return cached;
    const info = await this.publicGet<{ symbols: { filters: { filterType: string; stepSize?: string; tickSize?: string; minNotional?: string }[] }[] }>(
      "/api/v3/exchangeInfo",
      { symbol }
    );
    const f = info.symbols[0].filters;
    const filters = {
      step: f.find((x) => x.filterType === "LOT_SIZE")?.stepSize ?? "0.00001",
      tick: f.find((x) => x.filterType === "PRICE_FILTER")?.tickSize ?? "0.01",
      minNotional: Number(f.find((x) => x.filterType === "NOTIONAL" || x.filterType === "MIN_NOTIONAL")?.minNotional ?? 5),
    };
    this.filters.set(symbol, filters);
    return filters;
  }

  private holdings(): Record<string, Record<string, number>> {
    return fs.existsSync(this.holdingsFile) ? JSON.parse(fs.readFileSync(this.holdingsFile, "utf-8")) : {};
  }

  private writeHoldings(h: Record<string, Record<string, number>>) {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    fs.writeFileSync(`${this.holdingsFile}.tmp`, JSON.stringify(h, null, 2));
    fs.renameSync(`${this.holdingsFile}.tmp`, this.holdingsFile);
  }

  private record(entry: ILedgerEntry) {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    fs.appendFileSync(this.ledgerFile, `${JSON.stringify(entry)}\n`);
  }

  /**
   * Commissions of an order's trades: in USDT (base-asset fees at the fill price, BNB at the BNB price) and the part
   * taken in the base asset, which never reaches the account.
   */
  private async fees(symbol: string, orderId: number, avgPrice: number): Promise<{ usd: number; base: number }> {
    const trades = await this.signed<{ commission: string; commissionAsset: string }[]>("GET", "/api/v3/myTrades", { symbol, orderId: String(orderId) });
    const fee = { usd: 0, base: 0 };
    for (const t of trades) {
      const c = Number(t.commission);
      if (t.commissionAsset === "USDT") fee.usd += c;
      else if (symbol.startsWith(t.commissionAsset)) {
        fee.usd += c * avgPrice;
        fee.base += c;
      } else fee.usd += c * Number((await this.publicGet<{ price: string }>("/api/v3/ticker/price", { symbol: `${t.commissionAsset}USDT` })).price);
    }
    return fee;
  }

  private async market(symbol: string, side: "BUY" | "SELL", qty: string) {
    return this.signed<{ orderId: number; executedQty: string; cummulativeQuoteQty: string }>("POST", "/api/v3/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qty,
      newOrderRespType: "FULL",
    });
  }

  /** LIMIT_MAKER at the best bid (buy) / ask (sell); after the timeout the rest goes as a market order. */
  private async makerThenMarket(symbol: string, side: "BUY" | "SELL", qty: string, f: IFilters) {
    const orders: { id: number; type: string; qty: number; quote: number }[] = [];
    const book = await this.publicGet<{ bidPrice: string; askPrice: string }>("/api/v3/ticker/bookTicker", { symbol });
    const price = roundToTick(Number(side === "BUY" ? book.bidPrice : book.askPrice), f.tick, side);
    let rest = Number(qty);
    try {
      const placed = await this.signed<{ orderId: number }>("POST", "/api/v3/order", { symbol, side, type: "LIMIT_MAKER", quantity: qty, price });
      type IStatus = { status: string; executedQty: string; cummulativeQuoteQty: string };
      const id = { symbol, orderId: String(placed.orderId) };
      let status: IStatus = { status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" };
      for (let poll = 0; poll < Math.ceil(this.opts.makerTimeoutMs / this.opts.pollMs) && status.status !== "FILLED"; poll++) {
        await this.sleep(this.opts.pollMs);
        status = await this.signed<IStatus>("GET", "/api/v3/order", id);
      }
      if (status.status !== "FILLED") {
        // cancel first, then read what filled: a fill between the last poll and the cancel is still counted
        status = await this.signed<IStatus>("DELETE", "/api/v3/order", id).catch(() => this.signed<IStatus>("GET", "/api/v3/order", id));
      }
      orders.push({ id: placed.orderId, type: "LIMIT_MAKER", qty: Number(status.executedQty), quote: Number(status.cummulativeQuoteQty) });
      rest -= Number(status.executedQty);
    } catch (error) {
      // a maker order that would cross the book is rejected: the whole amount goes to the market
      log(`${symbol} ${side}: LIMIT_MAKER not placed (${error}), market order instead`, Colors.YELLOW);
    }
    const restQty = floorToStep(rest, f.step);
    if (Number(restQty) * Number(price) >= f.minNotional) {
      const m = await this.market(symbol, side, restQty);
      orders.push({ id: m.orderId, type: "MARKET", qty: Number(m.executedQty), quote: Number(m.cummulativeQuoteQty) });
    }
    return orders;
  }

  private async execute(req: IOrderRequest): Promise<void> {
    const base = { ...req, at: Date.now(), orders: [], qty: 0, quote: 0, avgPrice: 0, feeUsd: 0, slippageBps: 0, feeBps: 0 };
    // the guard comes before any request, public ones included: a refused host is never contacted
    const refused = this.refusal();
    if (refused) return this.record({ ...base, status: "refused", note: refused });
    // defense in depth: the bot-wide stop also blocks a buy here, whatever the paper book did
    if (req.side === "BUY" && fs.existsSync(path.join(this.opts.dir, "STOP"))) return this.record({ ...base, status: "refused", note: "STOP file present" });
    const f = await this.symbolFilters(req.symbol);
    const held = this.holdings()[req.strategy]?.[req.symbol] ?? 0;
    const wanted = req.side === "BUY" ? req.usd / req.refPrice : req.all ? held : Math.min(held, req.usd / req.refPrice);
    const qty = floorToStep(wanted, f.step);
    if (Number(qty) * req.refPrice < f.minNotional) {
      return this.record({ ...base, status: "skipped", note: `${qty} ${req.symbol} is below the minimum order (${f.minNotional} USDT)${req.side === "SELL" ? `; held ${held}` : ""}` });
    }
    const orders = this.opts.orderType === "market" ? await this.market(req.symbol, req.side, qty).then((m) => [{ id: m.orderId, type: "MARKET", qty: Number(m.executedQty), quote: Number(m.cummulativeQuoteQty) }]) : await this.makerThenMarket(req.symbol, req.side, qty, f);
    const exQty = orders.reduce((s, o) => s + o.qty, 0);
    const quote = orders.reduce((s, o) => s + o.quote, 0);
    const avgPrice = exQty > 0 ? quote / exQty : 0;
    let feeUsd = 0;
    let baseFee = 0;
    for (const o of orders.filter((x) => x.qty > 0)) {
      const fee = await this.fees(req.symbol, o.id, avgPrice);
      feeUsd += fee.usd;
      baseFee += fee.base;
    }
    // holdings: a buy adds what arrived (a base-asset fee is taken from it), a sell removes what left
    const h = this.holdings();
    h[req.strategy] = h[req.strategy] ?? {};
    h[req.strategy][req.symbol] = Math.max(0, held + (req.side === "BUY" ? exQty - baseFee : -exQty));
    this.writeHoldings(h);
    const entry: ILedgerEntry = {
      ...base,
      status: exQty >= Number(qty) * 0.999 ? "filled" : "partial",
      orders: orders.map(({ id, type }) => ({ id, type })),
      qty: exQty,
      quote,
      avgPrice,
      feeUsd,
      slippageBps: avgPrice ? slippageBps(req.side, avgPrice, req.refPrice) : 0,
      feeBps: quote ? (feeUsd / quote) * 1e4 : 0,
    };
    this.record(entry);
    log(
      `${req.strategy}: testnet ${req.side} ${exQty} ${req.symbol} at ${avgPrice.toFixed(2)} (${orders.map((o) => o.type).join("+")}), ` +
        `slippage ${entry.slippageBps.toFixed(1)} bps, fee ${entry.feeBps.toFixed(1)} bps vs paper ${req.paperCostBps.toFixed(1)} bps`,
      Colors.GREEN
    );
  }

  /** Queues the mirror order of a paper fill; never throws — a failed order is logged and recorded. */
  public submit(req: IOrderRequest): Promise<void> {
    this.pendingBy.set(req.strategy, this.pending(req.strategy) + 1);
    this.queue = this.queue.then(() =>
      this.execute(req)
        .catch((error) => {
          log(`${req.strategy}: testnet ${req.side} ${req.symbol} failed: ${error}`, Colors.RED);
          this.record({ ...req, at: Date.now(), status: "failed", note: String(error), orders: [], qty: 0, quote: 0, avgPrice: 0, feeUsd: 0, slippageBps: 0, feeBps: 0 });
        })
        .finally(() => this.pendingBy.set(req.strategy, this.pending(req.strategy) - 1))
    );
    return this.queue;
  }

  /** Orders of the strategy still waiting in the queue or being placed. */
  public pending(strategy: string): number {
    return this.pendingBy.get(strategy) ?? 0;
  }

  /** Base asset the strategy bought here and still holds. */
  public held(strategy: string, symbol: string): number {
    return this.holdings()[strategy]?.[symbol] ?? 0;
  }

  /** Free balances of the account, for the start-up log. */
  public async balances(assets: string[]): Promise<Record<string, number>> {
    const account = await this.signed<{ balances: { asset: string; free: string }[] }>("GET", "/api/v3/account");
    return Object.fromEntries(assets.map((a) => [a, Number(account.balances.find((b) => b.asset === a)?.free ?? 0)]));
  }

  public ledger(): ILedgerEntry[] {
    return fs.existsSync(this.ledgerFile) ? fs.readFileSync(this.ledgerFile, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
}

const { execution } = cryptoConfig;

/** The bot's adapter: active only with EXECUTION_MODE=testnet. */
class BinanceExecutionService extends BinanceExecution {
  public readonly enabled = execution.mode === "testnet";

  public mirror(req: IOrderRequest): void {
    if (this.enabled) void this.submit(req);
  }
}

export default new BinanceExecutionService({
  baseUrl: execution.baseUrl,
  key: process.env.BINANCE_TESTNET_API_KEY,
  secret: process.env.BINANCE_TESTNET_API_SECRET,
  dir: path.join(cryptoConfig.paths.storageDir, "trading"),
  orderType: execution.orderType,
  makerTimeoutMs: execution.makerTimeoutSeconds * 1000,
  pollMs: execution.pollSeconds * 1000,
});
