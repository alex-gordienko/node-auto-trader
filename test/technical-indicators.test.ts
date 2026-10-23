import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, atr, stochastic, buildMarketFeatures, IOHLCV } from "../src/utils/technical-indicators";

// Hand-computed values below are derived independently from the textbook definitions
// (sliding-window average, Wilder's RSI smoothing, true range), not by reading the
// implementation, so they can catch a divergence from the intended formula.

describe("sma", () => {
  test("matches a hand-computed sliding window average and fills warm-up with 0 (not NaN)", () => {
    const out = sma([1, 2, 3, 4, 5, 6, 7, 8], 3);
    assert.deepEqual(out, [0, 0, 2, 3, 4, 5, 6, 7]);
    assert.ok(out.slice(0, 2).every((v) => Number.isFinite(v)), "warm-up values must not be NaN");
  });
});

describe("ema", () => {
  test("matches the hand-computed recursive EMA formula", () => {
    const out = ema([10, 20, 10, 20, 10], 2);
    const expected = [10, 50 / 3, 110 / 9, 470 / 27, 1010 / 81];
    out.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `index ${i}: ${v} vs ${expected[i]}`));
  });

  test("first value seeds from the first input instead of NaN", () => {
    assert.equal(ema([42, 1, 1, 1], 5)[0], 42);
  });
});

describe("rsi", () => {
  test("returns neutral 50 for the whole series when shorter than the period", () => {
    assert.deepEqual(rsi([1, 2, 3], 14), [50, 50, 50]);
  });

  test("matches Wilder's RSI hand-computed on a fixed series (period=4)", () => {
    // changes: +2, -1, +4, -1, +4 -> avgGain=1.5, avgLoss=0.5 at index 4; then Wilder-smoothed at index 5
    const out = rsi([10, 12, 11, 15, 14, 18], 4);
    assert.deepEqual(out.slice(0, 4), [50, 50, 50, 50]);
    assert.ok(Math.abs(out[4] - 75) < 1e-9, `index 4: ${out[4]}`);
    assert.ok(Math.abs(out[5] - 85) < 1e-9, `index 5: ${out[5]}`);
  });

  test("a monotonically rising series settles at RSI 100, not NaN/Infinity from a zero loss", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    const out = rsi(closes, 14);
    assert.equal(out[out.length - 1], 100);
    assert.ok(out.every(Number.isFinite));
  });
});

describe("atr", () => {
  const candle = (high: number, low: number, close: number): IOHLCV => ({
    time: 0,
    open: close,
    high,
    low,
    close,
    volume: 0,
  });

  test("matches hand-computed true range + sliding average (period=2)", () => {
    const candles = [candle(10, 8, 9), candle(12, 9, 11), candle(11, 7, 8), candle(15, 13, 8)];
    // tr: [2, max(3,|12-9|=3,0)=3, max(4,|11-11|=0,|7-11|=4)=4, max(2,|15-8|=7,|13-8|=5)=7]
    const out = atr(candles, 2);
    assert.deepEqual(out, [0, 2.5, 3.5, 5.5]);
  });
});

describe("stochastic", () => {
  test("fills warm-up with neutral 50 and matches a hand-computed %K afterwards", () => {
    const candle = (high: number, low: number, close: number): IOHLCV => ({
      time: 0,
      open: close,
      high,
      low,
      close,
      volume: 0,
    });
    // kPeriod=3: window at i=2 is bars [0,1,2] -> lowest=5, highest=15, close=12 -> %K=(12-5)/(15-5)*100=70
    const candles = [candle(10, 5, 8), candle(15, 10, 11), candle(14, 9, 12)];
    const { k } = stochastic(candles, 3, 1);
    assert.deepEqual(k.slice(0, 2), [50, 50]);
    assert.ok(Math.abs(k[2] - 70) < 1e-9, `k[2]: ${k[2]}`);
  });
});

describe("buildMarketFeatures warm-up handling", () => {
  test("never emits NaN/Infinity even for the very first candles", () => {
    const candles: IOHLCV[] = Array.from({ length: 5 }, (_, i) => ({
      time: i * 60,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 10,
    }));
    const features = buildMarketFeatures(candles);
    for (const row of features) {
      for (const value of row) {
        assert.ok(Number.isFinite(value), `expected finite feature, got ${value}`);
      }
    }
  });

  test("handles an all-zero-volume series without dividing by zero", () => {
    const candles: IOHLCV[] = Array.from({ length: 25 }, (_, i) => ({
      time: i * 60,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    }));
    const features = buildMarketFeatures(candles);
    for (const row of features) {
      for (const value of row) {
        assert.ok(Number.isFinite(value), `expected finite feature, got ${value}`);
      }
    }
  });
});
