import cryptoConfig from "../../config/crypto.config";
import { BinanceStreamCollector } from "./BinanceStreamCollector";

/**
 * Forced liquidations on all USDⓈ-M futures markets. Cascades on other coins often spill over to ETH,
 * so the whole market is kept; filtering by symbol happens when features are built.
 * Binance sends at most one (the latest) liquidation per symbol per second.
 *
 * Row: [tradeTimeMs, symbol, side ("SELL" = a long was liquidated, "BUY" = a short), price, avgPrice, filledQty]
 */
export class LiquidationsCollector extends BinanceStreamCollector {
  constructor() {
    // liquidations can legitimately pause for minutes in a calm market: only a long silence means a dead stream
    super("liquidations", "ALL/futures-liquidations", `${cryptoConfig.collectors.futuresMarketStreamUrl}/!forceOrder@arr`, 15 * 60 * 1000);
  }

  protected handle(message: any, receivedAt: number): void {
    const events = Array.isArray(message) ? message : [message];
    for (const event of events) {
      const o = event?.o;
      if (event?.e !== "forceOrder" || !o) continue;
      this.record([o.T, o.s, o.S, Number(o.p), Number(o.ap), Number(o.z)], receivedAt);
    }
  }
}
