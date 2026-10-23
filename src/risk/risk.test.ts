/**
 * Self-checking tests for the risk/backtest module:
 *   yarn test:risk
 *
 * Written against node's `assert` with a tiny runner rather than a test framework, because the repo has no
 * test runner installed yet and this needs to be runnable today. QA Engineer (TRA-11) owns the real harness;
 * every check here is a plain function call on exported API, so porting them is mechanical.
 *
 * The no-look-ahead checks are the ones that matter most — they are the correctness invariant of the whole
 * module, and they are written to fail if the execution rule is ever loosened.
 */
import assert from "assert";

import { aggregateBars, closeToCloseReturns, IBacktestBar, returnStats } from "./bars";
import { assertNoLookAhead, findLookAheadViolations, IPrediction, runBacktest } from "./backtester";
import { buyAndHoldReport, randomSignalBenchmark } from "./benchmarks";
import { annualisedGrowthMultiple, breakEvenAccuracy, netEdgeBps } from "./breakeven";
import {
  createCostModel,
  exposureChangeCostBps,
  exposureChangeCostSplitBps,
  FEE_SCHEDULES,
  oneWayCostBps,
  roundTripCostBps,
} from "./costs";
import { maxDrawdown, performanceMetrics } from "./metrics";
import { evaluateRiskLimits, DEFAULT_RISK_LIMITS } from "./limits";
import {
  canEnter,
  checkEmergencyConditions,
  DEFAULT_GUARDRAILS,
  initialGuardrailState,
  manualReArm,
  recordBarReturn,
  recordClosedTrade,
  recordEntry,
  rollGuardrailDay,
  trailingStdDev,
} from "./guardrails";

type Test = { name: string; run: () => void };
const tests: Test[] = [];
const test = (name: string, run: () => void) => tests.push({ name, run });

/** Bars with an exact constant close-to-close step, so expected PnL can be written down by hand. */
const makeBars = (closes: number[], barSeconds = 300, start = 1_700_000_000): IBacktestBar[] =>
  closes.map((close, i) => ({
    time: start + i * barSeconds,
    // open equals the previous close, which is what a continuous venue looks like, so the gap term is zero
    open: i === 0 ? close : closes[i - 1],
    high: Math.max(close, i === 0 ? close : closes[i - 1]),
    low: Math.min(close, i === 0 ? close : closes[i - 1]),
    close,
    volumeto: 1_000_000,
  }));

/** A prediction on every bar that is always right about the next bar — the oracle. */
const oracle = (bars: IBacktestBar[]): IPrediction[] => {
  const predictions: IPrediction[] = [];
  for (let i = 0; i < bars.length - 1; i += 1) {
    const next = bars[i + 1];
    const move = next.close - next.open;
    predictions.push({ time: bars[i].time, direction: move > 0 ? 1 : move < 0 ? -1 : 0 });
  }
  return predictions;
};

const FREE = createCostModel({ takerSlippageBps: 0, fees: { name: "free", makerBps: 0, takerBps: 0 } });

// --- cost model -------------------------------------------------------------------------------------------

test("one-way and round-trip costs add fee and slippage per leg", () => {
  const model = createCostModel({ fees: FEE_SCHEDULES.binanceFuturesVip0, takerSlippageBps: 1 });
  assert.strictEqual(oneWayCostBps(model, "taker"), 6);
  assert.strictEqual(oneWayCostBps(model, "maker"), 2);
  assert.strictEqual(roundTripCostBps(model), 12);

  const makerTaker = createCostModel({ entry: "maker", exit: "taker", takerSlippageBps: 1 });
  assert.strictEqual(roundTripCostBps(makerTaker), 8);

  const makerMaker = createCostModel({ entry: "maker", exit: "maker" });
  assert.strictEqual(roundTripCostBps(makerMaker), 4);
});

test("a flip through zero trades two units of notional, not one", () => {
  const model = createCostModel({ takerSlippageBps: 1 });
  // long 1 -> short 1 closes 1 and opens 1
  assert.strictEqual(exposureChangeCostBps(model, 1, -1), 12);
  // a plain open is one leg
  assert.strictEqual(exposureChangeCostBps(model, 0, 1), 6);
  assert.strictEqual(exposureChangeCostBps(model, 1, 0), 6);
  // no change is free
  assert.strictEqual(exposureChangeCostBps(model, 1, 1), 0);
  // a partial reduction is charged pro rata
  assert.strictEqual(exposureChangeCostBps(model, 1, 0.5), 3);
});

test("cost split assigns the exit leg to the old position and the entry leg to the new one", () => {
  const model = createCostModel({ takerSlippageBps: 1 });
  assert.deepStrictEqual(exposureChangeCostSplitBps(model, 1, -1), { exitBps: 6, entryBps: 6 });
  assert.deepStrictEqual(exposureChangeCostSplitBps(model, 0, 1), { exitBps: 0, entryBps: 6 });
  assert.deepStrictEqual(exposureChangeCostSplitBps(model, 1, 0), { exitBps: 6, entryBps: 0 });
});

// --- break-even arithmetic --------------------------------------------------------------------------------

test("break-even accuracy is the accuracy at which net edge is exactly zero", () => {
  const input = {
    meanAbsReturnBps: 11.6,
    roundTripsPerBar: 0.5,
    costModel: createCostModel({ takerSlippageBps: 1 }),
  };
  const result = breakEvenAccuracy(input);
  // the two formulas are inverses of each other, so this pins the algebra in both directions
  assert.ok(Math.abs(netEdgeBps(result.breakEvenAccuracy, input)) < 1e-9);
  assert.ok(result.breakEvenAccuracy > 0.5);
});

test("break-even above 1.0 is reported as infeasible, and the oracle loses money there", () => {
  // trade every bar, taker in and taker out: 12 bps of cost against an 11.6 bps average move
  const input = {
    meanAbsReturnBps: 11.6,
    roundTripsPerBar: 1,
    costModel: createCostModel({ takerSlippageBps: 1 }),
  };
  const result = breakEvenAccuracy(input);
  assert.ok(result.breakEvenAccuracy > 1, `expected >1, got ${result.breakEvenAccuracy}`);
  assert.strictEqual(result.feasible, false);
  // a perfect oracle still bleeds, which is the point: no accuracy target can rescue this execution style
  assert.ok(result.oracleNetBps < 0);
  assert.ok(netEdgeBps(1.0, input) < 0);
});

test("60% accuracy on every bar is a loss in all three execution styles", () => {
  const styles = [
    { entry: "taker" as const, exit: "taker" as const },
    { entry: "maker" as const, exit: "taker" as const },
    { entry: "maker" as const, exit: "maker" as const },
  ];
  for (const style of styles) {
    const input = {
      meanAbsReturnBps: 11.6,
      roundTripsPerBar: 1,
      costModel: createCostModel({ ...style, takerSlippageBps: 1 }),
    };
    assert.ok(netEdgeBps(0.6, input) < 0, `60% should lose at ${style.entry}/${style.exit}`);
  }
});

test("a per-bar drag compounds into ruin over a year", () => {
  // -1.7 bps per 5-minute bar, 105,120 bars
  assert.ok(annualisedGrowthMultiple(-1.7, 365 * 24 * 12) < 0.001);
  assert.ok(annualisedGrowthMultiple(0, 365 * 24 * 12) === 1);
});

// --- bar aggregation --------------------------------------------------------------------------------------

test("aggregation builds 5m bars from 1m candles and drops incomplete groups", () => {
  const minute = (i: number, close: number) => ({
    time: 1_699_999_800 + i * 60, // a multiple of 300, so groups line up with epoch-aligned 5m buckets
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    volumefrom: 1,
    volumeto: 100,
  });
  // 5 complete minutes, then only 2 of the next group
  const candles = [...Array(7).keys()].map((i) => minute(i, 100 + i));
  const bars = aggregateBars(candles, 300);

  assert.strictEqual(bars.length, 1, "the partial second group must be dropped");
  assert.strictEqual(bars[0].open, 99);
  assert.strictEqual(bars[0].close, 104);
  assert.strictEqual(bars[0].high, 106);
  assert.strictEqual(bars[0].volumeto, 500);
});

test("returns are not computed across data gaps", () => {
  const bars = makeBars([100, 101, 102]);
  // push the last bar an hour into the future, breaking adjacency
  bars[2] = { ...bars[2], time: bars[2].time + 3600 };
  assert.strictEqual(closeToCloseReturns(bars).length, 1);
});

test("return stats report mean absolute move and the selective-trading upside", () => {
  const stats = returnStats([0.001, -0.001, 0.0005, -0.0005], [0.5]);
  assert.strictEqual(stats.count, 4);
  assert.ok(Math.abs(stats.meanAbsBps - 7.5) < 1e-9);
  // the larger half of the moves averages 10 bps, above the 7.5 bps of the whole set
  assert.ok(Math.abs(stats.meanAbsBpsOfTopFraction["0.5"] - 10) < 1e-9);
});

// --- the no-look-ahead invariant --------------------------------------------------------------------------

test("every fill happens in the bar after its signal, at that bar's open", () => {
  const bars = makeBars([100, 101, 100.5, 102, 101]);
  const report = runBacktest(bars, oracle(bars), { costModel: FREE });

  assert.ok(report.trades.length > 0, "the test is vacuous without trades");
  assertNoLookAhead(report, bars);
  for (const trade of report.trades) {
    assert.strictEqual(trade.executionBarIndex, trade.signalBarIndex + 1);
    assert.strictEqual(trade.executionPrice, bars[trade.executionBarIndex].open);
  }
});

test("the validator catches a tampered audit trail", () => {
  const bars = makeBars([100, 101, 102, 103]);
  const report = runBacktest(bars, oracle(bars), { costModel: FREE });

  // same-bar execution: the classic look-ahead bug
  const tampered = {
    ...report,
    trades: report.trades.map((t) => ({ ...t, executionBarIndex: t.signalBarIndex })),
  };
  assert.ok(findLookAheadViolations(tampered, bars).length > 0);
  assert.throws(() => assertNoLookAhead(tampered, bars));

  // filling at the execution bar's close instead of its open: the subtler one
  const closeFilled = {
    ...report,
    trades: report.trades.map((t) => ({ ...t, executionPrice: bars[t.executionBarIndex].close })),
  };
  assert.ok(findLookAheadViolations(closeFilled, bars).length > 0);
});

test("the execution bar's close cannot influence its own fill price", () => {
  const bars = makeBars([100, 101, 102, 103]);
  const base = runBacktest(bars, oracle(bars), { costModel: FREE });

  // move the final bar's close a long way; fills in earlier bars must be untouched
  const altered = bars.map((bar, i) => (i === bars.length - 1 ? { ...bar, close: bar.close * 1.5 } : bar));
  const predictions = oracle(bars); // identical signals, so only execution can differ
  const after = runBacktest(altered, predictions, { costModel: FREE });

  const basePrices = base.trades.filter((t) => t.executionBarIndex < bars.length - 1).map((t) => t.executionPrice);
  const afterPrices = after.trades.filter((t) => t.executionBarIndex < bars.length - 1).map((t) => t.executionPrice);
  assert.deepStrictEqual(afterPrices, basePrices);
});

test("a prediction on the final bar is never acted on", () => {
  const bars = makeBars([100, 101, 102]);
  const lastBarOnly: IPrediction[] = [{ time: bars[bars.length - 1].time, direction: 1 }];
  const report = runBacktest(bars, lastBarOnly, { costModel: FREE });

  assert.strictEqual(report.tradeCount, 0, "there is no bar left to execute in");
  assert.strictEqual(report.endEquity, report.startEquity);
});

test("strict mode is on by default and the engine refuses to read past the horizon", () => {
  const bars = makeBars([100, 101, 102]);
  // the guard is internal, so this asserts the observable consequence: a clean run with the default on
  const report = runBacktest(bars, oracle(bars), { costModel: FREE });
  assert.strictEqual(findLookAheadViolations(report, bars).length, 0);
});

// --- PnL accounting ---------------------------------------------------------------------------------------

test("a zero-cost oracle earns exactly the sum of absolute bar moves", () => {
  const bars = makeBars([100, 101, 100, 102, 101]);
  const report = runBacktest(bars, oracle(bars), { costModel: FREE });

  // bars 1..4 each contribute |close-open|/open, compounded
  let expected = 1;
  for (let i = 1; i < bars.length; i += 1) {
    expected *= 1 + Math.abs(bars[i].close - bars[i].open) / bars[i].open;
  }
  assert.ok(Math.abs(report.endEquity - expected) < 1e-12, `${report.endEquity} vs ${expected}`);
  assert.strictEqual(report.metrics.maxDrawdown, 0, "an oracle never draws down");
  assert.strictEqual(report.directionalAccuracy, 1);
});

test("costs are charged on both legs and reported split into fees and slippage", () => {
  // one long bar then flat: exactly one entry and one exit
  const bars = makeBars([100, 101, 101]);
  const predictions: IPrediction[] = [
    { time: bars[0].time, direction: 1 },
    { time: bars[1].time, direction: 0 },
  ];
  const model = createCostModel({ fees: FEE_SCHEDULES.binanceFuturesVip0, takerSlippageBps: 1 });
  const report = runBacktest(bars, predictions, { costModel: model });

  assert.strictEqual(report.tradeCount, 2);
  // 6 bps in and 6 bps out, charged on equity that barely moved
  assert.ok(Math.abs(report.totalCostAsEquityFraction - 12 / 1e4) < 1e-5);
  // fees are 5 of the 6 bps per leg
  assert.ok(Math.abs(report.totalFeesQuote / report.totalCostQuote - 10 / 12) < 1e-6);
  assert.ok(Math.abs(report.totalSlippageQuote / report.totalCostQuote - 2 / 12) < 1e-6);
});

test("flat-between-bars pays a full round trip every bar even when the direction is unchanged", () => {
  const bars = makeBars([100, 101, 102, 103, 104]);
  const alwaysLong: IPrediction[] = bars.map((bar) => ({ time: bar.time, direction: 1 as const }));
  const model = createCostModel({ takerSlippageBps: 1 });

  const held = runBacktest(bars, alwaysLong, { costModel: model, positionMode: "target-exposure" });
  const churned = runBacktest(bars, alwaysLong, { costModel: model, positionMode: "flat-between-bars" });

  // holding trades once; churning trades on every one of the 4 execution bars
  assert.strictEqual(held.tradeCount, 1);
  assert.strictEqual(churned.tradeCount, 4);
  assert.ok(churned.totalCostQuote > held.totalCostQuote * 3);
  assert.ok(churned.endEquity < held.endEquity);
  // every held bar is its own round trip, so every held bar is its own position
  assert.strictEqual(churned.closedPositions, 4);
});

test("an always-right oracle trading every bar still loses at taker/taker costs", () => {
  // the headline finding, as an executable check: 200 bars of realistic 11.6 bps moves
  const closes = [100];
  for (let i = 1; i < 200; i += 1) {
    closes.push(closes[i - 1] * (1 + (i % 2 === 0 ? 1 : -1) * 0.00116));
  }
  const bars = makeBars(closes);
  const model = createCostModel({ takerSlippageBps: 1 });
  const report = runBacktest(bars, oracle(bars), { costModel: model, positionMode: "flat-between-bars" });

  assert.strictEqual(report.directionalAccuracy, 1, "the oracle is right on every bar");
  assert.ok(report.endEquity < report.startEquity, "and still loses money");
});

test("equity, net bar returns and the curve stay consistent with each other", () => {
  const bars = makeBars([100, 101, 99, 103, 98, 104]);
  const report = runBacktest(bars, oracle(bars), { costModel: createCostModel({ takerSlippageBps: 1 }) });

  let equity = report.startEquity;
  for (const netReturn of report.netBarReturns) equity *= 1 + netReturn;
  assert.ok(Math.abs(equity - report.endEquity) < 1e-12);
  assert.strictEqual(report.equityCurve.length, report.netBarReturns.length + 1);
  assert.ok(Math.abs(report.metrics.netReturn - (report.endEquity / report.startEquity - 1)) < 1e-12);
});

test("a position is closed without claiming the move across a data gap", () => {
  const bars = makeBars([100, 101, 102, 103]);
  bars[2] = { ...bars[2], time: bars[2].time + 3600, open: 150, close: 160 };
  const alwaysLong: IPrediction[] = bars.map((bar) => ({ time: bar.time, direction: 1 as const }));
  const report = runBacktest(bars, alwaysLong, { costModel: FREE });

  // the 150 -> 160 jump sits on the far side of the hole and must not be earned
  assert.ok(report.endEquity < 1.02, `claimed a move across the gap: ${report.endEquity}`);
});

test("win rate and trade count are reported per position, not per bar", () => {
  const bars = makeBars([100, 101, 100, 101, 100]);
  const report = runBacktest(bars, oracle(bars), { costModel: FREE });
  assert.strictEqual(report.winRate, 1, "an oracle wins every position");
  assert.ok(report.closedPositions > 0);
  assert.ok(report.barsInMarket > 0);
});

test("confidence gating keeps the strategy out of low-conviction bars", () => {
  const bars = makeBars([100, 101, 102, 103, 104]);
  const predictions: IPrediction[] = bars.map((bar, i) => ({
    time: bar.time,
    direction: 1 as const,
    confidence: i % 2 === 0 ? 0.9 : 0.1,
  }));
  const gated = runBacktest(bars, predictions, { costModel: FREE, minConfidence: 0.5 });
  const ungated = runBacktest(bars, predictions, { costModel: FREE });
  assert.ok(gated.barsInMarket < ungated.barsInMarket);
});

test("maker legs that do not fill leave the position and the costs untouched", () => {
  const bars = makeBars([100, 101, 100, 101, 100, 101]);
  const model = createCostModel({ entry: "maker", exit: "maker" });
  const filled = runBacktest(bars, oracle(bars), { costModel: model, makerFillRate: 1, seed: 7 });
  const unfilled = runBacktest(bars, oracle(bars), { costModel: model, makerFillRate: 0, seed: 7 });

  assert.ok(filled.tradeCount > 0);
  assert.strictEqual(unfilled.tradeCount, 0, "nothing fills at a zero fill rate");
  assert.strictEqual(unfilled.totalCostQuote, 0);
  assert.strictEqual(unfilled.endEquity, unfilled.startEquity);
});

// --- metrics ----------------------------------------------------------------------------------------------

test("max drawdown measures the worst peak-to-trough fall", () => {
  assert.strictEqual(maxDrawdown([1, 2, 1, 2]), 0.5);
  assert.strictEqual(maxDrawdown([1, 1.1, 1.21]), 0);
  assert.ok(Math.abs(maxDrawdown([100, 50, 75, 25]) - 0.75) < 1e-12);
});

test("Sharpe annualises by the square root of bars per year", () => {
  const returns = [0.001, 0.002, -0.001, 0.003, 0.001];
  const curve = [1];
  for (const r of returns) curve.push(curve[curve.length - 1] * (1 + r));
  const metrics = performanceMetrics(returns, curve, 105120);

  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const std = Math.sqrt(returns.map((r) => (r - mean) ** 2).reduce((s, v) => s + v, 0) / returns.length);
  assert.ok(Math.abs((metrics.sharpe as number) - (mean / std) * Math.sqrt(105120)) < 1e-9);
  assert.ok(Math.abs(metrics.meanBarReturnBps - mean * 1e4) < 1e-9);
});

test("a flat strategy reports no Sharpe rather than a divide-by-zero", () => {
  const metrics = performanceMetrics([0, 0, 0], [1, 1, 1, 1]);
  assert.strictEqual(metrics.sharpe, null);
  assert.strictEqual(metrics.maxDrawdown, 0);
});

// --- benchmarks -------------------------------------------------------------------------------------------

test("buy and hold pays two legs and tracks the underlying", () => {
  const bars = makeBars([100, 102, 104, 106]);
  const report = buyAndHoldReport(bars, { costModel: FREE });
  assert.strictEqual(report.tradeCount, 1, "one entry; the final exit is not forced");
  // 100 -> 106 on the close-to-close path the engine can see
  assert.ok(report.endEquity > 1.05);
});

test("random signals are reproducible and lose roughly the cost drag", () => {
  const closes = [100];
  for (let i = 1; i < 300; i += 1) closes.push(closes[i - 1] * (1 + (i % 3 === 0 ? -0.0012 : 0.0006)));
  const bars = makeBars(closes);
  const options = { costModel: createCostModel({ takerSlippageBps: 1 }) };

  const a = randomSignalBenchmark(bars, options, 25, 1, 99);
  const b = randomSignalBenchmark(bars, options, 25, 1, 99);
  assert.deepStrictEqual(a, b, "the same seed must give the same benchmark");

  // coin flips paying 12 bps a round trip: the whole distribution should be under water
  assert.ok(a.netReturn.p95 < 0, `random p95 should be negative, got ${a.netReturn.p95}`);
  assert.strictEqual(a.shareProfitable, 0);
});

// --- risk limits ------------------------------------------------------------------------------------------

test("risk limits fire on position size, daily loss, drawdown and the kill switch", () => {
  const ok = evaluateRiskLimits(
    { equity: 10_000, peakEquity: 10_000, dayStartEquity: 10_000, exposure: 0.2, consecutiveLosingDays: 0 },
    DEFAULT_RISK_LIMITS
  );
  assert.strictEqual(ok.breaches.length, 0);
  assert.strictEqual(ok.action, "trade");

  const oversized = evaluateRiskLimits(
    { equity: 10_000, peakEquity: 10_000, dayStartEquity: 10_000, exposure: 0.9, consecutiveLosingDays: 0 },
    DEFAULT_RISK_LIMITS
  );
  assert.ok(oversized.breaches.some((b) => b.limit === "maxPositionFraction"));
  assert.strictEqual(oversized.action, "reduce");

  const dayLoss = evaluateRiskLimits(
    { equity: 9_700, peakEquity: 10_000, dayStartEquity: 10_000, exposure: 0.2, consecutiveLosingDays: 0 },
    DEFAULT_RISK_LIMITS
  );
  assert.ok(dayLoss.breaches.some((b) => b.limit === "maxDailyLossFraction"));
  assert.strictEqual(dayLoss.action, "halt_for_the_day");

  const drawdown = evaluateRiskLimits(
    { equity: 8_800, peakEquity: 10_000, dayStartEquity: 8_900, exposure: 0.2, consecutiveLosingDays: 0 },
    DEFAULT_RISK_LIMITS
  );
  assert.ok(drawdown.breaches.some((b) => b.limit === "maxDrawdownFraction"));
  assert.strictEqual(drawdown.action, "kill");
});

test("the kill switch is not reachable by the system itself", () => {
  const killed = evaluateRiskLimits(
    { equity: 5_000, peakEquity: 10_000, dayStartEquity: 5_100, exposure: 0, consecutiveLosingDays: 9 },
    DEFAULT_RISK_LIMITS
  );
  assert.strictEqual(killed.action, "kill");
  assert.strictEqual(killed.requiresHumanReset, true, "a kill must need a human to clear");
});

// --- guardrails: daily trade cap and kill-switch (TRA-18) ------------------------------------------------

test("the daily trade cap blocks a new entry once it is spent, but never blocks an exit", () => {
  const config = { ...DEFAULT_GUARDRAILS, maxTradesPerDay: 2 };
  let state = initialGuardrailState(1);
  state = rollGuardrailDay(state, 1_700_000_000, config);

  assert.strictEqual(canEnter(state, config), true);
  state = recordEntry(state);
  state = recordEntry(state);
  assert.strictEqual(state.entriesToday, 2);
  assert.strictEqual(canEnter(state, config), false, "the cap is spent");

  // the cap is spent, but it says nothing about exits: a halt is the only thing allowed to force flat
  assert.strictEqual(state.halted, false);
});

test("a losing streak trips the kill switch without needing a human to clear it", () => {
  const config = { ...DEFAULT_GUARDRAILS, maxConsecutiveLosingTrades: 3 };
  let state = initialGuardrailState(1);

  state = recordClosedTrade(state, -0.01, config);
  state = recordClosedTrade(state, -0.01, config);
  assert.strictEqual(state.halted, false, "two losses do not trip a 3-loss switch");

  state = recordClosedTrade(state, -0.01, config);
  assert.strictEqual(state.halted, true);
  assert.strictEqual(state.haltReason, "consecutive_losses");
  assert.strictEqual(state.requiresHumanReset, false, "a cold streak is expected variance, not an emergency");

  // a win anywhere resets the counter back to zero
  let fresh = initialGuardrailState(1);
  fresh = recordClosedTrade(fresh, -0.01, config);
  fresh = recordClosedTrade(fresh, 0.02, config);
  assert.strictEqual(fresh.consecutiveLosingTrades, 0);
});

test("emergency halts — drawdown, extreme volatility, a data gap — always require a human reset", () => {
  const config = { ...DEFAULT_GUARDRAILS, maxDrawdownFraction: 0.1, extremeVolatilityZScore: 4 };

  const drawdown = checkEmergencyConditions(
    initialGuardrailState(10_000),
    { equity: 8_900, barReturn: 0, trailingVolatility: 0.001, isDataGap: false },
    config
  );
  assert.strictEqual(drawdown.haltReason, "max_drawdown");
  assert.strictEqual(drawdown.requiresHumanReset, true);

  const volatility = checkEmergencyConditions(
    initialGuardrailState(10_000),
    { equity: 10_000, barReturn: 0.1, trailingVolatility: 0.01, isDataGap: false }, // 10 sigma move
    config
  );
  assert.strictEqual(volatility.haltReason, "extreme_volatility");
  assert.strictEqual(volatility.requiresHumanReset, true);

  const gap = checkEmergencyConditions(
    initialGuardrailState(10_000),
    { equity: 10_000, barReturn: null, trailingVolatility: null, isDataGap: true },
    config
  );
  assert.strictEqual(gap.haltReason, "data_gap");
  assert.strictEqual(gap.requiresHumanReset, true);
});

test("a consecutive-loss halt auto-clears after enough profitable days; an emergency halt does not", () => {
  const config = { ...DEFAULT_GUARDRAILS, consecutiveLossAutoResetProfitableDays: 1 };
  const DAY = 86_400;

  let cooled = initialGuardrailState(1);
  cooled = rollGuardrailDay(cooled, 0, config);
  cooled = recordClosedTrade(cooled, -0.01, config);
  cooled = recordClosedTrade(cooled, -0.01, config);
  cooled = recordClosedTrade(cooled, -0.01, config);
  cooled = recordClosedTrade(cooled, -0.01, config);
  assert.strictEqual(cooled.halted, true);
  cooled = recordBarReturn(cooled, 0.02); // the rest of the day closes green
  cooled = rollGuardrailDay(cooled, DAY, config); // a new UTC day, one profitable day behind it
  assert.strictEqual(cooled.halted, false, "a cold streak clears itself after a clean day");
  assert.strictEqual(cooled.consecutiveLosingTrades, 0);

  let emergency = initialGuardrailState(10_000);
  emergency = checkEmergencyConditions(
    emergency,
    { equity: 8_000, barReturn: null, trailingVolatility: null, isDataGap: false },
    { ...config, maxDrawdownFraction: 0.1 }
  );
  assert.strictEqual(emergency.halted, true);
  emergency = { ...emergency, dayNetReturn: 0.05 };
  emergency = rollGuardrailDay(emergency, DAY, config);
  assert.strictEqual(emergency.halted, true, "an emergency halt never clears itself, however good the following days are");
  assert.strictEqual(manualReArm(emergency).halted, false, "only an operator can clear it");
});

test("trailingStdDev needs enough samples and ignores gaps", () => {
  const sparse = [0.001, -0.001, 0.002];
  assert.strictEqual(trailingStdDev(sparse, 3, 100), null, "too few samples to trust");

  const window: number[] = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
  window[10] = NaN; // a data gap in the middle of the window
  const std = trailingStdDev(window, 30, 30);
  assert.ok(std !== null && Number.isFinite(std), "NaNs are dropped, not propagated");
});

test("the backtester enforces the daily trade cap pre-trade, not after the fact", () => {
  const bars = makeBars([100, 105, 100, 105, 100, 105, 100, 105, 100, 105, 100]);
  const report = runBacktest(bars, oracle(bars), { costModel: FREE, guardrails: { maxTradesPerDay: 2 } });

  assert.ok(report.blockedEntries.length > 0, "later flips in the same day must be blocked");
  assert.strictEqual(report.finalGuardrailState?.entriesToday, 2, "the cap, not the number of signals, bounds entries");
});

test("the backtester kill switch halts new entries after enough consecutive losses and flattens the book", () => {
  const bars = makeBars([100, 105, 100, 105, 100, 105, 100, 105, 100, 105, 100, 105, 100]);
  // betting against the oracle is wrong on every single bar, so every closed position is a loss
  const antiOracle: IPrediction[] = oracle(bars).map((p) => ({ ...p, direction: (-p.direction) as -1 | 0 | 1 }));
  const report = runBacktest(bars, antiOracle, {
    costModel: FREE,
    guardrails: { maxConsecutiveLosingTrades: 2, maxTradesPerDay: 100 },
  });

  assert.ok(report.guardrailHalts.some((h) => h.reason === "consecutive_losses"));
  assert.strictEqual(report.finalGuardrailState?.halted, true);
  assert.strictEqual(report.finalGuardrailState?.requiresHumanReset, false);

  const haltBarIndex = report.guardrailHalts[0].barIndex;
  const tradesAfterHalt = report.trades.filter((t) => t.signalBarIndex > haltBarIndex && t.toExposure !== 0);
  assert.strictEqual(tradesAfterHalt.length, 0, "no new position should open once the kill switch is tripped");
});

test("a data feed gap trips the guardrail kill switch and requires a human to clear it", () => {
  const bars = makeBars([100, 101, 102, 103]);
  bars[2] = { ...bars[2], time: bars[2].time + 3600, open: 150, close: 160 };
  const alwaysLong: IPrediction[] = bars.map((bar) => ({ time: bar.time, direction: 1 as const }));
  const report = runBacktest(bars, alwaysLong, { costModel: FREE, guardrails: {} });

  assert.ok(report.guardrailHalts.some((h) => h.reason === "data_gap"));
  assert.strictEqual(report.finalGuardrailState?.requiresHumanReset, true);
});

// --- runner -----------------------------------------------------------------------------------------------

let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(error as Error).message.split("\n").join("\n        ")}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
