import { INDICATOR_WARMUP, IOHLCV } from "../../utils/technical-indicators";
import { CANDLE_FEATURE_COUNT, FORECAST_LAYOUT } from "../../utils/tensorflow.helpers";
import { ORDERFLOW_VERDICT_COUNT } from "../../utils/orderflow.features";

// market features + model signals (forecast of the price path, order-book verdict) + position + unrealized PnL
export const SIGNAL_COUNT = FORECAST_LAYOUT.count + ORDERFLOW_VERDICT_COUNT;
export const DQN_FEATURE_COUNT = CANDLE_FEATURE_COUNT + SIGNAL_COUNT + 2;
const EMPTY_FORECAST: number[] = new Array(SIGNAL_COUNT).fill(0);

export const RLAction = {
  Hold: 0,
  Buy: 1,
  Sell: 2,
} as const;

export type RLActionIndex = (typeof RLAction)[keyof typeof RLAction];

export const RL_ACTION_LABELS: Record<RLActionIndex, "Hold" | "Buy" | "Sell"> = {
  [RLAction.Hold]: "Hold",
  [RLAction.Buy]: "Buy",
  [RLAction.Sell]: "Sell",
};

export interface IEnvStepResult {
  state: number[][];
  reward: number;
  done: boolean;
}

export class TradingEnvironment {
  private readonly prices: number[];
  private readonly marketFeatures: number[][];
  private readonly forecasts: number[][];
  private readonly timeSteps: number;
  private readonly feeRate: number;
  private readonly invalidActionPenalty: number;
  private readonly stepMinutes: number;
  private readonly drift: number;

  private t = 0;
  private endIndex = 0;
  private position = 0;
  private entryPrice = 0;

  /**
   * `features[i]` = standardized candle features at candle i,
   * `forecasts[i]` = forecast model outputs (FORECAST_LAYOUT) made at candle i,
   * `feeRate` = full cost of one swap as a share of the traded amount,
   * `stepMinutes` = minutes between decisions (one step of the environment),
   * `drift` = average market return per step that is subtracted from the reward, so only timing is rewarded.
   */
  constructor(
    candles: IOHLCV[],
    features: number[][],
    forecasts: number[][],
    timeSteps: number,
    feeRate: number,
    invalidActionPenalty: number,
    stepMinutes = 1,
    drift = 0
  ) {
    this.prices = candles.map((c) => c.close);
    this.marketFeatures = features;
    this.forecasts = forecasts;
    this.timeSteps = timeSteps;
    this.feeRate = feeRate;
    this.invalidActionPenalty = invalidActionPenalty;
    this.stepMinutes = stepMinutes;
    this.drift = drift;
    this.reset();
  }

  /** Average return per step over the whole data: (last / first)^(step / minutes) − 1. */
  public static averageStepReturn(candles: IOHLCV[], stepMinutes: number): number {
    if (candles.length < 2 || candles[0].close <= 0) return 0;
    const total = candles[candles.length - 1].close / candles[0].close;
    return Math.pow(total, stepMinutes / (candles.length - 1)) - 1;
  }

  public get length(): number {
    return this.prices.length;
  }

  public get startIndex(): number {
    return Math.max(INDICATOR_WARMUP, this.timeSteps);
  }

  /** Starts an episode at `start` that lasts `steps` decisions (default: until the end of data). */
  public reset(start = this.startIndex, steps = Infinity): number[][] {
    this.t = Math.max(start, this.startIndex);
    this.endIndex = Math.min(this.prices.length - 1, this.t + steps * this.stepMinutes);
    this.position = 0;
    this.entryPrice = 0;
    return this.getState();
  }

  public getState(): number[][] {
    const window: number[][] = [];
    const unrealized = this.getUnrealizedPnl(this.prices[this.t]);

    for (let i = this.t - this.timeSteps + 1; i <= this.t; i++) {
      const row = this.marketFeatures[i];
      window.push([...row, ...(this.forecasts[i] ?? EMPTY_FORECAST), this.position, unrealized]);
    }

    return window;
  }

  /** State at an arbitrary candle with the given position — used to replay live decisions. */
  public stateAt(t: number, position = 0): number[][] {
    const window: number[][] = [];
    for (let i = t - this.timeSteps + 1; i <= t; i++) {
      window.push([...this.marketFeatures[i], ...(this.forecasts[i] ?? EMPTY_FORECAST), position, 0]);
    }
    return window;
  }

  public step(action: RLActionIndex): IEnvStepResult {
    const price = this.prices[this.t];
    let traded = 0;
    let penalty = 0;

    if (action === RLAction.Buy) {
      if (this.position === 0) {
        this.position = 1;
        this.entryPrice = price;
        traded = 1;
      } else {
        penalty = this.invalidActionPenalty * 0.25;
      }
    } else if (action === RLAction.Sell) {
      if (this.position === 1) {
        this.position = 0;
        this.entryPrice = 0;
        traded = 1;
      } else {
        penalty = this.invalidActionPenalty;
      }
    }

    // the position is held until the next decision
    const next = Math.min(this.t + this.stepMinutes, this.prices.length - 1);
    const marketReturn = (this.prices[next] - price) / price;
    const holdingReturn = this.position * (marketReturn - this.drift);
    const reward = holdingReturn - this.feeRate * traded - penalty;

    this.t = next;
    const done = this.t + this.stepMinutes > this.endIndex;

    return {
      state: done ? this.getTerminalState() : this.getState(),
      reward,
      done,
    };
  }

  private getTerminalState(): number[][] {
    return Array.from({ length: this.timeSteps }, () => new Array(DQN_FEATURE_COUNT).fill(0));
  }

  private getUnrealizedPnl(price: number): number {
    if (this.position === 0 || this.entryPrice === 0) {
      return 0;
    }
    return (price - this.entryPrice) / this.entryPrice;
  }
}

/** Same layout as TradingEnvironment.getState(); `forecasts` is aligned with `candles`. */
export const buildInferenceState = (
  candles: IOHLCV[],
  features: number[][],
  forecasts: number[][],
  timeSteps: number,
  position: number,
  entryPrice: number
): number[][] => {
  const last = candles.length - 1;
  const price = candles[last].close;
  const unrealized = position === 1 && entryPrice > 0 ? (price - entryPrice) / entryPrice : 0;
  const window: number[][] = [];
  const start = Math.max(0, last - timeSteps + 1);

  for (let i = start; i <= last; i++) {
    window.push([...features[i], ...(forecasts[i] ?? EMPTY_FORECAST), position, unrealized]);
  }

  while (window.length < timeSteps) {
    window.unshift(window[0] ?? new Array(DQN_FEATURE_COUNT).fill(0));
  }

  return window;
};
