/**
 * Can the recorded order books, trades and liquidations pay for trades at the bot's pace (at most 3 a day)?
 *   yarn backtest:orderflow
 *
 * Walk-forward over the recorded days (src/Storage/collectors): before each day a ridge regression is fitted on
 * all earlier days and predicts the futures mid move over H seconds. Features: the per-second order-flow vector the
 * order-book model sees (orderflow.features) plus its averages over 1 / 5 / 15 / 60 minutes. A day is traded with
 * a rule fitted on the earlier days too: enter when the forecast is above a threshold, hold H seconds, at most
 * MAX_TRADES_PER_DAY trades. Compared with random entries of the same count and length, and with perfect foresight
 * (the best possible trades of the day), which shows whether any model could beat the costs at that horizon.
 * Nothing is saved besides the JSON report; no bot model is trained or changed.
 */
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import { readStream } from "../services/collectors/collector.reader";
import { DepthRow, LiquidationRow, ORDERFLOW_SECOND_FEATURES, OrderFlowSeconds, TradeRow } from "../utils/orderflow.features";
import { correlation, correlationT } from "../utils/tensorflow.helpers";
import { createLogger, Colors } from "../utils/colored-console";

const log = createLogger("orderflow-backtest");

const PAIR = "ETH-USDT";
const HORIZONS_SECONDS = [60, 300, 900, 3600];
const AVERAGE_WINDOWS_SECONDS = [60, 300, 900, 3600];
const SAMPLE_STEP = 10;
const MAX_TRADES_PER_DAY = 3;
// the first days only train
const MIN_TRAIN_DAYS = 3;
const RIDGE_PENALTY = Number(process.env.ORDERFLOW_BACKTEST_RIDGE || 10);
// share of training samples above the entry threshold, the best one is picked on the training days
const THRESHOLD_QUANTILES = [0.9, 0.97, 0.99, 0.997, 0.999];
const RANDOM_RUNS = 200;
// round-trip cost in basis points: Binance futures maker / taker, Binance spot taker, the bot's current swaps
const COSTS_BPS: Record<string, number> = { "futures maker": 4, "futures taker": 10, "spot taker": 20, "bot swaps": 100 };

interface ITrade {
  day: number;
  entry: number;
  bps: number;
}

/** Ridge regression on standardized features: weights in the original units plus the intercept. */
const fitRidge = (x: number[][], y: number[], penalty: number) => {
  const n = x.length;
  const k = x[0].length;
  const mean = Array.from({ length: k }, (_, j) => x.reduce((a, r) => a + r[j], 0) / n);
  const std = mean.map((m, j) => Math.sqrt(x.reduce((a, r) => a + (r[j] - m) ** 2, 0) / n) || 1);
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  // normal equations (XᵀX + λnI) w = Xᵀy on standardized x
  const a = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const z = x[i].map((v, j) => (v - mean[j]) / std[j]);
    for (let p = 0; p < k; p++) {
      b[p] += z[p] * (y[i] - yMean);
      for (let q = p; q < k; q++) a[p][q] += z[p] * z[q];
    }
  }
  for (let p = 0; p < k; p++) {
    a[p][p] += penalty * (n / 1000);
    for (let q = 0; q < p; q++) a[p][q] = a[q][p];
  }
  // Gaussian elimination
  for (let c = 0; c < k; c++) {
    let pivot = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    for (let r = c + 1; r < k; r++) {
      const f = a[r][c] / a[c][c];
      for (let q = c; q < k; q++) a[r][q] -= f * a[c][q];
      b[r] -= f * b[c];
    }
  }
  const w = new Array(k).fill(0);
  for (let c = k - 1; c >= 0; c--) {
    let s = b[c];
    for (let q = c + 1; q < k; q++) s -= a[c][q] * w[q];
    w[c] = s / a[c][c];
  }
  return (row: number[]) => yMean + row.reduce((acc, v, j) => acc + (w[j] * (v - mean[j])) / std[j], 0);
};

/** Enter when the forecast exceeds `threshold`, hold `horizon` seconds, at most MAX_TRADES_PER_DAY a day. */
const tradeRule = (times: number[], forecast: number[], move: number[], threshold: number, horizon: number): ITrade[] => {
  const trades: ITrade[] = [];
  const perDay = new Map<number, number>();
  let busyUntil = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const day = Math.floor(times[i] / 86400);
    if (times[i] < busyUntil || forecast[i] <= threshold || (perDay.get(day) ?? 0) >= MAX_TRADES_PER_DAY) continue;
    trades.push({ day, entry: times[i], bps: move[i] });
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    busyUntil = times[i] + horizon;
  }
  return trades;
};

/** Non-overlapping trades of one day taken in the given order of samples (best first, or random). */
const pickInOrder = (times: number[], move: number[], horizon: number, order: number[], count = MAX_TRADES_PER_DAY): ITrade[] => {
  const picked: number[] = [];
  for (const i of order) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(times[p] - times[i]) >= horizon)) picked.push(i);
  }
  return picked.map((i) => ({ day: Math.floor(times[i] / 86400), entry: times[i], bps: move[i] }));
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const avg = (values: number[]) => (values.length ? sum(values) / values.length : 0);
const fmt = (v: number, digits = 1) => (v >= 0 ? "+" : "") + v.toFixed(digits);

(async () => {
  log(`reading recorded order books, trades and liquidations from ${cryptoConfig.collectors.storageDir}`, Colors.BLUE);
  const flow = new OrderFlowSeconds(PAIR.replace("-", ""));
  for (const row of readStream<DepthRow>(`${PAIR}/futures-depth`)) flow.addBook("futures", row);
  for (const row of readStream<DepthRow>(`${PAIR}/spot-depth`)) flow.addBook("spot", row);
  for (const row of readStream<TradeRow>(`${PAIR}/futures-trades`)) flow.addTrade("futures", row);
  for (const row of readStream<TradeRow>(`${PAIR}/spot-trades`)) flow.addTrade("spot", row);
  for (const row of readStream<LiquidationRow>("ALL/futures-liquidations")) flow.addLiquidation(row);

  const seconds = flow.seconds();
  const first = seconds[0];
  const last = seconds[seconds.length - 1];
  const span = last - first + 1;

  // dense per-second vectors and their prefix sums for the moving averages (missing seconds count as zeros)
  const F = ORDERFLOW_SECOND_FEATURES;
  const prefix = new Float64Array((span + 1) * F);
  const present = new Uint8Array(span);
  for (let s = 0; s < span; s++) {
    const v = flow.vectorAt(first + s);
    if (v) present[s] = 1;
    for (let f = 0; f < F; f++) prefix[(s + 1) * F + f] = prefix[s * F + f] + (v?.[f] ?? 0);
  }
  const average = (s: number, window: number, f: number) => (prefix[(s + 1) * F + f] - prefix[Math.max(0, s + 1 - window) * F + f]) / window;

  const longestWindow = AVERAGE_WINDOWS_SECONDS[AVERAGE_WINDOWS_SECONDS.length - 1];
  const times: number[] = [];
  const rows: number[][] = [];
  const mids: number[] = [];
  for (let s = longestWindow; s < span; s += SAMPLE_STEP) {
    const t = first + s;
    const mid = flow.midAt(t);
    const v = present[s] ? flow.vectorAt(t) : null;
    if (!mid || !v) continue;
    const row = [...v];
    for (const w of AVERAGE_WINDOWS_SECONDS) for (let f = 0; f < F; f++) row.push(average(s, w, f));
    // past returns over the same windows (momentum / mean reversion)
    for (const w of AVERAGE_WINDOWS_SECONDS) {
      const past = flow.midAt(t - w);
      row.push(past ? Math.log(mid / past) * 1e4 : 0);
    }
    times.push(t);
    rows.push(row);
    mids.push(mid);
  }
  const days = Array.from(new Set(times.map((t) => Math.floor(t / 86400)))).sort((a, b) => a - b);
  log(
    `${((last - first) / 86400).toFixed(1)} days recorded (${new Date(first * 1000).toISOString()} → ${new Date(last * 1000).toISOString()}), ` +
      `${rows.length} samples × ${rows[0].length} features, testing ${days.length - MIN_TRAIN_DAYS} days`,
    Colors.BLUE
  );

  const report: Record<string, unknown> = {};
  for (const horizon of HORIZONS_SECONDS) {
    // futures mid move over the next `horizon` seconds, in bps; samples without it are left out
    const index: number[] = [];
    const move: number[] = [];
    times.forEach((t, i) => {
      const future = t + horizon <= last ? flow.midAt(t + horizon) : null;
      if (future) {
        index.push(i);
        move.push(Math.log(future / mids[i]) * 1e4);
      }
    });
    const T = index.map((i) => times[i]);
    const X = index.map((i) => rows[i]);
    const dayOf = T.map((t) => Math.floor(t / 86400));

    const model: ITrade[] = [];
    const best: ITrade[] = [];
    const forecasts: number[] = [];
    const realized: number[] = [];
    const randomPerRun: number[][] = Array.from({ length: RANDOM_RUNS }, () => []);

    for (const day of days.slice(MIN_TRAIN_DAYS)) {
      // training samples end `horizon` before the day so no target reaches into it
      const train = T.map((t, i) => (dayOf[i] < day && t + horizon <= day * 86400 ? i : -1)).filter((i) => i >= 0);
      const test = dayOf.map((d, i) => (d === day ? i : -1)).filter((i) => i >= 0);
      if (train.length < 1000 || test.length < 100) continue;
      const predict = fitRidge(
        train.map((i) => X[i]),
        train.map((i) => move[i]),
        RIDGE_PENALTY
      );

      // threshold: the quantile that made the most per trade on the training days (after the cheapest cost)
      const trainForecast = train.map((i) => predict(X[i]));
      const sorted = [...trainForecast].sort((a, b) => a - b);
      let threshold = Infinity;
      let bestGain = -Infinity;
      for (const q of THRESHOLD_QUANTILES) {
        const candidate = sorted[Math.floor(q * (sorted.length - 1))];
        const trades = tradeRule(
          train.map((i) => T[i]),
          trainForecast,
          train.map((i) => move[i]),
          candidate,
          horizon
        );
        const gain = sum(trades.map((tr) => tr.bps - COSTS_BPS["futures maker"]));
        if (trades.length && gain > bestGain) {
          bestGain = gain;
          threshold = candidate;
        }
      }

      const testTimes = test.map((i) => T[i]);
      const testMove = test.map((i) => move[i]);
      const testForecast = test.map((i) => predict(X[i]));
      forecasts.push(...testForecast);
      realized.push(...testMove);
      const trades = tradeRule(testTimes, testForecast, testMove, threshold, horizon);
      model.push(...trades);
      // perfect foresight: the best long trades of the day
      const byMove = testTimes.map((_, i) => i).sort((a, b) => testMove[b] - testMove[a]).filter((i) => testMove[i] > 0);
      best.push(...pickInOrder(testTimes, testMove, horizon, byMove));
      // random entries: as many trades as the model made that day, at random moments
      for (let run = 0; run < RANDOM_RUNS; run++) {
        const shuffled = testTimes.map((_, i) => i);
        for (let k = shuffled.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
        }
        randomPerRun[run].push(...pickInOrder(testTimes, testMove, horizon, shuffled, trades.length).map((p) => p.bps));
      }
    }

    const ic = correlation(forecasts, realized);
    const icT = correlationT(ic, forecasts.length, horizon / SAMPLE_STEP);
    const randomMeans = randomPerRun.map(avg).sort((a, b) => a - b);
    const modelMean = avg(model.map((t) => t.bps));
    const beatsRandomPct = (randomMeans.filter((m) => m < modelMean).length / RANDOM_RUNS) * 100;
    const label = horizon < 3600 ? `${horizon / 60} min` : `${horizon / 3600} h`;

    log(`\nhold ${label}: out-of-sample IC ${fmt(ic, 3)} (t=${icT.toFixed(1)})`, Colors.WHITE);
    log(`${"".padEnd(26)}${"trades".padStart(7)}${"gross bps/trade".padStart(17)}${Object.keys(COSTS_BPS).map((c) => c.padStart(15)).join("")}`, Colors.WHITE);
    const line = (name: string, bps: number[], color = Colors.WHITE) =>
      log(
        `${name.padEnd(26)}${String(bps.length).padStart(7)}${fmt(avg(bps)).padStart(17)}` +
          Object.values(COSTS_BPS)
            .map((c) => fmt(sum(bps.map((b) => b - c)) / 100, 2).concat("%").padStart(15))
            .join(""),
        color
      );
    line("model (ridge)", model.map((t) => t.bps), modelMean > COSTS_BPS["futures taker"] ? Colors.GREEN : Colors.YELLOW);
    line("random entries (median)", randomPerRun.map((r) => [avg(r), r] as const).sort((a, b) => a[0] - b[0])[RANDOM_RUNS / 2][1]);
    line("perfect foresight", best.map((t) => t.bps));
    log(`model beats ${beatsRandomPct.toFixed(0)}% of random entry runs; columns after "gross" are the summed net return`, Colors.WHITE);

    report[horizon] = {
      ic,
      icT,
      modelTrades: model,
      modelMeanBps: modelMean,
      randomMedianMeanBps: randomMeans[RANDOM_RUNS / 2],
      beatsRandomPct,
      oracleMeanBps: avg(best.map((t) => t.bps)),
      oracleTrades: best.length,
    };
  }

  const file = `${cryptoConfig.paths.storageDir}/orderflow-backtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(file, { pair: PAIR, from: first, to: last, maxTradesPerDay: MAX_TRADES_PER_DAY, costsBps: COSTS_BPS, results: report }, { spaces: 2 });
  log(`\nreport saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();
