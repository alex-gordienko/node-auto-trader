/**
 * Stop-crane and daily trade limit for any strategy (the AI, a daily rule, a backtest). Pure functions over a small
 * state object; the live bot keeps the state in a file (services/KillSwitch.service.ts), a backtest keeps it in memory.
 *
 * A trade is one position: opening it uses one of the day's trades, closing it is free. An exit is never blocked, so
 * the bot can always get out — and while stopped it must: a stop that lets a position ride is not a stop.
 *
 * Per decision:
 *   1. `checkMarket` with the current price and equity — may stop on bad data, an abnormal move, a daily loss or a
 *      drawdown. While `state.stopped` is set the caller closes any open position and opens nothing;
 *   2. `canOpen` before opening a position — false while stopped or when today's trades are used up;
 *   3. `recordOpen` after opening, `recordClose` after closing — the closing pnl feeds the losing-streak rule.
 * A stop holds until a human calls `resumeKillSwitch`. The daily limit is not a stop: it lifts at 00:00 UTC.
 */

// the project's limit: no setting can allow more trades per UTC day
export const HARD_MAX_TRADES_PER_DAY = 3;

const DAY_MS = 86_400_000;

export interface IKillSwitchRules {
  maxTradesPerDay: number; // positions opened per UTC day, capped at HARD_MAX_TRADES_PER_DAY
  maxLossesInARow: number; // closed positions with pnl <= 0, net of costs
  maxDailyLoss: number; // share of the equity at the end of the previous UTC day
  maxDrawdown: number; // share of the peak equity since the start or the last resume
  maxPriceMove: number; // abnormal move: price change within priceWindowMinutes
  priceWindowMinutes: number;
}

export interface IKillSwitchState {
  stopped: string | null;
  stoppedAt: number; // ms; 0 while trading
  resumedAt: number;
  day: number; // UTC day number of the last update
  tradesToday: number;
  dayStartEquity: number;
  lastEquity: number;
  peakEquity: number;
  lossesInARow: number;
  recentPrices: { at: number; price: number }[]; // within priceWindowMinutes
}

export interface IKillSwitchCheck {
  state: IKillSwitchState;
  stop: string | null; // set when this call stopped trading
}

const utcDay = (now: number) => Math.floor(now / DAY_MS);

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const createKillSwitch = (equity: number, now: number): IKillSwitchState => ({
  stopped: null,
  stoppedAt: 0,
  resumedAt: now,
  day: utcDay(now),
  tradesToday: 0,
  dayStartEquity: equity,
  lastEquity: equity,
  peakEquity: equity,
  lossesInARow: 0,
  recentPrices: [],
});

// a new UTC day starts from the last equity seen, so a strategy that checks once a day still sees the day's loss
const rollDay = (s: IKillSwitchState, now: number): IKillSwitchState =>
  utcDay(now) === s.day ? s : { ...s, day: utcDay(now), tradesToday: 0, dayStartEquity: s.lastEquity };

const halt = (s: IKillSwitchState, now: number, reason: string): IKillSwitchCheck => ({
  state: { ...s, stopped: reason, stoppedAt: now },
  stop: reason,
});

/** Market rules on every check, with or without a trade. A stopped state is returned unchanged. */
export const checkMarket = (
  state: IKillSwitchState,
  { now, price, equity }: { now: number; price: number; equity: number },
  rules: IKillSwitchRules
): IKillSwitchCheck => {
  if (state.stopped) return { state, stop: null };
  // a broken feed is an emergency too: no decision should be made on it
  if (!(price > 0) || !Number.isFinite(equity)) return halt(rollDay(state, now), now, `bad market data (price ${price}, equity ${equity})`);

  const windowMs = rules.priceWindowMinutes * 60_000;
  const recentPrices = [...state.recentPrices.filter((p) => p.at >= now - windowMs && p.at < now), { at: now, price }];
  const s: IKillSwitchState = { ...rollDay(state, now), recentPrices, lastEquity: equity, peakEquity: Math.max(state.peakEquity, equity) };

  const move = recentPrices.reduce((worst, p) => (Math.abs(price / p.price - 1) > Math.abs(worst) ? price / p.price - 1 : worst), 0);
  if (Math.abs(move) > rules.maxPriceMove) return halt(s, now, `price moved ${pct(move)} within ${rules.priceWindowMinutes} min`);

  const dailyLoss = s.dayStartEquity > 0 ? 1 - equity / s.dayStartEquity : 0;
  if (dailyLoss > rules.maxDailyLoss) return halt(s, now, `equity is ${pct(dailyLoss)} below the start of the day`);

  const drawdown = s.peakEquity > 0 ? 1 - equity / s.peakEquity : 0;
  if (drawdown > rules.maxDrawdown) return halt(s, now, `equity is ${pct(drawdown)} below its peak`);

  return { state: s, stop: null };
};

/** Whether a position may be opened now; `reason` says why not. Closing a position needs no permission. */
export const canOpen = (state: IKillSwitchState, now: number, rules: IKillSwitchRules): { allowed: boolean; reason: string | null } => {
  if (state.stopped) return { allowed: false, reason: `stopped: ${state.stopped}` };
  const limit = Math.min(rules.maxTradesPerDay, HARD_MAX_TRADES_PER_DAY);
  const today = rollDay(state, now).tradesToday;
  if (today >= limit) return { allowed: false, reason: `${today} of ${limit} trades today already made` };
  return { allowed: true, reason: null };
};

/** Uses one of the day's trades. */
export const recordOpen = (state: IKillSwitchState, now: number): IKillSwitchState => {
  const s = rollDay(state, now);
  return { ...s, tradesToday: s.tradesToday + 1 };
};

/** A closed position: `pnl` net of all its costs; a break-even trade counts as a loss, since it only paid fees. */
export const recordClose = (state: IKillSwitchState, { now, pnl }: { now: number; pnl: number }, rules: IKillSwitchRules): IKillSwitchCheck => {
  const s = rollDay(state, now);
  const lossesInARow = pnl <= 0 ? s.lossesInARow + 1 : 0;
  const next = { ...s, lossesInARow };
  if (!s.stopped && lossesInARow >= rules.maxLossesInARow) return halt(next, now, `${lossesInARow} losing trades in a row`);
  return { state: next, stop: null };
};

/**
 * Manual reset after a human has looked: the losing streak, the peak and the day's loss start afresh. Trades already
 * made today still count, so a reset never allows more than the daily limit.
 */
export const resumeKillSwitch = (state: IKillSwitchState, equity: number, now: number): IKillSwitchState => ({
  ...rollDay(state, now),
  stopped: null,
  stoppedAt: 0,
  resumedAt: now,
  dayStartEquity: equity,
  lastEquity: equity,
  peakEquity: equity,
  lossesInARow: 0,
  recentPrices: [],
});
