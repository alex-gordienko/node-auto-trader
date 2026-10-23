/**
 * Proposed live risk limits, as a pure function. DESIGN ONLY: nothing in the repo calls this on a live path and
 * nothing here places or cancels orders. Wiring it to real funds needs an explicit decision from the user.
 */

export interface IRiskLimits {
  /** Max gross exposure as a fraction of equity (1 = unlevered, fully invested). */
  maxPositionFraction: number;
  /** Halt new trading for the rest of the UTC day once equity is this far below the day-start equity. */
  maxDailyLossFraction: number;
  /** Kill once equity is this far below its running peak. */
  maxDrawdownFraction: number;
  /** Kill after this many consecutive losing days, even if drawdown is inside the limit. */
  maxConsecutiveLosingDays: number;
}

export const DEFAULT_RISK_LIMITS: IRiskLimits = {
  maxPositionFraction: 0.5,
  maxDailyLossFraction: 0.02,
  maxDrawdownFraction: 0.1,
  maxConsecutiveLosingDays: 5,
};

export interface IRiskState {
  equity: number;
  peakEquity: number;
  dayStartEquity: number;
  /** Current gross exposure as a fraction of equity. */
  exposure: number;
  consecutiveLosingDays: number;
}

export type RiskAction = "trade" | "reduce" | "halt_for_the_day" | "kill";

export interface IRiskBreach {
  limit: keyof IRiskLimits;
  value: number;
  threshold: number;
}

export interface IRiskDecision {
  action: RiskAction;
  breaches: IRiskBreach[];
  /** True for `kill`: the system may never clear this itself. */
  requiresHumanReset: boolean;
}

export const evaluateRiskLimits = (state: IRiskState, limits: IRiskLimits = DEFAULT_RISK_LIMITS): IRiskDecision => {
  const breaches: IRiskBreach[] = [];

  const drawdown = state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity : 0;
  const dayLoss = state.dayStartEquity > 0 ? (state.dayStartEquity - state.equity) / state.dayStartEquity : 0;

  if (state.exposure > limits.maxPositionFraction) {
    breaches.push({ limit: "maxPositionFraction", value: state.exposure, threshold: limits.maxPositionFraction });
  }
  if (dayLoss >= limits.maxDailyLossFraction) {
    breaches.push({ limit: "maxDailyLossFraction", value: dayLoss, threshold: limits.maxDailyLossFraction });
  }
  if (drawdown >= limits.maxDrawdownFraction) {
    breaches.push({ limit: "maxDrawdownFraction", value: drawdown, threshold: limits.maxDrawdownFraction });
  }
  if (state.consecutiveLosingDays >= limits.maxConsecutiveLosingDays) {
    breaches.push({
      limit: "maxConsecutiveLosingDays",
      value: state.consecutiveLosingDays,
      threshold: limits.maxConsecutiveLosingDays,
    });
  }

  const has = (limit: keyof IRiskLimits) => breaches.some((b) => b.limit === limit);
  const action: RiskAction =
    has("maxDrawdownFraction") || has("maxConsecutiveLosingDays")
      ? "kill"
      : has("maxDailyLossFraction")
      ? "halt_for_the_day"
      : has("maxPositionFraction")
      ? "reduce"
      : "trade";

  return { action, breaches, requiresHumanReset: action === "kill" };
};
