export interface IOHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
  takerBuyVolume?: number; // base volume bought by market orders
}

export interface IIndicatorSeries {
  sma5: number[];
  sma10: number[];
  sma20: number[];
  ema12: number[];
  ema26: number[];
  rsi14: number[];
  macd: number[];
  macdSignal: number[];
  macdHist: number[];
  bbUpper: number[];
  bbMiddle: number[];
  bbLower: number[];
  atr14: number[];
  stochK: number[];
  stochD: number[];
  volumeSma20: number[];
}

const safeDiv = (num: number, den: number, fallback = 0): number => {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return fallback;
  }
  return num / den;
};

export const sma = (values: number[], period: number): number[] => {
  const out = new Array(values.length).fill(0);
  let windowSum = 0;

  for (let i = 0; i < values.length; i++) {
    windowSum += values[i];
    if (i >= period) {
      windowSum -= values[i - period];
    }
    if (i >= period - 1) {
      out[i] = windowSum / period;
    }
  }

  return out;
};

export const ema = (values: number[], period: number): number[] => {
  const out = new Array(values.length).fill(0);
  if (values.length === 0) {
    return out;
  }

  const k = 2 / (period + 1);
  out[0] = values[0];

  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }

  return out;
};

export const rsi = (closes: number[], period = 14): number[] => {
  const out = new Array(closes.length).fill(50);
  if (closes.length <= period) {
    return out;
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) {
      avgGain += change;
    } else {
      avgLoss -= change;
    }
  }

  avgGain /= period;
  avgLoss /= period;
  out[period] = 100 - 100 / (1 + safeDiv(avgGain, avgLoss, 0));

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = 100 - 100 / (1 + safeDiv(avgGain, avgLoss, 0));
  }

  return out;
};

export const standardDeviation = (values: number[], period: number, means: number[]): number[] => {
  const out = new Array(values.length).fill(0);

  for (let i = period - 1; i < values.length; i++) {
    const mean = means[i];
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - mean;
      sumSq += diff * diff;
    }
    out[i] = Math.sqrt(sumSq / period);
  }

  return out;
};

export const atr = (candles: IOHLCV[], period = 14): number[] => {
  const tr = new Array(candles.length).fill(0);

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
      continue;
    }
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }

  return sma(tr, period);
};

export const stochastic = (
  candles: IOHLCV[],
  kPeriod = 14,
  dPeriod = 3
): { k: number[]; d: number[] } => {
  const k = new Array(candles.length).fill(50);

  for (let i = kPeriod - 1; i < candles.length; i++) {
    let lowest = candles[i].low;
    let highest = candles[i].high;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      lowest = Math.min(lowest, candles[j].low);
      highest = Math.max(highest, candles[j].high);
    }
    k[i] = safeDiv(candles[i].close - lowest, highest - lowest, 0.5) * 100;
  }

  return { k, d: sma(k, dPeriod) };
};

export const computeIndicators = (candles: IOHLCV[]): IIndicatorSeries => {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const sma5 = sma(closes, 5);
  const sma10 = sma(closes, 10);
  const sma20 = sma(closes, 20);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const rsi14 = rsi(closes, 14);

  const macd = ema12.map((value, i) => value - ema26[i]);
  const macdSignal = ema(macd, 9);
  const macdHist = macd.map((value, i) => value - macdSignal[i]);

  const bbStd = standardDeviation(closes, 20, sma20);
  const bbMiddle = sma20;
  const bbUpper = sma20.map((mid, i) => mid + 2 * bbStd[i]);
  const bbLower = sma20.map((mid, i) => mid - 2 * bbStd[i]);

  const { k: stochK, d: stochD } = stochastic(candles, 14, 3);

  return {
    sma5,
    sma10,
    sma20,
    ema12,
    ema26,
    rsi14,
    macd,
    macdSignal,
    macdHist,
    bbUpper,
    bbMiddle,
    bbLower,
    atr14: atr(candles, 14),
    stochK,
    stochD,
    volumeSma20: sma(volumes, 20),
  };
};

/** Scale-free market features: 17 from OHLCV indicators + 3 from order flow. */
export const MARKET_FEATURE_COUNT = 20;
export const INDICATOR_WARMUP = 40;
/** Per reference market (e.g. BTC): its 1-bar and 5-bar return, our 5-bar return relative to it, its order flow. */
export const REFERENCE_FEATURE_COUNT = 4;

/** Taker buy share minus 0.5: > 0 when aggressive buyers dominate; 0 when the data is not available. */
const takerImbalance = (candle: IOHLCV): number =>
  candle.takerBuyVolume !== undefined && candle.volume > 0 ? candle.takerBuyVolume / candle.volume - 0.5 : 0;

export const buildMarketFeatures = (candles: IOHLCV[]): number[][] => {
  const indicators = computeIndicators(candles);
  const features: number[][] = [];
  const imbalance = candles.map(takerImbalance);
  const imbalance5 = sma(imbalance, 5);
  const trades = candles.map((c) => c.trades ?? 0);
  const tradesSma20 = sma(trades, 20);

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : candle.close;
    const ret = safeDiv(candle.close - prevClose, prevClose);
    const hlRange = safeDiv(candle.high - candle.low, candle.close);
    const body = safeDiv(candle.close - candle.open, candle.open);
    const volRatio = safeDiv(candle.volume, indicators.volumeSma20[i], 1);
    const bbWidth = indicators.bbUpper[i] - indicators.bbLower[i];
    const bbPct = safeDiv(candle.close - indicators.bbLower[i], bbWidth, 0.5);

    features.push([
      ret,
      hlRange,
      body,
      Math.min(volRatio, 5) / 5,
      safeDiv(candle.close, indicators.sma5[i]) - 1,
      safeDiv(candle.close, indicators.sma10[i]) - 1,
      safeDiv(candle.close, indicators.sma20[i]) - 1,
      safeDiv(candle.close, indicators.ema12[i]) - 1,
      safeDiv(candle.close, indicators.ema26[i]) - 1,
      indicators.rsi14[i] / 100,
      safeDiv(indicators.macd[i], candle.close),
      safeDiv(indicators.macdSignal[i], candle.close),
      safeDiv(indicators.macdHist[i], candle.close),
      Math.min(Math.max(bbPct, 0), 1),
      safeDiv(indicators.atr14[i], candle.close),
      indicators.stochK[i] / 100,
      indicators.stochD[i] / 100,
      // order flow: who is aggressive now and over the last 5 bars, and how busy the market is
      imbalance[i],
      imbalance5[i],
      candle.trades !== undefined ? Math.log((trades[i] + 1) / (tradesSma20[i] + 1)) : 0,
    ]);
  }

  return features;
};

/**
 * Features of `candles` relative to a reference market aligned by time (bars of the same size).
 * Missing reference bars give zeros, so a gap in reference data never shifts the alignment.
 */
export const buildReferenceFeatures = (candles: IOHLCV[], reference: IOHLCV[], step: number): number[][] => {
  const byTime = new Map<number, IOHLCV>();
  reference.forEach((c) => byTime.set(c.time, c));
  const logReturn = (to?: IOHLCV, from?: IOHLCV) => (to && from && from.close > 0 ? Math.log(to.close / from.close) : 0);

  return candles.map((candle, i) => {
    const ref = byTime.get(candle.time);
    if (!ref) return new Array(REFERENCE_FEATURE_COUNT).fill(0);
    const ref5 = logReturn(ref, byTime.get(candle.time - 5 * step));
    const own5 = i >= 5 ? logReturn(candle, candles[i - 5]) : 0;
    return [logReturn(ref, byTime.get(candle.time - step)), ref5, own5 - ref5, takerImbalance(ref)];
  });
};

/** Market features followed by features against every reference market. */
/** Futures premium per candle: current value and its average over `window` bars, in basis points. */
export const PREMIUM_FEATURE_COUNT = 2;

/** A point of the premium series aligned with a candle (same open time). */
export interface IPremiumPoint {
  time: number;
  close: number;
}

export const buildPremiumFeatures = (candles: IOHLCV[], premium: IPremiumPoint[], window: number): number[][] => {
  const byTime = new Map<number, number>();
  premium.forEach((p) => byTime.set(p.time, p.close * 1e4));
  const values = candles.map((c) => byTime.get(c.time));
  const recent: number[] = [];
  return values.map((value) => {
    if (value === undefined) return new Array(PREMIUM_FEATURE_COUNT).fill(0);
    recent.push(value);
    if (recent.length > window) recent.shift();
    return [value, recent.reduce((sum, v) => sum + v, 0) / recent.length];
  });
};

/**
 * Market features, then features against every reference market, then the futures premium.
 * An empty reference or premium series gives zeros (missing data or a feature group switched off).
 */
export const buildCandleFeatures = (
  candles: IOHLCV[],
  references: IOHLCV[][],
  step: number,
  premium: IPremiumPoint[] = []
): number[][] => {
  const market = buildMarketFeatures(candles);
  const relative = references.map((reference) => buildReferenceFeatures(candles, reference, step));
  // average over the last hour of minute bars, or the last day of hourly bars
  const premiumRows = buildPremiumFeatures(candles, premium, step === 60 ? 60 : 24);
  return market.map((row, i) => relative.reduce((acc, ref) => acc.concat(ref[i]), row).concat(premiumRows[i]));
};
