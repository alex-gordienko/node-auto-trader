import assert from "assert";
import { test } from "node:test";

import { rebalanceLeg, toDailyBars, trendVote } from "./daily-strategy";

const COSTS = { feeRate: 0.001, slippage: 0.0005, minChange: 0.25, minTradeUsd: 10 };

test("trend vote: share of lookbacks pointing up, NaN without 120 days", () => {
  const rising = Array.from({ length: 121 }, (_, k) => 100 + k);
  assert.strictEqual(trendVote(rising), 1);
  assert.ok(Number.isNaN(trendVote(rising.slice(1))));
  // rises to 190 on day 90, falls to 130 on day 120: only above day 0 (100); equal to day 30 counts as not up
  const peak = Array.from({ length: 121 }, (_, k) => (k <= 90 ? 100 + k : 190 - (k - 90) * 2));
  assert.strictEqual(trendVote(peak), 1 / 8);
});

test("daily bars use the close of the hour that ended by 00:00 UTC", () => {
  const day = 86400 * 20000;
  const candles = [22, 23, 24].map((h, i) => ({ time: day - 86400 + h * 3600, close: 10 + i }));
  // 22:00 and 23:00 of the previous day, 00:00 of this day: the 23:00 candle ends at 00:00
  assert.deepStrictEqual(toDailyBars(candles), [{ t: day, price: 11 }]);
});

test("paper leg: buy and sell pay fee and slippage, a full exit reports the position's pnl", () => {
  const start = { qty: 0, usdt: 500, flow: 0 };
  const buy = rebalanceLeg(start, 100, 1, COSTS);
  assert.strictEqual(buy.fill?.side, "buy");
  assert.ok(buy.fill?.opened);
  assert.ok(Math.abs(buy.leg.qty - (500 * 0.999) / 100.05) < 1e-12);
  assert.strictEqual(buy.leg.usdt, 0);

  const exit = rebalanceLeg(buy.leg, 100, 0, COSTS);
  assert.strictEqual(exit.leg.qty, 0);
  // flat price: the round trip loses only its costs (~0.3%)
  assert.ok(exit.fill!.closedPnl! < 0 && exit.fill!.closedPnl! > -2);
  assert.ok(Math.abs(exit.leg.usdt - 500 - exit.fill!.closedPnl!) < 1e-9);
});

test("paper leg: small changes are not traded, leaving the market always is", () => {
  const half = { qty: 2.5, usdt: 250, flow: -250 };
  assert.strictEqual(rebalanceLeg(half, 100, 0.6, COSTS).fill, null);
  assert.strictEqual(rebalanceLeg(half, 100, 0.25, COSTS).fill?.side, "sell");
  assert.strictEqual(rebalanceLeg(half, 100, 0.25, COSTS).fill?.closedPnl, null);
  assert.strictEqual(rebalanceLeg({ qty: 0.05, usdt: 495, flow: -5 }, 100, 0, COSTS).fill, null); // $5 < minTradeUsd
  assert.strictEqual(rebalanceLeg(half, 100, 0, COSTS).fill?.side, "sell");
});
