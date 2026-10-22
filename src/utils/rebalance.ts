/**
 * 50/50 rebalancing: the capital is split between ETH and USDT. When the ETH share leaves target ± band, the bot
 * trades back to the target — it sells part of the ETH after a rise and buys after a fall. The decision needs only
 * the current price, no forecast. The same code runs in paper trading (Rebalance.service) and in the backtest
 * (scripts/rebalance-backtest.ts).
 *
 * Stop-crane: before every trade the rules in `rebalanceStep` are checked; when one fires, the bot stops trading
 * and waits for a human.
 */

export interface IRebalanceConfig {
  target: number; // ETH share of the portfolio, e.g. 0.5
  band: number; // trade when the share is further than this from the target
  feeRate: number; // exchange fee + spread, share of the traded amount
  gasUsd: number; // network fee per swap
  minTradeUsd: number; // smaller trades are not made
  stop: {
    minShare: number;
    maxShare: number;
    maxDrawdown: number; // share of the portfolio's peak value
    buysInARow: number;
    maxTradesPerDay: number;
    maxPriceJump: number; // between two checks at most 12 hours apart
  };
}

export interface IRebalanceTrade {
  at: number; // ms
  side: "buy" | "sell";
  price: number;
  usd: number; // amount moved, before costs
  cost: number; // fee + network fee, USD
}

export interface IPaperPortfolio {
  eth: number;
  usdt: number;
  startedAt: number;
  startPrice: number;
  startValue: number; // capital before the first purchase
  peakValue: number;
  lastPrice: number;
  lastCheckAt: number;
  trades: IRebalanceTrade[]; // rebalances only, not the first purchase
  // set while the stop-crane holds the bot; a resume starts the drawdown and the purchase count afresh
  stopped: string | null;
  resumedAt: number;
  // the first check after a resume trades back to the target even from a skew or after a jump: a human has looked
  justResumed?: boolean;
}

export interface IRebalanceStep {
  portfolio: IPaperPortfolio;
  trade: IRebalanceTrade | null;
  stop: string | null;
}

// covers checks every hour or every 8 hours; after a longer pause a big move is no sign of a bad price
const JUMP_CHECK_WINDOW_MS = 12 * 3600_000;

export const portfolioValue = (p: IPaperPortfolio, price: number) => p.eth * price + p.usdt;

export const ethShare = (p: IPaperPortfolio, price: number) => (p.eth * price) / portfolioValue(p, price);

/** `capitalUsd` in USDT, of which the target share is spent on ETH (paying the costs). */
export const createPortfolio = (capitalUsd: number, price: number, now: number, cfg: IRebalanceConfig): IPaperPortfolio => {
  const usd = capitalUsd * cfg.target;
  const cost = usd * cfg.feeRate + cfg.gasUsd;
  return {
    eth: (usd - cost) / price,
    usdt: capitalUsd - usd,
    startedAt: now,
    startPrice: price,
    startValue: capitalUsd,
    peakValue: capitalUsd - cost,
    lastPrice: price,
    lastCheckAt: now,
    trades: [],
    stopped: null,
    resumedAt: now,
  };
};

/** After a human resumes trading: the drawdown is measured from now and earlier purchases no longer count. */
export const resumePortfolio = (p: IPaperPortfolio, price: number, now: number): IPaperPortfolio => ({
  ...p,
  stopped: null,
  resumedAt: now,
  peakValue: portfolioValue(p, price),
  justResumed: true,
});

/** ETH prices at which the share leaves the band: the bot buys below `buyAt` and sells above `sellAt`. */
export const bandPrices = (p: IPaperPortfolio, cfg: IRebalanceConfig) => {
  const priceAt = (share: number) => (share * p.usdt) / (p.eth * (1 - share));
  return { buyAt: priceAt(cfg.target - cfg.band), sellAt: priceAt(cfg.target + cfg.band) };
};

/**
 * One check at `price`: stop-crane rules first, then a trade back to the target if the band is left. Pure; a stopped
 * portfolio (`stopped` set) is returned unchanged until `resumePortfolio`.
 */
export const rebalanceStep = (p: IPaperPortfolio, price: number, now: number, cfg: IRebalanceConfig): IRebalanceStep => {
  if (p.stopped) return { portfolio: p, trade: null, stop: null };
  const value = portfolioValue(p, price);
  const share = (p.eth * price) / value;
  const next: IPaperPortfolio = { ...p, lastPrice: price, lastCheckAt: now, peakValue: Math.max(p.peakValue, value), justResumed: false };
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const rules = cfg.stop;
  const stop = (reason: string): IRebalanceStep => ({ portfolio: { ...next, stopped: reason }, trade: null, stop: reason });

  // a jump like this between close checks is more often a bad price than a real move, and a real one deserves a look
  const jump = price / p.lastPrice - 1;
  if (!p.justResumed && now - p.lastCheckAt < JUMP_CHECK_WINDOW_MS && Math.abs(jump) > rules.maxPriceJump) {
    return stop(`price changed ${pct(jump)} since the previous check`);
  }
  if (!p.justResumed && (share < rules.minShare || share > rules.maxShare)) {
    return stop(`ETH share ${pct(share)} is outside ${pct(rules.minShare)}–${pct(rules.maxShare)}`);
  }
  const drawdown = 1 - value / next.peakValue;
  if (drawdown > rules.maxDrawdown) return stop(`portfolio value is ${pct(drawdown)} below its peak`);

  const usd = Math.abs(share - cfg.target) * value;
  if (Math.abs(share - cfg.target) <= cfg.band || usd < cfg.minTradeUsd) return { portfolio: next, trade: null, stop: null };
  const lastDay = p.trades.filter((t) => t.at > now - 86_400_000).length;
  if (lastDay >= rules.maxTradesPerDay) return stop(`${lastDay} rebalances in the last 24 hours`);

  const side = share > cfg.target ? "sell" : "buy";
  const cost = usd * cfg.feeRate + cfg.gasUsd;
  if (side === "sell") {
    next.eth -= usd / price;
    next.usdt += usd - cost;
  } else {
    next.usdt -= usd;
    next.eth += (usd - cost) / price;
  }
  const trade: IRebalanceTrade = { at: now, side, price, usd, cost };
  next.trades = [...p.trades, trade];

  // buying again and again means the price keeps falling: the losing case of rebalancing
  let buys = 0;
  for (let i = next.trades.length - 1; i >= 0 && next.trades[i].side === "buy" && next.trades[i].at > p.resumedAt; i--) buys++;
  if (buys < rules.buysInARow) return { portfolio: next, trade, stop: null };
  const reason = `${buys} purchases in a row: the price keeps falling`;
  return { portfolio: { ...next, stopped: reason }, trade, stop: reason };
};
