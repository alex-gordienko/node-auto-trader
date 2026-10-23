import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketFeatures,
  buildCandleFeatures,
  buildReferenceFeatures,
  IOHLCV,
} from "../src/utils/technical-indicators";

/**
 * If a feature at bar i depends on data after bar i (look-ahead bias), then truncating the
 * series after i and recomputing must change the value at i. Conversely, if the feature is
 * purely causal, truncation must leave every earlier row byte-identical. This test fails loudly
 * the moment any feature or indicator starts peeking into the future.
 */

const makeCandles = (n: number, seed = 1): IOHLCV[] => {
  let price = 100;
  const candles: IOHLCV[] = [];
  for (let i = 0; i < n; i++) {
    // deterministic pseudo-random walk so the series isn't degenerately flat/monotonic
    const delta = Math.sin(i * seed * 0.7) * 3 + Math.cos(i * 0.31) * 2;
    price = Math.max(1, price + delta);
    const high = price + Math.abs(Math.sin(i)) * 1.5;
    const low = price - Math.abs(Math.cos(i)) * 1.5;
    candles.push({
      time: i * 60,
      open: price - delta / 2,
      high,
      low,
      close: price,
      volume: 100 + (i % 7) * 10,
      trades: 50 + (i % 5) * 3,
      takerBuyVolume: 40 + (i % 9) * 2,
    });
  }
  return candles;
};

test("buildMarketFeatures: truncating the tail does not change earlier rows", () => {
  const full = makeCandles(80);
  const truncated = full.slice(0, 50);

  const fullFeatures = buildMarketFeatures(full);
  const truncatedFeatures = buildMarketFeatures(truncated);

  for (let i = 0; i < truncated.length; i++) {
    assert.deepEqual(
      truncatedFeatures[i],
      fullFeatures[i],
      `feature row ${i} changed after truncating future candles — look-ahead bias`
    );
  }
});

test("buildReferenceFeatures: truncating either series does not change earlier rows", () => {
  const own = makeCandles(80, 1);
  const reference = makeCandles(80, 1.3);

  const fullOwn = own;
  const fullRef = reference;
  const truncatedOwn = own.slice(0, 50);
  const truncatedRef = reference.slice(0, 50);

  const fullFeatures = buildReferenceFeatures(fullOwn, fullRef, 60);
  const truncatedFeatures = buildReferenceFeatures(truncatedOwn, truncatedRef, 60);

  for (let i = 0; i < truncatedOwn.length; i++) {
    assert.deepEqual(
      truncatedFeatures[i],
      fullFeatures[i],
      `reference feature row ${i} changed after truncating future candles — look-ahead bias`
    );
  }
});

test("buildCandleFeatures (full pipeline incl. references/premium/coinbase): truncation-stable", () => {
  const own = makeCandles(80, 1);
  const reference = makeCandles(80, 1.3);
  const premium = own.map((c) => ({ time: c.time, close: Math.sin(c.time) * 0.001 }));
  const coinbase = makeCandles(80, 1.6);

  const full = buildCandleFeatures(own, [reference], 60, premium, coinbase);
  const truncated = buildCandleFeatures(
    own.slice(0, 50),
    [reference.slice(0, 50)],
    60,
    premium.slice(0, 50),
    coinbase.slice(0, 50)
  );

  for (let i = 0; i < 50; i++) {
    assert.deepEqual(full[i], truncated[i], `combined feature row ${i} changed after truncation — look-ahead bias`);
  }
});
