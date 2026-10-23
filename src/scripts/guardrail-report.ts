/**
 * TRA-18: re-run the cost-aware backtester with the daily-trade-cap and kill-switch guardrails active, and
 * report what they cost or save relative to running the same signals with no guardrails at all:
 *   yarn ts-node --transpile-only src/scripts/guardrail-report.ts
 *
 * ## What this can and cannot show yet
 *
 * TRA-17 (Quant Engineer) owns the "rescoped net-return strategy" — formulation C's magnitude-gated entry
 * signal — and it is not in the repo yet. Without it there is no strategy prediction series to run the
 * guardrails against, so this script cannot answer "does the guarded strategy still clear the 50/50 rebalance
 * baseline net of costs" (~21-29%/yr, -70..-73% drawdown, from `yarn rebalance:backtest`). That comparison is
 * a one-line change here (swap in TRA-17's predictions in place of the two stand-ins below) once that signal
 * lands — do not take the numbers below as a verdict on the strategy, they are not testing it.
 *
 * What this *does* show, on real ETH-USDT 5-minute bars, through the same engine TRA-17's signal will run on:
 *  - buy-and-hold only ever makes one entry, so the daily trade cap and the consecutive-loss kill-switch
 *    cannot bind it — but the *emergency* halts (drawdown, extreme volatility, a data gap) are exposure-wide
 *    and apply even to a single held position, by design: a kill-switch that lets an existing position ride
 *    through a volatility spike because it wasn't "a new trade" is not a kill-switch. On the stored history
 *    this actually fires once (a genuine ~1.2% move in a single 5-minute bar against a calm trailing
 *    baseline), which forces buy-and-hold flat and then idle until a human re-arms it — worth noting as a
 *    real operational cost of the guardrail, not a bug: see the run below.
 *  - a random signal at the strategy's trading cadence is bounded by the daily cap and kill-switch exactly
 *    as intended — the mechanism that will protect the real strategy from overtrading and cold streaks.
 */
import { loadBars } from "../risk/bars";
import { buyAndHoldReport, randomSignalBenchmark } from "../risk/benchmarks";
import { IBacktestOptions, IBacktestReport, runBacktest, IPrediction } from "../risk/backtester";
import { createCostModel, FEE_SCHEDULES } from "../risk/costs";
import { DEFAULT_GUARDRAILS } from "../risk/guardrails";
import { CryptoPairs } from "../types/basic.types";
import { Colors, log } from "../utils/colored-console";

const PAIR = CryptoPairs.ETH_USDT;

const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const fmtReport = (r: IBacktestReport) =>
  `net ${pct(r.metrics.netReturn)} (annualised ${pct(r.metrics.annualisedReturn)}), max DD ${pct(r.metrics.maxDrawdown)}, ` +
  `Sharpe ${r.metrics.sharpe?.toFixed(2) ?? "n/a"}, entries blocked by cap ${r.blockedEntries.length}, ` +
  `kill-switch halts ${r.guardrailHalts.length}${r.guardrailHalts[0] ? ` (first: ${r.guardrailHalts[0].reason} @ bar ${r.guardrailHalts[0].barIndex})` : ""}, ` +
  `trades ${r.tradeCount}, cost ${pct(r.totalCostAsEquityFraction, 2)}`;

(async () => {
  const bars = await loadBars(PAIR);
  if (bars.length < 2) {
    log(`no stored 5-minute bars for ${PAIR}: run the collectors or backfill first`, Colors.RED);
    process.exit(1);
  }
  log(
    `[**] ${bars.length} bars of ${PAIR} (${new Date(bars[0].time * 1000).toISOString().slice(0, 10)} … ` +
      `${new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10)})`,
    Colors.BLUE
  );

  const costModel = createCostModel({ fees: FEE_SCHEDULES.binanceFuturesVip0 });
  const base: IBacktestOptions = { costModel, maxExposure: 1 };
  const guarded: IBacktestOptions = { ...base, guardrails: DEFAULT_GUARDRAILS };

  log("\n[**] buy and hold — a single entry, so only the emergency halts (not the cap or loss-streak switch) can bind it", Colors.WHITE);
  const bhFree = buyAndHoldReport(bars, base);
  const bhGuarded = buyAndHoldReport(bars, guarded);
  log(`  without guardrails: ${fmtReport(bhFree)}`, Colors.WHITE);
  log(`  with guardrails:    ${fmtReport(bhGuarded)}`, Colors.YELLOW);

  log("\n[**] random signal at a strategy-like trading cadence — this is what the cap and kill-switch bound", Colors.WHITE);
  const tradeProbability = 0.1; // roughly one decision in ten bars changes the position, a plausible cadence for a selective signal
  const randomFree = randomSignalBenchmark(bars, base, 50, tradeProbability);
  const randomGuarded = randomSignalBenchmark(bars, guarded, 50, tradeProbability);
  log(
    `  without guardrails: mean net ${pct(randomFree.netReturn.mean)}, mean max DD ${pct(randomFree.maxDrawdown.mean)}, ` +
      `mean trades ${randomFree.meanTradeCount.toFixed(0)}, profitable ${pct(randomFree.shareProfitable)}`,
    Colors.WHITE
  );
  log(
    `  with guardrails:    mean net ${pct(randomGuarded.netReturn.mean)}, mean max DD ${pct(randomGuarded.maxDrawdown.mean)}, ` +
      `mean trades ${randomGuarded.meanTradeCount.toFixed(0)}, profitable ${pct(randomGuarded.shareProfitable)}`,
    Colors.WHITE
  );

  // a single run, shown in detail, so the halts and blocked entries are visible rather than only averaged away
  const sampleRng = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  };
  const rng = sampleRng(7);
  const samplePredictions: IPrediction[] = bars.map((bar) => ({
    time: bar.time,
    direction: rng() > tradeProbability ? 0 : rng() < 0.5 ? -1 : 1,
  }));
  const sampleGuarded = runBacktest(bars, samplePredictions, guarded, "random sample, guarded");
  log(
    `\n[**] one sample run in detail: ${fmtReport(sampleGuarded)}`,
    Colors.WHITE
  );
  if (sampleGuarded.guardrailHalts.length > 0) {
    log(`  halts: ${JSON.stringify(sampleGuarded.guardrailHalts)}`, Colors.YELLOW);
  }

  log(
    "\n[**] TRA-18 status: guardrails (3 trades/day cap, 4-consecutive-loss kill-switch, drawdown/volatility/data-gap " +
      "emergency halts) are implemented in src/risk/guardrails.ts and wired into src/risk/backtester.ts. The 50/50 " +
      "baseline comparison the ticket asks for needs TRA-17's entry signal, which is not in the repo yet — rerun this " +
      "script with that signal in place of the random stand-in above to get it.",
    Colors.YELLOW
  );
  process.exit(0);
})();
