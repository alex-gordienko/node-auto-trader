/**
 * Daily strategies for ETH-USDT: one decision a day at 00:00 UTC, the wanted ETH share of the portfolio (0 = all
 * USDT, 1 = all ETH). A pure simulation shared by the strategy check (scripts/strategy-check.ts): costs per traded
 * amount, a minimum change before a trade is made, and a guard that sits out after losing streaks or a deep drawdown.
 */

export interface IDailyBar {
  t: number; // decision time, unix seconds (00:00 UTC)
  price: number; // ETH price at t
}

// trend lookbacks in days: no single one is picked, they vote (30d alone is a lucky peak among them)
export const TREND_LOOKBACKS = [10, 14, 21, 30, 45, 60, 90, 120];

/** Share of TREND_LOOKBACKS whose price is below the close of day k; `closes` are daily, oldest first. NaN without history. */
export const trendVote = (closes: number[], k = closes.length - 1): number =>
  k >= TREND_LOOKBACKS[TREND_LOOKBACKS.length - 1]
    ? TREND_LOOKBACKS.filter((days) => closes[k] > closes[k - days]).length / TREND_LOOKBACKS.length
    : NaN;

/** Annualized volatility of the 30 daily returns up to day k; NaN without history. */
export const realizedVolatility = (closes: number[], k = closes.length - 1): number => {
  if (k < 30) return NaN;
  let sum = 0;
  for (let j = k - 29; j <= k; j++) sum += Math.log(closes[j] / closes[j - 1]) ** 2;
  return Math.sqrt((sum / 30) * 365);
};

/**
 * Wanted coin share: the trend vote, scaled down when the coin is more volatile than `targetVolatility`; `volatility`
 * is the trailing 30-day one unless a forecast is given.
 */
export const voteTarget = (closes: number[], targetVolatility: number, k = closes.length - 1, volatility = realizedVolatility(closes, k)): number =>
  trendVote(closes, k) * Math.min(1, targetVolatility / volatility);

/** Daily bars at 00:00 UTC from hourly candles (`time` = candle start, unix seconds): a close is known when its candle ends. */
export const toDailyBars = (candles: { time: number; close: number }[]): IDailyBar[] => {
  const times = candles.map((c) => c.time + 3600);
  const bars: IDailyBar[] = [];
  for (let t = Math.ceil(times[0] / 86400) * 86400; t <= times[times.length - 1]; t += 86400) {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    bars.push({ t, price: candles[lo].close });
  }
  return bars;
};

/** One coin's half of the live paper portfolio: traded on its own like a half in `simulate`. */
export interface IPaperLeg {
  qty: number; // coin
  usdt: number;
  flow: number; // USDT received from sells minus USDT spent on buys since the position was opened
}

export interface IPaperFill {
  side: "buy" | "sell";
  price: number; // fill price, slippage included
  usd: number; // traded amount at the market price, before costs
  fee: number; // USDT
  opened: boolean; // the leg was out of the market before
  closedPnl: number | null; // set when the leg left the market: the position's result net of all costs
}

export interface IPaperCosts {
  feeRate: number; // share of the traded amount
  slippage: number; // fills are this much worse than the market price
  minChange: number; // as in ISimConfig
  minTradeUsd: number;
}

/** Trades the leg to `target` coin share at market `price`, with the same "is it worth it" rule as `simulate`. Pure. */
export const rebalanceLeg = (leg: IPaperLeg, price: number, target: number, c: IPaperCosts): { leg: IPaperLeg; fill: IPaperFill | null } => {
  const value = leg.qty * price + leg.usdt;
  const share = value > 0 ? (leg.qty * price) / value : 0;
  const wanted = Math.min(1, Math.max(0, target));
  const change = Math.abs(wanted - share);
  const usd = wanted === 0 ? leg.qty * price : change * value;
  if (change < 1e-9 || (change < c.minChange && wanted !== 0) || usd < c.minTradeUsd) return { leg, fill: null };
  if (wanted > share) {
    const fillPrice = price * (1 + c.slippage);
    const fee = usd * c.feeRate;
    const opened = leg.qty === 0;
    const next = { qty: leg.qty + (usd - fee) / fillPrice, usdt: leg.usdt - usd, flow: (opened ? 0 : leg.flow) - usd };
    return { leg: next, fill: { side: "buy", price: fillPrice, usd, fee, opened, closedPnl: null } };
  }
  const fillPrice = price * (1 - c.slippage);
  const qty = wanted === 0 ? leg.qty : usd / price;
  const received = qty * fillPrice;
  const fee = received * c.feeRate;
  const next = { qty: wanted === 0 ? 0 : leg.qty - qty, usdt: leg.usdt + received - fee, flow: leg.flow + received - fee };
  return { leg: next, fill: { side: "sell", price: fillPrice, usd, fee, opened: false, closedPnl: wanted === 0 ? next.flow : null } };
};

export interface IGuardConfig {
  lossesInARow: number; // closed positions with a loss, in a row
  maxDrawdown: number; // share of the peak value since the last resume
  maxDayMove: number; // |price change| over the last day: no new entries on such a day
  pauseDays: number; // in the backtest a pause ends by itself; live, a human resumes
}

export interface ISimConfig {
  cost: number; // fee + spread, share of the traded amount
  minChange: number; // smaller changes of the ETH share are not traded
  step: number; // a decision every `step` days, held in between
  offset: number; // which day of the step decides
  guard: IGuardConfig | null;
}

export interface ISimResult {
  equity: number[]; // value per bar, starts at 1
  swaps: number;
  positions: number; // closed positions (in ETH → back to USDT)
  losingPositions: number;
  stops: { t: number; reason: string }[];
  inMarket: number; // average ETH share
}

export interface IStats {
  total: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number; // daily returns, annualized with 365 days
  swapsPerYear: number;
  years: Record<string, number>;
}

/**
 * Runs `wanted` (ETH share per bar, NaN = keep the current share) over the bars. A position is "closed" when the
 * share drops to 0; its result is the portfolio value then against the value when the share left 0.
 */
export const simulate = (bars: IDailyBar[], wanted: number[], cfg: ISimConfig): ISimResult => {
  let eth = 0;
  let usdt = 1;
  let peak = 1;
  let openedAt = NaN; // value when the current position was opened
  let losses = 0;
  let pausedUntil = -Infinity;
  let swaps = 0;
  let positions = 0;
  let losingPositions = 0;
  let shareSum = 0;
  const equity: number[] = [];
  const stops: ISimResult["stops"] = [];

  bars.forEach((bar, k) => {
    const { price, t } = bar;
    let value = eth * price + usdt;
    peak = Math.max(peak, value);
    const share = value > 0 ? (eth * price) / value : 0;
    const guard = cfg.guard;
    let target = share;
    const decides = (k - cfg.offset) % cfg.step === 0 && Number.isFinite(wanted[k]);
    if (decides) target = Math.min(1, Math.max(0, wanted[k]));

    if (guard) {
      if (t < pausedUntil) target = 0;
      else if (1 - value / peak > guard.maxDrawdown) {
        stops.push({ t, reason: `drawdown ${((1 - value / peak) * 100).toFixed(0)}%` });
        pausedUntil = t + guard.pauseDays * 86400;
        target = 0;
      } else if (k > 0 && Math.abs(price / bars[k - 1].price - 1) > guard.maxDayMove && target > share) {
        target = share; // no new entries on a crash or spike day
      }
    }

    const change = Math.abs(target - share);
    // leaving the market is always allowed; anything else only when the change is big enough to pay its cost
    if (change > 1e-9 && (change >= cfg.minChange || target === 0)) {
      const traded = change * value;
      value -= traded * cfg.cost;
      eth = (target * value) / price;
      usdt = value - eth * price;
      swaps++;
      if (share === 0 && target > 0) openedAt = value + traded * cfg.cost; // value before the entry cost
      if (share > 0 && target === 0) {
        positions++;
        if (value < openedAt) {
          losingPositions++;
          losses++;
        } else losses = 0;
        if (guard && losses >= guard.lossesInARow && t >= pausedUntil) {
          stops.push({ t, reason: `${losses} losing positions in a row` });
          pausedUntil = t + guard.pauseDays * 86400;
          losses = 0;
        }
      }
    }
    // a pause ends with a fresh peak: the drawdown is measured from the resume
    if (guard && t < pausedUntil && t + 86400 >= pausedUntil) peak = value;
    shareSum += value > 0 ? (eth * price) / value : 0;
    equity.push(value);
  });
  return { equity, swaps, positions, losingPositions, stops, inMarket: shareSum / bars.length };
};

const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();

export const stats = (bars: IDailyBar[], equity: number[], swaps: number): IStats => {
  let peak = equity[0];
  let maxDrawdown = 0;
  const daily: number[] = [];
  const years: Record<string, number> = {};
  let startOfYear = equity[0];
  equity.forEach((v, k) => {
    peak = Math.max(peak, v);
    maxDrawdown = Math.max(maxDrawdown, 1 - v / peak);
    if (k > 0) daily.push(v / equity[k - 1] - 1);
    if (k > 0 && yearOf(bars[k].t) !== yearOf(bars[k - 1].t)) startOfYear = equity[k - 1];
    years[yearOf(bars[k].t)] = v / startOfYear - 1;
  });
  const days = (bars[bars.length - 1].t - bars[0].t) / 86400;
  const mean = daily.reduce((s, v) => s + v, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((s, v) => s + (v - mean) ** 2, 0) / daily.length) || 1;
  const total = equity[equity.length - 1] / equity[0] - 1;
  return {
    total,
    cagr: (1 + total) ** (365 / days) - 1,
    maxDrawdown,
    sharpe: (mean / sd) * Math.sqrt(365),
    swapsPerYear: (swaps * 365) / days,
    years,
  };
};
