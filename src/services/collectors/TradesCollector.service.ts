import cryptoConfig from "../../config/crypto.config";
import { MarketSymbol } from "../../types/marketData.types";
import { BinanceStreamCollector } from "./BinanceStreamCollector";

/**
 * Every aggregated trade (spot or USDⓈ-M futures): who hit whom, at what price and size.
 *
 * Row: [tradeTimeMs, price, quantity, buyerIsMaker (1 = aggressive seller, 0 = aggressive buyer)]
 */
export class TradesCollector extends BinanceStreamCollector {
  constructor(symbol: MarketSymbol, market: "spot" | "futures") {
    const { spotStreamUrl, futuresMarketStreamUrl } = cryptoConfig.collectors;
    const stream = `${symbol.replace("-", "").toLowerCase()}@aggTrade`;
    super("trades", `${symbol}/${market}-trades`, `${market === "spot" ? spotStreamUrl : futuresMarketStreamUrl}/${stream}`);
  }

  protected handle(message: any, receivedAt: number): void {
    if (message.e !== "aggTrade") return;
    this.writer.write([message.T, Number(message.p), Number(message.q), message.m ? 1 : 0], receivedAt);
  }
}
