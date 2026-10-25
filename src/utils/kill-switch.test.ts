import assert from "assert";
import { test } from "node:test";

import {
  canOpen,
  checkMarket,
  createKillSwitch,
  HARD_MAX_TRADES_PER_DAY,
  IKillSwitchRules,
  IKillSwitchState,
  recordClose,
  recordOpen,
  resumeKillSwitch,
} from "./kill-switch";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 0, 1, 10); // 10:00 UTC
const RULES: IKillSwitchRules = {
  maxTradesPerDay: 3,
  maxLossesInARow: 3,
  maxDailyLoss: 0.05,
  maxDrawdown: 0.2,
  maxPriceMove: 0.1,
  priceWindowMinutes: 60,
};

const market = (s: IKillSwitchState, now: number, price: number, equity = 1000) => checkMarket(s, { now, price, equity }, RULES);

test("three positions a day, the fourth waits until 00:00 UTC", () => {
  let s = createKillSwitch(1000, T0);
  for (let i = 0; i < 3; i++) {
    assert.ok(canOpen(s, T0 + i * HOUR, RULES).allowed, `trade ${i + 1} is allowed`);
    s = recordOpen(s, T0 + i * HOUR);
  }
  const fourth = canOpen(s, T0 + 4 * HOUR, RULES);
  assert.ok(!fourth.allowed && fourth.reason?.includes("3 of 3"));
  assert.equal(s.stopped, null, "the limit is not a stop");
  assert.ok(canOpen(s, Date.UTC(2026, 0, 2, 0, 1), RULES).allowed, "a new UTC day starts a new count");
});

test("no setting allows more than the hard limit", () => {
  let s = createKillSwitch(1000, T0);
  const loose = { ...RULES, maxTradesPerDay: 10 };
  for (let i = 0; i < HARD_MAX_TRADES_PER_DAY; i++) s = recordOpen(s, T0);
  assert.ok(!canOpen(s, T0, loose).allowed);
});

test("losing trades in a row stop the bot; a win resets the count", () => {
  let s = createKillSwitch(1000, T0);
  s = recordClose(s, { now: T0, pnl: -5 }, RULES).state;
  s = recordClose(s, { now: T0, pnl: -5 }, RULES).state;
  s = recordClose(s, { now: T0, pnl: 1 }, RULES).state;
  assert.equal(s.lossesInARow, 0, "a win resets the streak");
  s = recordClose(s, { now: T0, pnl: -5 }, RULES).state;
  s = recordClose(s, { now: T0, pnl: 0 }, RULES).state;
  const third = recordClose(s, { now: T0, pnl: -5 }, RULES);
  assert.ok(third.stop?.includes("3 losing trades in a row"), "a break-even trade counts as a loss");
  assert.ok(!canOpen(third.state, T0 + 3 * 86_400_000, RULES).allowed, "a stop does not lift by itself, even days later");
});

test("a daily loss stops the bot, measured from the end of the previous day", () => {
  let s = market(createKillSwitch(1000, T0), T0, 100, 1000).state;
  s = market(s, T0 + 12 * HOUR, 100, 990).state; // 22:00, the last check of the day
  const loss = market(s, T0 + 15 * HOUR, 100, 930); // 01:00 next day
  assert.equal(loss.state.dayStartEquity, 990, "the day starts from the last equity seen");
  assert.ok(loss.stop?.includes("6.1% below the start of the day"), String(loss.stop));
  assert.ok(!market(createKillSwitch(1000, T0), T0, 100, 960).stop, "4% is inside the 5% limit");
});

test("a drawdown from the peak stops the bot", () => {
  let s = createKillSwitch(1000, T0);
  // −4% a day: never a daily stop, but the losses add up
  for (let d = 0; d < 8; d++) {
    const r = market(s, T0 + d * 86_400_000, 100, 1200 * 0.96 ** d);
    s = r.state;
    if (r.stop) break;
  }
  assert.ok(s.stopped?.includes("below its peak"), String(s.stopped));
});

test("an abnormal move within the window stops the bot, a slow one does not", () => {
  const s = market(createKillSwitch(1000, T0), T0, 100).state;
  assert.ok(market(s, T0 + 30 * MIN, 89).stop?.includes("price moved -11.0%"));
  assert.ok(market(s, T0 + 30 * MIN, 111).stop?.includes("price moved 11.0%"));
  assert.ok(!market(s, T0 + 2 * HOUR, 89).stop, "the same move over two hours is a market, not an emergency");
});

test("bad market data stops the bot", () => {
  const s = createKillSwitch(1000, T0);
  assert.ok(market(s, T0, NaN).stop?.includes("bad market data"));
  assert.ok(market(s, T0, 0).stop?.includes("bad market data"));
});

test("while stopped nothing opens and checks change nothing; a manual resume starts afresh", () => {
  let s = market(createKillSwitch(1000, T0), T0, 100).state;
  s = market(s, T0 + MIN, 50).state;
  assert.ok(s.stopped);
  assert.ok(!canOpen(s, T0 + 2 * MIN, RULES).allowed);
  assert.deepEqual(market(s, T0 + 3 * MIN, 50, 500).state, s, "a stopped state is left as it is");

  const resumed = resumeKillSwitch(s, 800, T0 + HOUR);
  assert.equal(resumed.stopped, null);
  assert.equal(resumed.peakEquity, 800, "the drawdown is measured from the resume");
  assert.ok(!market(resumed, T0 + HOUR + MIN, 50, 800).stop, "the move before the resume is forgotten");
});

test("a resume does not give back the day's trades", () => {
  let s = createKillSwitch(1000, T0);
  for (let i = 0; i < 3; i++) s = recordOpen(s, T0);
  s = recordClose(s, { now: T0, pnl: -1 }, { ...RULES, maxLossesInARow: 1 }).state;
  assert.ok(s.stopped);
  const resumed = resumeKillSwitch(s, 990, T0 + HOUR);
  assert.ok(!canOpen(resumed, T0 + HOUR, RULES).allowed, "still 3 of 3 today");
  assert.ok(canOpen(resumed, T0 + 15 * HOUR, RULES).allowed, "tomorrow it trades again");
});
