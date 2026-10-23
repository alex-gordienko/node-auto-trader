/**
 * Cost-aware backtester: a series of directional predictions in, a net performance report out.
 *
 * ## The execution rule, which is the whole point
 *
 * A prediction is attributed to the bar at whose **close** it was made. It can only ever be acted on in the
 * **next** bar, and it fills at that bar's **open**. Nothing about bar i+1 is readable while the decision for
 * bar i+1 is being formed. This is the no-look-ahead invariant, and it is enforced three ways:
 *
 *  - structurally: the loop reads bars through `read(index, horizon)`, which throws if asked for a bar beyond
 *    the horizon that is legitimately visible at that point. `strictNoLookAhead` (default on) keeps the guard
 *    live in production runs, not just in tests, because a silent look-ahead is worse than a crash.
 *  - by audit: every exposure change is recorded with the bar that produced the signal and the bar that
 *    executed it, so the relationship can be checked after the fact by `assertNoLookAhead`.
 *  - by construction: the fill price is `bars[i + 1].open`, which is known before bar i+1 has traded. A
 *    backtester that fills at bar i+1's *close* has already seen the move it is betting on.
 *
 * ## Accounting
 *
 * Exposure `e` means the position is `e * equity` of notional, so the return on equity from holding is
 * `e * assetReturn` and the cost of a trade is `|Δe| * rate`. One bar of PnL splits in two because the trade
 * lands at the open:
 *
 *     net = e_prev * (open_j - close_(j-1)) / close_(j-1)   // the gap, held at the old exposure
 *         + e_new  * (close_j - open_j) / open_j            // the bar, held at the new exposure
 *         - cost(e_prev -> e_new)
 *
 * On Binance the gap term is ~0 because trading is continuous, but it is kept exact so the accounting does not
 * quietly depend on that.
 */
import {
  exposureChangeCostBps,
  exposureChangeCostSplitBps,
  ICostModel,
  createCostModel,
  describeCostModel,
  roundTripCostBps,
  ExecutionStyle,
} from "./costs";
import { IBacktestBar, BAR_SECONDS_5MIN } from "./bars";
import { IPerformanceMetrics, performanceMetrics } from "./metrics";
import { BARS_PER_YEAR_5MIN } from "./breakeven";
import { createRng, Rng } from "./random";
import {
  canEnter,
  checkEmergencyConditions,
  DEFAULT_GUARDRAILS,
  GuardrailHaltReason,
  IGuardrailConfig,
  IGuardrailState,
  initialGuardrailState,
  recordBarReturn,
  recordClosedTrade,
  recordEntry,
  rollGuardrailDay,
  trailingStdDev,
} from "./guardrails";

/** A directional call made at the close of the bar whose open time is `time`. */
export interface IPrediction {
  time: number;
  /** -1 short, 0 no position, 1 long */
  direction: -1 | 0 | 1;
  /** optional 0..1 strength, used for sizing or gating when the options ask for it */
  confidence?: number;
}

export type PositionMode =
  /** carry the position and only trade the difference — what a real system does */
  | "target-exposure"
  /** force flat at every bar open, so every traded bar pays a full round trip (the literal "trade every bar") */
  | "flat-between-bars";

export interface IBacktestOptions {
  costModel?: ICostModel;
  barSeconds?: number;
  barsPerYear?: number;
  startEquity?: number;
  positionMode?: PositionMode;
  /** largest absolute exposure, as a multiple of equity. 1 = fully invested, no leverage. */
  maxExposure?: number;
  /** predictions with confidence below this are treated as no position */
  minConfidence?: number;
  /** size the position as confidence * maxExposure instead of full maxExposure */
  sizeByConfidence?: boolean;
  /**
   * Probability that a maker leg actually fills. Only applies to legs whose style is "maker". A resting order
   * that does not fill leaves the exposure unchanged and costs nothing — but it also earns nothing, which is
   * the real price of being a maker and the reason maker/maker break-even numbers flatter the strategy.
   */
  makerFillRate?: number;
  seed?: number;
  strictNoLookAhead?: boolean;
  /**
   * Pre-trade guardrails: a hard daily entry cap and a kill-switch (consecutive losses, drawdown, extreme
   * volatility, data gaps). Undefined (the default) runs with no guardrails at all, so existing callers and
   * tests are unaffected. Partial — anything omitted falls back to `DEFAULT_GUARDRAILS`; pass `{}` to turn
   * guardrails on with those defaults untouched.
   */
  guardrails?: Partial<IGuardrailConfig>;
}

export interface ITradeRecord {
  /** index of the bar at whose close the signal was formed */
  signalBarIndex: number;
  signalBarTime: number;
  /** index of the bar in which it executed — must be signalBarIndex + 1 */
  executionBarIndex: number;
  executionBarTime: number;
  /** the fill: the execution bar's open, knowable before that bar trades */
  executionPrice: number;
  fromExposure: number;
  toExposure: number;
  costBps: number;
  costQuote: number;
  feeQuote: number;
  slippageQuote: number;
}

export interface IGuardrailHaltEvent {
  barIndex: number;
  time: number;
  reason: GuardrailHaltReason;
}

/** A new entry that the day's trade cap blocked: the attempt is dropped, no order is sent. */
export interface IBlockedEntryEvent {
  barIndex: number;
  time: number;
  entriesToday: number;
}

export interface IClosedPosition {
  direction: -1 | 1;
  openBarIndex: number;
  closeBarIndex: number;
  /** net return on equity contributed over the position's life, after costs */
  netReturn: number;
}

export interface IBacktestReport {
  label: string;
  costModelDescription: string;
  roundTripCostBps: number;
  bars: number;
  from: number;
  to: number;
  startEquity: number;
  endEquity: number;
  metrics: IPerformanceMetrics;
  /** number of exposure changes, i.e. orders sent */
  tradeCount: number;
  closedPositions: number;
  /** fraction of closed positions with a positive net contribution */
  winRate: number | null;
  /** fraction of bars held in which the direction was right, before costs */
  directionalAccuracy: number | null;
  barsInMarket: number;
  totalCostQuote: number;
  totalFeesQuote: number;
  totalSlippageQuote: number;
  /** total cost expressed as a share of starting equity, which is the drag to compare against gross edge */
  totalCostAsEquityFraction: number;
  equityCurve: number[];
  netBarReturns: number[];
  trades: ITradeRecord[];
  positions: IClosedPosition[];
  /** present only when `options.guardrails` was set */
  guardrailHalts: IGuardrailHaltEvent[];
  blockedEntries: IBlockedEntryEvent[];
  finalGuardrailState: IGuardrailState | null;
}

const DEFAULTS = {
  barSeconds: BAR_SECONDS_5MIN,
  barsPerYear: BARS_PER_YEAR_5MIN,
  startEquity: 1,
  positionMode: "target-exposure" as PositionMode,
  maxExposure: 1,
  minConfidence: 0,
  sizeByConfidence: false,
  makerFillRate: 1,
  seed: 1,
  strictNoLookAhead: true,
};

/** Target exposure a prediction asks for, after gating and sizing. */
const targetExposure = (prediction: IPrediction | undefined, options: Required<Pick<IBacktestOptions, "maxExposure" | "minConfidence" | "sizeByConfidence">>): number => {
  if (!prediction || prediction.direction === 0) return 0;

  const confidence = prediction.confidence ?? 1;
  if (confidence < options.minConfidence) return 0;

  const size = options.sizeByConfidence ? Math.min(1, Math.max(0, confidence)) : 1;
  return prediction.direction * options.maxExposure * size;
};

/** True when both legs of a potential change are maker legs that would need to fill. */
const legStyle = (model: ICostModel, from: number, to: number): ExecutionStyle =>
  Math.abs(to) >= Math.abs(from) ? model.entry : model.exit;

export const runBacktest = (
  bars: IBacktestBar[],
  predictions: IPrediction[],
  options: IBacktestOptions = {},
  label = "strategy"
): IBacktestReport => {
  const costModel = options.costModel ?? createCostModel();
  const opts = { ...DEFAULTS, ...options, costModel };
  // slippage stripped out, so the fee-only cost of the same trade gives the fee/slippage split for free
  const feeOnlyModel: ICostModel = { ...costModel, takerSlippageBps: 0, makerSlippageBps: 0 };
  const rng: Rng = createRng(opts.seed);

  if (bars.length < 2) {
    throw new Error(`backtest needs at least 2 bars, got ${bars.length}`);
  }

  /**
   * The only way the loop is allowed to touch bar data. `horizon` is the highest index that is legitimately
   * known at this point in time; reading past it is look-ahead.
   */
  const read = (index: number, horizon: number): IBacktestBar => {
    if (opts.strictNoLookAhead && index > horizon) {
      throw new Error(`look-ahead: bar ${index} read while only bars up to ${horizon} are known`);
    }
    return bars[index];
  };

  const predictionByTime = new Map<number, IPrediction>();
  for (const prediction of predictions) predictionByTime.set(prediction.time, prediction);

  const guardrailConfig: IGuardrailConfig | null = options.guardrails ? { ...DEFAULT_GUARDRAILS, ...options.guardrails } : null;
  let guardrailState: IGuardrailState | null = guardrailConfig ? initialGuardrailState(opts.startEquity) : null;
  const guardrailHalts: IGuardrailHaltEvent[] = [];
  const blockedEntries: IBlockedEntryEvent[] = [];
  // close-to-close returns aligned by index, used only for the volatility guardrail; NaN across a gap or at index 0
  const barReturns: number[] = bars.map((bar, i) =>
    i > 0 && bar.time - bars[i - 1].time === opts.barSeconds ? (bar.close - bars[i - 1].close) / bars[i - 1].close : NaN
  );

  const equityCurve: number[] = [opts.startEquity];
  const netBarReturns: number[] = [];
  const trades: ITradeRecord[] = [];
  const positions: IClosedPosition[] = [];

  let equity = opts.startEquity;
  let exposure = 0;
  // the open position is tracked separately from `exposure`, because a flip closes one position and opens
  // another within a single bar and the two need different directions recorded
  let openDirection: -1 | 0 | 1 = 0;
  let openBarIndex = -1;
  let openPositionReturn = 0;
  let totalCostQuote = 0;
  let totalFeesQuote = 0;
  let totalSlippageQuote = 0;
  let barsInMarket = 0;
  let correctBars = 0;
  let heldDirectionalBars = 0;

  const closePosition = (closeBarIndex: number) => {
    if (openDirection === 0) return;
    positions.push({ direction: openDirection, openBarIndex, closeBarIndex, netReturn: openPositionReturn });
    openDirection = 0;
    openBarIndex = -1;
    openPositionReturn = 0;
  };

  // `signalIndex` is the bar at whose close we decide; `execIndex` is the bar we may act in. The loop never
  // touches `execIndex` data before the decision is fixed.
  for (let signalIndex = 0; signalIndex < bars.length - 1; signalIndex += 1) {
    const execIndex = signalIndex + 1;

    // --- decision, with only bars up to signalIndex visible -------------------------------------------
    const signalBar = read(signalIndex, signalIndex);
    const prediction = predictionByTime.get(signalBar.time);
    const desired = targetExposure(prediction, opts);

    // --- execution, bars up to execIndex now visible --------------------------------------------------
    const execBar = read(execIndex, execIndex);
    const prevClose = signalBar.close;

    // A data gap means the bars are not adjacent, so there is no continuous price path between them. Carrying
    // a position across the hole would claim a move we cannot show happened, so flatten and claim nothing.
    const isGap = execBar.time - signalBar.time !== opts.barSeconds;

    if (guardrailState && guardrailConfig) {
      const wasHalted = guardrailState.halted;
      guardrailState = rollGuardrailDay(guardrailState, signalBar.time, guardrailConfig);
      guardrailState = checkEmergencyConditions(
        guardrailState,
        {
          equity,
          barReturn: Number.isFinite(barReturns[signalIndex]) ? barReturns[signalIndex] : null,
          trailingVolatility: trailingStdDev(barReturns, signalIndex, guardrailConfig.volatilityLookbackBars),
          isDataGap: isGap,
        },
        guardrailConfig
      );
      if (!wasHalted && guardrailState.halted) {
        guardrailHalts.push({ barIndex: signalIndex, time: signalBar.time, reason: guardrailState.haltReason! });
      }
    }

    if (isGap) {
      let gapCostReturn = 0;
      if (exposure !== 0) {
        // liquidate at the last close we can see; the exit still costs, it just earns nothing
        const costBps = exposureChangeCostBps(costModel, exposure, 0);
        const costQuote = (costBps / 1e4) * equity;
        const feeQuote = (exposureChangeCostBps(feeOnlyModel, exposure, 0) / 1e4) * equity;
        totalCostQuote += costQuote;
        totalFeesQuote += feeQuote;
        totalSlippageQuote += costQuote - feeQuote;

        trades.push({
          signalBarIndex: signalIndex,
          signalBarTime: signalBar.time,
          executionBarIndex: execIndex,
          executionBarTime: execBar.time,
          executionPrice: execBar.open,
          fromExposure: exposure,
          toExposure: 0,
          costBps,
          costQuote,
          feeQuote,
          slippageQuote: costQuote - feeQuote,
        });

        gapCostReturn = -costBps / 1e4;
        openPositionReturn += gapCostReturn;
        equity *= 1 + gapCostReturn;
        closePosition(signalIndex);
        exposure = 0;

        if (guardrailState && guardrailConfig && positions[positions.length - 1]?.closeBarIndex === signalIndex) {
          const wasHalted = guardrailState.halted;
          guardrailState = recordClosedTrade(guardrailState, positions[positions.length - 1].netReturn, guardrailConfig);
          if (!wasHalted && guardrailState.halted) {
            guardrailHalts.push({ barIndex: signalIndex, time: signalBar.time, reason: guardrailState.haltReason! });
          }
        }
      }
      if (guardrailState) {
        guardrailState = recordBarReturn(guardrailState, gapCostReturn);
        guardrailState = { ...guardrailState, peakEquity: Math.max(guardrailState.peakEquity, equity) };
      }
      equityCurve.push(equity);
      netBarReturns.push(gapCostReturn);
      continue;
    }

    // A maker leg only moves the position if it fills. A non-fill is not an error, it is the ordinary cost of
    // resting: no trade, no fee, and no exposure to the move we predicted.
    let newExposure = desired;
    if (newExposure !== exposure && opts.makerFillRate < 1) {
      const style = legStyle(costModel, exposure, newExposure);
      if (style === "maker" && rng() > opts.makerFillRate) newExposure = exposure;
    }

    // Guardrail gating: a halt flattens unconditionally (a kill-switch that still lets a position ride is not
    // one); short of a halt, the daily cap only blocks brand-new entries — closing out, or trimming toward
    // flat, is never capped because the bot must always be able to get out of a position.
    let guardrailEntryAttempted = false;
    if (guardrailState && guardrailConfig) {
      guardrailEntryAttempted = newExposure !== 0 && (exposure === 0 || Math.sign(newExposure) !== Math.sign(exposure));
      if (guardrailState.halted) {
        newExposure = 0;
        guardrailEntryAttempted = false;
      } else if (guardrailEntryAttempted && !canEnter(guardrailState, guardrailConfig)) {
        blockedEntries.push({ barIndex: signalIndex, time: signalBar.time, entriesToday: guardrailState.entriesToday });
        newExposure = 0;
        guardrailEntryAttempted = false;
      }
    }

    const prevExposure = exposure;
    if (guardrailState && guardrailConfig && guardrailEntryAttempted) {
      guardrailState = recordEntry(guardrailState);
    }

    // In flat-between-bars mode the position is closed and reopened even when the direction is unchanged, so
    // the cost is always two legs. In target-exposure mode only the difference trades.
    const split =
      opts.positionMode === "flat-between-bars"
        ? {
            exitBps: exposureChangeCostSplitBps(costModel, prevExposure, 0).exitBps,
            entryBps: exposureChangeCostSplitBps(costModel, 0, newExposure).entryBps,
          }
        : exposureChangeCostSplitBps(costModel, prevExposure, newExposure);

    const feeSplit =
      opts.positionMode === "flat-between-bars"
        ? {
            exitBps: exposureChangeCostSplitBps(feeOnlyModel, prevExposure, 0).exitBps,
            entryBps: exposureChangeCostSplitBps(feeOnlyModel, 0, newExposure).entryBps,
          }
        : exposureChangeCostSplitBps(feeOnlyModel, prevExposure, newExposure);

    const costBps = split.exitBps + split.entryBps;
    const feeBps = feeSplit.exitBps + feeSplit.entryBps;

    const gapReturn = (execBar.open - prevClose) / prevClose;
    const intrabarReturn = (execBar.close - execBar.open) / execBar.open;
    // the bar's PnL splits at the position boundary: the old exposure held the gap into the open, the new
    // exposure holds the bar itself, and each leg's cost sits with the position it belongs to
    const closingContribution = prevExposure * gapReturn - split.exitBps / 1e4;
    const openingContribution = newExposure * intrabarReturn - split.entryBps / 1e4;
    const netReturn = closingContribution + openingContribution;

    // recorded on every order, not only costly ones: the audit trail must exist even under a zero-cost model
    const sentOrder =
      opts.positionMode === "flat-between-bars" ? prevExposure !== 0 || newExposure !== 0 : prevExposure !== newExposure;
    if (sentOrder) {
      const costQuote = (costBps / 1e4) * equity;
      const feeQuote = (feeBps / 1e4) * equity;
      totalCostQuote += costQuote;
      totalFeesQuote += feeQuote;
      totalSlippageQuote += costQuote - feeQuote;

      trades.push({
        signalBarIndex: signalIndex,
        signalBarTime: signalBar.time,
        executionBarIndex: execIndex,
        executionBarTime: execBar.time,
        executionPrice: execBar.open,
        fromExposure: prevExposure,
        toExposure: newExposure,
        costBps,
        costQuote,
        feeQuote,
        slippageQuote: costQuote - feeQuote,
      });
    }

    // Position bookkeeping: a return to zero or a flip ends the position that was open. In
    // flat-between-bars mode every bar is its own round trip, so every held bar is its own position.
    const flipped = prevExposure !== 0 && newExposure !== 0 && Math.sign(prevExposure) !== Math.sign(newExposure);
    const closesThisBar = opts.positionMode === "flat-between-bars" || newExposure === 0 || flipped;

    // what the position that existed entering this bar earned on the way to the open
    openPositionReturn += closingContribution;
    if (closesThisBar) closePosition(execIndex);

    if (guardrailState && guardrailConfig && closesThisBar && positions[positions.length - 1]?.closeBarIndex === execIndex) {
      const wasHalted = guardrailState.halted;
      guardrailState = recordClosedTrade(guardrailState, positions[positions.length - 1].netReturn, guardrailConfig);
      if (!wasHalted && guardrailState.halted) {
        guardrailHalts.push({ barIndex: signalIndex, time: signalBar.time, reason: guardrailState.haltReason! });
      }
    }

    if (newExposure !== 0 && openDirection === 0) {
      openDirection = newExposure > 0 ? 1 : -1;
      openBarIndex = execIndex;
      openPositionReturn = 0;
    }
    // and what the exposure held through this bar earned
    openPositionReturn += openingContribution;

    if (newExposure !== 0) {
      barsInMarket += 1;
      // accuracy is measured on the move the position was actually exposed to
      const realised = (execBar.close - execBar.open) / execBar.open;
      if (realised !== 0) {
        heldDirectionalBars += 1;
        if (Math.sign(realised) === Math.sign(newExposure)) correctBars += 1;
      }
    }

    equity *= 1 + netReturn;
    exposure = newExposure;
    equityCurve.push(equity);
    netBarReturns.push(netReturn);

    if (guardrailState) {
      guardrailState = recordBarReturn(guardrailState, netReturn);
      guardrailState = { ...guardrailState, peakEquity: Math.max(guardrailState.peakEquity, equity) };
    }
  }

  // mark the final open position closed at the last bar, so it is counted rather than silently dropped
  closePosition(bars.length - 1);

  const wins = positions.filter((position) => position.netReturn > 0).length;

  return {
    label,
    costModelDescription: describeCostModel(costModel),
    roundTripCostBps: roundTripCostBps(costModel),
    bars: bars.length,
    from: bars[0].time,
    to: bars[bars.length - 1].time,
    startEquity: opts.startEquity,
    endEquity: equity,
    metrics: performanceMetrics(netBarReturns, equityCurve, opts.barsPerYear),
    tradeCount: trades.length,
    closedPositions: positions.length,
    winRate: positions.length > 0 ? wins / positions.length : null,
    directionalAccuracy: heldDirectionalBars > 0 ? correctBars / heldDirectionalBars : null,
    barsInMarket,
    totalCostQuote,
    totalFeesQuote,
    totalSlippageQuote,
    totalCostAsEquityFraction: totalCostQuote / opts.startEquity,
    equityCurve,
    netBarReturns,
    trades,
    positions,
    guardrailHalts,
    blockedEntries,
    finalGuardrailState: guardrailState,
  };
};

/**
 * Post-hoc check of the no-look-ahead invariant on a finished report.
 *
 * The engine already refuses to look ahead while running; this verifies the same property from the outside,
 * against the audit trail, so a test can assert it without trusting the engine's internals. Returns the list
 * of violations, empty when the report is clean.
 */
export const findLookAheadViolations = (report: IBacktestReport, bars: IBacktestBar[]): string[] => {
  const violations: string[] = [];

  for (const trade of report.trades) {
    if (trade.executionBarIndex !== trade.signalBarIndex + 1) {
      violations.push(
        `trade on signal bar ${trade.signalBarIndex} executed in bar ${trade.executionBarIndex}, expected ${trade.signalBarIndex + 1}`
      );
    }
    if (trade.executionBarTime <= trade.signalBarTime) {
      violations.push(`trade executed at ${trade.executionBarTime}, not after its signal at ${trade.signalBarTime}`);
    }
    const executionBar = bars[trade.executionBarIndex];
    if (!executionBar) {
      violations.push(`trade references bar ${trade.executionBarIndex}, which does not exist`);
    } else if (trade.executionPrice !== executionBar.open) {
      violations.push(
        `trade in bar ${trade.executionBarIndex} filled at ${trade.executionPrice}, not that bar's open ${executionBar.open}`
      );
    }
  }
  return violations;
};

export const assertNoLookAhead = (report: IBacktestReport, bars: IBacktestBar[]): void => {
  const violations = findLookAheadViolations(report, bars);
  if (violations.length > 0) {
    throw new Error(`no-look-ahead invariant violated:\n  ${violations.join("\n  ")}`);
  }
};
