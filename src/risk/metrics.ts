/**
 * Performance statistics of an equity curve.
 *
 * All of these are computed on net per-bar returns — after fees and slippage. A gross Sharpe on a 5-minute
 * strategy is not a weaker version of the net number, it is a different and much larger number, so the two
 * are never mixed here.
 */
import { BARS_PER_YEAR_5MIN } from "./breakeven";

export interface IPerformanceMetrics {
  /** total net return over the whole period, as a fraction of starting equity */
  netReturn: number;
  /** net return expressed per year by compounding, as a fraction */
  annualisedReturn: number;
  /** mean net return of one bar, in bps — the number break-even analysis predicts */
  meanBarReturnBps: number;
  /** standard deviation of net per-bar returns, annualised, as a fraction */
  annualisedVolatility: number;
  /** annualised Sharpe at a zero risk-free rate; null when there is no variation to divide by */
  sharpe: number | null;
  /** like Sharpe but penalising only downside deviation */
  sortino: number | null;
  /** worst peak-to-trough fall of the equity curve, as a positive fraction */
  maxDrawdown: number;
  /** annualised return divided by max drawdown; null when there was no drawdown */
  calmar: number | null;
}

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Running peak-to-trough: the number a drawdown kill-switch is written against. */
export const maxDrawdown = (equityCurve: number[]): number => {
  let peak = -Infinity;
  let worst = 0;

  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
};

/**
 * Metrics of a net per-bar return series and the equity curve it produced.
 *
 * `barsPerYear` is what turns a per-bar Sharpe into an annual one. For 5-minute bars on a market that never
 * closes this is 105,120, and the sqrt of that is ~324 — which is why a per-bar edge far too small to see is
 * still a large Sharpe if it is real and stable. It also cuts the other way: a small per-bar cost drag
 * annualises into a large negative Sharpe.
 */
export const performanceMetrics = (
  netBarReturns: number[],
  equityCurve: number[],
  barsPerYear = BARS_PER_YEAR_5MIN
): IPerformanceMetrics => {
  const startEquity = equityCurve[0];
  const endEquity = equityCurve[equityCurve.length - 1];
  const netReturn = startEquity === 0 ? 0 : endEquity / startEquity - 1;
  const drawdown = maxDrawdown(equityCurve);

  if (netBarReturns.length === 0) {
    return {
      netReturn,
      annualisedReturn: 0,
      meanBarReturnBps: 0,
      annualisedVolatility: 0,
      sharpe: null,
      sortino: null,
      maxDrawdown: drawdown,
      calmar: null,
    };
  }

  const avg = mean(netBarReturns);
  const std = Math.sqrt(mean(netBarReturns.map((r) => (r - avg) ** 2)));
  // downside deviation: upside volatility is not a risk we are trying to avoid
  const downside = Math.sqrt(mean(netBarReturns.map((r) => (r < 0 ? r * r : 0))));

  const years = netBarReturns.length / barsPerYear;
  // compounded, so a curve that halves and doubles is not reported as flat growth
  const annualisedReturn = years > 0 && netReturn > -1 ? Math.pow(1 + netReturn, 1 / years) - 1 : 0;
  const annualisationFactor = Math.sqrt(barsPerYear);

  return {
    netReturn,
    annualisedReturn,
    meanBarReturnBps: avg * 1e4,
    annualisedVolatility: std * annualisationFactor,
    sharpe: std > 0 ? (avg / std) * annualisationFactor : null,
    sortino: downside > 0 ? (avg / downside) * annualisationFactor : null,
    maxDrawdown: drawdown,
    calmar: drawdown > 0 ? annualisedReturn / drawdown : null,
  };
};
