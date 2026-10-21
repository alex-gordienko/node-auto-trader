/**
 * Per-second order-flow state of one market, built from the rows the recorders write
 * (see services/collectors). The same code runs on recorded files (training) and on the live stream
 * (worker thread), so the model sees identical features in both.
 */

type Level = [number, number];
/** [receivedAtMs, eventTimeMs | null, bids, asks] */
export type DepthRow = [number, number | null, Level[], Level[]];
/** [tradeTimeMs, price, quantity, buyerIsMaker] */
export type TradeRow = [number, number, number, number];
/** [tradeTimeMs, symbol, side, price, avgPrice, filledQty] */
export type LiquidationRow = [number, string, string, number, number, number];

interface IBook {
  mid: number;
  imbalance1: number;
  imbalance5: number;
  imbalance20: number;
  micropriceBps: number;
  spreadBps: number;
}

interface IFlow {
  buy: number;
  sell: number;
}

interface ILiquidations {
  long: number; // USD of liquidated longs of the symbol
  short: number;
  all: number; // USD liquidated on the whole market
}

/**
 * Features of one second: futures book imbalance at 1 / 5 / 20 levels, microprice and spread, mid change
 * vs. the previous second, spot book imbalance, futures − spot, futures and spot trade flow, futures volume,
 * liquidations of the symbol (shorts − longs) and of the whole market.
 */
export const ORDERFLOW_SECOND_FEATURES = 13;

/** The order-book model predicts the futures price move over these horizons; its verdict has one value each. */
export const ORDERFLOW_HORIZONS_SECONDS = [10, 60, 300];
export const ORDERFLOW_VERDICT_COUNT = ORDERFLOW_HORIZONS_SECONDS.length;

const imbalance = (bids: Level[], asks: Level[], levels: number) => {
  const b = bids.slice(0, levels).reduce((sum, [, q]) => sum + q, 0);
  const a = asks.slice(0, levels).reduce((sum, [, q]) => sum + q, 0);
  return b + a > 0 ? (b - a) / (b + a) : 0;
};

const toBook = (bids: Level[], asks: Level[]): IBook | null => {
  if (!bids.length || !asks.length) return null;
  const [bidPrice, bidQty] = bids[0];
  const [askPrice, askQty] = asks[0];
  const mid = (bidPrice + askPrice) / 2;
  if (!(mid > 0)) return null;
  // the mid shifted toward the side with less quantity waiting
  const microprice = bidQty + askQty > 0 ? (bidPrice * askQty + askPrice * bidQty) / (bidQty + askQty) : mid;
  return {
    mid,
    imbalance1: imbalance(bids, asks, 1),
    imbalance5: imbalance(bids, asks, 5),
    imbalance20: imbalance(bids, asks, 20),
    micropriceBps: ((microprice - mid) / mid) * 1e4,
    spreadBps: ((askPrice - bidPrice) / mid) * 1e4,
  };
};

const flowImbalance = (f?: IFlow) => (f && f.buy + f.sell > 0 ? (f.buy - f.sell) / (f.buy + f.sell) : 0);
const signedLog = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v));

export class OrderFlowSeconds {
  private futuresBooks = new Map<number, IBook>();
  private spotBooks = new Map<number, IBook>();
  private futuresTrades = new Map<number, IFlow>();
  private spotTrades = new Map<number, IFlow>();
  private liquidations = new Map<number, ILiquidations>();

  /** @param binanceSymbol liquidations of this symbol (e.g. "ETHUSDT") are counted separately */
  constructor(private readonly binanceSymbol: string) {}

  public addBook(market: "spot" | "futures", [receivedAt, eventTime, bids, asks]: DepthRow): void {
    const book = toBook(bids, asks);
    if (!book) return;
    (market === "spot" ? this.spotBooks : this.futuresBooks).set(Math.floor((eventTime ?? receivedAt) / 1000), book);
  }

  public addTrade(market: "spot" | "futures", [time, , qty, buyerIsMaker]: TradeRow): void {
    const map = market === "spot" ? this.spotTrades : this.futuresTrades;
    const second = Math.floor(time / 1000);
    const flow = map.get(second) ?? { buy: 0, sell: 0 };
    // buyer is maker = an aggressive seller hit the bid
    if (buyerIsMaker) flow.sell += qty;
    else flow.buy += qty;
    map.set(second, flow);
  }

  public addLiquidation([time, symbol, side, , avgPrice, qty]: LiquidationRow): void {
    const second = Math.floor(time / 1000);
    const bucket = this.liquidations.get(second) ?? { long: 0, short: 0, all: 0 };
    const usd = avgPrice * qty;
    bucket.all += usd;
    if (symbol === this.binanceSymbol) {
      // a SELL liquidation closes a long, a BUY closes a short
      if (side === "SELL") bucket.long += usd;
      else bucket.short += usd;
    }
    this.liquidations.set(second, bucket);
  }

  /** The futures book at second t, or the latest one at most 2 s before it. */
  private futuresBookAt(t: number) {
    return this.futuresBooks.get(t) ?? this.futuresBooks.get(t - 1) ?? this.futuresBooks.get(t - 2);
  }

  /** Futures mid price at second t (for targets), null when the book is missing. */
  public midAt(t: number): number | null {
    return this.futuresBookAt(t)?.mid ?? null;
  }

  /** Feature vector of second t; null when there is no futures book around it. */
  public vectorAt(t: number): number[] | null {
    const book = this.futuresBookAt(t);
    if (!book) return null;
    const previous = this.futuresBookAt(t - 1);
    const spot = this.spotBooks.get(t) ?? this.spotBooks.get(t - 1) ?? this.spotBooks.get(t - 2);
    const futuresFlow = this.futuresTrades.get(t);
    const liquidations = this.liquidations.get(t);
    return [
      book.imbalance1,
      book.imbalance5,
      book.imbalance20,
      book.micropriceBps,
      book.spreadBps,
      previous ? Math.log(book.mid / previous.mid) * 1e4 : 0,
      spot?.imbalance5 ?? 0,
      spot ? ((book.mid - spot.mid) / spot.mid) * 1e4 : 0,
      flowImbalance(futuresFlow),
      Math.log1p((futuresFlow?.buy ?? 0) + (futuresFlow?.sell ?? 0)),
      flowImbalance(this.spotTrades.get(t)),
      signedLog((liquidations?.short ?? 0) - (liquidations?.long ?? 0)),
      Math.log1p(liquidations?.all ?? 0),
    ];
  }

  /** Seconds with a futures book, oldest first. */
  public seconds(): number[] {
    return Array.from(this.futuresBooks.keys()).sort((a, b) => a - b);
  }

  /** Forgets everything before `second` (the live state only needs the last minutes). */
  public prune(second: number): void {
    for (const map of [this.futuresBooks, this.spotBooks, this.futuresTrades, this.spotTrades, this.liquidations]) {
      for (const key of map.keys()) if (key < second) map.delete(key);
    }
  }
}
