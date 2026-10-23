/**
 * Break-even directional accuracy for a fixed-horizon directional strategy.
 *
 * ## The arithmetic
 *
 * Hold ±1 unit of notional for one bar on the strength of a directional call that is right with probability
 * `p`. Write `E|r|` for the average absolute return of one bar. If accuracy does not depend on how big the
 * move is, the expected gross return of one bar held is
 *
 *     gross = p * E|r| - (1 - p) * E|r| = (2p - 1) * E|r|
 *
 * `(2p - 1)` is the whole edge: at p = 0.5 it is zero, and it grows only 2 bps of edge per 1 pp of accuracy
 * per 1 bp of E|r|. That linearity is why accuracy is such a weak lever and cost is such a strong one.
 *
 * Costs scale with how often the position is actually turned over, not with how often a prediction is made.
 * Write `c` for the round-trip cost in bps and `k` for the number of round trips per bar held:
 *
 *     net = (2p - 1) * E|r| - k * c
 *
 * Setting net = 0 and solving for p gives the break-even accuracy
 *
 *     p* = 0.5 + k * c / (2 * E|r|)
 *
 * Two consequences are worth stating out loud, because they are what make or break the strategy:
 *
 * 1. If `k * c > E|r|`, then p* > 1. The strategy is not merely hard, it is arithmetically impossible: a
 *    perfect oracle that calls every bar correctly still loses money, because the average move it is
 *    harvesting is smaller than the cost of harvesting it. No model work can fix this; only cost work can.
 * 2. `p*` depends on E|r| only through the bars we actually trade. Trading selectively raises E|r| on the
 *    traded subset and is therefore the cheapest way to move p* down — far cheaper than raising accuracy.
 *
 * ## The assumption to be suspicious of
 *
 * `gross = (2p - 1) * E|r|` assumes accuracy is independent of move size, i.e. that the model is no better
 * and no worse on big bars than on small ones. Reality is usually worse than this: large 5-minute moves are
 * news- and liquidation-driven, which is precisely the part of the distribution a feature-based model
 * predicts least well. If accuracy is concentrated in the small bars, realised PnL is below everything
 * computed here even when the headline accuracy is met. Treat these numbers as an optimistic bound.
 */
import { ICostModel, roundTripCostBps } from "./costs";

export interface IBreakEvenInput {
  /** average absolute return of one bar, in bps, over the bars that are actually traded */
  meanAbsReturnBps: number;
  /**
   * Round trips per bar held. 1.0 = open and close every bar (flat between bars). 0.5 = carry a position and
   * flip it on half the bars, which is what an unpredictable signal does to a continuously held position.
   * Lower = a more persistent signal.
   */
  roundTripsPerBar: number;
  costModel: ICostModel;
}

export interface IBreakEvenResult {
  /** bps of edge the signal must produce per bar just to pay the costs */
  requiredEdgeBps: number;
  /** directional accuracy that produces exactly that edge; > 1 means impossible at any accuracy */
  breakEvenAccuracy: number;
  /** net bps per bar a perfect oracle (accuracy 1.0) would earn; negative means the strategy cannot work */
  oracleNetBps: number;
  feasible: boolean;
  roundTripCostBps: number;
}

export const breakEvenAccuracy = (input: IBreakEvenInput): IBreakEvenResult => {
  const cost = roundTripCostBps(input.costModel);
  const requiredEdgeBps = input.roundTripsPerBar * cost;
  const oracleNetBps = input.meanAbsReturnBps - requiredEdgeBps;

  return {
    requiredEdgeBps,
    breakEvenAccuracy: 0.5 + requiredEdgeBps / (2 * input.meanAbsReturnBps),
    oracleNetBps,
    feasible: oracleNetBps > 0,
    roundTripCostBps: cost,
  };
};

/** Expected net return of one bar held, in bps, at a given accuracy. The inverse of the break-even solve. */
export const netEdgeBps = (accuracy: number, input: IBreakEvenInput): number =>
  (2 * accuracy - 1) * input.meanAbsReturnBps - input.roundTripsPerBar * roundTripCostBps(input.costModel);

/**
 * Compound a per-bar net edge over a year, to turn bps into something a human can react to.
 * Returns the growth multiple of equity; below 1.0 is a loss, near 0 is ruin.
 */
export const annualisedGrowthMultiple = (netBpsPerBar: number, barsPerYear: number): number =>
  Math.exp(barsPerYear * Math.log1p(netBpsPerBar / 1e4));

/** 5-minute bars in a 365-day year on a market that never closes. */
export const BARS_PER_YEAR_5MIN = 365 * 24 * 12;
