/**
 * The bot's daily AI model: forecasts the realized volatility of the next 3 days from the volatility of the last
 * 1, 3, 7 and 30 days (a HAR-style ridge regression on log volatility, hourly returns). Refitted on a rolling window
 * of days whose 3-day target had already ended — the same fit in the backtest (scripts/strategy-check.ts) and in
 * paper trading (services/VoteTrader.service.ts). Its forecast replaces the trailing 30-day volatility in sizing.
 */

const HOURS_PER_YEAR = 365 * 24;
export const VOL_HORIZON_HOURS = 72;
const LOOKBACK_HOURS = [24, 72, 168, 720];
// samples one day apart within the last TRAIN_DAYS: fits on ~1 year of stored hourly candles with features
export const TRAIN_DAYS = 300;
// ridge penalty per sample on standardized features; 4 strongly correlated inputs need a little
const PENALTY = 0.1;

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const std = (values: number[], m: number) => Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length) || 1;

/** Solves A·x = b (A symmetric positive definite: Gauss–Jordan without pivoting is enough). */
const solve = (A: number[][], b: number[]): number[] => {
  const m = A.map((row, i) => [...row, b[i]]);
  const n = b.length;
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
};

/** Ridge regression on standardized features (the intercept, i.e. the average target, is not penalized). */
export const fitRidge = (X: number[][], y: number[], penalty: number) => {
  const n = X.length;
  const cols = X[0].map((_, j) => j);
  const mu = cols.map((j) => mean(X.map((row) => row[j])));
  const sd = cols.map((j) => std(X.map((row) => row[j]), mu[j]));
  const Z = X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));
  const yMean = mean(y);
  const A = cols.map((i) => cols.map((j) => Z.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j ? penalty * n : 0)));
  const w = solve(
    A,
    cols.map((i) => Z.reduce((sum, row, k) => sum + row[i] * (y[k] - yMean), 0))
  );
  return (x: number[]) => yMean + x.reduce((sum, v, j) => sum + (w[j] * (v - mu[j])) / sd[j], 0);
};

/** Annualized volatility of the hourly log returns in (i − hours, i]; `closes` hourly, oldest first. */
export const hourlyVolatility = (closes: number[], i: number, hours: number): number => {
  if (i - hours < 0 || i >= closes.length) return NaN;
  let sum = 0;
  for (let j = i - hours + 1; j <= i; j++) sum += Math.log(closes[j] / closes[j - 1]) ** 2;
  return Math.sqrt((sum / hours) * HOURS_PER_YEAR);
};

const features = (closes: number[], i: number) => LOOKBACK_HOURS.map((h) => Math.log(hourlyVolatility(closes, i, h)));

/**
 * The model fitted at hour i (only closes up to i are used) → forecast of the next 3 days' annualized volatility at
 * hour i. NaN without TRAIN_DAYS of history. The log forecast is corrected by half its residual variance: the mean
 * volatility, not the median, is what sizing needs.
 */
export const forecastVolatility = (closes: number[], i: number): number => {
  const X: number[][] = [];
  const y: number[] = [];
  for (let j = i - VOL_HORIZON_HOURS; j >= i - TRAIN_DAYS * 24; j -= 24) {
    const x = features(closes, j);
    const target = Math.log(hourlyVolatility(closes, j + VOL_HORIZON_HOURS, VOL_HORIZON_HOURS));
    if (x.every(Number.isFinite) && Number.isFinite(target)) {
      X.push(x);
      y.push(target);
    }
  }
  const x = features(closes, i);
  if (X.length < TRAIN_DAYS / 2 || !x.every(Number.isFinite)) return NaN;
  const predict = fitRidge(X, y, PENALTY);
  const residualVariance = mean(X.map((row, k) => (y[k] - predict(row)) ** 2));
  return Math.exp(predict(x) + residualVariance / 2);
};

/** Realized volatility of the 3 days after hour i, for scoring forecasts. */
export const realizedNextVolatility = (closes: number[], i: number) => hourlyVolatility(closes, i + VOL_HORIZON_HOURS, VOL_HORIZON_HOURS);
