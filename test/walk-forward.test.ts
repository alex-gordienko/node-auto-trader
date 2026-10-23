import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindows, walkForward, DirectionLabel } from '../src/services/direction/walk-forward';

const cfg = { trainSize: 100, testSize: 20, step: 20, embargo: 6, labelHorizon: 6 };

test('windows are time-ordered, embargoed and non-overlapping train/test', () => {
    const ws = makeWindows(300, cfg);
    assert.ok(ws.length > 1);
    for (const w of ws) {
        assert.equal(w.testStart - w.trainEnd, cfg.embargo);
        assert.ok(w.testEnd <= 300);
    }
    for (let i = 1; i < ws.length; i++) assert.ok(ws[i].testStart > ws[i - 1].testStart);
});

test('embargo shorter than label horizon is rejected', () => {
    assert.throws(() => makeWindows(300, { ...cfg, embargo: 2 }));
});

test('constant-Flat predictor on imbalanced data does not beat train-majority baseline', () => {
    const labels: DirectionLabel[] = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 'Up' : 'Flat'));
    const r = walkForward(labels, cfg, (_a, _b, s, e) => new Array(e - s).fill('Flat'));
    assert.equal(r.windowsBeatingTrainMajority, 0);
    assert.ok(r.meanAccuracy > 0.85); // looks respectable...
    assert.ok(r.windows.every((w) => w.predictedDistribution.Flat === w.n)); // ...but is degenerate, and visible
});

test('pure-noise labels: a random predictor stays near the random baseline', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = (): DirectionLabel => ['Up', 'Down', 'Flat'][Math.floor(rnd() * 3)] as DirectionLabel;
    const labels = Array.from({ length: 3000 }, pick);
    const r = walkForward(labels, { ...cfg, testSize: 200, step: 200 }, (_a, _b, s, e) => Array.from({ length: e - s }, pick));
    assert.ok(Math.abs(r.meanAccuracy - 1 / 3) < 0.05);
});

test('fitPredict is never given test labels via indices beyond train range', () => {
    const labels: DirectionLabel[] = Array.from({ length: 300 }, () => 'Up');
    walkForward(labels, cfg, (ts, te, s) => {
        assert.ok(te + cfg.embargo <= s);
        return new Array(cfg.testSize).fill('Up');
    });
});
