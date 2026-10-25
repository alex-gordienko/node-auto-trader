/**
 * The horizon-search candidates (research/horizon): a model scores the market every 5 minutes from 1-minute candles
 * and only the most confident moments are traded — at most 3 entries a UTC day, one position at a time, held for the
 * model's horizon. Models are trained by research/horizon/export.py and loaded from src/models/horizon/<name>.json;
 * this file computes the same 30 features as research/horizon/study.py (checked against Python by
 * horizon-model.test.ts) and evaluates the exported ridge or gradient-boosted trees.
 */

const MIN = 60_000;
const DAY = 86_400_000;
export const STEP_MINUTES = 5;
// the 3-a-day rule: a score is traded when it is beyond this quantile of the previous 30 days' scores
export const PER_DAY = 3;
export const THRESHOLD_QUANTILE = 1 - PER_DAY / (1440 / STEP_MINUTES);
export const THRESHOLD_DAYS = 30;
export const THRESHOLD_MIN_DAYS = 7;
const TREND_LOOKBACKS = [10, 14, 21, 30, 45, 60, 90, 120];

export const FEATURE_NAMES = [
  "ret_1", "ret_5", "ret_15", "ret_60", "ret_240", "ret_720", "ret_1440", "ret_4320",
  "other_ret_15", "other_ret_60", "other_ret_240", "rv_60", "rv_1440", "rv_ratio", "vol_ratio_60", "vol_ratio_5",
  "taker_imb_5", "taker_imb_60", "taker_imb_240", "range_60", "range_5", "vwap_dev_1440", "hi_dist_1440", "lo_dist_1440",
  "hour_sin", "hour_cos", "dow", "trend_vote", "daily_ret_30", "funding_3d",
];
// longest window: the 3-day return
export const HISTORY_MINUTES = 4320 + 1;

export interface IMinuteBar {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  tbv: number; // taker buy base volume
}

export interface IHorizonInputs {
  minutes: IMinuteBar[]; // the traded coin, oldest first; missing minutes are filled like the research (close carried, no volume)
  other: { t: number; c: number }[]; // the other coin's 1m closes (BTC for ETH)
  dailyCloses: { t: number; c: number }[]; // the coin's daily closes stamped when known (00:00 UTC of the next day), one per day
  funding: { t: number; rate: number }[]; // perpetual funding payments, time in ms
}

export interface IRidgeModel {
  kind: "ridge";
  mu: number[];
  sd: number[];
  coef: number[];
  intercept: number;
}

export interface IGbmModel {
  kind: "gbm";
  baseline: number;
  trees: { feature: number[]; threshold: number[]; left: number[]; right: number[]; missingLeft: number[]; leaf: number[]; value: number[] }[];
}

export type IHorizonModel = (IRidgeModel | IGbmModel) & {
  name: string;
  symbol: string;
  other: string;
  horizonMinutes: number;
  modes: ("long" | "ls")[];
  features: string[];
  trainedThrough: string;
};

// the research stored features as float32 (the clock features stayed float64): the same rounding keeps tree splits identical
const f32 = Math.fround;

const windowStats = (a: Float64Array, from: number, to: number) => {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (let j = from; j <= to; j++) {
    sum += a[j];
    if (a[j] > max) max = a[j];
    if (a[j] < min) min = a[j];
  }
  return { sum, max, min };
};

/** Sample standard deviation (as pandas) of a[from..to]; NaN if any value is NaN. */
const windowStd = (a: Float64Array, from: number, to: number) => {
  const n = to - from + 1;
  let mean = 0;
  for (let j = from; j <= to; j++) mean += a[j];
  mean /= n;
  let ss = 0;
  for (let j = from; j <= to; j++) ss += (a[j] - mean) ** 2;
  return Math.sqrt(ss / (n - 1));
};

const finite = (v: number) => (Number.isFinite(v) ? v : NaN);

/**
 * Features at each decision time (ms, multiples of 5 minutes): only candles that closed by then are used, i.e. the
 * minute opened at T − 1 m is the last one. NaN where the history is too short.
 */
export const horizonFeatures = (inp: IHorizonInputs, decisionTimes: number[]): number[][] => {
  const bars = inp.minutes;
  if (!bars.length) return decisionTimes.map(() => FEATURE_NAMES.map(() => NaN));
  const t0 = bars[0].t;
  const n = Math.round((bars[bars.length - 1].t - t0) / MIN) + 1;
  const c = new Float64Array(n).fill(NaN);
  const h = new Float64Array(n).fill(NaN);
  const l = new Float64Array(n).fill(NaN);
  const v = new Float64Array(n);
  const tbv = new Float64Array(n);
  for (const b of bars) {
    const i = Math.round((b.t - t0) / MIN);
    [c[i], h[i], l[i], v[i], tbv[i]] = [b.c, b.h, b.l, b.v, b.tbv];
  }
  for (let i = 1; i < n; i++) {
    if (Number.isNaN(c[i])) {
      c[i] = c[i - 1];
      h[i] = c[i];
      l[i] = c[i];
    }
  }
  const lr = c.map(Math.log);
  const r1 = lr.map((x, i) => (i ? x - lr[i - 1] : NaN));
  const cv = c.map((x, i) => x * v[i]);
  // the other coin's last close at or before each minute
  const olr = new Float64Array(n).fill(NaN);
  let k = 0;
  let last = NaN;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * MIN;
    while (k < inp.other.length && inp.other[k].t <= t) last = inp.other[k++].c;
    olr[i] = Math.log(last);
  }
  const dailyIndex = new Map(inp.dailyCloses.map((d, j) => [d.t, j]));

  return decisionTimes.map((T) => {
    const i = Math.round((T - MIN - t0) / MIN);
    if (i < 0 || i >= n) return FEATURE_NAMES.map(() => NaN);
    const back = (a: Float64Array, lag: number) => (i - lag >= 0 ? f32(a[i] - a[i - lag]) : NaN);
    const has = (w: number) => i - w + 1 >= 0;
    const sum = (a: Float64Array, w: number) => (has(w) ? windowStats(a, i - w + 1, i).sum : NaN);
    const rv = (w: number) => (i - w + 1 >= 1 ? f32(windowStd(r1, i - w + 1, i)) : NaN);
    const imb = (w: number) => {
      const vv = sum(v, w);
      return vv ? f32((2 * sum(tbv, w) - vv) / vv) : NaN;
    };
    const range = (w: number) => (has(w) ? f32((windowStats(h, i - w + 1, i).max - windowStats(l, i - w + 1, i).min) / c[i]) : NaN);
    const v1440 = sum(v, 1440);
    const rv60 = rv(60);
    const rv1440 = rv(1440);

    const date = new Date(T);
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
    const j = dailyIndex.get(Math.floor(T / DAY) * DAY);
    const dc = inp.dailyCloses;
    const vote =
      j !== undefined && j >= 120 ? f32(TREND_LOOKBACKS.filter((lag) => dc[j].c > dc[j - lag].c).length / TREND_LOOKBACKS.length) : NaN;
    const ret30 = j !== undefined && j >= 30 ? f32(Math.log(dc[j].c) - Math.log(dc[j - 30].c)) : NaN;
    let p = -1;
    while (p + 1 < inp.funding.length && inp.funding[p + 1].t <= T) p++;
    const funding = p >= 8 ? f32(inp.funding.slice(p - 8, p + 1).reduce((s, f) => s + f.rate, 0) / 9) : NaN;

    const row = [
      back(lr, 1), back(lr, 5), back(lr, 15), back(lr, 60), back(lr, 240), back(lr, 720), back(lr, 1440), back(lr, 4320),
      back(olr, 15), back(olr, 60), back(olr, 240), rv60, rv1440, f32(rv60 / rv1440),
      f32(sum(v, 60) / (v1440 / 24)), f32(sum(v, 5) / (v1440 / 288)),
      imb(5), imb(60), imb(240), range(60), range(5),
      has(1440) ? f32(lr[i] - Math.log(sum(cv, 1440) / v1440)) : NaN,
      has(1440) ? f32(lr[i] - Math.log(windowStats(h, i - 1439, i).max)) : NaN,
      has(1440) ? f32(lr[i] - Math.log(windowStats(l, i - 1439, i).min)) : NaN,
      Math.sin((2 * Math.PI * hours) / 24), Math.cos((2 * Math.PI * hours) / 24), f32((date.getUTCDay() + 6) % 7),
      vote, ret30, funding,
    ];
    return row.map(finite);
  });
};

/** The model's score: the predicted log return over its horizon. */
export const predictHorizon = (model: IRidgeModel | IGbmModel, x: number[]): number => {
  if (model.kind === "ridge") {
    return x.reduce((s, v, j) => {
      const z = Math.max(-5, Math.min(5, (v - model.mu[j]) / model.sd[j]));
      return s + (Number.isNaN(z) ? 0 : z) * model.coef[j];
    }, model.intercept);
  }
  let out = model.baseline;
  for (const t of model.trees) {
    let i = 0;
    while (!t.leaf[i]) {
      const v = x[t.feature[i]];
      i = (Number.isNaN(v) ? t.missingLeft[i] : v <= t.threshold[i]) ? t.left[i] : t.right[i];
    }
    out += t.value[i];
  }
  return out;
};

/** Linear-interpolated quantile (numpy / pandas default); NaN for an empty list. */
export const quantile = (values: number[], q: number): number => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};

/**
 * The causal entry threshold: the THRESHOLD_QUANTILE of the scores of the previous THRESHOLD_DAYS (|score| for
 * long/short); NaN with less than THRESHOLD_MIN_DAYS of scores.
 */
export const entryThreshold = (past: { t: number; s: number }[], now: number, mode: "long" | "ls"): number => {
  const window = past.filter((p) => p.t < now && p.t >= now - THRESHOLD_DAYS * DAY).map((p) => (mode === "long" ? p.s : Math.abs(p.s)));
  return window.length >= (THRESHOLD_MIN_DAYS * 1440) / STEP_MINUTES ? quantile(window, THRESHOLD_QUANTILE) : NaN;
};

/** Which side to take for a score: 1 long, −1 short (long/short mode only), 0 none. */
export const entrySide = (score: number, threshold: number, mode: "long" | "ls"): number => {
  if (!Number.isFinite(threshold)) return 0;
  if (mode === "long") return score > threshold ? 1 : 0;
  return Math.abs(score) > threshold ? Math.sign(score) : 0;
};
