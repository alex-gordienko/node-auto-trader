/**
 * Read-only access to the stored Binance candles, aggregated to the trading horizon.
 *
 * This module only consumes the dataset through LocalStorageService; it never writes to it and holds no
 * opinion about how it is collected. Dataset collection belongs to the collectors.
 */
import LocalStorageService from "../services/Local.storage.service";
import { IMarketCandle, MarketSymbol } from "../types/marketData.types";

/** The subset of a candle the backtester needs. Deliberately narrow so tests can build bars by hand. */
export interface IBacktestBar {
  time: number; // bar open, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volumeto: number; // quote volume, used only for liquidity sanity checks
}

export const BAR_SECONDS_5MIN = 300;

/**
 * Aggregate 1-minute candles into bars of `barSeconds`, aligned to epoch multiples of `barSeconds` so the
 * bars match what an exchange would call a 5m candle.
 *
 * Incomplete groups are dropped. A bar built from 3 of its 5 minutes has a close that is not the close of the
 * period, and silently trading on it would be a quiet data bug rather than a visible gap.
 */
export const aggregateBars = (candles: IMarketCandle[], barSeconds: number): IBacktestBar[] => {
  const expected = Math.round(barSeconds / 60);
  const groups = new Map<number, { bar: IBacktestBar; minutes: number }>();

  for (const candle of [...candles].sort((a, b) => a.time - b.time)) {
    const bucket = Math.floor(candle.time / barSeconds) * barSeconds;
    const existing = groups.get(bucket);

    if (!existing) {
      groups.set(bucket, {
        minutes: 1,
        bar: {
          time: bucket,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volumeto: candle.volumeto,
        },
      });
      continue;
    }

    existing.bar.high = Math.max(existing.bar.high, candle.high);
    existing.bar.low = Math.min(existing.bar.low, candle.low);
    existing.bar.close = candle.close;
    existing.bar.volumeto += candle.volumeto;
    existing.minutes += 1;
  }

  return [...groups.values()]
    .filter((group) => group.minutes === expected)
    .map((group) => group.bar)
    .sort((a, b) => a.time - b.time);
};

/** Stored 1-minute candles for `symbol`, aggregated to `barSeconds`. */
export const loadBars = async (
  symbol: MarketSymbol,
  barSeconds = BAR_SECONDS_5MIN,
  sinceSec = 0
): Promise<IBacktestBar[]> => aggregateBars(await LocalStorageService.getCandles(symbol, "minute", sinceSec), barSeconds);

/**
 * Close-to-close returns of consecutive bars, as fractions.
 *
 * Only genuinely consecutive bars contribute: a return computed across a data gap is not a return any
 * strategy could have earned, and including it inflates both the measured edge and the measured volatility.
 */
export const closeToCloseReturns = (bars: IBacktestBar[], barSeconds = BAR_SECONDS_5MIN): number[] => {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i].time - bars[i - 1].time !== barSeconds) continue;
    returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  }
  return returns;
};

export interface IReturnStats {
  count: number;
  meanBps: number;
  meanAbsBps: number;
  medianAbsBps: number;
  stdBps: number;
  /** mean |return| of the largest-|return| bars, keyed by the fraction of bars kept */
  meanAbsBpsOfTopFraction: Record<string, number>;
}

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Descriptive statistics of a return series, in bps. `meanAbsBps` is the input the break-even analysis turns
 * on, and `meanAbsBpsOfTopFraction` bounds how much selective trading could help.
 */
export const returnStats = (returns: number[], topFractions = [0.5, 0.25, 0.1]): IReturnStats => {
  const absSorted = returns.map(Math.abs).sort((a, b) => a - b);
  const avg = mean(returns);
  const variance = mean(returns.map((r) => (r - avg) ** 2));

  const meanAbsBpsOfTopFraction: Record<string, number> = {};
  for (const fraction of topFractions) {
    const kept = absSorted.slice(Math.floor((1 - fraction) * absSorted.length));
    meanAbsBpsOfTopFraction[fraction.toString()] = mean(kept) * 1e4;
  }

  return {
    count: returns.length,
    meanBps: avg * 1e4,
    meanAbsBps: mean(absSorted) * 1e4,
    medianAbsBps: absSorted[Math.floor(0.5 * (absSorted.length - 1))] * 1e4,
    stdBps: Math.sqrt(variance) * 1e4,
    meanAbsBpsOfTopFraction,
  };
};
