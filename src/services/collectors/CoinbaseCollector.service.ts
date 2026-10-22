import axios from "axios";

import cryptoConfig from "../../config/crypto.config";
import { CandleTimeframe, IMarketCandle, MarketSymbol } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("coinbase");

const MAX_ROWS_PER_REQUEST = 300;
const STEP_SECONDS: Record<CandleTimeframe, number> = { minute: 60, hour: 3600 };
// public endpoints allow ~10 requests per second
const PAUSE_MS = 150;
const RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Coinbase Exchange candles of the pair's base coin in US dollars (ETH-USDT → ETH-USD). Coinbase is where US
 * buyers trade: its price above Binance's ("Coinbase premium") means US demand is stronger. Free, years of history.
 */
class CoinbaseCollector {
  constructor() {
    log("initializing Coinbase candles collector", Colors.WHITE);
  }

  public product = (pair: MarketSymbol) => `${pair.split("-")[0]}-USD`;

  /** One page: [time, low, high, open, close, volume], newest first; retried when rate-limited. */
  private async page(product: string, step: number, from: number, to: number): Promise<number[][] | null> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const response = await axios.get<number[][]>(`${cryptoConfig.marketData.coinbaseApiUrl}/products/${product}/candles`, {
          params: { granularity: step, start: new Date(from * 1000).toISOString(), end: new Date(to * 1000).toISOString() },
          timeout: 15000,
        });
        return response.data;
      } catch (error: any) {
        log(`${product}: request failed (${error?.response?.status ?? error?.message}), attempt ${attempt + 1}/${RETRIES}`, Colors.YELLOW);
        await sleep(1000 * (attempt + 1));
      }
    }
    return null;
  }

  /** Closed candles in [fromSec, now). Null if the first request failed. */
  public fetchRange = async (pair: MarketSymbol, timeframe: CandleTimeframe, fromSec: number): Promise<IMarketCandle[] | null> => {
    const product = this.product(pair);
    const step = STEP_SECONDS[timeframe];
    const now = Math.floor(Date.now() / 1000);
    const byTime = new Map<number, IMarketCandle>();

    for (let start = fromSec; start + step <= now; start += MAX_ROWS_PER_REQUEST * step) {
      // `end` is inclusive: stop one bar short so pages do not overlap
      const rows = await this.page(product, step, start, Math.min(now, start + MAX_ROWS_PER_REQUEST * step - step));
      if (!rows) return byTime.size ? Array.from(byTime.values()).sort((a, b) => a.time - b.time) : null;
      rows
        .filter(([time]) => time >= fromSec && time + step <= now)
        .forEach(([time, low, high, open, close, volume]) =>
          byTime.set(time, { time, open, high, low, close, volumefrom: volume, volumeto: volume * close })
        );
      await sleep(PAUSE_MS);
    }
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  };

  public backfill = async (pair: MarketSymbol, timeframe: CandleTimeframe, days: number): Promise<IMarketCandle[]> => {
    log(`${pair}: loading ${days} days of ${timeframe} ${this.product(pair)} candles`, Colors.BLUE);
    const candles = (await this.fetchRange(pair, timeframe, Math.floor(Date.now() / 1000) - days * 86400)) ?? [];
    log(`${pair}: loaded ${candles.length} ${timeframe} Coinbase candles`, Colors.BLUE);
    return candles;
  };
}

export default new CoinbaseCollector();
