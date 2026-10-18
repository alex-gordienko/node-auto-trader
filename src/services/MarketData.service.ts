import BinanceMarketDataService from "./BinanceMarketData.service";
// import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import StorageService, { MarketSeries } from "./Local.storage.service";

import cryptoConfig from "../config/crypto.config";
import { CryptoBase, CryptoPairs } from "../types/basic.types";
import {
  CandleTimeframe,
  ICandleSeries,
  IFundingRate,
  IFuturesMetrics,
  IMarketCandle,
  IMarketDataset,
  MarketSymbol,
} from "../types/marketData.types";
import { log, Colors } from "../utils/colored-console";

const STEP_SECONDS: Record<CandleTimeframe, number> = { minute: 60, hour: 3600 };
const CANDLE_SERIES: Record<CandleTimeframe, MarketSeries> = { minute: "1m", hour: "1h" };
const FUTURES_PERIOD_SECONDS = 300;
const FUNDING_INTERVAL_SECONDS = 8 * 3600;

/** True if consecutive rows are further apart than `maxSeconds` (e.g. a download interrupted by a network error). */
const hasGap = (rows: { time: number }[], maxSeconds: number) =>
  rows.some((row, i) => i > 0 && row.time - rows[i - 1].time > maxSeconds);

// what stays in memory between updates: enough for inference, the full history lives in storage
const MEMORY_KEEP_SECONDS: Record<MarketSeries, number> = {
  "1m": 2 * 86400,
  "1h": 30 * 86400,
  "futures-metrics": 3 * 86400, // 24h open interest change needs a day of history
  funding: 7 * 86400,
};

/**
 * Single entry point for market data: keeps Binance datasets up to date incrementally
 * (only missing rows are requested, each request asks for the maximum page size)
 * and assembles datasets for training and inference.
 */
class MarketDataService {
  private cache: Map<string, { time: number }[]> = new Map();

  constructor() {
    log("[*] Initializing Market Data Service", Colors.WHITE);
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
    } else if (now - lastTime >= 2 * step) {
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

  private async syncCandleSeries(symbol: MarketSymbol): Promise<ICandleSeries> {
    return { minute: await this.syncCandles(symbol, "minute"), hour: await this.syncCandles(symbol, "hour") };
  }

  /** Brings every dataset of the pair (candles, reference markets, futures) up to date. */
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
        const since = now - days * 86400;
        const existing = await StorageService.getCandles(symbol, timeframe, since);
        const complete =
          existing.length > 0 &&
          existing[0].time - since <= 86400 &&
          !hasGap(existing, STEP_SECONDS[timeframe] * 60) &&
          existing.every((c) => c.takerBuyBase !== undefined);

        const candles = complete
          ? ((await BinanceMarketDataService.fetchRange(symbol, timeframe, existing[existing.length - 1].time + STEP_SECONDS[timeframe])) ?? [])
          : await BinanceMarketDataService.backfill(symbol, timeframe, days);
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

    this.cache.clear();
  };

  public getCurrentPrice = (base: CryptoBase, to: CryptoBase): Promise<number | null> =>
    BinanceMarketDataService.getCurrentPrice(base, to);
}

export default new MarketDataService();
