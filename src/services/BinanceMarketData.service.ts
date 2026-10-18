import axios from "axios";
import AdmZip from "adm-zip";
import { format } from "date-fns";

import cryptoConfig from "../config/crypto.config";
import { CryptoBase } from "../types/basic.types";
import { CandleTimeframe, IFundingRate, IFuturesMetrics, IMarketCandle, MarketSymbol } from "../types/marketData.types";
import { log, Colors } from "../utils/colored-console";

// Binance kline row: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
type BinanceKline = (string | number)[];

// one request returns up to 1000 candles / funding rates — always ask for the maximum
const MAX_KLINES_PER_REQUEST = 1000;
// futures statistics endpoints return at most 500 rows (≈41h of 5-minute data) and keep only the last 30 days
const MAX_FUTURES_STATS_PER_REQUEST = 500;
const FUTURES_PERIOD_SECONDS = 300;

const INTERVAL: Record<CandleTimeframe, string> = { minute: "1m", hour: "1h" };
const STEP_SECONDS: Record<CandleTimeframe, number> = { minute: 60, hour: 3600 };

const METRIC_FIELDS: (keyof IFuturesMetrics)[] = [
  "openInterest",
  "openInterestValue",
  "longShortAccountRatio",
  "topTraderAccountRatio",
  "topTraderPositionRatio",
  "takerBuySellRatio",
];

/**
 * Free market data from Binance (no API key):
 * - spot klines (REST for updates, data.binance.vision archives for history), incl. trade count and taker buy volume;
 * - USDⓈ-M futures: open interest, long/short ratios, taker buy/sell ratio (5-minute) and funding rates.
 */
class BinanceMarketDataService {
  private readonly priceCache: Map<string, { value: number; expiresAt: number }> = new Map();
  private blockedUntil = 0;

  constructor() {
    log("[*] Initializing Binance Market Data Service", Colors.WHITE);
  }

  private symbol(pair: MarketSymbol): string {
    return pair.replace("-", "");
  }

  /** Archive timestamps are in microseconds since 2025, REST ones in milliseconds. */
  private toSeconds(timestamp: number): number {
    return timestamp > 1e14 ? Math.floor(timestamp / 1e6) : Math.floor(timestamp / 1e3);
  }

  private toCandle = (row: BinanceKline): IMarketCandle => ({
    time: this.toSeconds(Number(row[0])),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volumefrom: Number(row[5]),
    volumeto: Number(row[7]),
    trades: Number(row[8]),
    takerBuyBase: Number(row[9]),
    takerBuyQuote: Number(row[10]),
  });

  /** Tries each base URL in turn; pauses all requests if Binance asks us to back off. */
  private async get<T>(baseUrls: string[], path: string, params: Record<string, string | number>): Promise<T | null> {
    if (Date.now() < this.blockedUntil) {
      log(`Binance is rate limited until ${new Date(this.blockedUntil).toLocaleTimeString()}, skipping request`, Colors.YELLOW);
      return null;
    }

    for (const baseUrl of baseUrls) {
      try {
        const response = await axios.get<T>(`${baseUrl}${path}`, { params, timeout: 15000 });
        return response.data;
      } catch (error: any) {
        const status = error?.response?.status;
        if (status === 429 || status === 418) {
          const retryAfter = Number(error.response.headers?.["retry-after"] ?? 60);
          this.blockedUntil = Date.now() + retryAfter * 1000;
          log(`Binance rate limit reached (${status}), pausing requests for ${retryAfter}s`, Colors.RED);
          return null;
        }
        if (status === 400) {
          log(`Binance rejected ${path}: ${JSON.stringify(error.response.data)}`, Colors.RED);
          return null;
        }
        log(`Binance request to ${baseUrl}${path} failed: ${error?.message}`, Colors.YELLOW);
      }
    }
    return null;
  }

  private getSpot<T>(path: string, params: Record<string, string | number>) {
    return this.get<T>(cryptoConfig.marketData.binanceApiUrls, path, params);
  }

  private getFutures<T>(path: string, params: Record<string, string | number>) {
    return this.get<T>([cryptoConfig.marketData.binanceFuturesApiUrl], path, params);
  }

  /** Downloads a data.binance.vision ZIP and returns its CSV rows (header skipped); null if not published yet. */
  private async downloadArchiveRows(path: string): Promise<string[][] | null> {
    const url = `${cryptoConfig.marketData.binanceArchiveUrl}/data/${path}`;
    try {
      const response = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 60000 });
      const zip = new AdmZip(Buffer.from(response.data));
      const csv = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
      if (!csv) return null;
      return csv
        .getData()
        .toString("utf-8")
        .split("\n")
        .map((line) => line.trim())
        // skip empty lines and a header row if present
        .filter((line) => line && /^\d/.test(line))
        .map((line) => line.split(","));
    } catch (error: any) {
      if (error?.response?.status !== 404) {
        log(`Binance archive ${path} download failed: ${error?.message}`, Colors.YELLOW);
      }
      return null;
    }
  }

  /** Calendar days (UTC, "yyyy-MM-dd") from `fromSec` up to yesterday — the ones daily archives can exist for. */
  private pastDays(fromSec: number): string[] {
    const days: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (let t = fromSec; ; t += 86400) {
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      if (day >= today) break;
      days.push(day);
    }
    return days;
  }

  // ---------- spot candles ----------

  /**
   * All closed candles in [fromSec, now): paginated by 1000 candles per request.
   * Returns null if the first request failed, so the caller can retry later instead of storing a hole.
   */
  public fetchRange = async (symbol: MarketSymbol, timeframe: CandleTimeframe, fromSec: number): Promise<IMarketCandle[] | null> => {
    const step = STEP_SECONDS[timeframe];
    const now = Math.floor(Date.now() / 1000);
    const result: IMarketCandle[] = [];
    let cursor = fromSec;

    while (cursor + step <= now) {
      const rows = await this.getSpot<BinanceKline[]>("/api/v3/klines", {
        symbol: this.symbol(symbol),
        interval: INTERVAL[timeframe],
        startTime: cursor * 1000,
        limit: MAX_KLINES_PER_REQUEST,
      });
      if (!rows) return result.length ? result : null;
      if (!rows.length) break;

      const candles = rows.map(this.toCandle);
      // never keep the still-open candle: its close would be frozen with a wrong value
      result.push(...candles.filter((c) => c.time + step <= now));
      cursor = candles[candles.length - 1].time + step;
      if (rows.length < MAX_KLINES_PER_REQUEST) break;
    }

    return result;
  };

  private downloadKlineArchive = async (
    symbol: MarketSymbol,
    timeframe: CandleTimeframe,
    period: "monthly" | "daily",
    key: string
  ): Promise<IMarketCandle[] | null> => {
    const s = this.symbol(symbol);
    const interval = INTERVAL[timeframe];
    const rows = await this.downloadArchiveRows(`spot/${period}/klines/${s}/${interval}/${s}-${interval}-${key}.zip`);
    return rows?.map(this.toCandle) ?? null;
  };

  /**
   * History for the last `days`: monthly archives for full past months, daily archives for
   * the current month, REST for what archives do not have yet (usually today).
   */
  public backfill = async (symbol: MarketSymbol, timeframe: CandleTimeframe, days: number): Promise<IMarketCandle[]> => {
    const now = new Date();
    const from = Math.floor(now.getTime() / 1000) - days * 86400;
    const byTime = new Map<number, IMarketCandle>();
    const add = (candles: IMarketCandle[] | null) => candles?.forEach((c) => c.time >= from && byTime.set(c.time, c));

    const currentMonth = format(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), "yyyy-MM");
    const cursor = new Date(from * 1000);
    cursor.setUTCDate(1);

    log(`[**] ${symbol}: loading ${days} days of ${timeframe} candles from Binance archives`, Colors.BLUE);

    while (format(cursor.getTime(), "yyyy-MM") < currentMonth) {
      const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
      add(await this.downloadKlineArchive(symbol, timeframe, "monthly", key));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    // a monthly archive appears only after the month ends; fill the current month day by day
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
    for (const day of this.pastDays(Math.max(from, monthStart))) {
      add(await this.downloadKlineArchive(symbol, timeframe, "daily", day));
    }

    // the rest (archives lag by about a day) via REST, 1000 candles per request
    let lastTime = from - STEP_SECONDS[timeframe];
    byTime.forEach((_, time) => (lastTime = Math.max(lastTime, time)));
    add(await this.fetchRange(symbol, timeframe, lastTime + STEP_SECONDS[timeframe]));

    const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    log(`[**] ${symbol}: loaded ${candles.length} ${timeframe} candles from Binance`, Colors.BLUE);
    return candles;
  };

  // ---------- futures ----------

  /**
   * Futures metrics since `fromSec` via REST (only the last 30 days exist there): 5 endpoints × 500 rows
   * per page, merged by timestamp. Rows not returned by every endpoint are dropped.
   */
  public fetchFuturesMetrics = async (pair: MarketSymbol, fromSec: number): Promise<IFuturesMetrics[] | null> => {
    const symbol = this.symbol(pair);
    const now = Math.floor(Date.now() / 1000);
    const result: IFuturesMetrics[] = [];

    type Row = Record<string, string | number>;
    const endpoints: [string, (r: Row) => Partial<IFuturesMetrics>][] = [
      ["/futures/data/openInterestHist", (r) => ({ openInterest: Number(r.sumOpenInterest), openInterestValue: Number(r.sumOpenInterestValue) })],
      ["/futures/data/globalLongShortAccountRatio", (r) => ({ longShortAccountRatio: Number(r.longShortRatio) })],
      ["/futures/data/topLongShortAccountRatio", (r) => ({ topTraderAccountRatio: Number(r.longShortRatio) })],
      ["/futures/data/topLongShortPositionRatio", (r) => ({ topTraderPositionRatio: Number(r.longShortRatio) })],
      ["/futures/data/takerlongshortRatio", (r) => ({ takerBuySellRatio: Number(r.buySellRatio) })],
    ];

    let cursor = Math.max(fromSec, now - 29 * 86400);
    while (cursor + FUTURES_PERIOD_SECONDS <= now) {
      const byTime = new Map<number, Partial<IFuturesMetrics>>();
      let maxRows = 0;
      let maxTime = 0;

      for (const [path, map] of endpoints) {
        const rows = await this.getFutures<Row[]>(path, {
          symbol,
          period: "5m",
          startTime: cursor * 1000,
          limit: MAX_FUTURES_STATS_PER_REQUEST,
        });
        if (!rows) return result.length ? result : null;
        maxRows = Math.max(maxRows, rows.length);
        rows.forEach((r) => {
          const time = this.toSeconds(Number(r.timestamp));
          byTime.set(time, { ...byTime.get(time), time, ...map(r) });
          maxTime = Math.max(maxTime, time);
        });
      }

      byTime.forEach((row) => METRIC_FIELDS.every((f) => row[f] !== undefined) && result.push(row as IFuturesMetrics));
      if (maxRows < MAX_FUTURES_STATS_PER_REQUEST || maxTime < cursor) break;
      cursor = maxTime + FUTURES_PERIOD_SECONDS;
    }

    return result.sort((a, b) => a.time - b.time);
  };

  /** Futures metrics history from daily archives (a year back is available) plus REST for the last day. */
  public backfillFuturesMetrics = async (pair: MarketSymbol, days: number): Promise<IFuturesMetrics[]> => {
    const symbol = this.symbol(pair);
    const from = Math.floor(Date.now() / 1000) - days * 86400;
    const byTime = new Map<number, IFuturesMetrics>();

    log(`[**] ${pair}: loading ${days} days of futures metrics from Binance archives`, Colors.BLUE);

    for (const day of this.pastDays(from)) {
      const rows = await this.downloadArchiveRows(`futures/um/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`);
      // create_time, symbol, sum_open_interest, sum_open_interest_value, count_toptrader_long_short_ratio,
      // sum_toptrader_long_short_ratio, count_long_short_ratio, sum_taker_long_short_vol_ratio
      rows?.forEach((r) => {
        const time = Math.floor(Date.parse(`${r[0].replace(" ", "T")}Z`) / 1000);
        byTime.set(time, {
          time,
          openInterest: Number(r[2]),
          openInterestValue: Number(r[3]),
          topTraderAccountRatio: Number(r[4]),
          topTraderPositionRatio: Number(r[5]),
          longShortAccountRatio: Number(r[6]),
          takerBuySellRatio: Number(r[7]),
        });
      });
    }

    let lastTime = from;
    byTime.forEach((_, time) => (lastTime = Math.max(lastTime, time)));
    (await this.fetchFuturesMetrics(pair, lastTime + FUTURES_PERIOD_SECONDS))?.forEach((m) => byTime.set(m.time, m));

    const metrics = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    log(`[**] ${pair}: loaded ${metrics.length} futures metric rows from Binance`, Colors.BLUE);
    return metrics;
  };

  /** Funding rates since `fromSec`, 1000 per request (≈ 11 months of 8-hour funding). */
  public fetchFundingRates = async (pair: MarketSymbol, fromSec: number): Promise<IFundingRate[] | null> => {
    const result: IFundingRate[] = [];
    const now = Math.floor(Date.now() / 1000);
    let cursor = fromSec;

    while (cursor < now) {
      const rows = await this.getFutures<{ fundingTime: number; fundingRate: string }[]>("/fapi/v1/fundingRate", {
        symbol: this.symbol(pair),
        startTime: cursor * 1000,
        limit: MAX_KLINES_PER_REQUEST,
      });
      if (!rows) return result.length ? result : null;
      if (!rows.length) break;
      result.push(...rows.map((r) => ({ time: this.toSeconds(r.fundingTime), rate: Number(r.fundingRate) })));
      cursor = result[result.length - 1].time + 1;
      if (rows.length < MAX_KLINES_PER_REQUEST) break;
    }

    return result;
  };

  // ---------- price ----------

  /** Cached for a short TTL; a missing direct symbol (e.g. USDTETH) is derived from the reverse one. */
  public getCurrentPrice = async (base: CryptoBase, to: CryptoBase): Promise<number | null> => {
    const now = Date.now();
    const direct = this.priceCache.get(`${base}${to}`);
    if (direct && direct.expiresAt > now) return direct.value;
    const reverse = this.priceCache.get(`${to}${base}`);
    if (reverse && reverse.expiresAt > now && reverse.value > 0) return 1 / reverse.value;

    const ttl = cryptoConfig.marketData.priceCacheTtlSeconds * 1000;
    for (const [symbol, invert] of [[`${base}${to}`, false], [`${to}${base}`, true]] as [string, boolean][]) {
      const ticker = await this.getSpot<{ price: string }>("/api/v3/ticker/price", { symbol });
      const price = Number(ticker?.price);
      if (price > 0) {
        this.priceCache.set(symbol, { value: price, expiresAt: now + ttl });
        return invert ? 1 / price : price;
      }
    }
    return null;
  };
}

export default new BinanceMarketDataService();
