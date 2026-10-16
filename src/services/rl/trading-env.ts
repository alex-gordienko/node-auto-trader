import {
  buildMarketFeatures,
  INDICATOR_WARMUP,
  IOHLCV,
  STATE_FEATURE_COUNT,
} from "../../utils/technical-indicators";

// market features + price forecast + position + unrealized PnL
export const DQN_FEATURE_COUNT = STATE_FEATURE_COUNT + 1;

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
  private readonly forecasts: number[];
  private readonly timeSteps: number;
  private readonly feeRate: number;
  private readonly invalidActionPenalty: number;

  private t = 0;
  private position = 0;
  private entryPrice = 0;

  /** `forecasts[i]` = forecast model output (scaled horizon return) made at candle i. */
  constructor(candles: IOHLCV[], forecasts: number[], timeSteps: number, feeRate: number, invalidActionPenalty: number) {
    this.prices = candles.map((c) => c.close);
    this.marketFeatures = buildMarketFeatures(candles);
    this.forecasts = forecasts;
    this.timeSteps = timeSteps;
    this.feeRate = feeRate;
    this.invalidActionPenalty = invalidActionPenalty;
    this.reset();
  }

  public get startIndex(): number {
    return Math.max(INDICATOR_WARMUP, this.timeSteps);
  }

  public reset(): number[][] {
    this.t = this.startIndex;
    this.position = 0;
    this.entryPrice = 0;
    return this.getState();
  }

  public getState(): number[][] {
    const window: number[][] = [];
    const unrealized = this.getUnrealizedPnl(this.prices[this.t]);

    for (let i = this.t - this.timeSteps + 1; i <= this.t; i++) {
      const row = this.marketFeatures[i];
      window.push([...row, this.forecasts[i] ?? 0, this.position, unrealized]);
    }

    return window;
  }

  /** State at an arbitrary candle with the given position — used to replay live decisions. */
  public stateAt(t: number, position = 0): number[][] {
    const window: number[][] = [];
    for (let i = t - this.timeSteps + 1; i <= t; i++) {
      window.push([...this.marketFeatures[i], this.forecasts[i] ?? 0, position, 0]);
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

    const nextPrice = this.prices[this.t + 1];
    const marketReturn = (nextPrice - price) / price;
    const holdingReturn = this.position * marketReturn;
    const reward = holdingReturn - this.feeRate * traded - penalty;

    this.t += 1;
    const done = this.t >= this.prices.length - 1;

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
  forecasts: number[],
  timeSteps: number,
  position: number,
  entryPrice: number
): number[][] => {
  const features = buildMarketFeatures(candles);
  const last = candles.length - 1;
  const price = candles[last].close;
  const unrealized = position === 1 && entryPrice > 0 ? (price - entryPrice) / entryPrice : 0;
  const window: number[][] = [];
  const start = Math.max(0, last - timeSteps + 1);

  for (let i = start; i <= last; i++) {
    window.push([...features[i], forecasts[i] ?? 0, position, unrealized]);
  }

  while (window.length < timeSteps) {
    window.unshift(window[0] ?? new Array(DQN_FEATURE_COUNT).fill(0));
  }

  return window;
};
