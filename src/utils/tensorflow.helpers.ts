import { ICyptoCompareData } from "../types/cryptoCompare.types";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";
import { INDICATOR_WARMUP, IOHLCV } from "./technical-indicators";

// forecast target = log-return over the horizon in percent, so the loss is not vanishingly small
export const FORECAST_TARGET_SCALE = 100;

export interface IForecastMetrics {
  trainedAt: number;
  samples: number;
  valSamples: number;
  modelMae: number; // in % of price
  naiveMae: number; // "price will not change" baseline, in % of price
  directionAccuracy: number; // share of samples with correctly predicted sign
  beatsNaive: boolean;
  live?: ILiveForecastStats;
}

export interface ILiveForecastStats {
  count: number;
  mae: number;
  naiveMae: number;
  directionAccuracy: number;
}

/** A trading decision made in production, with the price move that actually followed it. */
export interface ILiveDecision {
  candleIndex: number;
  command: string;
  realizedReturn: number; // fraction over the forecast horizon
}

export interface ILiveFeedback {
  forecast: ILiveForecastStats | null;
  // candle indexes whose live forecast error was above the median: these are oversampled in retraining
  hardSampleIndexes: Set<number>;
  decisions: ILiveDecision[];
}

export const toOHLCV = (data: Pick<ICyptoCompareData, "time" | "high" | "low" | "open" | "close" | "volumefrom">[]): IOHLCV[] =>
  data
    .map((d) => ({
      time: d.time,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volumefrom ?? 0,
    }))
    .sort((a, b) => a.time - b.time);

export const argmax = (values: number[]): number => {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[best]) {
      best = i;
    }
  }
  return best;
};

/** Prefix count of gaps in minute data, so "is there a gap between a and b" is O(1). */
export const buildGapChecker = (candles: IOHLCV[]) => {
  const prefix = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    prefix[i] = prefix[i - 1] + (candles[i].time - candles[i - 1].time !== 60 ? 1 : 0);
  }
  return (from: number, to: number) => prefix[Math.min(to, candles.length - 1)] - prefix[Math.max(from, 0)] > 0;
};

export const forecastTarget = (candles: IOHLCV[], t: number, horizon: number): number =>
  Math.log(candles[t + horizon].close / candles[t].close) * FORECAST_TARGET_SCALE;

/** Window of market features ending at index t (inclusive). */
export const featureWindow = (features: number[][], t: number, windowSize: number): number[][] =>
  features.slice(t - windowSize + 1, t + 1);

/**
 * Supervised samples for the price forecast. Windows crossing a gap in minute data are skipped,
 * since the dataset is stitched from separate API fetches.
 */
export const buildForecastSamples = (
  candles: IOHLCV[],
  features: number[][],
  windowSize: number,
  horizon: number
): { indexes: number[]; xs: number[][][]; ys: number[] } => {
  const hasGap = buildGapChecker(candles);
  const indexes: number[] = [];
  const xs: number[][][] = [];
  const ys: number[] = [];

  for (let t = Math.max(INDICATOR_WARMUP, windowSize - 1); t + horizon < candles.length; t++) {
    if (hasGap(t - INDICATOR_WARMUP, t + horizon)) {
      continue;
    }
    indexes.push(t);
    xs.push(featureWindow(features, t, windowSize));
    ys.push(forecastTarget(candles, t, horizon));
  }

  return { indexes, xs, ys };
};

export const computeForecastErrors = (predicted: number[], actual: number[]) => {
  let modelErr = 0;
  let naiveErr = 0;
  let rightDirection = 0;
  for (let i = 0; i < actual.length; i++) {
    modelErr += Math.abs(predicted[i] - actual[i]);
    naiveErr += Math.abs(actual[i]);
    if (Math.sign(predicted[i]) === Math.sign(actual[i])) rightDirection++;
  }
  const n = Math.max(actual.length, 1);
  return { mae: modelErr / n, naiveMae: naiveErr / n, directionAccuracy: rightDirection / n };
};

/**
 * Self-correction input: compares saved production predictions with prices that actually happened.
 * Returns live forecast accuracy, the hardest samples to retrain on, and the outcome of each DQN decision.
 */
export const evaluateLivePredictions = (
  predictions: ITensorflowPrediction[],
  candles: IOHLCV[],
  horizon: number
): ILiveFeedback => {
  const indexByTime = new Map<number, number>();
  candles.forEach((c, i) => indexByTime.set(c.time, i));

  const predicted: number[] = [];
  const actual: number[] = [];
  const forecastIndexes: number[] = [];
  const decisions: ILiveDecision[] = [];

  for (const p of predictions) {
    // prediction is anchored to the last closed candle: target time = candle open + 1 min + horizon
    const anchorTime = p.lstm_timestamp / 1000 - 60 - horizon * 60;
    const t = indexByTime.get(anchorTime);
    if (t === undefined || t + horizon >= candles.length || candles[t + horizon].time !== anchorTime + horizon * 60) {
      continue;
    }

    const realizedReturn = candles[t + horizon].close / candles[t].close - 1;
    decisions.push({ candleIndex: t, command: p.predicted_command, realizedReturn });

    // older records have no real forecast (predicted_value was derived from Q-values), skip them
    // raw model output is stored even when the forecast fell back to "no change", so it can still be judged
    const rawReturn = p.forecast_raw_return ?? p.predicted_return;
    if (rawReturn !== undefined) {
      predicted.push(Math.log(1 + rawReturn) * FORECAST_TARGET_SCALE);
      actual.push(forecastTarget(candles, t, horizon));
      forecastIndexes.push(t);
    }
  }

  const hardSampleIndexes = new Set<number>();
  if (actual.length) {
    const errors = actual.map((a, i) => Math.abs(a - predicted[i]));
    const median = [...errors].sort((a, b) => a - b)[Math.floor(errors.length / 2)];
    errors.forEach((e, i) => e > median && hardSampleIndexes.add(forecastIndexes[i]));
  }

  return {
    forecast: actual.length ? { count: actual.length, ...computeForecastErrors(predicted, actual) } : null,
    hardSampleIndexes,
    decisions,
  };
};
