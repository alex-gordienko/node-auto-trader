import { CandleTimeframe, IPremiumCandle, MarketSymbol } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";
import BinanceClient from "./BinanceClient";

const log = createLogger("premium-index");

const MAX_ROWS_PER_REQUEST = 1500;
const INTERVAL: Record<CandleTimeframe, string> = { minute: "1m", hour: "1h" };
const STEP_SECONDS: Record<CandleTimeframe, number> = { minute: 60, hour: 3600 };

/**
 * Binance USDⓈ-M futures premium index: how much the perpetual contract trades above (or below) spot.
 * A high premium means leveraged longs are crowded and pay for it — the market is vulnerable to a drop.
 * History from data.binance.vision archives, updates via REST (/fapi/v1/premiumIndexKlines).
 */
class PremiumIndexCollector {
  constructor() {
    log("initializing futures premium index collector", Colors.WHITE);
  }

  private toCandle = (row: (string | number)[]): IPremiumCandle => ({
    time: BinanceClient.toSeconds(Number(row[0])),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
  });

  /** Closed candles in [fromSec, now), 1500 per request. Null if the first request failed. */
  public fetchRange = async (pair: MarketSymbol, timeframe: CandleTimeframe, fromSec: number): Promise<IPremiumCandle[] | null> => {
    const step = STEP_SECONDS[timeframe];
    const now = Math.floor(Date.now() / 1000);
    const result: IPremiumCandle[] = [];
    let cursor = fromSec;

    while (cursor + step <= now) {
      const rows = await BinanceClient.getFutures<(string | number)[][]>("/fapi/v1/premiumIndexKlines", {
        symbol: BinanceClient.symbol(pair),
        interval: INTERVAL[timeframe],
        startTime: cursor * 1000,
        limit: MAX_ROWS_PER_REQUEST,
      });
      if (!rows) return result.length ? result : null;
      if (!rows.length) break;

      const candles = rows.map(this.toCandle);
      result.push(...candles.filter((c) => c.time + step <= now));
      cursor = candles[candles.length - 1].time + step;
      if (rows.length < MAX_ROWS_PER_REQUEST) break;
    }
    return result;
  };

  /** History for the last `days`: monthly archives, daily archives for the current month, REST for the rest. */
  public backfill = async (pair: MarketSymbol, timeframe: CandleTimeframe, days: number): Promise<IPremiumCandle[]> => {
    const symbol = BinanceClient.symbol(pair);
    const interval = INTERVAL[timeframe];
    const now = new Date();
    const from = Math.floor(now.getTime() / 1000) - days * 86400;
    const byTime = new Map<number, IPremiumCandle>();
    const add = (rows: string[][] | null) =>
      rows?.map(this.toCandle).forEach((c) => c.time >= from && byTime.set(c.time, c));

    log(`${pair}: loading ${days} days of ${timeframe} premium index from archives`, Colors.BLUE);
    const base = `futures/um/%s/premiumIndexKlines/${symbol}/${interval}/${symbol}-${interval}`;

    for (const month of BinanceClient.pastMonths(from)) {
      add(await BinanceClient.downloadArchiveRows(`${base.replace("%s", "monthly")}-${month}.zip`));
    }
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
    for (const day of BinanceClient.pastDays(Math.max(from, monthStart))) {
      add(await BinanceClient.downloadArchiveRows(`${base.replace("%s", "daily")}-${day}.zip`));
    }

    let lastTime = from - STEP_SECONDS[timeframe];
    byTime.forEach((_, time) => (lastTime = Math.max(lastTime, time)));
    (await this.fetchRange(pair, timeframe, lastTime + STEP_SECONDS[timeframe]))?.forEach((c) => byTime.set(c.time, c));

    const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    log(`${pair}: loaded ${candles.length} ${timeframe} premium index candles`, Colors.BLUE);
    return candles;
  };
}

export default new PremiumIndexCollector();
