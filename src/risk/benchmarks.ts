/**
 * Benchmarks a strategy report has to be read against.
 *
 * A net-positive backtest is not evidence of skill on its own. Two comparisons make it meaningful:
 *
 *  - **buy and hold**: if the strategy earns less than simply holding ETH over the same window, the model has
 *    produced nothing but turnover, however good its Sharpe looks.
 *  - **random signals**: the distribution of outcomes from predictions with no information, traded at the same
 *    cadence and charged the same costs. This is the null hypothesis. A strategy inside the random
 *    distribution has not been shown to work, and a strategy that trades often will usually find that the
 *    random distribution is entirely below zero — which is the cost drag made visible.
 */
import { IBacktestBar } from "./bars";
import { IBacktestOptions, IBacktestReport, IPrediction, runBacktest } from "./backtester";
import { createRng, percentile } from "./random";

/**
 * Hold one unit of exposure for the whole period: one entry at the start, one exit at the end.
 *
 * Implemented through the same engine as the strategy so that fees, slippage and the next-bar execution rule
 * are identical. A benchmark computed by a different code path is not a comparison.
 */
export const buyAndHoldReport = (
  bars: IBacktestBar[],
  options: IBacktestOptions = {},
  label = "buy and hold"
): IBacktestReport => {
  const predictions: IPrediction[] = bars.map((bar) => ({ time: bar.time, direction: 1 as const }));
  return runBacktest(bars, predictions, { ...options, positionMode: "target-exposure" }, label);
};

export interface IRandomBenchmarkSummary {
  runs: number;
  /** fraction of bars on which a random run takes a position, matched to the strategy */
  tradeProbability: number;
  netReturn: { mean: number; p5: number; p50: number; p95: number };
  sharpe: { mean: number; p5: number; p50: number; p95: number };
  maxDrawdown: { mean: number; p50: number; p95: number };
  meanTradeCount: number;
  meanTotalCostQuote: number;
  /** fraction of random runs that finished with a positive net return */
  shareProfitable: number;
}

const summarise = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    p5: percentile(sorted, 0.05),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
};

/**
 * Run `runs` independent coin-flip strategies over the same bars and costs.
 *
 * `tradeProbability` should be set to the share of bars the real strategy takes a position on, so the random
 * benchmark pays a comparable amount of cost. Comparing a selective strategy against a random one that trades
 * every bar would flatter the strategy for free.
 */
export const randomSignalBenchmark = (
  bars: IBacktestBar[],
  options: IBacktestOptions = {},
  runs = 200,
  tradeProbability = 1,
  seed = 12345
): IRandomBenchmarkSummary => {
  const netReturns: number[] = [];
  const sharpes: number[] = [];
  const drawdowns: number[] = [];
  let tradeCountSum = 0;
  let costSum = 0;

  for (let run = 0; run < runs; run += 1) {
    const rng = createRng(seed + run);
    const predictions: IPrediction[] = bars.map((bar) => ({
      time: bar.time,
      direction: rng() > tradeProbability ? 0 : rng() < 0.5 ? -1 : 1,
    }));

    const report = runBacktest(bars, predictions, options, `random #${run}`);
    netReturns.push(report.metrics.netReturn);
    if (report.metrics.sharpe !== null) sharpes.push(report.metrics.sharpe);
    drawdowns.push(report.metrics.maxDrawdown);
    tradeCountSum += report.tradeCount;
    costSum += report.totalCostQuote;
  }

  const drawdownSorted = [...drawdowns].sort((a, b) => a - b);

  return {
    runs,
    tradeProbability,
    netReturn: summarise(netReturns),
    sharpe: sharpes.length > 0 ? summarise(sharpes) : { mean: 0, p5: 0, p50: 0, p95: 0 },
    maxDrawdown: {
      mean: drawdowns.reduce((sum, v) => sum + v, 0) / drawdowns.length,
      p50: percentile(drawdownSorted, 0.5),
      p95: percentile(drawdownSorted, 0.95),
    },
    meanTradeCount: tradeCountSum / runs,
    meanTotalCostQuote: costSum / runs,
    shareProfitable: netReturns.filter((r) => r > 0).length / runs,
  };
};

/**
 * Where the strategy's net return sits inside the random distribution, as a fraction in [0, 1].
 *
 * This is the honest read of a backtest: 0.5 means indistinguishable from chance, and anything below ~0.95
 * has not cleared the bar that a single backtest can clear.
 */
export const percentileVsRandom = (
  strategyNetReturn: number,
  bars: IBacktestBar[],
  options: IBacktestOptions = {},
  runs = 200,
  tradeProbability = 1,
  seed = 12345
): number => {
  const netReturns: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const rng = createRng(seed + run);
    const predictions: IPrediction[] = bars.map((bar) => ({
      time: bar.time,
      direction: rng() > tradeProbability ? 0 : rng() < 0.5 ? -1 : 1,
    }));
    netReturns.push(runBacktest(bars, predictions, options, `random #${run}`).metrics.netReturn);
  }
  return netReturns.filter((r) => r < strategyNetReturn).length / runs;
};
