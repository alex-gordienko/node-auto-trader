export type DirectionLabel = 'Up' | 'Down' | 'Flat';
export const LABELS: DirectionLabel[] = ['Up', 'Down', 'Flat'];

export interface WalkForwardConfig {
    trainSize: number;
    testSize: number;
    step: number;
    /** Bars dropped between train end and test start. Must be >= label horizon so no train label overlaps test bars. */
    embargo: number;
    /** Bars ahead each label looks at; used to enforce embargo >= horizon. */
    labelHorizon: number;
}

export interface WalkForwardWindow {
    trainStart: number;
    trainEnd: number; // exclusive
    testStart: number;
    testEnd: number; // exclusive
}

export type ClassCounts = Record<DirectionLabel, number>;

export interface WindowResult {
    window: WalkForwardWindow;
    n: number;
    accuracy: number;
    majorityBaseline: number; // test-set majority rate (upper bound for a constant predictor)
    trainMajorityBaseline: number; // accuracy of always predicting the train-set majority class
    randomBaseline: number; // expected accuracy of sampling predictions from the train class prior
    actualDistribution: ClassCounts;
    predictedDistribution: ClassCounts;
}

export interface WalkForwardReport {
    config: WalkForwardConfig;
    windows: WindowResult[];
    meanAccuracy: number;
    stdAccuracy: number;
    meanMajorityBaseline: number;
    meanTrainMajorityBaseline: number;
    meanRandomBaseline: number;
    windowsBeatingTrainMajority: number;
}

export function makeWindows(total: number, cfg: WalkForwardConfig): WalkForwardWindow[] {
    if (cfg.embargo < cfg.labelHorizon) {
        throw new Error(`embargo (${cfg.embargo}) must be >= labelHorizon (${cfg.labelHorizon}); labels would leak across the boundary`);
    }
    if (cfg.trainSize <= 0 || cfg.testSize <= 0 || cfg.step <= 0 || cfg.embargo < 0) {
        throw new Error('trainSize, testSize, step must be > 0 and embargo >= 0');
    }
    const windows: WalkForwardWindow[] = [];
    for (let trainStart = 0; ; trainStart += cfg.step) {
        const trainEnd = trainStart + cfg.trainSize;
        const testStart = trainEnd + cfg.embargo;
        const testEnd = testStart + cfg.testSize;
        if (testEnd > total) break;
        windows.push({ trainStart, trainEnd, testStart, testEnd });
    }
    return windows;
}

const emptyCounts = (): ClassCounts => ({ Up: 0, Down: 0, Flat: 0 });

function countLabels(labels: DirectionLabel[]): ClassCounts {
    const c = emptyCounts();
    for (const l of labels) c[l]++;
    return c;
}

/**
 * fitPredict receives only the train slice [trainStart, trainEnd) and the test index range;
 * it must return one prediction per test bar. Test labels are never passed to it.
 */
export type FitPredict = (trainStart: number, trainEnd: number, testStart: number, testEnd: number) => DirectionLabel[];

export function walkForward(labels: DirectionLabel[], cfg: WalkForwardConfig, fitPredict: FitPredict): WalkForwardReport {
    const windows = makeWindows(labels.length, cfg);
    if (windows.length === 0) throw new Error('not enough data for a single walk-forward window');

    const results: WindowResult[] = windows.map((w) => {
        const preds = fitPredict(w.trainStart, w.trainEnd, w.testStart, w.testEnd);
        const n = w.testEnd - w.testStart;
        if (preds.length !== n) throw new Error(`fitPredict returned ${preds.length} predictions, expected ${n}`);
        const actual = labels.slice(w.testStart, w.testEnd);
        const trainCounts = countLabels(labels.slice(w.trainStart, w.trainEnd));
        const testCounts = countLabels(actual);
        const trainN = w.trainEnd - w.trainStart;
        const trainMajority = LABELS.reduce((a, b) => (trainCounts[b] > trainCounts[a] ? b : a));
        const correct = preds.reduce((s, p, i) => s + (p === actual[i] ? 1 : 0), 0);
        const randomBaseline = LABELS.reduce((s, l) => s + (trainCounts[l] / trainN) * (testCounts[l] / n), 0);
        return {
            window: w,
            n,
            accuracy: correct / n,
            majorityBaseline: Math.max(...LABELS.map((l) => testCounts[l])) / n,
            trainMajorityBaseline: testCounts[trainMajority] / n,
            randomBaseline,
            actualDistribution: testCounts,
            predictedDistribution: countLabels(preds),
        };
    });

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const acc = results.map((r) => r.accuracy);
    const m = mean(acc);
    return {
        config: cfg,
        windows: results,
        meanAccuracy: m,
        stdAccuracy: Math.sqrt(mean(acc.map((a) => (a - m) ** 2))),
        meanMajorityBaseline: mean(results.map((r) => r.majorityBaseline)),
        meanTrainMajorityBaseline: mean(results.map((r) => r.trainMajorityBaseline)),
        meanRandomBaseline: mean(results.map((r) => r.randomBaseline)),
        windowsBeatingTrainMajority: results.filter((r) => r.accuracy > r.trainMajorityBaseline).length,
    };
}

export function formatReport(r: WalkForwardReport): string {
    const d = (c: ClassCounts) => `U${c.Up}/D${c.Down}/F${c.Flat}`;
    const lines = [
        `walk-forward: train=${r.config.trainSize} test=${r.config.testSize} step=${r.config.step} embargo=${r.config.embargo} horizon=${r.config.labelHorizon}`,
        ...r.windows.map(
            (w, i) =>
                `#${i} test[${w.window.testStart},${w.window.testEnd}) acc=${w.accuracy.toFixed(3)} trainMaj=${w.trainMajorityBaseline.toFixed(3)} ` +
                `testMaj=${w.majorityBaseline.toFixed(3)} rand=${w.randomBaseline.toFixed(3)} actual=${d(w.actualDistribution)} pred=${d(w.predictedDistribution)}`,
        ),
        `mean acc=${r.meanAccuracy.toFixed(3)} (sd ${r.stdAccuracy.toFixed(3)}) trainMaj=${r.meanTrainMajorityBaseline.toFixed(3)} ` +
            `rand=${r.meanRandomBaseline.toFixed(3)}; beat train-majority in ${r.windowsBeatingTrainMajority}/${r.windows.length} windows`,
    ];
    return lines.join('\n');
}
