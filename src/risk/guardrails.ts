/**
 * Pre-trade guardrails for the net-return strategy: a hard daily trade cap and a kill-switch.
 *
 * This is the backtester-side half of TRA-18. It is deliberately separate from `limits.ts`, which scores an
 * already-running live book against day-level equity thresholds. These guardrails instead gate individual
 * *entries* before they happen, which is the only place a "no more than 3 trades a day" rule or a "stop after
 * 4 losses in a row" rule can actually bind — checking either after the fact is a report, not a control.
 *
 * ## What halts the bot, and how it clears
 *
 * Two kinds of halt, with different reset rules because they mean different things:
 *
 *  - **Consecutive-loss halt** (`consecutive_losses`): the strategy has gone cold. This is expected variance,
 *    not evidence of a broken system, so it clears itself once the book has strung together
 *    `consecutiveLossAutoResetProfitableDays` fully profitable UTC trading days with no human involved.
 *  - **Emergency halts** (`max_drawdown`, `extreme_volatility`, `data_gap`): something is wrong with the
 *    market data, the model's premise, or the account itself. These always set `requiresHumanReset = true`
 *    and only `manualReArm` clears them — a bot should never argue itself back into trading after blowing
 *    through a drawdown limit.
 *
 * Any active halt forces the position to flat, not just blocked new entries: a kill-switch that still lets an
 * existing position ride is not a kill-switch.
 */

export type GuardrailHaltReason = "consecutive_losses" | "max_drawdown" | "extreme_volatility" | "data_gap";

export interface IGuardrailConfig {
  /** hard cap on new entries per UTC day, enforced pre-trade. Exits (reducing exposure toward flat) are never capped. */
  maxTradesPerDay: number;
  /** halt after this many consecutive losing (net return <= 0) closed positions */
  maxConsecutiveLosingTrades: number;
  /** kill once equity is this far below its running peak */
  maxDrawdownFraction: number;
  /** a bar whose |close-to-close return| exceeds this many standard deviations of the trailing window is "extreme volatility" */
  extremeVolatilityZScore: number;
  /** bars in the trailing window used to estimate volatility for the check above */
  volatilityLookbackBars: number;
  /** consecutive fully profitable UTC days needed to auto-clear a consecutive-loss halt; 0 disables auto-reset (manual re-arm only) */
  consecutiveLossAutoResetProfitableDays: number;
}

export const DEFAULT_GUARDRAILS: IGuardrailConfig = {
  maxTradesPerDay: 3,
  maxConsecutiveLosingTrades: 4,
  maxDrawdownFraction: 0.15,
  extremeVolatilityZScore: 6,
  volatilityLookbackBars: 288, // one UTC day of 5-minute bars
  consecutiveLossAutoResetProfitableDays: 1,
};

export interface IGuardrailState {
  /** UTC day bucket (days since epoch) of the bar currently being processed; -1 before the first bar */
  dayKey: number;
  entriesToday: number;
  consecutiveLosingTrades: number;
  consecutiveProfitableDays: number;
  /** running net return of bars seen so far in the current UTC day, used only to judge "was today profitable" */
  dayNetReturn: number;
  peakEquity: number;
  halted: boolean;
  haltReason: GuardrailHaltReason | null;
  requiresHumanReset: boolean;
}

export const initialGuardrailState = (startEquity: number): IGuardrailState => ({
  dayKey: -1,
  entriesToday: 0,
  consecutiveLosingTrades: 0,
  consecutiveProfitableDays: 0,
  dayNetReturn: 0,
  peakEquity: startEquity,
  halted: false,
  haltReason: null,
  requiresHumanReset: false,
});

const dayKeyOf = (barTimeSeconds: number): number => Math.floor(barTimeSeconds / 86400);

/**
 * Roll the day bucket forward for `barTime`, resetting the daily trade count and, on a consecutive-loss halt
 * only, applying the auto-reset rule against the day that just ended. No-op within the same UTC day.
 */
export const rollGuardrailDay = (state: IGuardrailState, barTime: number, config: IGuardrailConfig): IGuardrailState => {
  const dayKey = dayKeyOf(barTime);
  if (dayKey === state.dayKey) return state;

  const previousDayWasProfitable = state.dayKey >= 0 && state.dayNetReturn > 0;
  const consecutiveProfitableDays = previousDayWasProfitable ? state.consecutiveProfitableDays + 1 : 0;

  const clearsOnSchedule =
    state.halted &&
    state.haltReason === "consecutive_losses" &&
    !state.requiresHumanReset &&
    config.consecutiveLossAutoResetProfitableDays > 0 &&
    consecutiveProfitableDays >= config.consecutiveLossAutoResetProfitableDays;

  return {
    ...state,
    dayKey,
    entriesToday: 0,
    dayNetReturn: 0,
    consecutiveProfitableDays,
    halted: clearsOnSchedule ? false : state.halted,
    haltReason: clearsOnSchedule ? null : state.haltReason,
    consecutiveLosingTrades: clearsOnSchedule ? 0 : state.consecutiveLosingTrades,
  };
};

/** Accumulate a bar's net return toward the running "was today profitable" judgement. */
export const recordBarReturn = (state: IGuardrailState, netBarReturn: number): IGuardrailState => ({
  ...state,
  dayNetReturn: state.dayNetReturn + netBarReturn,
});

/** Register a closed position's net return, updating (and possibly tripping) the consecutive-loss kill-switch. */
export const recordClosedTrade = (state: IGuardrailState, netReturn: number, config: IGuardrailConfig): IGuardrailState => {
  const isLoss = netReturn <= 0;
  const consecutiveLosingTrades = isLoss ? state.consecutiveLosingTrades + 1 : 0;
  const trips = isLoss && consecutiveLosingTrades >= config.maxConsecutiveLosingTrades && !state.halted;

  return {
    ...state,
    consecutiveLosingTrades,
    halted: trips ? true : state.halted,
    haltReason: trips ? "consecutive_losses" : state.haltReason,
    requiresHumanReset: trips ? false : state.requiresHumanReset,
  };
};

export interface IEmergencyCheckInput {
  equity: number;
  /** close-to-close return of the bar just observed, used for the volatility check; null when not available */
  barReturn: number | null;
  /** standard deviation of the trailing `volatilityLookbackBars` close-to-close returns; null until the window fills */
  trailingVolatility: number | null;
  /** true when the bar being processed is not adjacent to the previous one, i.e. a data feed gap */
  isDataGap: boolean;
}

/** Check drawdown, extreme volatility and data-gap conditions, tripping the kill-switch (always requiring a human reset) if any fire. */
export const checkEmergencyConditions = (
  state: IGuardrailState,
  input: IEmergencyCheckInput,
  config: IGuardrailConfig
): IGuardrailState => {
  const peakEquity = Math.max(state.peakEquity, input.equity);
  const drawdown = peakEquity > 0 ? (peakEquity - input.equity) / peakEquity : 0;

  let reason: GuardrailHaltReason | null = null;
  if (input.isDataGap) reason = "data_gap";
  else if (drawdown >= config.maxDrawdownFraction) reason = "max_drawdown";
  else if (
    input.barReturn !== null &&
    input.trailingVolatility !== null &&
    input.trailingVolatility > 0 &&
    Math.abs(input.barReturn) / input.trailingVolatility >= config.extremeVolatilityZScore
  ) {
    reason = "extreme_volatility";
  }

  if (!reason || state.halted) return { ...state, peakEquity };

  return { ...state, peakEquity, halted: true, haltReason: reason, requiresHumanReset: true };
};

/** Whether a brand-new entry (opening from flat, or flipping direction) may be taken right now. */
export const canEnter = (state: IGuardrailState, config: IGuardrailConfig): boolean =>
  !state.halted && state.entriesToday < config.maxTradesPerDay;

/** Record that an entry was actually taken, consuming one slot of today's trade budget. */
export const recordEntry = (state: IGuardrailState): IGuardrailState => ({
  ...state,
  entriesToday: state.entriesToday + 1,
});

/** Operator action: clear any halt, including emergency ones. Nothing in this module calls this on its own. */
export const manualReArm = (state: IGuardrailState): IGuardrailState => ({
  ...state,
  halted: false,
  haltReason: null,
  requiresHumanReset: false,
  consecutiveLosingTrades: 0,
});

/**
 * Rolling standard deviation of the last `lookback` values of `returns` ending at (and excluding)
 * `uptoIndexExclusive`. Non-finite entries (gaps, the sentinel at index 0) are dropped from the window rather
 * than poisoning it.
 */
export const trailingStdDev = (returns: number[], uptoIndexExclusive: number, lookback: number): number | null => {
  const from = Math.max(0, uptoIndexExclusive - lookback);
  const window = returns.slice(from, uptoIndexExclusive).filter((v) => Number.isFinite(v));
  if (window.length < Math.min(lookback, 20)) return null; // too few samples to trust a volatility estimate

  const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance);
};
