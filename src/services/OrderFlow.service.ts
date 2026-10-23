import "../utils/tfjs-node-compat";
import fse from "fs-extra";
import type * as tfType from "@tensorflow/tfjs-node";

import cryptoConfig from "../config/crypto.config";
import { CryptoPairs } from "../types/basic.types";
import { createLogger, Colors } from "../utils/colored-console";
import {
  DepthRow,
  LiquidationRow,
  ORDERFLOW_HORIZONS_SECONDS,
  ORDERFLOW_SECOND_FEATURES,
  ORDERFLOW_VERDICT_COUNT,
  OrderFlowSeconds,
  TradeRow,
} from "../utils/orderflow.features";
import { computeOutputErrors, correlationT, fitCalibration, IOutputCalibration } from "../utils/tensorflow.helpers";
import { readStream } from "./collectors/collector.reader";

const tf: typeof tfType = cryptoConfig.useGPU ? require("@tensorflow/tfjs-node-gpu") : require("@tensorflow/tfjs-node");
const log = createLogger("orderflow");

const MODEL_VERSION = 1;
// live per-second features kept for verdicts of the last DQN window (15 minutes) plus one model window
const LIVE_KEEP_SECONDS = 20 * 60;
// a window may miss a few seconds (reconnects); missing seconds are fed as zeros
const MAX_MISSING_SECONDS = 5;

interface IOrderFlowMetrics {
  version: number;
  trainedAt: number;
  windowSeconds: number;
  samples: number;
  featureMean: number[];
  featureStd: number[];
  targetStd: number[];
  calibration: IOutputCalibration[];
  outputs: { horizonSeconds: number; ic: number; icT: number; mseVsNaivePct: number; reliable: boolean }[];
}

export interface IOrderFlowBundle {
  model: tfType.LayersModel;
  metrics: IOrderFlowMetrics;
}

/**
 * Order-book model: reads the last `windowSeconds` of order-flow features (book imbalance, microprice, trade
 * flow, liquidations — see orderflow.features) and predicts the futures price move in 10 s / 1 min / 5 min.
 * Its verdict (calibrated, masked to the outputs that proved useful) is a DQN input.
 * Trained on recorded files; live features come every second from the recorders' worker thread.
 */
class OrderFlowService {
  private directory = `${cryptoConfig.paths.modelsDir}/orderflow_models`;
  private bundles = new Map<CryptoPairs, IOrderFlowBundle>();
  private live = new Map<string, Map<number, number[]>>();
  // recorded history loaded for the last training, reused for the DQN's verdict history
  private history = new Map<string, OrderFlowSeconds>();
  public readonly ready: Promise<void>;

  constructor() {
    log("initializing order-book model", Colors.GREEN);
    fse.ensureDirSync(this.directory);
    this.ready = this.load();
  }

  private get window() {
    return cryptoConfig.orderFlow.windowSeconds;
  }

  private dir(pair: CryptoPairs) {
    return `${this.directory}/orderflow_model_${pair}`;
  }

  private async load(): Promise<void> {
    for (const pair of Object.values(CryptoPairs)) {
      try {
        const metrics: IOrderFlowMetrics = fse.readJsonSync(`${this.dir(pair)}/metrics.json`);
        if (metrics.version !== MODEL_VERSION || metrics.windowSeconds !== this.window) continue;
        const model = await tf.loadLayersModel(`file://${this.dir(pair)}/model.json`);
        this.compile(model);
        this.bundles.set(pair, { model, metrics });
        log(`${pair}: model loaded`, Colors.GREEN);
      } catch {
        log(`${pair}: no model yet, it is trained once enough order-book data is recorded`, Colors.YELLOW);
      }
    }
  }

  private compile(model: tfType.LayersModel) {
    model.compile({ optimizer: tf.train.adam(0.001), loss: "meanSquaredError" });
  }

  private createModel(): tfType.LayersModel {
    const model = tf.sequential();
    model.add(tf.layers.inputLayer({ inputShape: [this.window, ORDERFLOW_SECOND_FEATURES] }));
    model.add(tf.layers.conv1d({ filters: 16, kernelSize: 5, activation: "relu" }));
    model.add(tf.layers.lstm({ units: 32 }));
    model.add(tf.layers.dense({ units: 16, activation: "relu" }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.dense({ units: ORDERFLOW_VERDICT_COUNT }));
    this.compile(model);
    return model;
  }

  // ---------- live features ----------

  /** A feature vector of one second from the recorders' worker thread. */
  public addLive(symbol: string, second: number, vector: number[]): void {
    const seconds = this.live.get(symbol) ?? new Map<number, number[]>();
    seconds.set(second, vector);
    for (const key of seconds.keys()) if (key < second - LIVE_KEEP_SECONDS) seconds.delete(key);
    this.live.set(symbol, seconds);
  }

  // ---------- windows and tensors ----------

  /** Features of the `window` seconds ending at `end` (inclusive); null if too many seconds are missing. */
  private windowAt(vectorAt: (second: number) => number[] | null | undefined, end: number): number[][] | null {
    const rows: number[][] = [];
    let missing = 0;
    for (let s = end - this.window + 1; s <= end; s++) {
      const v = vectorAt(s);
      // most candles of the DQN's 90 days lie before recording started: stop as soon as the window is unusable
      if (!v && ++missing > MAX_MISSING_SECONDS) return null;
      rows.push(v ?? new Array(ORDERFLOW_SECOND_FEATURES).fill(0));
    }
    return rows;
  }

  private toTensor(windows: number[][][], mean: number[], std: number[]): tfType.Tensor3D {
    const n = windows.length;
    const F = ORDERFLOW_SECOND_FEATURES;
    const data = new Float32Array(n * this.window * F);
    windows.forEach((w, i) =>
      w.forEach((row, s) =>
        row.forEach((v, f) => (data[(i * this.window + s) * F + f] = Math.max(-5, Math.min(5, (v - mean[f]) / std[f]))))
      )
    );
    return tf.tensor3d(data, [n, this.window, F]);
  }

  /** Calibrated predictions in basis points, one row per window. */
  private predict(bundle: IOrderFlowBundle, windows: number[][][]): number[][] {
    const result: number[][] = [];
    const { featureMean, featureStd, targetStd, calibration } = bundle.metrics;
    for (let start = 0; start < windows.length; start += 2048) {
      const x = this.toTensor(windows.slice(start, start + 2048), featureMean, featureStd);
      // tfjs predicts in batches of 32 by default, which is many times slower
      const out = tf.tidy(() => (bundle.model.predict(x, { batchSize: 2048 }) as tfType.Tensor).arraySync() as number[][]);
      x.dispose();
      out.forEach((row) => result.push(row.map((v, j) => calibration[j].a + calibration[j].b * v * targetStd[j])));
    }
    return result;
  }

  // ---------- training ----------

  /** Recorded order-book history of the pair for the last `trainingDays`. */
  private loadHistory(pair: CryptoPairs): OrderFlowSeconds {
    const from = Date.now() - cryptoConfig.orderFlow.trainingDays * 86400_000;
    log(`${pair}: reading recorded order books, trades and liquidations`, Colors.CYAN);
    const flow = new OrderFlowSeconds(pair.replace("-", ""));
    for (const row of readStream<DepthRow>(`${pair}/futures-depth`, from)) flow.addBook("futures", row);
    for (const row of readStream<DepthRow>(`${pair}/spot-depth`, from)) flow.addBook("spot", row);
    for (const row of readStream<TradeRow>(`${pair}/futures-trades`, from)) flow.addTrade("futures", row);
    for (const row of readStream<TradeRow>(`${pair}/spot-trades`, from)) flow.addTrade("spot", row);
    for (const row of readStream<LiquidationRow>("ALL/futures-liquidations", from)) flow.addLiquidation(row);
    this.history.set(pair, flow);
    return flow;
  }

  /**
   * Trains a new model on the recorded history; it is not used until `commit`. Same honest scheme as the
   * forecast model: time-ordered train / calibration / evaluation parts with a gap of the longest horizon.
   */
  public async train(pair: CryptoPairs): Promise<IOrderFlowBundle | null> {
    if (!cryptoConfig.features.orderFlow) return null;
    const flow = this.loadHistory(pair);
    const seconds = flow.seconds();
    const hours = seconds.length / 3600;
    if (hours < cryptoConfig.orderFlow.minHours) {
      log(`${pair}: only ${hours.toFixed(1)} h of order-book data recorded, not training yet`, Colors.YELLOW);
      return null;
    }

    const { sampleStepSeconds, maxSamples, epochs } = cryptoConfig.orderFlow;
    const longest = ORDERFLOW_HORIZONS_SECONDS[ORDERFLOW_HORIZONS_SECONDS.length - 1];
    const step = Math.max(sampleStepSeconds, Math.ceil(seconds.length / maxSamples));
    const vectors = new Map<number, number[]>();
    seconds.forEach((s) => {
      const v = flow.vectorAt(s);
      if (v) vectors.set(s, v);
    });

    const windows: number[][][] = [];
    const ys: number[][] = [];
    for (let t = seconds[0] + this.window; t + longest <= seconds[seconds.length - 1]; t += step) {
      const mid = flow.midAt(t);
      const future = ORDERFLOW_HORIZONS_SECONDS.map((h) => flow.midAt(t + h));
      if (!mid || future.some((f) => !f)) continue;
      const w = this.windowAt((s) => vectors.get(s), t);
      if (!w) continue;
      windows.push(w);
      ys.push(future.map((f) => Math.log(f! / mid) * 1e4));
    }
    if (windows.length < 2000) {
      log(`${pair}: only ${windows.length} usable windows, not training yet`, Colors.YELLOW);
      return null;
    }

    const n = windows.length;
    const embargo = Math.ceil(longest / step);
    const calStart = Math.floor(n * 0.7);
    const evalStart = Math.floor(n * 0.85);
    const train = { x: windows.slice(0, calStart - embargo), y: ys.slice(0, calStart - embargo) };
    const cal = { x: windows.slice(calStart, evalStart - embargo), y: ys.slice(calStart, evalStart - embargo) };
    const evaluation = { x: windows.slice(evalStart), y: ys.slice(evalStart) };

    // feature scaling from the last second of each training window; targets keep mean 0 (no drift)
    const lastRows = train.x.map((w) => w[w.length - 1]);
    const featureMean = Array.from({ length: ORDERFLOW_SECOND_FEATURES }, (_, f) => lastRows.reduce((a, r) => a + r[f], 0) / lastRows.length);
    const featureStd = featureMean.map(
      (m, f) => Math.sqrt(lastRows.reduce((a, r) => a + (r[f] - m) ** 2, 0) / Math.max(lastRows.length - 1, 1)) || 1
    );
    const targetStd = ORDERFLOW_HORIZONS_SECONDS.map(
      (_, j) => Math.sqrt(train.y.reduce((a, y) => a + y[j] ** 2, 0) / Math.max(train.y.length - 1, 1)) || 1
    );
    const scaleY = (rows: number[][]) =>
      tf.tensor2d(rows.map((r) => r.map((v, j) => Math.max(-5, Math.min(5, v / targetStd[j])))));

    const xTrain = this.toTensor(train.x, featureMean, featureStd);
    const yTrain = scaleY(train.y);
    const xCal = this.toTensor(cal.x, featureMean, featureStd);
    const yCal = scaleY(cal.y);
    const model = this.createModel();

    let best = Infinity;
    let bestWeights: tfType.Tensor[] | null = null;
    let badEpochs = 0;
    let epochStartedAt = Date.now();
    const patience = 6;
    const keepBest = new tf.CustomCallback({
      onEpochEnd: async (epoch, logs) => {
        const loss = logs?.val_loss ?? Infinity;
        const improved = loss < best - 1e-5;
        if (improved) {
          best = loss;
          bestWeights?.forEach((w) => w.dispose());
          bestWeights = model.getWeights().map((w) => w.clone());
          badEpochs = 0;
        } else if (++badEpochs >= patience) {
          model.stopTraining = true;
        }
        log(
          `${pair}: epoch ${epoch + 1}/${epochs}: loss ${(logs?.loss ?? NaN).toFixed(4)}, val ${loss.toFixed(4)}` +
            `${improved ? " (best)" : ` (no gain ${badEpochs}/${patience})`}, ${((Date.now() - epochStartedAt) / 1000).toFixed(0)}s`,
          Colors.CYAN
        );
        epochStartedAt = Date.now();
      },
    });

    log(`${pair}: training on ${train.x.length} windows of ${this.window}s (${hours.toFixed(1)} h recorded)`, Colors.GREEN);
    try {
      await model.fit(xTrain, yTrain, { epochs, batchSize: 256, shuffle: true, validationData: [xCal, yCal], callbacks: keepBest, verbose: 0 });
      if (bestWeights) {
        model.setWeights(bestWeights);
        (bestWeights as tfType.Tensor[]).forEach((w) => w.dispose());
      }

      const raw = (x: number[][][]) => {
        const t = this.toTensor(x, featureMean, featureStd);
        const out = tf.tidy(() => (model.predict(t, { batchSize: 2048 }) as tfType.Tensor).arraySync() as number[][]);
        t.dispose();
        return out.map((row) => row.map((v, j) => v * targetStd[j]));
      };
      const calPred = raw(cal.x);
      const calibration = ORDERFLOW_HORIZONS_SECONDS.map((_, j) =>
        fitCalibration(
          calPred.map((p) => p[j]),
          cal.y.map((y) => y[j]),
          true
        )
      );
      const evalPred = raw(evaluation.x).map((row) => row.map((v, j) => calibration[j].a + calibration[j].b * v));
      const errors = computeOutputErrors(evalPred, evaluation.y, ORDERFLOW_HORIZONS_SECONDS.map(() => 0), 1);

      const outputs = ORDERFLOW_HORIZONS_SECONDS.map((horizonSeconds, j) => {
        const icT = correlationT(errors.ic[j], evaluation.y.length, horizonSeconds / step);
        return {
          horizonSeconds,
          ic: errors.ic[j],
          icT,
          mseVsNaivePct: (1 - errors.mse[j] / errors.naiveMse[j]) * 100,
          reliable: calibration[j].b > 0 && errors.ic[j] > 0 && icT > 2 && errors.mse[j] < errors.naiveMse[j],
        };
      });
      outputs.forEach((o) =>
        log(
          `${pair}: ${String(o.horizonSeconds).padStart(3)} s  IC=${o.ic.toFixed(3)} (t=${o.icT.toFixed(1)}) ` +
            `MSE vs naive ${o.mseVsNaivePct.toFixed(2)}% better  ${o.reliable ? "reliable" : "not reliable"}`,
          o.reliable ? Colors.GREEN : Colors.YELLOW
        )
      );

      return {
        model,
        metrics: {
          version: MODEL_VERSION,
          trainedAt: Date.now(),
          windowSeconds: this.window,
          samples: n,
          featureMean,
          featureStd,
          targetStd,
          calibration,
          outputs,
        },
      };
    } catch (error) {
      log(`${pair}: training failed: ${error}`, Colors.RED);
      model.dispose();
      return null;
    } finally {
      tf.dispose([xTrain, yTrain, xCal, yCal]);
    }
  }

  /** Puts a trained model into use (together with the DQN that learned from its verdicts) and saves it. */
  public async commit(pair: CryptoPairs, bundle: IOrderFlowBundle): Promise<void> {
    this.bundles.get(pair)?.model.dispose();
    this.bundles.set(pair, bundle);
    fse.ensureDirSync(this.dir(pair));
    await bundle.model.save(`file://${this.dir(pair)}`);
    fse.writeJsonSync(`${this.dir(pair)}/metrics.json`, bundle.metrics, { spaces: 2 });
  }

  public liveBundle(pair: CryptoPairs): IOrderFlowBundle | undefined {
    return this.bundles.get(pair);
  }

  /** The recorded history (~50 MB of memory per recorded day) is needed only until the DQN has its verdicts. */
  public releaseHistory(pair: CryptoPairs): void {
    this.history.delete(pair);
  }

  // ---------- verdicts for the DQN ----------

  /**
   * Verdict per minute candle (open times in seconds): what the model expects right after the candle closes,
   * from the window ending at its last second. In units of each output's typical move (≈ ±1); zeros where data
   * is missing, for outputs that did not prove useful, or when the feature group is off.
   */
  public verdicts(pair: CryptoPairs, candleTimes: number[], source: "live" | "history", bundle = this.liveBundle(pair)): number[][] {
    const empty = () => new Array(ORDERFLOW_VERDICT_COUNT).fill(0);
    if (!bundle || !cryptoConfig.features.orderFlow) return candleTimes.map(empty);

    const liveSeconds = this.live.get(pair);
    const historySeconds = this.history.get(pair);
    const vectorAt = (s: number) => (source === "live" ? liveSeconds?.get(s) : historySeconds?.vectorAt(s));

    const index: number[] = [];
    const windows: number[][][] = [];
    candleTimes.forEach((time, i) => {
      const w = this.windowAt(vectorAt, time + 59);
      if (w) {
        index.push(i);
        windows.push(w);
      }
    });

    const result = candleTimes.map(empty);
    if (!windows.length) return result;
    const reliable = bundle.metrics.outputs.map((o) => o.reliable);
    this.predict(bundle, windows).forEach((row, k) => {
      result[index[k]] = row.map((v, j) => (reliable[j] ? v / bundle.metrics.targetStd[j] : 0));
    });
    return result;
  }
}

export default new OrderFlowService();
