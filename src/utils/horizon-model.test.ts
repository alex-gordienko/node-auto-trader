import assert from "assert";
import fs from "fs";
import path from "path";
import { test } from "node:test";

import { entrySide, entryThreshold, FEATURE_NAMES, horizonFeatures, IGbmModel, IHorizonInputs, IRidgeModel, predictHorizon, quantile } from "./horizon-model";

// written by research/horizon/export.py: Python features and predictions at the last 6 decision points of its data
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "horizon-model.fixture.json"), "utf-8"));

const toInputs = (cut = Infinity): IHorizonInputs => ({
  minutes: fixture.candles.ETHUSDT.filter((r: number[]) => r[0] < cut).map(([t, o, h, l, c, v, tbv]: number[]) => ({ t, o, h, l, c, v, tbv })),
  other: fixture.candles.BTCUSDT.filter((r: number[]) => r[0] < cut).map(([t, , , , c]: number[]) => ({ t, c })),
  dailyCloses: fixture.dailyCloses.map(([t, c]: number[]) => ({ t, c })),
  funding: fixture.funding.map(([t, rate]: number[]) => ({ t, rate })),
});

const close = (a: number, b: number | null) => (b === null ? Number.isNaN(a) : Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)));

test("features equal the Python research features", () => {
  for (const [name, c] of Object.entries<{ times: number[]; features: (number | null)[][] }>(fixture.candidates)) {
    const ts = horizonFeatures(toInputs(), c.times);
    c.times.forEach((_, r) =>
      FEATURE_NAMES.forEach((f, j) => assert.ok(close(ts[r][j], c.features[r][j]), `${name} ${f}: TS ${ts[r][j]} vs Python ${c.features[r][j]}`))
    );
  }
});

test("model scores equal Python on the same features, and on the TS features", () => {
  for (const c of Object.values<{ model: IRidgeModel | IGbmModel; times: number[]; features: (number | null)[][]; predictions: number[] }>(fixture.candidates)) {
    const ts = horizonFeatures(toInputs(), c.times);
    c.features.forEach((row, r) => {
      const x = row.map((v) => (v === null ? NaN : v));
      assert.ok(Math.abs(predictHorizon(c.model, x) - c.predictions[r]) < 1e-12);
      assert.ok(Math.abs(predictHorizon(c.model, ts[r]) - c.predictions[r]) < 1e-9);
    });
  }
});

test("features at a decision time ignore candles that closed after it", () => {
  const times: number[] = fixture.candidates["eth-3d-gbm"].times;
  const T = times[2];
  const all = horizonFeatures(toInputs(), [T])[0];
  const cut = horizonFeatures(toInputs(T), [T])[0]; // only minutes opened before T, i.e. closed by T
  all.forEach((v, j) => assert.ok(Object.is(v, cut[j]) || Math.abs(v - cut[j]) < 1e-12, FEATURE_NAMES[j]));
});

test("the entry threshold uses only past scores and needs a week of them", () => {
  const day = 86_400_000;
  // scores spread evenly over [0, 1) every day: the 3-a-day quantile sits just below 1
  const past = Array.from({ length: 288 * 10 }, (_, i) => ({ t: i * 300_000, s: (i % 288) / 288 }));
  const now = 10 * day;
  assert.ok(Number.isNaN(entryThreshold(past.slice(0, 288 * 6), now, "long")));
  const thr = entryThreshold(past, now, "long");
  assert.ok(thr > 0 && thr < 1);
  assert.strictEqual(entrySide(1, thr, "long"), 1);
  assert.strictEqual(entrySide(-1, thr, "long"), 0);
  assert.strictEqual(entrySide(-1, thr, "ls"), -1);
  assert.strictEqual(entrySide(1, NaN, "ls"), 0);
  assert.strictEqual(quantile([1, 2, 3, 4], 0.5), 2.5);
});
