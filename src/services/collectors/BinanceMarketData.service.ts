import cryptoConfig from "../../config/crypto.config";
import { CryptoBase } from "../../types/basic.types";
import { CandleTimeframe, IFundingRate, IFuturesMetrics, IMarketCandle, MarketSymbol } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";
import BinanceClient from "./BinanceClient";

const log = createLogger("binance");

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
 * Binance market data collector:
 * - spot klines (REST for updates, archives for history), incl. trade count and taker buy volume;
 * - USDⓈ-M futures: open interest, long/short ratios, taker buy/sell ratio (5-minute) and funding rates;
 * - current prices.
 */
class BinanceMarketDataService {
  private readonly priceCache: Map<string, { value: number; expiresAt: number }> = new Map();

  constructor() {
    log("initializing Binance market data collector", Colors.WHITE);
  }

  private toCandle = (row: BinanceKline): IMarketCandle => ({
    time: BinanceClient.toSeconds(Number(row[0])),
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
      const rows = await BinanceClient.getSpot<BinanceKline[]>("/api/v3/klines", {
        symbol: BinanceClient.symbol(symbol),
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
    const s = BinanceClient.symbol(symbol);
    const interval = INTERVAL[timeframe];
    const rows = await BinanceClient.downloadArchiveRows(`spot/${period}/klines/${s}/${interval}/${s}-${interval}-${key}.zip`);
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

    log(`${symbol}: loading ${days} days of ${timeframe} candles from archives`, Colors.BLUE);

    for (const month of BinanceClient.pastMonths(from)) {
      add(await this.downloadKlineArchive(symbol, timeframe, "monthly", month));
    }

    // a monthly archive appears only after the month ends; fill the current month day by day
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
    for (const day of BinanceClient.pastDays(Math.max(from, monthStart))) {
      add(await this.downloadKlineArchive(symbol, timeframe, "daily", day));
    }

    // the rest (archives lag by about a day) via REST, 1000 candles per request
    let lastTime = from - STEP_SECONDS[timeframe];
    byTime.forEach((_, time) => (lastTime = Math.max(lastTime, time)));
    add(await this.fetchRange(symbol, timeframe, lastTime + STEP_SECONDS[timeframe]));

    const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    log(`${symbol}: loaded ${candles.length} ${timeframe} candles`, Colors.BLUE);
    return candles;
  };

  // ---------- futures ----------

  /**
   * Futures metrics since `fromSec` via REST (only the last 30 days exist there): 5 endpoints × 500 rows
   * per page, merged by timestamp. Rows not returned by every endpoint are dropped.
   */
  public fetchFuturesMetrics = async (pair: MarketSymbol, fromSec: number): Promise<IFuturesMetrics[] | null> => {
    const symbol = BinanceClient.symbol(pair);
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
        const rows = await BinanceClient.getFutures<Row[]>(path, {
          symbol,
          period: "5m",
          startTime: cursor * 1000,
          limit: MAX_FUTURES_STATS_PER_REQUEST,
        });
        if (!rows) return result.length ? result : null;
        maxRows = Math.max(maxRows, rows.length);
        rows.forEach((r) => {
          const time = BinanceClient.toSeconds(Number(r.timestamp));
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
    const symbol = BinanceClient.symbol(pair);
    const from = Math.floor(Date.now() / 1000) - days * 86400;
    const byTime = new Map<number, IFuturesMetrics>();

    log(`${pair}: loading ${days} days of futures metrics from archives`, Colors.BLUE);

    for (const day of BinanceClient.pastDays(from)) {
      const rows = await BinanceClient.downloadArchiveRows(`futures/um/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`);
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
    log(`${pair}: loaded ${metrics.length} futures metric rows`, Colors.BLUE);
    return metrics;
  };

  /** Funding rates since `fromSec`, 1000 per request (≈ 11 months of 8-hour funding). */
  public fetchFundingRates = async (pair: MarketSymbol, fromSec: number): Promise<IFundingRate[] | null> => {
    const result: IFundingRate[] = [];
    const now = Math.floor(Date.now() / 1000);
    let cursor = fromSec;

    while (cursor < now) {
      const rows = await BinanceClient.getFutures<{ fundingTime: number; fundingRate: string }[]>("/fapi/v1/fundingRate", {
        symbol: BinanceClient.symbol(pair),
        startTime: cursor * 1000,
        limit: MAX_KLINES_PER_REQUEST,
      });
      if (!rows) return result.length ? result : null;
      if (!rows.length) break;
      result.push(...rows.map((r) => ({ time: BinanceClient.toSeconds(r.fundingTime), rate: Number(r.fundingRate) })));
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
      const ticker = await BinanceClient.getSpot<{ price: string }>("/api/v3/ticker/price", { symbol });
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
