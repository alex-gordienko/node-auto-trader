/**
 * Can the direction of ETH-USDT be predicted 1, 3 or 7 days ahead, and would a simple long/flat strategy beat
 * buy & hold after swap costs?
 *   STORAGE_DIR=<own folder> REFERENCE_PAIRS=BTC-USDT yarn backfill:binance 1 3400
 *   STORAGE_DIR=<same folder> npx ts-node --transpile-only src/scripts/daily-horizon.ts
 * Use a folder of its own, not the bot's src/Storage: the backfill rewrites month files the running bot reads.
 *
 * One decision a day at 00:00 UTC. Features use only hourly candles closed by then: past returns, distance to the
 * 50/200-day averages and realized volatility of ETH and BTC, ETH's strength against BTC, funding (since late 2019).
 * Signals: trend rules (nothing fitted) and linear / ridge regression refitted every January on the days whose
 * target had already ended. IC t-statistics count only every H-th day as independent (H-day targets overlap).
 * Long/flat backtest: ETH while the forecast is positive, else USDT; for horizon H a decision every H days,
 * averaged over the H possible first days. Nothing is trained for the bot or saved besides the JSON report.
 */
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import StorageService from "../services/Local.storage.service";
import { IFundingRate, IMarketCandle } from "../types/marketData.types";
import { correlation, correlationT, lastIndexAtOrBefore } from "../utils/tensorflow.helpers";
import { createLogger, Colors } from "../utils/colored-console";
import { fitRidge } from "../utils/vol-model";

const log = createLogger("daily-horizon");

const DAY = 86400;
const HOUR = 3600;
const HORIZONS = [1, 3, 7];
// cost of one swap: none (the bare signal), exchange spot fee, current bot (ChangeNow fee + Ethereum gas)
const COSTS = [0, 0.001, 0.007];
// models are refitted every January on earlier days only; testing starts after a year of usable history
const FIRST_TEST_YEAR = 2019;
// funding history starts in late 2019, so the model that uses it is tested from 2021
const FUNDING_FIRST_TEST_YEAR = 2021;
// ridge penalty per training day on standardized features: "linear" is almost plain least squares
const LINEAR_PENALTY = 0.01;
const RIDGE_PENALTY = 1;
// ~20 features × 3 horizons are checked: |t| ≥ 3 is the bar for "not chance"
const SIGNIFICANT_T = 3;
// lookbacks of the trend rule: checked side by side, and one is picked every January by its past IC
const LOOKBACKS = [7, 14, 21, 30, 45, 60, 90];

/** Values by the time they become known (a candle's close: open + 1 hour). */
interface ISeries {
  times: number[];
  values: number[];
}
interface IMarket {
  eth: ISeries;
  btc: ISeries;
  funding: ISeries;
}
interface ISample {
  t: number;
  x: number[];
  // ETH log return over each horizon, NaN while it has not ended
  y: number[];
}
interface ISignal {
  name: string;
  firstYear: number;
  // positive = hold ETH; NaN = no forecast
  forecast: number[];
}
interface IBacktest {
  total: number;
  years: Record<string, number>;
  swaps: number;
  inMarket: number;
  maxDrawdown: number;
}

const COIN_FEATURES = ["return 1d", "return 7d", "return 30d", "return 90d", "vs 50d avg", "vs 200d avg", "volatility 7d", "volatility 30d"];
const FEATURES = [
  ...["eth", "btc"].flatMap((coin) => COIN_FEATURES.map((name) => `${coin} ${name}`)),
  "eth-btc 7d",
  "eth-btc 30d",
  "eth-btc 90d",
  "funding 7d",
];
const FUNDING = FEATURES.indexOf("funding 7d");

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const std = (values: number[], m: number) => Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length) || 1;
const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();
const yearStart = (year: number) => Date.UTC(year, 0, 1) / 1000;
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

const toSeries = <T>(rows: T[], knownAt: (row: T) => number, value: (row: T) => number, until = Infinity): ISeries => {
  const known = rows.filter((row) => knownAt(row) <= until);
  return { times: known.map(knownAt), values: known.map(value) };
};

const valueAt = (series: ISeries, t: number) => {
  const i = lastIndexAtOrBefore(series.times, t);
  return i >= 0 ? series.values[i] : NaN;
};

/** Past log returns, log distance to the 50/200-day average price, daily realized volatility from hourly moves. */
const coinFeatures = (series: ISeries, t: number): number[] => {
  const price = valueAt(series, t);
  const change = (days: number) => Math.log(price / valueAt(series, t - days * DAY));
  const vsAverage = (days: number) => {
    let sum = 0;
    for (let d = 0; d < days; d++) sum += valueAt(series, t - d * DAY);
    return Math.log((price * days) / sum);
  };
  const volatility = (days: number) => {
    const end = lastIndexAtOrBefore(series.times, t);
    if (end < days * 24) return NaN;
    let sum = 0;
    for (let i = end - days * 24 + 1; i <= end; i++) sum += Math.log(series.values[i] / series.values[i - 1]) ** 2;
    return Math.sqrt(sum / days);
  };
  return [change(1), change(7), change(30), change(90), vsAverage(50), vsAverage(200), volatility(7), volatility(30)];
};

const featuresAt = (market: IMarket, t: number): number[] => {
  const eth = coinFeatures(market.eth, t);
  const btc = coinFeatures(market.btc, t);
  // average funding of the last week, NaN until a full week of funding history exists
  const from = lastIndexAtOrBefore(market.funding.times, t - 7 * DAY);
  const week = market.funding.values.slice(from + 1, lastIndexAtOrBefore(market.funding.times, t) + 1);
  const funding = from >= 0 && week.length ? mean(week) : NaN;
  return [...eth, ...btc, eth[1] - btc[1], eth[2] - btc[2], eth[3] - btc[3], funding];
};

/** Out-of-sample forecasts: each test year uses a model fitted only on days whose target ended by January 1. */
const walkForward = (samples: ISample[], hi: number, columns: number[], penalty: number, firstYear: number): number[] => {
  const h = HORIZONS[hi];
  const forecast = samples.map(() => NaN);
  const usable = (s: ISample) => columns.every((j) => Number.isFinite(s.x[j]));
  for (let year = firstYear; year <= yearOf(samples[samples.length - 1].t); year++) {
    const train = samples.filter((s) => s.t + h * DAY <= yearStart(year) && usable(s) && Number.isFinite(s.y[hi]));
    const predict = fitRidge(
      train.map((s) => columns.map((j) => s.x[j])),
      train.map((s) => s.y[hi]),
      penalty
    );
    samples.forEach((s, i) => {
      if (yearOf(s.t) === year && usable(s)) forecast[i] = predict(columns.map((j) => s.x[j]));
    });
  }
  return forecast;
};

/** Long/flat: positions[k] = 1 holds ETH over day k; every change of position costs `cost` of the capital. */
const simulate = (times: number[], returns: number[], positions: number[], cost: number): IBacktest => {
  let wealth = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let held = 0;
  let swaps = 0;
  let inMarket = 0;
  let startOfYear = 1;
  const years: Record<string, number> = {};
  positions.forEach((position, k) => {
    if (k === 0 || yearOf(times[k]) !== yearOf(times[k - 1])) startOfYear = wealth;
    if (position !== held) {
      wealth *= 1 - cost;
      swaps++;
      held = position;
    }
    if (position) {
      wealth *= Math.exp(returns[k]);
      inMarket++;
    }
    peak = Math.max(peak, wealth);
    maxDrawdown = Math.max(maxDrawdown, 1 - wealth / peak);
    years[yearOf(times[k])] = wealth / startOfYear - 1;
  });
  return { total: wealth - 1, years, swaps, inMarket: inMarket / positions.length, maxDrawdown };
};

/** A decision every `step` days, held in between; averaged over the `step` possible first decision days. */
const backtest = (times: number[], returns: number[], wanted: number[], step: number, cost: number) => {
  const runs = Array.from({ length: step }, (_, offset) =>
    simulate(
      times,
      returns,
      wanted.map((_, k) => wanted[Math.max(0, k - ((((k - offset) % step) + step) % step))]),
      cost
    )
  );
  const avg = (pick: (run: IBacktest) => number) => mean(runs.map(pick));
  const years: Record<string, number> = {};
  Object.keys(runs[0].years).forEach((year) => (years[year] = avg((run) => run.years[year])));
  return {
    total: avg((r) => r.total),
    worstStart: Math.min(...runs.map((r) => r.total)),
    bestStart: Math.max(...runs.map((r) => r.total)),
    years,
    swaps: avg((r) => r.swaps),
    inMarket: avg((r) => r.inMarket),
    maxDrawdown: avg((r) => r.maxDrawdown),
  };
};

/** Ranks with ties averaged, for the rank IC (robust to the few huge days of crypto). */
const ranks = (values: number[]): number[] => {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const result = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j++;
    for (let k = i; k <= j; k++) result[order[k]] = (i + j) / 2;
    i = j + 1;
  }
  return result;
};

const signed = (v: number, digits: number) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
const pct = (v: number) => `${signed(v * 100, 0)}%`;
const icText = (ic: number, t: number) => `${signed(ic, 3)} (${signed(t, 1)})`;

(async () => {
  const [ethCandles, btcCandles, fundingRows] = await Promise.all([
    StorageService.getCandles("ETH-USDT", "hour"),
    StorageService.getCandles("BTC-USDT", "hour"),
    StorageService.getSeries<IFundingRate>("ETH-USDT", "funding"),
  ]);
  if (!ethCandles.length || ethCandles[0].time > yearStart(FIRST_TEST_YEAR - 1) || !btcCandles.length) {
    throw new Error(`Needs hourly ETH-USDT and BTC-USDT since 2017 in ${cryptoConfig.paths.storageDir}: run the backfill from the header`);
  }
  const market = (until?: number): IMarket => ({
    eth: toSeries(ethCandles, (c: IMarketCandle) => c.time + HOUR, (c) => c.close, until),
    btc: toSeries(btcCandles, (c: IMarketCandle) => c.time + HOUR, (c) => c.close, until),
    funding: toSeries(fundingRows, (f) => f.time, (f) => f.rate, until),
  });
  const all = market();
  const last = all.eth.times[all.eth.times.length - 1];
  const missingHours = (last - all.eth.times[0]) / HOUR + 1 - all.eth.times.length;
  log(
    `ETH-USDT ${date(all.eth.times[0])} … ${date(last)}: ${ethCandles.length} hourly candles (${missingHours} hours missing), ` +
      `BTC-USDT ${btcCandles.length}, funding since ${fundingRows.length ? date(fundingRows[0].time) : "—"}`,
    Colors.WHITE
  );

  const samples: ISample[] = [];
  for (let t = Math.ceil(all.eth.times[0] / DAY) * DAY; t <= last; t += DAY) {
    const price = valueAt(all.eth, t);
    samples.push({
      t,
      x: featuresAt(all, t),
      y: HORIZONS.map((h) => (t + h * DAY <= last ? Math.log(valueAt(all.eth, t + h * DAY) / price) : NaN)),
    });
  }

  // look-ahead self-check: features computed from data cut at the decision time must equal the ones from all data
  samples
    .filter((_, i) => i % 50 === 0)
    .forEach((s) => {
      const cut = featuresAt(market(s.t), s.t);
      FEATURES.forEach((name, j) => {
        if (cut[j] !== s.x[j] && !(Number.isNaN(cut[j]) && Number.isNaN(s.x[j]))) {
          throw new Error(`look-ahead: "${name}" at ${date(s.t)} changes when later data is removed`);
        }
      });
    });
  // self-check of the regression: recovers a known relation y = 3 + 2·a − b
  const known = fitRidge(
    Array.from({ length: 50 }, (_, i) => [i, (i * 7) % 5]),
    Array.from({ length: 50 }, (_, i) => 3 + 2 * i - ((i * 7) % 5)),
    1e-9
  );
  if (Math.abs(known([10, 3]) - 20) > 1e-6) throw new Error("ridge regression self-check failed");
  log(`self-check passed: features do not change when data after the decision time is removed; regression recovers a known relation`, Colors.GREEN);

  // ---------- each feature alone (all days, in-sample: describes the market, chooses nothing) ----------
  const featureIc = FEATURES.map((name, j) => ({
    name,
    horizons: HORIZONS.map((h, hi) => {
      const rows = samples.filter((s) => Number.isFinite(s.x[j]) && Number.isFinite(s.y[hi]));
      const x = rows.map((s) => s.x[j]);
      const y = rows.map((s) => s.y[hi]);
      const half = Math.floor(rows.length / 2);
      const ic = correlation(x, y);
      return {
        horizonDays: h,
        ic,
        t: correlationT(ic, rows.length, h),
        icFirstHalf: correlation(x.slice(0, half), y.slice(0, half)),
        icSecondHalf: correlation(x.slice(half), y.slice(half)),
        from: rows.length ? date(rows[0].t) : null,
        n: rows.length,
      };
    }),
  }));
  log(`\nIC of each feature alone with the ETH return over the next 1 / 3 / 7 days (t in brackets, all days)`, Colors.WHITE);
  log(`${"feature".padEnd(20)}${HORIZONS.map((h) => `${h}d`.padStart(18)).join("")}   halves (7d)`, Colors.WHITE);
  featureIc.forEach((f) => {
    const strong = f.horizons.some((r) => Math.abs(r.t) >= SIGNIFICANT_T && Math.sign(r.icFirstHalf) === Math.sign(r.icSecondHalf));
    const halves = f.horizons[HORIZONS.length - 1];
    log(
      `${f.name.padEnd(20)}${f.horizons.map((r) => icText(r.ic, r.t).padStart(18)).join("")}   ` +
        `${signed(halves.icFirstHalf, 3)} / ${signed(halves.icSecondHalf, 3)}`,
      strong ? Colors.GREEN : Colors.WHITE
    );
  });
  log(`green = |t| ≥ ${SIGNIFICANT_T} at some horizon and the same sign in both halves of the history`, Colors.WHITE);

  // ---------- signals tested out of sample ----------
  const allColumns = FEATURES.map((_, j) => j).filter((j) => j !== FUNDING);
  // trend rule: in ETH while the price is above where it was `days` ago
  const lookbackSigns = LOOKBACKS.map((days) => samples.map((s) => Math.sign(valueAt(all.eth, s.t) - valueAt(all.eth, s.t - days * DAY))));
  const trend = (days: number): ISignal => ({ name: `trend ${days}d`, firstYear: FIRST_TEST_YEAR, forecast: lookbackSigns[LOOKBACKS.indexOf(days)] });
  const sma200 = FEATURES.indexOf("eth vs 200d avg");

  /** The trend rule a trader could have chosen: every January the lookback with the best IC on the days before. */
  const pickedTrend = (hi: number) => {
    const forecast = samples.map(() => NaN);
    const picks: Record<string, number> = {};
    for (let year = FIRST_TEST_YEAR; year <= yearOf(last); year++) {
      const past = samples
        .map((_, i) => i)
        .filter((i) => samples[i].t + HORIZONS[hi] * DAY <= yearStart(year) && lookbackSigns.every((sign) => Number.isFinite(sign[i])));
      const ics = lookbackSigns.map((sign) =>
        correlation(
          past.map((i) => sign[i]),
          past.map((i) => samples[i].y[hi])
        )
      );
      const best = ics.indexOf(Math.max(...ics));
      picks[year] = LOOKBACKS[best];
      samples.forEach((s, i) => {
        if (yearOf(s.t) === year) forecast[i] = lookbackSigns[best][i];
      });
    }
    return { name: "trend, picked", firstYear: FIRST_TEST_YEAR, forecast, picks };
  };

  const evaluate = (signal: ISignal, hi: number) => {
    const h = HORIZONS[hi];
    // test days: forecast exists and the next day's return is known (contiguous, used by the backtest)
    const days = samples
      .map((_, i) => i)
      .filter((i) => samples[i].t >= yearStart(signal.firstYear) && Number.isFinite(signal.forecast[i]) && Number.isFinite(samples[i].y[0]));
    const scored = days.filter((i) => Number.isFinite(samples[i].y[hi]));
    const f = scored.map((i) => signal.forecast[i]);
    const y = scored.map((i) => samples[i].y[hi]);
    const ic = correlation(f, y);
    const icByYear: Record<string, number> = {};
    Array.from(new Set(scored.map((i) => yearOf(samples[i].t)))).forEach((year) => {
      const inYear = scored.filter((i) => yearOf(samples[i].t) === year);
      icByYear[year] = correlation(
        inYear.map((i) => signal.forecast[i]),
        inYear.map((i) => samples[i].y[hi])
      );
    });
    const run = (positions: number[], step: number) =>
      COSTS.map((cost) => ({
        cost,
        ...backtest(
          days.map((i) => samples[i].t),
          days.map((i) => samples[i].y[0]),
          positions,
          step,
          cost
        ),
      }));
    return {
      name: signal.name,
      from: date(samples[days[0]].t),
      to: date(samples[days[days.length - 1]].t),
      ic,
      t: correlationT(ic, scored.length, h),
      rankIc: correlation(ranks(f), ranks(y)),
      hitRate: mean(f.map((v, k) => Number((v > 0) === (y[k] > 0)))),
      upShare: mean(y.map((v) => Number(v > 0))),
      n: scored.length,
      nIndependent: Math.floor(scored.length / h),
      icByYear,
      yearsPositiveIc: Object.values(icByYear).filter((v) => v > 0).length,
      strategy: run(
        days.map((i) => Number(signal.forecast[i] > 0)),
        h
      ),
      buyHold: run(
        days.map(() => 1),
        1
      ),
    };
  };

  const report = HORIZONS.map((h, hi) => {
    const picked = pickedTrend(hi);
    const signals: ISignal[] = [
      trend(7),
      trend(30),
      trend(90),
      { name: "above 200d avg", firstYear: FIRST_TEST_YEAR, forecast: samples.map((s) => Math.sign(s.x[sma200])) },
      picked,
      { name: "linear", firstYear: FIRST_TEST_YEAR, forecast: walkForward(samples, hi, allColumns, LINEAR_PENALTY, FIRST_TEST_YEAR) },
      { name: "ridge", firstYear: FIRST_TEST_YEAR, forecast: walkForward(samples, hi, allColumns, RIDGE_PENALTY, FIRST_TEST_YEAR) },
      {
        name: "ridge + funding",
        firstYear: FUNDING_FIRST_TEST_YEAR,
        forecast: walkForward(samples, hi, [...allColumns, FUNDING], RIDGE_PENALTY, FUNDING_FIRST_TEST_YEAR),
      },
    ];
    return {
      horizonDays: h,
      trendPicks: picked.picks,
      signals: signals.map((signal) => evaluate(signal, hi)),
      // robustness: does a trend result hold for neighbouring lookbacks, or is one lookback a lucky peak?
      lookbacks: LOOKBACKS.map((days) => evaluate(trend(days), hi)),
    };
  });

  // ---------- tables ----------
  const costLabel = (cost: number) => `net ${+(cost * 100).toFixed(1)}%`;
  const share = (v: number) => `${(v * 100).toFixed(0)}%`;
  const costHeader = COSTS.map((c) => costLabel(c).padStart(11)).join("");
  const returns = (s: ReturnType<typeof evaluate>) => s.strategy.map((r) => pct(r.total).padStart(11)).join("");
  // the swap cost of the current bot; the range shows how much the day of the first decision changes the result
  const startRange = (s: ReturnType<typeof evaluate>) => {
    const r = s.strategy[COSTS.length - 1];
    return `${pct(r.worstStart)} … ${pct(r.bestStart)}`;
  };
  for (const { horizonDays: h, signals, lookbacks, trendPicks } of report) {
    log(`\n${h}-day horizon: a decision every ${h} day(s), held until the next one`, Colors.CYAN);
    log(
      `${"signal".padEnd(17)}${"IC (t)".padStart(16)}${"rank IC".padStart(9)}${"hit".padStart(6)}${"up".padStart(6)}${"yrs IC>0".padStart(9)}` +
        `${costHeader}${"swaps".padStart(7)}${"in ETH".padStart(8)}${"max DD".padStart(8)}   ${costLabel(COSTS[COSTS.length - 1])} by first day`,
      Colors.WHITE
    );
    for (const firstYear of [FIRST_TEST_YEAR, FUNDING_FIRST_TEST_YEAR]) {
      const group = signals.filter((s) => s.from.startsWith(`${firstYear}`));
      if (!group.length) continue;
      const bh = group[0].buyHold;
      log(
        `${`buy & hold ${firstYear}+`.padEnd(17)}${"".padStart(46)}${bh.map((r) => pct(r.total).padStart(11)).join("")}` +
          `${"1".padStart(7)}${"100%".padStart(8)}${pct(-bh[0].maxDrawdown).padStart(8)}`,
        Colors.WHITE
      );
      group.forEach((s) => {
        const beats = s.strategy.map((r, c) => r.total > s.buyHold[c].total);
        log(
          `${s.name.padEnd(17)}${icText(s.ic, s.t).padStart(16)}${signed(s.rankIc, 3).padStart(9)}${share(s.hitRate).padStart(6)}` +
            `${share(s.upShare).padStart(6)}${`${s.yearsPositiveIc}/${Object.keys(s.icByYear).length}`.padStart(9)}${returns(s)}` +
            `${s.strategy[0].swaps.toFixed(0).padStart(7)}${share(s.strategy[0].inMarket).padStart(8)}${pct(-s.strategy[0].maxDrawdown).padStart(8)}` +
            `   ${startRange(s)}`,
          beats[COSTS.length - 1] ? Colors.GREEN : beats.some(Boolean) ? Colors.YELLOW : Colors.WHITE
        );
      });
    }
    log(`  "trend, picked" used: ${Object.keys(trendPicks).map((y) => `${y} ${trendPicks[y]}d`).join(", ")}`, Colors.WHITE);
    log(`  trend rule by lookback (a real effect holds for neighbouring lookbacks, luck makes one lonely peak):`, Colors.WHITE);
    log(`  ${"".padEnd(17)}${"IC (t)".padStart(16)}${"yrs IC>0".padStart(9)}${costHeader}${"swaps".padStart(7)}`, Colors.WHITE);
    lookbacks.forEach((s) =>
      log(
        `  ${s.name.padEnd(17)}${icText(s.ic, s.t).padStart(16)}${`${s.yearsPositiveIc}/${Object.keys(s.icByYear).length}`.padStart(9)}` +
          `${returns(s)}${s.strategy[0].swaps.toFixed(0).padStart(7)}`,
        s.strategy[COSTS.length - 1].total > s.buyHold[COSTS.length - 1].total ? Colors.GREEN : Colors.WHITE
      )
    );
    for (const c of [1, 2]) {
      const years = Object.keys(signals[0].strategy[c].years);
      log(`  by year, ${costLabel(COSTS[c])} per swap:`, Colors.WHITE);
      log(`  ${"".padEnd(17)}${years.map((y) => y.padStart(8)).join("")}`, Colors.WHITE);
      log(`  ${"buy & hold".padEnd(17)}${years.map((y) => pct(signals[0].buyHold[c].years[y]).padStart(8)).join("")}`, Colors.WHITE);
      signals.forEach((s) =>
        log(`  ${s.name.padEnd(17)}${years.map((y) => (y in s.strategy[c].years ? pct(s.strategy[c].years[y]) : "").padStart(8)).join("")}`, Colors.WHITE)
      );
    }
  }
  log(
    `\nIC = correlation of the forecast with the actual return (t ≥ 2 needed, ≥ ${SIGNIFICANT_T} with this many checks); ` +
      `hit = share of correct directions, up = share of rising periods (what "always up" scores); swaps / in ETH / max DD ` +
      `at zero cost, averaged over the possible first decision days. Green = beats buy & hold at ${costLabel(COSTS[COSTS.length - 1])}, ` +
      `yellow = only at a lower cost.`,
    Colors.WHITE
  );

  const file = `${cryptoConfig.paths.storageDir}/daily-horizon-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(
    file,
    {
      pair: "ETH-USDT",
      data: {
        from: date(all.eth.times[0]),
        to: date(last),
        ethCandles: ethCandles.length,
        missingHours,
        btcCandles: btcCandles.length,
        fundingRows: fundingRows.length,
      },
      settings: {
        horizons: HORIZONS,
        costs: COSTS,
        decisionTimeUtc: "00:00",
        firstTestYear: FIRST_TEST_YEAR,
        fundingFirstTestYear: FUNDING_FIRST_TEST_YEAR,
        linearPenalty: LINEAR_PENALTY,
        ridgePenalty: RIDGE_PENALTY,
        trendLookbacks: LOOKBACKS,
      },
      features: featureIc,
      horizons: report,
    },
    { spaces: 2 }
  );
  log(`report saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();
