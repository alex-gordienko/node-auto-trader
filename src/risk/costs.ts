/**
 * Trading-cost model for the backtester and the break-even analysis.
 *
 * Everything is in basis points of traded notional (1 bp = 0.01% = 0.0001), because that is the unit the
 * fee schedules are published in and the unit the break-even arithmetic is easiest to check in.
 *
 * Fees and slippage are kept apart on purpose: the fee is a published number we can look up, the slippage is
 * our assumption, and the two sensitivities are very different. Slippage is also per execution style — a taker
 * order crosses the spread and pays impact, a resting maker order gets exactly its limit price and pays none.
 */

/** How one leg of a trade is executed. */
export type ExecutionStyle = "maker" | "taker";

export interface IFeeSchedule {
  name: string;
  makerBps: number;
  takerBps: number;
}

/**
 * Published Binance fee tiers (checked 2026-10).
 *
 * Spot is included only to show that it is hopeless at this horizon: 10 bps per side is almost an order of
 * magnitude above the average 5-minute move, so a 5-minute spot strategy cannot work at any accuracy.
 * USDⓈ-M futures is the only venue in this family whose fees are small enough to argue about.
 */
export const FEE_SCHEDULES = {
  binanceFuturesVip0: { name: "Binance USDⓈ-M futures VIP0", makerBps: 2.0, takerBps: 5.0 },
  // the 10% BNB-balance discount on futures fees
  binanceFuturesVip0Bnb: { name: "Binance USDⓈ-M futures VIP0 (BNB discount)", makerBps: 1.8, takerBps: 4.5 },
  binanceFuturesVip1: { name: "Binance USDⓈ-M futures VIP1", makerBps: 1.6, takerBps: 4.0 },
  binanceSpotVip0: { name: "Binance spot VIP0", makerBps: 10.0, takerBps: 10.0 },
  // the 25% BNB-balance discount on spot fees
  binanceSpotVip0Bnb: { name: "Binance spot VIP0 (BNB discount)", makerBps: 7.5, takerBps: 7.5 },
} satisfies Record<string, IFeeSchedule>;

export type FeeScheduleKey = keyof typeof FEE_SCHEDULES;

export interface ICostModel {
  fees: IFeeSchedule;
  /**
   * One-way slippage on a taker fill, in bps: half the spread plus market impact plus the price drift between
   * the decision and the fill. See SLIPPAGE_ASSUMPTIONS for how the default is argued.
   */
  takerSlippageBps: number;
  /**
   * One-way slippage on a maker fill, in bps. Zero by construction: a resting limit order fills at its own
   * price or not at all. The cost of being a maker is not slippage, it is non-fills and adverse selection,
   * which show up in the realised edge rather than here — see `makerFillRate` in the backtester options.
   */
  makerSlippageBps: number;
  entry: ExecutionStyle;
  exit: ExecutionStyle;
}

/**
 * Taker slippage assumptions for ETH-USDT perpetuals. ETH-USDT is the second most liquid pair on the venue;
 * the tick is $0.01, so on a ~$2,700 price one tick is ~0.04 bps and the top-of-book spread is usually one or
 * two ticks. For notional small enough to rest inside the top of book (order of $50k), the floor is therefore
 * about half a tick of crossing cost, and the rest of the budget is impact and decision-to-fill drift.
 *
 * `base` is what the headline numbers use. It is deliberately above the mechanical half-spread, because a
 * directional signal trades when the book is moving, which is exactly when the spread is widest.
 */
export const SLIPPAGE_ASSUMPTIONS = {
  // small size, calm book, patient execution
  optimistic: 0.5,
  // headline assumption
  base: 1.0,
  // size that walks the book, or trading through news
  pessimistic: 2.0,
} as const;

export interface ICostModelOptions {
  fees?: IFeeSchedule;
  takerSlippageBps?: number;
  makerSlippageBps?: number;
  entry?: ExecutionStyle;
  exit?: ExecutionStyle;
}

export const createCostModel = (options: ICostModelOptions = {}): ICostModel => ({
  fees: options.fees ?? FEE_SCHEDULES.binanceFuturesVip0,
  takerSlippageBps: options.takerSlippageBps ?? SLIPPAGE_ASSUMPTIONS.base,
  makerSlippageBps: options.makerSlippageBps ?? 0,
  entry: options.entry ?? "taker",
  exit: options.exit ?? "taker",
});

/** Cost of one leg (entry or exit) as bps of the notional traded in that leg. */
export const oneWayCostBps = (model: ICostModel, style: ExecutionStyle): number =>
  style === "maker"
    ? model.fees.makerBps + model.makerSlippageBps
    : model.fees.takerBps + model.takerSlippageBps;

/** Cost of opening and closing one unit of notional: the number the break-even edge has to beat. */
export const roundTripCostBps = (model: ICostModel): number =>
  oneWayCostBps(model, model.entry) + oneWayCostBps(model, model.exit);

/**
 * Cost of changing exposure, in bps of equity, given a signed exposure change.
 *
 * Increasing absolute exposure is an entry, decreasing it is an exit, and a flip through zero is both, so it
 * is split at zero rather than charged at one rate. This matters: a flip from fully long to fully short trades
 * two units of notional, not one, and a backtester that charges one unit understates costs by half on exactly
 * the trades a 5-minute signal makes most.
 */
export const exposureChangeCostBps = (model: ICostModel, from: number, to: number): number => {
  const split = exposureChangeCostSplitBps(model, from, to);
  return split.exitBps + split.entryBps;
};

/**
 * The same cost, split into the part that closes old exposure and the part that opens new exposure.
 *
 * The backtester needs the split to attribute PnL across a position boundary: when a position is closed and
 * another opened in the same bar, the exit cost belongs to the position that ended and the entry cost to the
 * one that began. Summing them and charging the total to one side would distort per-position win rates.
 */
export const exposureChangeCostSplitBps = (
  model: ICostModel,
  from: number,
  to: number
): { exitBps: number; entryBps: number } => {
  if (from === to) return { exitBps: 0, entryBps: 0 };

  const entryRate = oneWayCostBps(model, model.entry);
  const exitRate = oneWayCostBps(model, model.exit);

  // a flip through zero closes |from| and opens |to|
  if (from !== 0 && to !== 0 && Math.sign(from) !== Math.sign(to)) {
    return { exitBps: Math.abs(from) * exitRate, entryBps: Math.abs(to) * entryRate };
  }

  const delta = Math.abs(to) - Math.abs(from);
  return delta > 0 ? { exitBps: 0, entryBps: delta * entryRate } : { exitBps: -delta * exitRate, entryBps: 0 };
};

export const describeCostModel = (model: ICostModel): string => {
  const entry = oneWayCostBps(model, model.entry).toFixed(2);
  const exit = oneWayCostBps(model, model.exit).toFixed(2);
  return `${model.fees.name}, ${model.entry}/${model.exit}: entry ${entry} bps + exit ${exit} bps = ${roundTripCostBps(model).toFixed(2)} bps round trip`;
};
