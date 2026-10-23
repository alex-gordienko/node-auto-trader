import cryptoConfig from "../../config/crypto.config";
import { MarketSymbol } from "../../types/marketData.types";
import { BinanceStreamCollector } from "./BinanceStreamCollector";

type Level = [number, number]; // [price, quantity]

/**
 * Top-N order book (spot or USDⓈ-M futures). The stream sends a full top-20 snapshot every 100 ms;
 * one snapshot per `depthSnapshotMs` is stored.
 *
 * Row: [receivedAtMs, eventTimeMs | null, bids [[price, qty], ...], asks [[price, qty], ...]]
 * (spot snapshots carry no event time, so the receive time is the timestamp to use)
 */
export class OrderBookCollector extends BinanceStreamCollector {
  private latest: { receivedAt: number; eventTime: number | null; bids: Level[]; asks: Level[] } | null = null;
  private latestWritten = true;
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(symbol: MarketSymbol, market: "spot" | "futures") {
    const { spotStreamUrl, futuresPublicStreamUrl } = cryptoConfig.collectors;
    const stream = `${symbol.replace("-", "").toLowerCase()}@depth20@100ms`;
    super("orderbook", `${symbol}/${market}-depth`, `${market === "spot" ? spotStreamUrl : futuresPublicStreamUrl}/${stream}`);
  }

  protected handle(message: any, receivedAt: number): void {
    // spot partial book: { bids, asks }, futures: { E, b, a }
    const bids = message.bids ?? message.b;
    const asks = message.asks ?? message.a;
    if (!Array.isArray(bids) || !Array.isArray(asks)) return;

    const levels = cryptoConfig.collectors.depthLevels;
    const toLevels = (rows: string[][]): Level[] => rows.slice(0, levels).map(([p, q]) => [Number(p), Number(q)]);
    this.latest = { receivedAt, eventTime: message.E ?? null, bids: toLevels(bids), asks: toLevels(asks) };
    this.latestWritten = false;
  }

  public start(): void {
    super.start();
    this.snapshotTimer = setInterval(() => {
      if (!this.latest || this.latestWritten) return;
      const { receivedAt, eventTime, bids, asks } = this.latest;
      this.record([receivedAt, eventTime, bids, asks], receivedAt);
      this.latestWritten = true;
    }, cryptoConfig.collectors.depthSnapshotMs);
  }

  public async stop(): Promise<void> {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    await super.stop();
  }
}
