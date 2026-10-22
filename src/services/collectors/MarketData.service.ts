import BinanceMarketDataService from "./BinanceMarketData.service";
import CoinbaseCollector from "./CoinbaseCollector.service";
import DvolCollector from "./DvolCollector.service";
import FearGreedCollector from "./FearGreedCollector.service";
import PremiumIndexCollector from "./PremiumIndexCollector.service";
import StablecoinsCollector from "./StablecoinsCollector.service";
import StorageService, { MarketSeries } from "../Local.storage.service";

import cryptoConfig from "../../config/crypto.config";
import { CryptoBase, CryptoPairs } from "../../types/basic.types";
import {
  CandleTimeframe,
  ICandleSeries,
  IFundingRate,
  IFuturesMetrics,
  IMarketCandle,
  IMarketDataset,
  IPremiumCandle,
  IPremiumSeries,
  ISeriesPoint,
  MarketSymbol,
} from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("market-data");

const STEP_SECONDS: Record<CandleTimeframe, number> = { minute: 60, hour: 3600 };
const CANDLE_SERIES: Record<CandleTimeframe, MarketSeries> = { minute: "1m", hour: "1h" };
const PREMIUM_SERIES: Record<CandleTimeframe, MarketSeries> = { minute: "premium-1m", hour: "premium-1h" };
const COINBASE_SERIES: Record<CandleTimeframe, MarketSeries> = { minute: "coinbase-1m", hour: "coinbase-1h" };
// market-wide series (stablecoins, fear & greed) are stored under this name instead of a pair
const MARKET = "MARKET";
const DAY_SECONDS = 86400;
const FUTURES_PERIOD_SECONDS = 300;
const FUNDING_INTERVAL_SECONDS = 8 * 3600;

/** True if consecutive rows are further apart than `maxSeconds` (e.g. a download interrupted by a network error). */
const hasGap = (rows: { time: number }[], maxSeconds: number) =>
  rows.some((row, i) => i > 0 && row.time - rows[i - 1].time > maxSeconds);

// what stays in memory between updates: enough for inference, the full history lives in storage
const MEMORY_KEEP_SECONDS: Record<MarketSeries, number> = {
  "1m": 2 * 86400,
  "1h": 35 * 86400, // the 30-day trend feature needs 720 full hourly candles
  "futures-metrics": 3 * 86400, // 24h open interest change needs a day of history
  funding: 7 * 86400,
  "premium-1m": 2 * 86400,
  "premium-1h": 30 * 86400,
  "coinbase-1m": 2 * 86400,
  "coinbase-1h": 30 * 86400,
  "dvol-1h": 3 * 86400, // 24h change
  "stablecoins-1d": 40 * 86400, // 30-day change, published with a delay
  "fear-greed-1d": 10 * 86400, // 7-day change
};

/**
 * Single entry point for market data collected over REST: keeps every dataset up to date incrementally
 * (only missing rows are requested, each request asks for the maximum page size) and assembles datasets
 * for training and inference. Sources: Binance (candles, futures metrics, funding, premium index),
 * Coinbase (USD candles), Deribit (DVOL), DefiLlama (stablecoin supply), alternative.me (fear & greed).
 */
class MarketDataService {
  private cache: Map<string, { time: number }[]> = new Map();
  // last request per series: daily sources publish late, so "behind" does not mean "new data is out"
  private lastAttempt: Map<string, number> = new Map();

  constructor() {
    log("initializing market data service", Colors.WHITE);
  }

  private get references(): MarketSymbol[] {
    return cryptoConfig.marketData.referencePairs;
  }

  /**
   * Generic incremental sync: loads the cached tail from storage once, asks `fetchSince` for rows after the
   * last stored one (or `backfill` when the dataset is empty), saves new rows and returns the cached tail.
   */
  private async syncSeries<T extends { time: number }>(
    symbol: MarketSymbol,
    series: MarketSeries,
    step: number,
    fetchSince: (fromSec: number) => Promise<T[] | null>,
    backfill: () => Promise<T[]>
  ): Promise<T[]> {
    const key = `${symbol}:${series}`;
    const now = Math.floor(Date.now() / 1000);
    let cached = this.cache.get(key) as T[] | undefined;
    if (!cached) {
      cached = await StorageService.getSeries<T>(symbol, series, now - MEMORY_KEEP_SECONDS[series]);
      if (!cached.length) {
        // storage may still hold older rows: continue from them instead of re-downloading everything
        const all = await StorageService.getSeries<T>(symbol, series);
        cached = all.slice(-1);
      }
    }

    const lastTime = cached.length ? cached[cached.length - 1].time : 0;
    let fresh: T[] = [];
    if (!lastTime) {
      fresh = await backfill();
    } else if (now - lastTime >= 2 * step && now - (this.lastAttempt.get(key) ?? 0) >= step) {
      this.lastAttempt.set(key, now);
      fresh = (await fetchSince(lastTime + step)) ?? [];
    }

    fresh = fresh.filter((row) => row.time > lastTime);
    if (fresh.length) {
      await StorageService.pushSeries(symbol, series, fresh);
    }

    const result = [...cached, ...fresh].filter((row) => row.time >= now - MEMORY_KEEP_SECONDS[series]);
    this.cache.set(key, result);
    return result;
  }

  public syncCandles = (symbol: MarketSymbol, timeframe: CandleTimeframe): Promise<IMarketCandle[]> => {
    const { backfillMinuteDays, backfillHourDays } = cryptoConfig.marketData;
    return this.syncSeries<IMarketCandle>(
      symbol,
      CANDLE_SERIES[timeframe],
      STEP_SECONDS[timeframe],
      (from) => BinanceMarketDataService.fetchRange(symbol, timeframe, from),
      () => BinanceMarketDataService.backfill(symbol, timeframe, timeframe === "hour" ? backfillHourDays : backfillMinuteDays)
    );
  };

  public syncFuturesMetrics = (pair: MarketSymbol): Promise<IFuturesMetrics[]> => {
    if (!cryptoConfig.marketData.useFutures) return Promise.resolve([]);
    return this.syncSeries<IFuturesMetrics>(
      pair,
      "futures-metrics",
      FUTURES_PERIOD_SECONDS,
      (from) => BinanceMarketDataService.fetchFuturesMetrics(pair, from),
      () => BinanceMarketDataService.backfillFuturesMetrics(pair, cryptoConfig.marketData.backfillMinuteDays)
    );
  };

  public syncFunding = (pair: MarketSymbol): Promise<IFundingRate[]> => {
    if (!cryptoConfig.marketData.useFutures) return Promise.resolve([]);
    return this.syncSeries<IFundingRate>(
      pair,
      "funding",
      FUNDING_INTERVAL_SECONDS / 2,
      (from) => BinanceMarketDataService.fetchFundingRates(pair, from),
      async () =>
        (await BinanceMarketDataService.fetchFundingRates(
          pair,
          Math.floor(Date.now() / 1000) - cryptoConfig.marketData.backfillHourDays * 86400
        )) ?? []
    );
  };

  public syncPremium = (pair: MarketSymbol, timeframe: CandleTimeframe): Promise<IPremiumCandle[]> => {
    const { backfillMinuteDays, backfillHourDays } = cryptoConfig.marketData;
    return this.syncSeries<IPremiumCandle>(
      pair,
      PREMIUM_SERIES[timeframe],
      STEP_SECONDS[timeframe],
      (from) => PremiumIndexCollector.fetchRange(pair, timeframe, from),
      () => PremiumIndexCollector.backfill(pair, timeframe, timeframe === "hour" ? backfillHourDays : backfillMinuteDays)
    );
  };

  /** Candles of the pair's base coin in USD on Coinbase, at the pair's own times. */
  public syncCoinbase = (pair: MarketSymbol, timeframe: CandleTimeframe): Promise<IMarketCandle[]> => {
    const { backfillMinuteDays, backfillHourDays } = cryptoConfig.marketData;
    return this.syncSeries<IMarketCandle>(
      pair,
      COINBASE_SERIES[timeframe],
      STEP_SECONDS[timeframe],
      (from) => CoinbaseCollector.fetchRange(pair, timeframe, from),
      () => CoinbaseCollector.backfill(pair, timeframe, timeframe === "hour" ? backfillHourDays : backfillMinuteDays)
    );
  };

  /** Hourly DVOL of the pair's base currency (ETH for ETH-USDT). */
  public syncDvol = (pair: MarketSymbol): Promise<ISeriesPoint[]> => {
    const currency = pair.split("-")[0];
    const backfillFrom = () => Math.floor(Date.now() / 1000) - cryptoConfig.marketData.backfillHourDays * DAY_SECONDS;
    return this.syncSeries<ISeriesPoint>(
      pair,
      "dvol-1h",
      STEP_SECONDS.hour,
      (from) => DvolCollector.fetchSince(currency, from),
      async () => (await DvolCollector.fetchSince(currency, backfillFrom())) ?? []
    );
  };

  // daily sources return their whole history in one request; checked twice a day
  public syncStablecoins = (): Promise<ISeriesPoint[]> =>
    this.syncSeries<ISeriesPoint>(
      MARKET,
      "stablecoins-1d",
      DAY_SECONDS / 2,
      () => StablecoinsCollector.fetchAll(),
      async () => (await StablecoinsCollector.fetchAll()) ?? []
    );

  public syncFearGreed = (): Promise<ISeriesPoint[]> =>
    this.syncSeries<ISeriesPoint>(
      MARKET,
      "fear-greed-1d",
      DAY_SECONDS / 2,
      () => FearGreedCollector.fetchAll(),
      async () => (await FearGreedCollector.fetchAll()) ?? []
    );

  private async syncPremiumSeries(pair: MarketSymbol): Promise<IPremiumSeries> {
    return { minute: await this.syncPremium(pair, "minute"), hour: await this.syncPremium(pair, "hour") };
  }

  private async syncCandleSeries(symbol: MarketSymbol): Promise<ICandleSeries> {
    return { minute: await this.syncCandles(symbol, "minute"), hour: await this.syncCandles(symbol, "hour") };
  }

  /** Brings every dataset of the pair (candles, reference markets, futures, premium, DVOL, daily indexes) up to date. */
  public syncAll = async (pair: CryptoPairs): Promise<void> => {
    await this.getInferenceDataset(pair);
  };

  /** Freshest data for a prediction; the call itself performs the incremental update. */
  public getInferenceDataset = async (pair: CryptoPairs): Promise<IMarketDataset> => {
    const own = await this.syncCandleSeries(pair);
    const references: ICandleSeries[] = [];
    for (const symbol of this.references) {
      references.push(await this.syncCandleSeries(symbol));
    }
    return {
      ...own,
      references,
      futures: await this.syncFuturesMetrics(pair),
      funding: await this.syncFunding(pair),
      premium: await this.syncPremiumSeries(pair),
      coinbase: { minute: await this.syncCoinbase(pair, "minute"), hour: await this.syncCoinbase(pair, "hour") },
      dvol: await this.syncDvol(pair),
      stablecoins: await this.syncStablecoins(),
      fearGreed: await this.syncFearGreed(),
    };
  };

  /** History for retraining, read from storage: minutes for the last `minuteDays` (default: trainingMinuteDays), all hours. */
  public getTrainingDataset = async (
    pair: CryptoPairs,
    minuteDays = cryptoConfig.marketData.trainingMinuteDays
  ): Promise<IMarketDataset> => {
    const since = Math.floor(Date.now() / 1000) - minuteDays * 86400;
    const load = async (symbol: MarketSymbol): Promise<ICandleSeries> => ({
      minute: await StorageService.getCandles(symbol, "minute", since),
      hour: await StorageService.getCandles(symbol, "hour"),
    });

    const references: ICandleSeries[] = [];
    for (const symbol of this.references) {
      references.push(await load(symbol));
    }
    return {
      ...(await load(pair)),
      references,
      // one extra day so the first samples already have a 24h open interest change
      futures: await StorageService.getSeries<IFuturesMetrics>(pair, "futures-metrics", since - 86400),
      funding: await StorageService.getSeries<IFundingRate>(pair, "funding"),
      premium: {
        minute: await StorageService.getSeries<IPremiumCandle>(pair, "premium-1m", since),
        hour: await StorageService.getSeries<IPremiumCandle>(pair, "premium-1h"),
      },
      coinbase: {
        minute: await StorageService.getSeries<IMarketCandle>(pair, "coinbase-1m", since),
        hour: await StorageService.getSeries<IMarketCandle>(pair, "coinbase-1h"),
      },
      dvol: await StorageService.getSeries<ISeriesPoint>(pair, "dvol-1h"),
      stablecoins: await StorageService.getSeries<ISeriesPoint>(MARKET, "stablecoins-1d"),
      fearGreed: await StorageService.getSeries<ISeriesPoint>(MARKET, "fear-greed-1d"),
    };
  };

  /**
   * Downloads history for the pair and its reference markets. Candles saved before trade-flow fields existed
   * (no `takerBuyBase`) are re-downloaded, so the new model inputs have full history.
   */
  public backfill = async (pair: CryptoPairs, minuteDays: number, hourDays: number): Promise<void> => {
    const now = Math.floor(Date.now() / 1000);

    for (const symbol of [pair, ...this.references]) {
      for (const [timeframe, days] of [
        ["minute", minuteDays],
        ["hour", hourDays],
      ] as [CandleTimeframe, number][]) {
        const since = now - days * DAY_SECONDS;
        const candles = await this.refresh(
          await StorageService.getCandles(symbol, timeframe, since),
          since,
          STEP_SECONDS[timeframe],
          (from) => BinanceMarketDataService.fetchRange(symbol, timeframe, from),
          () => BinanceMarketDataService.backfill(symbol, timeframe, days),
          // candles saved before trade-flow fields existed are downloaded again
          (rows) => rows.every((c) => c.takerBuyBase !== undefined)
        );
        await StorageService.pushCandles(symbol, timeframe, candles);
      }
    }

    if (cryptoConfig.marketData.useFutures) {
      const existing = await StorageService.getSeries<IFuturesMetrics>(pair, "futures-metrics", now - minuteDays * 86400);
      const metrics =
        existing.length && existing[0].time - (now - minuteDays * 86400) <= 86400 && !hasGap(existing, 6 * 3600)
          ? ((await BinanceMarketDataService.fetchFuturesMetrics(pair, existing[existing.length - 1].time + FUTURES_PERIOD_SECONDS)) ?? [])
          : await BinanceMarketDataService.backfillFuturesMetrics(pair, minuteDays);
      await StorageService.pushSeries(pair, "futures-metrics", metrics);

      const funding = (await BinanceMarketDataService.fetchFundingRates(pair, now - hourDays * 86400)) ?? [];
      await StorageService.pushSeries(pair, "funding", funding);
    }

    // futures premium index and Coinbase candles: same rules as candles
    for (const [timeframe, days] of [
      ["minute", minuteDays],
      ["hour", hourDays],
    ] as [CandleTimeframe, number][]) {
      const since = now - days * DAY_SECONDS;
      const rows = await this.refresh(
        await StorageService.getSeries<IPremiumCandle>(pair, PREMIUM_SERIES[timeframe], since),
        since,
        STEP_SECONDS[timeframe],
        (from) => PremiumIndexCollector.fetchRange(pair, timeframe, from),
        () => PremiumIndexCollector.backfill(pair, timeframe, days)
      );
      await StorageService.pushSeries(pair, PREMIUM_SERIES[timeframe], rows);

      const coinbase = await this.refresh(
        await StorageService.getSeries<IMarketCandle>(pair, COINBASE_SERIES[timeframe], since),
        since,
        STEP_SECONDS[timeframe],
        (from) => CoinbaseCollector.fetchRange(pair, timeframe, from),
        () => CoinbaseCollector.backfill(pair, timeframe, days)
      );
      await StorageService.pushSeries(pair, COINBASE_SERIES[timeframe], coinbase);
    }

    const dvol = (await DvolCollector.fetchSince(pair.split("-")[0], now - hourDays * DAY_SECONDS)) ?? [];
    await StorageService.pushSeries(pair, "dvol-1h", dvol);
    await StorageService.pushSeries(MARKET, "stablecoins-1d", (await StablecoinsCollector.fetchAll()) ?? []);
    await StorageService.pushSeries(MARKET, "fear-greed-1d", (await FearGreedCollector.fetchAll()) ?? []);

    this.cache.clear();
  };

  /** Only the tail when stored rows reach back far enough without holes, otherwise the whole history. */
  private async refresh<T extends { time: number }>(
    existing: T[],
    since: number,
    step: number,
    tail: (fromSec: number) => Promise<T[] | null>,
    history: () => Promise<T[]>,
    isComplete: (rows: T[]) => boolean = () => true
  ): Promise<T[]> {
    const complete =
      existing.length > 0 && existing[0].time - since <= DAY_SECONDS && !hasGap(existing, step * 60) && isComplete(existing);
    return complete ? ((await tail(existing[existing.length - 1].time + step)) ?? []) : history();
  }

  public getCurrentPrice = (base: CryptoBase, to: CryptoBase): Promise<number | null> =>
    BinanceMarketDataService.getCurrentPrice(base, to);
}

export default new MarketDataService();
