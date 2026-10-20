import cryptoConfig from "../config/crypto.config";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";
import { IFundingRate, IFuturesMetrics, IMarketCandle, ISeriesPoint } from "../types/marketData.types";
import {
  buildCandleFeatures,
  INDICATOR_WARMUP,
  IOHLCV,
  IPremiumPoint,
  MARKET_FEATURE_COUNT,
  PREMIUM_FEATURE_COUNT,
  REFERENCE_FEATURE_COUNT,
  sma,
} from "./technical-indicators";

// returns are forecast as log-returns in percent, so the loss is not vanishingly small
export const FORECAST_TARGET_SCALE = 100;
// per candle: market + order flow features, then features against each reference market (BTC, ...)
export const CANDLE_FEATURE_COUNT =
  MARKET_FEATURE_COUNT + REFERENCE_FEATURE_COUNT * cryptoConfig.marketData.referencePairs.length + PREMIUM_FEATURE_COUNT;
// time features: hour-of-day and day-of-week as sin/cos pairs
export const TIME_FEATURE_COUNT = 4;
// futures: availability flag, open interest change 1h / 24h, three long/short ratios, taker buy/sell ratio, funding
export const FUTURES_FEATURE_COUNT = 8;
// one vector per sample describing "now": time + futures market state
// DVOL level and 24h change, stablecoin supply 7d / 30d change, fear & greed level and 7d change
export const EXTERNAL_FEATURE_COUNT = 6;
// weekend, US session, volatility regime, 7d / 30d trend, distance to a round price, to 24h / 7d high and low
export const REGIME_FEATURE_COUNT = 10;
export const CONTEXT_FEATURE_COUNT = TIME_FEATURE_COUNT + FUTURES_FEATURE_COUNT + EXTERNAL_FEATURE_COUNT + REGIME_FEATURE_COUNT;
// daily indexes are published with a delay: a value stamped D is used only from D + 2 days
const DAILY_AVAILABILITY_DELAY_SECONDS = 2 * 86400;
// futures rows older than this are treated as missing (data comes every 5 minutes)
const MAX_FUTURES_LAG_SECONDS = 30 * 60;
// A futures row stamped T describes the period [T, T+5m): taker ratio and long/short ratios correlate with the
// price move AFTER T (checked on archive data). So a row only becomes known at T + 5m — using it earlier
// leaks the future into the model.
const FUTURES_AVAILABILITY_DELAY_SECONDS = 5 * 60;
const MAX_FUNDING_LAG_SECONDS = 9 * 3600;
// hourly data older than this is considered stale and not used
const MAX_HOURLY_LAG_SECONDS = 3 * 3600;

/**
 * Forecast outputs, in this order:
 * - return at each horizon (scaled log-return);
 * - max / min return within the longest horizon (from candle highs / lows) — the best sell / buy price;
 * - time to that max / min as a fraction of the longest horizon (0..1).
 */
export interface IForecastLayout {
  horizons: number[];
  pathMinutes: number;
  mainIndex: number;
  maxIndex: number;
  minIndex: number;
  timeToMaxIndex: number;
  timeToMinIndex: number;
  names: string[];
  count: number;
}

export const forecastLayout = (horizons: number[], mainHorizon: number): IForecastLayout => {
  const r = horizons.length;
  return {
    horizons,
    pathMinutes: horizons[horizons.length - 1],
    mainIndex: horizons.indexOf(mainHorizon),
    maxIndex: r,
    minIndex: r + 1,
    timeToMaxIndex: r + 2,
    timeToMinIndex: r + 3,
    names: [...horizons.map((h) => `return_${h}m`), "max_return", "min_return", "time_to_max", "time_to_min"],
    count: r + 4,
  };
};

export const FORECAST_LAYOUT = forecastLayout(cryptoConfig.forecast.horizons, cryptoConfig.forecast.horizonMinutes);

// bump when the meaning of saved forecast models changes, so old ones are retrained instead of misused
export const FORECAST_MODEL_VERSION = 4;

export interface IForecastOutputMetrics {
  name: string;
  mae: number;
  naiveMae: number;
  mse: number;
  naiveMse: number;
  ic: number; // correlation between forecast and what happened
  icT: number; // t-statistic of ic, corrected for overlapping horizons
  reliable: boolean;
  live?: { count: number; mse: number; naiveMse: number; ic: number };
}

/** Per-feature mean / std of the training data; inputs are standardized with it. */
export interface IFeatureScaler {
  minuteMean: number[];
  minuteStd: number[];
  hourMean: number[];
  hourStd: number[];
  contextMean: number[];
  contextStd: number[];
}

/** final forecast = a + b * (model output converted back to target units), fitted on held-out data */
export interface IOutputCalibration {
  a: number;
  b: number;
}

export interface IForecastMetrics {
  version: number;
  trainedAt: number;
  samples: number;
  evalSamples: number;
  directionAccuracy: number; // main horizon on the untouched evaluation part
  // baseline per output: 0 for returns ("price will not change"), training mean for the rest
  naiveValues: number[];
  scaler: IFeatureScaler;
  // targets are standardized per output; return outputs keep mean 0, so no market drift is learned
  targetMean: number[];
  targetStd: number[];
  calibration: IOutputCalibration[];
  outputs: IForecastOutputMetrics[];
  beatsNaive: boolean; // main horizon is reliable
}

/** A trading decision made in production, with the price move that actually followed it. */
export interface ILiveDecision {
  candleIndex: number;
  command: string;
  position: number; // what the bot held when deciding
  realizedReturn: number; // fraction until the next decision
}

export interface ILiveFeedback {
  // per-output live quality of saved forecasts vs. what actually happened
  outputs: { count: number; mse: number[]; naiveMse: number[]; ic: number[] } | null;
  directionAccuracy: number | null;
  // candle indexes whose live forecast error was above the median: these are oversampled in retraining
  hardSampleIndexes: Set<number>;
  decisions: ILiveDecision[];
}

export interface IHourlyContext {
  times: number[];
  features: number[][];
  candles: IOHLCV[];
  // rolling statistics per hourly candle (inclusive), for the market regime features
  stats: {
    sma168: number[];
    sma720: number[];
    std24: number[];
    std168: number[];
    max24: number[];
    min24: number[];
    max168: number[];
    min168: number[];
  };
}

/** DVOL, stablecoin supply and fear & greed as sorted arrays for "last value before t" lookups. */
export interface IExternalContext {
  dvolTimes: number[];
  dvol: number[];
  stablecoinTimes: number[];
  stablecoins: number[];
  fearGreedTimes: number[];
  fearGreed: number[];
}

/** Everything describing "now" besides candles: futures market state and external indexes. */
export interface IMarketContext {
  futures: IFuturesContext;
  external: IExternalContext;
}

/** Futures metrics and funding as parallel arrays for fast "last value before time t" lookups. */
export interface IFuturesContext {
  times: number[];
  metrics: IFuturesMetrics[];
  fundingTimes: number[];
  fundingRates: number[];
}

export interface IForecastInput {
  minute: number[][];
  hour: number[][];
  context: number[];
}

export const toOHLCV = (data: IMarketCandle[]): IOHLCV[] =>
  data
    .map((d) => ({
      time: d.time,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volumefrom ?? 0,
      trades: d.trades,
      takerBuyVolume: d.takerBuyBase,
    }))
    .sort((a, b) => a.time - b.time);

/** Index of the last element of sorted `times` that is <= `time`, or -1. */
export const lastIndexAtOrBefore = (times: number[], time: number): number => {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
};

export const argmax = (values: number[]): number => {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[best]) {
      best = i;
    }
  }
  return best;
};

/** Prefix count of gaps in candle data, so "is there a gap between a and b" is O(1). */
export const buildGapChecker = (candles: IOHLCV[], step = 60) => {
  const prefix = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    prefix[i] = prefix[i - 1] + (candles[i].time - candles[i - 1].time !== step ? 1 : 0);
  }
  return (from: number, to: number) => prefix[Math.min(to, candles.length - 1)] - prefix[Math.max(from, 0)] > 0;
};

/** Window of features ending at index t (inclusive). */
export const featureWindow = (features: number[][], t: number, windowSize: number): number[][] =>
  features.slice(t - windowSize + 1, t + 1);

export const timeFeatures = (unixSeconds: number): number[] => {
  const date = new Date(unixSeconds * 1000);
  const dayPhase = ((date.getUTCHours() * 60 + date.getUTCMinutes()) / 1440) * 2 * Math.PI;
  const weekPhase = ((date.getUTCDay() + date.getUTCHours() / 24) / 7) * 2 * Math.PI;
  return [Math.sin(dayPhase), Math.cos(dayPhase), Math.sin(weekPhase), Math.cos(weekPhase)];
};

const rolling = (values: number[], window: number, reduce: (slice: number[]) => number): number[] =>
  values.map((_, i) => reduce(values.slice(Math.max(0, i - window + 1), i + 1)));

const stdOf = (slice: number[]) => {
  const m = slice.reduce((a, b) => a + b, 0) / Math.max(slice.length, 1);
  return Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(slice.length - 1, 1));
};

export const buildHourlyContext = (hourly: IOHLCV[], references: IOHLCV[][], premium: IPremiumPoint[] = []): IHourlyContext => {
  const closes = hourly.map((c) => c.close);
  const returns = closes.map((c, i) => (i > 0 && closes[i - 1] > 0 ? Math.log(c / closes[i - 1]) : 0));
  return {
    times: hourly.map((c) => c.time),
    features: buildCandleFeatures(hourly, references, 3600, premium),
    candles: hourly,
    stats: {
      sma168: sma(closes, 168),
      sma720: sma(closes, 720),
      std24: rolling(returns, 24, stdOf),
      std168: rolling(returns, 168, stdOf),
      max24: rolling(hourly.map((c) => c.high), 24, (s) => Math.max(...s)),
      min24: rolling(hourly.map((c) => c.low), 24, (s) => Math.min(...s)),
      max168: rolling(hourly.map((c) => c.high), 168, (s) => Math.max(...s)),
      min168: rolling(hourly.map((c) => c.low), 168, (s) => Math.min(...s)),
    },
  };
};

export const buildExternalContext = (dvol: ISeriesPoint[], stablecoins: ISeriesPoint[], fearGreed: ISeriesPoint[]): IExternalContext => {
  const sorted = (points: ISeriesPoint[]) => [...points].sort((a, b) => a.time - b.time);
  const d = sorted(dvol);
  const st = sorted(stablecoins);
  const fg = sorted(fearGreed);
  return {
    dvolTimes: d.map((p) => p.time),
    dvol: d.map((p) => p.value),
    stablecoinTimes: st.map((p) => p.time),
    stablecoins: st.map((p) => p.value),
    fearGreedTimes: fg.map((p) => p.time),
    fearGreed: fg.map((p) => p.value),
  };
};

/** Value of a sorted series known at `knownAt`, and its value `lagSeconds` earlier; null if missing or stale. */
const valueWithLag = (times: number[], values: number[], knownAt: number, lagSeconds: number, maxAgeSeconds: number) => {
  const i = lastIndexAtOrBefore(times, knownAt);
  if (i < 0 || knownAt - times[i] > maxAgeSeconds) return null;
  const j = lastIndexAtOrBefore(times, times[i] - lagSeconds);
  const previous = j >= 0 && times[i] - lagSeconds - times[j] <= maxAgeSeconds ? values[j] : null;
  return { value: values[i], previous };
};

const safeLogRatio = (a: number, b: number | null) => (b && a > 0 && b > 0 ? Math.log(a / b) : 0);

/**
 * External market state known at `time`: DVOL (hourly, a point stamped T is final after T + 1h),
 * stablecoin supply and fear & greed (daily, used only from D + 2 days). Zeros for missing data and
 * for feature groups switched off in config.features.
 */
export const externalFeaturesAt = (ctx: IExternalContext, time: number): number[] => {
  const features = cryptoConfig.features;
  const result = new Array(EXTERNAL_FEATURE_COUNT).fill(0);

  const dvol = features.dvol ? valueWithLag(ctx.dvolTimes, ctx.dvol, time - 3600, 86400, 3 * 3600) : null;
  if (dvol) {
    result[0] = dvol.value / 100;
    result[1] = safeLogRatio(dvol.value, dvol.previous);
  }

  const dailyKnownAt = time - DAILY_AVAILABILITY_DELAY_SECONDS;
  const stable7 = features.stablecoins ? valueWithLag(ctx.stablecoinTimes, ctx.stablecoins, dailyKnownAt, 7 * 86400, 3 * 86400) : null;
  const stable30 = features.stablecoins ? valueWithLag(ctx.stablecoinTimes, ctx.stablecoins, dailyKnownAt, 30 * 86400, 3 * 86400) : null;
  if (stable7) result[2] = safeLogRatio(stable7.value, stable7.previous) * 100;
  if (stable30) result[3] = safeLogRatio(stable30.value, stable30.previous) * 100;

  const fearGreed = features.fearGreed ? valueWithLag(ctx.fearGreedTimes, ctx.fearGreed, dailyKnownAt, 7 * 86400, 3 * 86400) : null;
  if (fearGreed) {
    result[4] = fearGreed.value / 100 - 0.5;
    result[5] = fearGreed.previous !== null ? (fearGreed.value - fearGreed.previous) / 100 : 0;
  }
  return result;
};

/**
 * Market regime at `closeTime` for the current `price`: calendar (weekend, US session), volatility of the last
 * day vs. the last week, trend vs. 7- and 30-day averages, distance to the nearest round price (×100) and to
 * the 24h / 7d high and low. Uses only hourly candles that have closed.
 */
export const regimeFeaturesAt = (hourly: IHourlyContext, closeTime: number, price: number): number[] => {
  const result = new Array(REGIME_FEATURE_COUNT).fill(0);
  if (!cryptoConfig.features.regime || !(price > 0)) return result;

  const date = new Date(closeTime * 1000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  result[0] = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1 : 0;
  // US stock market hours (13:30–20:00 UTC, without daylight-saving shifts)
  result[1] = minutes >= 13 * 60 + 30 && minutes < 20 * 60 ? 1 : 0;
  const round = Math.round(price / 100) * 100;
  result[5] = ((price - round) / price) * 100;

  const i = lastIndexAtOrBefore(hourly.times, closeTime - 3600);
  if (i < 0 || closeTime - 3600 - hourly.times[i] > MAX_HOURLY_LAG_SECONDS) return result;
  const s = hourly.stats;
  result[2] = s.std168[i] > 0 && s.std24[i] > 0 ? Math.log(s.std24[i] / s.std168[i]) : 0;
  result[3] = safeLogRatio(price, s.sma168[i]);
  result[4] = safeLogRatio(price, s.sma720[i]);
  result[6] = safeLogRatio(price, s.max24[i]);
  result[7] = safeLogRatio(price, s.min24[i]);
  result[8] = safeLogRatio(price, s.max168[i]);
  result[9] = safeLogRatio(price, s.min168[i]);
  return result;
};

export const buildFuturesContext = (metrics: IFuturesMetrics[], funding: IFundingRate[]): IFuturesContext => {
  const sortedMetrics = [...metrics].sort((a, b) => a.time - b.time);
  const sortedFunding = [...funding].sort((a, b) => a.time - b.time);
  return {
    times: sortedMetrics.map((m) => m.time),
    metrics: sortedMetrics,
    fundingTimes: sortedFunding.map((f) => f.time),
    fundingRates: sortedFunding.map((f) => f.rate),
  };
};

/**
 * Futures market state known at `time` (no look-ahead): positioning of traders, open interest dynamics
 * and funding. All zeros with flag 0 when data is missing or stale.
 */
export const futuresFeaturesAt = (ctx: IFuturesContext, time: number): number[] => {
  const empty = new Array(FUTURES_FEATURE_COUNT).fill(0);
  const knownAt = time - FUTURES_AVAILABILITY_DELAY_SECONDS;
  const i = lastIndexAtOrBefore(ctx.times, knownAt);
  if (i < 0 || knownAt - ctx.times[i] > MAX_FUTURES_LAG_SECONDS) return empty;

  const m = ctx.metrics[i];
  const safeLog = (v: number) => (v > 0 ? Math.log(v) : 0);
  const oiChange = (seconds: number) => {
    const j = lastIndexAtOrBefore(ctx.times, ctx.times[i] - seconds);
    if (j < 0 || ctx.times[i] - seconds - ctx.times[j] > MAX_FUTURES_LAG_SECONDS) return 0;
    // a few archive rows have zero open interest
    if (!(m.openInterest > 0) || !(ctx.metrics[j].openInterest > 0)) return 0;
    return Math.log(m.openInterest / ctx.metrics[j].openInterest) * 100;
  };
  const f = lastIndexAtOrBefore(ctx.fundingTimes, time);
  const funding = f >= 0 && time - ctx.fundingTimes[f] <= MAX_FUNDING_LAG_SECONDS ? ctx.fundingRates[f] * 1e4 : 0;

  return [
    1,
    oiChange(3600),
    oiChange(86400),
    safeLog(m.longShortAccountRatio),
    safeLog(m.topTraderAccountRatio),
    safeLog(m.topTraderPositionRatio),
    safeLog(m.takerBuySellRatio),
    funding,
  ];
};

/** Last `size` hourly feature rows that were already closed at `closeTime`, or null if unavailable / stale / gapped. */
export const hourlyWindowAt = (ctx: IHourlyContext, closeTime: number, size: number): number[][] | null => {
  // last hourly candle already closed at closeTime: time + 3600 <= closeTime
  const found = lastIndexAtOrBefore(ctx.times, closeTime - 3600);

  if (found < INDICATOR_WARMUP + size - 1) return null;
  if (closeTime - (ctx.times[found] + 3600) > MAX_HOURLY_LAG_SECONDS) return null;
  if (ctx.times[found] - ctx.times[found - size + 1] !== (size - 1) * 3600) return null;

  return featureWindow(ctx.features, found, size);
};

/** Model input for the minute candle at index t, or null if there is not enough history. */
export const forecastInputAt = (
  t: number,
  candles: IOHLCV[],
  features: number[][],
  hourly: IHourlyContext,
  context: IMarketContext,
  windowSize: number,
  hourWindowSize: number
): IForecastInput | null => {
  if (t < Math.max(INDICATOR_WARMUP, windowSize - 1)) return null;
  const closeTime = candles[t].time + 60;
  const hour = hourlyWindowAt(hourly, closeTime, hourWindowSize);
  if (!hour) return null;
  return {
    minute: featureWindow(features, t, windowSize),
    hour,
    context: [
      ...timeFeatures(closeTime),
      ...futuresFeaturesAt(context.futures, closeTime),
      ...externalFeaturesAt(context.external, closeTime),
      ...regimeFeaturesAt(hourly, closeTime, candles[t].close),
    ],
  };
};

/** What actually happened after candle t, in the same layout as the forecast outputs. */
export const forecastTargets = (candles: IOHLCV[], t: number, layout: IForecastLayout): number[] => {
  const close = candles[t].close;
  const targets = layout.horizons.map((h) => Math.log(candles[t + h].close / close) * FORECAST_TARGET_SCALE);

  let maxHigh = -Infinity;
  let minLow = Infinity;
  let maxAt = 1;
  let minAt = 1;
  for (let k = 1; k <= layout.pathMinutes; k++) {
    const c = candles[t + k];
    if (c.high > maxHigh) {
      maxHigh = c.high;
      maxAt = k;
    }
    if (c.low < minLow) {
      minLow = c.low;
      minAt = k;
    }
  }

  targets.push(
    Math.log(maxHigh / close) * FORECAST_TARGET_SCALE,
    Math.log(minLow / close) * FORECAST_TARGET_SCALE,
    maxAt / layout.pathMinutes,
    minAt / layout.pathMinutes
  );
  return targets;
};

/**
 * Supervised samples for the forecast. Windows crossing a gap in minute data are skipped,
 * since the dataset is stitched from separate API fetches.
 */
export const buildForecastSamples = (
  candles: IOHLCV[],
  features: number[][],
  hourly: IHourlyContext,
  context: IMarketContext,
  windowSize: number,
  hourWindowSize: number,
  layout: IForecastLayout,
  // neighbouring minutes give almost identical windows; a stride covers more history for the same memory
  stride = 1
): { indexes: number[]; inputs: IForecastInput[]; ys: number[][] } => {
  const hasGap = buildGapChecker(candles);
  const indexes: number[] = [];
  const inputs: IForecastInput[] = [];
  const ys: number[][] = [];

  for (let t = 0; t + layout.pathMinutes < candles.length; t += stride) {
    if (hasGap(t - INDICATOR_WARMUP, t + layout.pathMinutes)) continue;
    const input = forecastInputAt(t, candles, features, hourly, context, windowSize, hourWindowSize);
    if (!input) continue;
    indexes.push(t);
    inputs.push(input);
    ys.push(forecastTargets(candles, t, layout));
  }

  return { indexes, inputs, ys };
};

/** Baseline that a useful forecast must beat: 0 for returns, the training mean for extremes and timing. */
export const naiveForecastValues = (ys: number[][], layout: IForecastLayout): number[] =>
  Array.from({ length: layout.count }, (_, j) =>
    j < layout.horizons.length ? 0 : ys.reduce((sum, y) => sum + y[j], 0) / Math.max(ys.length, 1)
  );

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);

const std = (values: number[], m = mean(values)) =>
  Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / Math.max(values.length - 1, 1)) || 1;

export const correlation = (x: number[], y: number[]): number => {
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) ** 2;
    vy += (y[i] - my) ** 2;
  }
  return vx && vy ? cov / Math.sqrt(vx * vy) : 0;
};

/**
 * t-statistic of a correlation. Targets of neighbouring samples overlap (a 60m return shares 59 minutes
 * with the next one), so only every `overlap`-th sample counts as independent.
 */
export const correlationT = (ic: number, n: number, overlap: number): number => {
  const nEff = n / Math.max(1, overlap);
  return nEff > 3 && Math.abs(ic) < 1 ? (ic * Math.sqrt(nEff - 2)) / Math.sqrt(1 - ic * ic) : 0;
};

/** Number of samples whose targets overlap for output j, given the sampling stride. */
export const outputOverlap = (layout: IForecastLayout, j: number, stride: number): number =>
  (j < layout.horizons.length ? layout.horizons[j] : layout.pathMinutes) / Math.max(stride, 1);

export const fitFeatureScaler = (inputs: IForecastInput[]): IFeatureScaler => {
  // the last row of each window is enough: windows overlap, so all rows come from the same distribution
  const column = (rows: number[][], j: number) => rows.map((r) => r[j]);
  const minuteRows = inputs.map((i) => i.minute[i.minute.length - 1]);
  const hourRows = inputs.map((i) => i.hour[i.hour.length - 1]);
  const stats = (rows: number[][]) => {
    const means = rows[0].map((_, j) => mean(column(rows, j)));
    return { means, stds: means.map((m, j) => std(column(rows, j), m)) };
  };
  const minute = stats(minuteRows);
  const hour = stats(hourRows);
  const context = stats(inputs.map((i) => i.context));
  return {
    minuteMean: minute.means,
    minuteStd: minute.stds,
    hourMean: hour.means,
    hourStd: hour.stds,
    contextMean: context.means,
    contextStd: context.stds,
  };
};

export const fitTargetScaler = (ys: number[][], layout: IForecastLayout) => {
  const targetMean = Array.from({ length: layout.count }, (_, j) =>
    // returns are centred on 0: a trend of the training period must not become a permanent forecast
    j < layout.horizons.length ? 0 : mean(ys.map((y) => y[j]))
  );
  const targetStd = targetMean.map((m, j) => std(ys.map((y) => y[j]), m));
  return { targetMean, targetStd };
};

/** Least squares y ≈ a + b·x; returns get a = 0 (no drift) and b is never negative. */
export const fitCalibration = (x: number[], y: number[], zeroIntercept: boolean): IOutputCalibration => {
  if (zeroIntercept) {
    const sxx = x.reduce((sum, v) => sum + v * v, 0);
    const sxy = x.reduce((sum, v, i) => sum + v * y[i], 0);
    return { a: 0, b: sxx ? Math.max(0, sxy / sxx) : 0 };
  }
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const b = sxx ? Math.max(0, sxy / sxx) : 0;
  return { a: my - b * mx, b };
};

export const computeOutputErrors = (predicted: number[][], actual: number[][], naiveValues: number[], mainIndex: number) => {
  const count = naiveValues.length;
  const mae = new Array(count).fill(0);
  const naiveMae = new Array(count).fill(0);
  const mse = new Array(count).fill(0);
  const naiveMse = new Array(count).fill(0);
  let rightDirection = 0;

  for (let i = 0; i < actual.length; i++) {
    for (let j = 0; j < count; j++) {
      const err = predicted[i][j] - actual[i][j];
      const naiveErr = naiveValues[j] - actual[i][j];
      mae[j] += Math.abs(err);
      naiveMae[j] += Math.abs(naiveErr);
      mse[j] += err * err;
      naiveMse[j] += naiveErr * naiveErr;
    }
    if (Math.sign(predicted[i][mainIndex]) === Math.sign(actual[i][mainIndex])) rightDirection++;
  }

  const n = Math.max(actual.length, 1);
  const ic = Array.from({ length: count }, (_, j) =>
    correlation(
      predicted.map((p) => p[j]),
      actual.map((a) => a[j])
    )
  );
  return {
    mae: mae.map((v) => v / n),
    naiveMae: naiveMae.map((v) => v / n),
    mse: mse.map((v) => v / n),
    naiveMse: naiveMse.map((v) => v / n),
    ic,
    directionAccuracy: rightDirection / n,
  };
};

/**
 * Self-correction input: compares saved production predictions with prices that actually happened.
 * Returns live accuracy per forecast output, the hardest samples to retrain on, and the outcome of each DQN decision.
 */
export const evaluateLivePredictions = (
  predictions: ITensorflowPrediction[],
  candles: IOHLCV[],
  layout: IForecastLayout,
  naiveValues?: number[],
  // DQN decisions are judged by the price move until the next decision
  decisionMinutes = layout.horizons[layout.mainIndex]
): ILiveFeedback => {
  const indexByTime = new Map<number, number>();
  candles.forEach((c, i) => indexByTime.set(c.time, i));
  const hasGap = buildGapChecker(candles);
  const mainHorizon = layout.horizons[layout.mainIndex];

  const predicted: number[][] = [];
  const actual: number[][] = [];
  const forecastIndexes: number[] = [];
  const decisions: ILiveDecision[] = [];

  for (const p of predictions) {
    // prediction is anchored to the last closed candle: target time = candle open + 1 min + main horizon
    const t = indexByTime.get(p.lstm_timestamp / 1000 - 60 - mainHorizon * 60);
    if (t === undefined) continue;

    if (t + decisionMinutes < candles.length && !hasGap(t, t + decisionMinutes)) {
      const realizedReturn = candles[t + decisionMinutes].close / candles[t].close - 1;
      decisions.push({ candleIndex: t, command: p.predicted_command, position: p.position ?? 0, realizedReturn });
    }

    // only records made with the current output layout can be judged
    if (p.forecast_raw?.length === layout.count && t + layout.pathMinutes < candles.length && !hasGap(t, t + layout.pathMinutes)) {
      predicted.push(p.forecast_raw);
      actual.push(forecastTargets(candles, t, layout));
      forecastIndexes.push(t);
    }
  }

  const hardSampleIndexes = new Set<number>();
  let outputs: ILiveFeedback["outputs"] = null;
  let directionAccuracy: number | null = null;

  if (actual.length) {
    const errors = computeOutputErrors(predicted, actual, naiveValues ?? naiveForecastValues(actual, layout), layout.mainIndex);
    outputs = { count: actual.length, mse: errors.mse, naiveMse: errors.naiveMse, ic: errors.ic };
    directionAccuracy = errors.directionAccuracy;

    // "hard" = total error over all return-like outputs above the median
    const totalError = actual.map((a, i) =>
      a.slice(0, layout.minIndex + 1).reduce((sum, v, j) => sum + Math.abs(v - predicted[i][j]), 0)
    );
    const median = [...totalError].sort((a, b) => a - b)[Math.floor(totalError.length / 2)];
    totalError.forEach((e, i) => e > median && hardSampleIndexes.add(forecastIndexes[i]));
  }

  return { outputs, directionAccuracy, hardSampleIndexes, decisions };
};

/** Column mean / std of feature rows, for standardizing the DQN state. */
export interface IColumnScaler {
  mean: number[];
  std: number[];
}

export const fitColumnScaler = (rows: number[][]): IColumnScaler => {
  const columns = rows[0]?.length ?? 0;
  const meanValues = Array.from({ length: columns }, (_, j) => mean(rows.map((r) => r[j])));
  return { mean: meanValues, std: meanValues.map((m, j) => std(rows.map((r) => r[j]), m)) };
};

/** Standardized copy of the rows, clipped to ±5 so a single outlier cannot dominate. */
export const applyColumnScaler = (rows: number[][], scaler: IColumnScaler): number[][] =>
  rows.map((row) => row.map((v, j) => Math.max(-5, Math.min(5, (v - scaler.mean[j]) / scaler.std[j]))));
