import assert from "assert";
import { test } from "node:test";

import { forecastVolatility, hourlyVolatility, TRAIN_DAYS, VOL_HORIZON_HOURS } from "./vol-model";

// hourly closes with a fixed annualized volatility per hour (alternating ± returns)
const series = (volAt: (h: number) => number, hours: number) => {
  const closes = [100];
  for (let h = 1; h < hours; h++) closes.push(closes[h - 1] * Math.exp((h % 2 ? 1 : -1) * volAt(h) / Math.sqrt(365 * 24)));
  return closes;
};
const HOURS = (TRAIN_DAYS + 40) * 24;

test("a constant volatility is forecast as itself", () => {
  const closes = series(() => 0.8, HOURS);
  assert.ok(Math.abs(hourlyVolatility(closes, HOURS - 1, 72) - 0.8) < 1e-9);
  assert.ok(Math.abs(forecastVolatility(closes, HOURS - 1) - 0.8) < 0.01);
});

test("only closes up to hour i are used", () => {
  const i = HOURS - 1 - 3 * VOL_HORIZON_HOURS;
  const closes = series((h) => 0.5 + 0.3 * Math.sin(h / 500), HOURS);
  const changed = [...closes.slice(0, i + 1), ...closes.slice(i + 1).map((c) => c * 3)];
  assert.strictEqual(forecastVolatility(changed, i), forecastVolatility(closes, i));
});

test("without enough history there is no forecast", () => {
  assert.ok(Number.isNaN(forecastVolatility(series(() => 0.8, 30 * 24), 30 * 24 - 1)));
});
