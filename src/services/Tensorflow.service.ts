import "../utils/tfjs-node-compat";
import fse from "fs-extra";
import type * as tfType from "@tensorflow/tfjs-node";
import { format } from "date-fns";

import cryptoConfig from "../config/crypto.config";

import { IMarketDataset } from "../types/marketData.types";
import { log, Colors, getRandomEnumValue } from "../utils/colored-console";
import { IForecastPath, ITensorflowPrediction } from "../types/cryptoExchange.types";
import { CryptoPairs } from "../types/basic.types";
import { buildCandleFeatures, INDICATOR_WARMUP, IOHLCV } from "../utils/technical-indicators";
import {
  applyColumnScaler,
  argmax,
  buildForecastSamples,
  buildFuturesContext,
  buildHourlyContext,
  CANDLE_FEATURE_COUNT,
  CONTEXT_FEATURE_COUNT,
  fitColumnScaler,
  IColumnScaler,
  IFuturesContext,
  computeOutputErrors,
  correlationT,
  fitCalibration,
  fitFeatureScaler,
  fitTargetScaler,
  FORECAST_MODEL_VERSION,
  IFeatureScaler,
  IForecastOutputMetrics,
  IOutputCalibration,
  outputOverlap,
  FORECAST_LAYOUT,
  FORECAST_TARGET_SCALE,
  forecastInputAt,
  evaluateLivePredictions,
  IForecastInput,
  IForecastMetrics,
  IHourlyContext,
  ILiveFeedback,
  naiveForecastValues,
  toOHLCV,
} from "../utils/tensorflow.helpers";
import {
  buildInferenceState,
  DQN_FEATURE_COUNT,
  RL_ACTION_LABELS,
  RLAction,
  RLActionIndex,
  TradingEnvironment,
} from "./rl/trading-env";
import { ITransition, ReplayBuffer } from "./rl/replay-buffer";

const tf: typeof tfType = cryptoConfig.useGPU ? require("@tensorflow/tfjs-node-gpu") : require("@tensorflow/tfjs-node");

/**
 * Two linked models per pair:
 * - forecast: supervised regressor over minute + hourly candles and time of day / week; predicts the price path:
 *   returns at several horizons, the best (max / min) price within the longest one, and when it happens;
 * - DQN: chooses Hold / Buy / Sell and receives the forecast as an input feature.
 * Both self-correct on retraining using saved production predictions vs. prices that actually happened.
 */
/** Precomputed inputs for backtesting one pair. */
export interface IBacktestInputs {
  pair: CryptoPairs;
  candles: IOHLCV[];
  startIndex: number;
  dqn: number[][]; // standardized candle features
  forecast: number[][]; // forecast outputs as the DQN sees them (masked when unreliable)
  raw: (number[] | null)[]; // raw forecast outputs per candle, for the range rule
}

class TensorflowAI {
  private dqnDirectory: string = `${cryptoConfig.paths.modelsDir}/dqn_models`;
  private forecastDirectory: string = `${cryptoConfig.paths.modelsDir}/forecast_models`;

  private modelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();
  private targetModelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();
  private forecastModelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();
  private forecastMetricsMap: Map<CryptoPairs, IForecastMetrics> = new Map();
  // DQN inputs are standardized with the statistics of its first training data
  private dqnScalerMap: Map<CryptoPairs, IColumnScaler> = new Map();

  constructor() {
    log("[*] Initializing Tensorflow Service (forecast + DQN)", Colors.GREEN);
    fse.ensureDirSync(this.dqnDirectory);
    fse.ensureDirSync(this.forecastDirectory);
    this.loadModels();
  }

  private get dqnTimeSteps() {
    return cryptoConfig.longTermMinuteWindowPrediction;
  }

  private get forecastWindow() {
    return cryptoConfig.forecast.windowSize;
  }

  private get hourWindow() {
    return cryptoConfig.forecast.hourWindowSize;
  }

  private get horizon() {
    return cryptoConfig.forecast.horizonMinutes;
  }

  public generateModelName(pair: CryptoPairs): string {
    return `dqn_model_${pair}`;
  }

  private generateForecastModelName(pair: CryptoPairs): string {
    return `forecast_model_${pair}`;
  }

  // ---------- model creation / persistence ----------

  /** Conv1D finds short local patterns, LSTM tracks how they evolve; optional LayerNorm stabilizes activations. */
  private createDQNmodel = (): tfType.LayersModel => {
    const { convFilters, lstmUnits, denseUnits, layerNorm } = cryptoConfig.rl.network;
    const model = tf.sequential();
    model.add(tf.layers.inputLayer({ inputShape: [this.dqnTimeSteps, DQN_FEATURE_COUNT] }));
    model.add(tf.layers.conv1d({ filters: convFilters, kernelSize: 3, activation: "relu" }));
    if (layerNorm) model.add(tf.layers.layerNormalization());
    model.add(tf.layers.lstm({ units: lstmUnits }));
    if (layerNorm) model.add(tf.layers.layerNormalization());
    model.add(tf.layers.dense({ units: denseUnits, activation: "relu" }));
    model.add(tf.layers.dense({ units: 3 }));
    this.compileDQN(model);
    return model;
  };

  /** A saved model is reused only if it has exactly the architecture the current config would build. */
  private sameArchitecture(saved: tfType.LayersModel, fresh: tfType.LayersModel): boolean {
    const same = saved.layers.length === fresh.layers.length && saved.countParams() === fresh.countParams();
    fresh.dispose();
    return same;
  }

  private compileDQN(model: tfType.LayersModel) {
    model.compile({ optimizer: tf.train.adam(cryptoConfig.rl.learningRate), loss: "meanSquaredError" });
  }

  /** Minute branch sees short-term patterns, hourly branch — daily cycles and trend, time input — hour / weekday. */
  private createForecastModel(): tfType.LayersModel {
    const minuteIn = tf.input({ shape: [this.forecastWindow, CANDLE_FEATURE_COUNT], name: "minute" });
    const hourIn = tf.input({ shape: [this.hourWindow, CANDLE_FEATURE_COUNT], name: "hour" });
    // time of day / week + futures market state
    const contextIn = tf.input({ shape: [CONTEXT_FEATURE_COUNT], name: "context" });

    const { minuteUnits, minuteLayers, hourUnits, denseUnits, dropout, l2, layerNorm } = cryptoConfig.forecast.network;
    const apply = (layer: tfType.layers.Layer, input: tfType.SymbolicTensor | tfType.SymbolicTensor[]) =>
      layer.apply(input) as tfType.SymbolicTensor;
    const norm = (input: tfType.SymbolicTensor) => (layerNorm ? apply(tf.layers.layerNormalization(), input) : input);

    // stacked LSTMs: lower layers see raw minute patterns, upper ones — patterns of patterns
    let minuteBranch: tfType.SymbolicTensor = minuteIn;
    for (let i = 0; i < minuteLayers; i++) {
      const last = i === minuteLayers - 1;
      minuteBranch = apply(tf.layers.lstm({ units: minuteUnits, dropout: 0.1, returnSequences: !last }), minuteBranch);
      minuteBranch = norm(minuteBranch);
    }
    let hourBranch = apply(tf.layers.lstm({ units: hourUnits, dropout: 0.1 }), hourIn);
    hourBranch = norm(hourBranch);

    const merged = apply(tf.layers.concatenate(), [minuteBranch, hourBranch, contextIn]);
    let hidden = apply(tf.layers.dense({ units: denseUnits, activation: "relu", kernelRegularizer: tf.regularizers.l2({ l2 }) }), merged);
    hidden = norm(hidden);
    hidden = apply(tf.layers.dropout({ rate: dropout }), hidden);
    hidden = apply(tf.layers.dense({ units: denseUnits / 2, activation: "relu", kernelRegularizer: tf.regularizers.l2({ l2 }) }), hidden);
    hidden = apply(tf.layers.dropout({ rate: dropout }), hidden);
    const output = apply(tf.layers.dense({ units: FORECAST_LAYOUT.count }), hidden);

    const model = tf.model({ inputs: [minuteIn, hourIn, contextIn], outputs: output });
    this.compileForecast(model);
    return model;
  }

  private isForecastModelCompatible(model: tfType.LayersModel): boolean {
    const [minute, hour, context] = model.inputs.map((i) => i.shape);
    return (
      model.inputs.length === 3 &&
      minute[1] === this.forecastWindow &&
      minute[2] === CANDLE_FEATURE_COUNT &&
      hour[1] === this.hourWindow &&
      hour[2] === CANDLE_FEATURE_COUNT &&
      context[1] === CONTEXT_FEATURE_COUNT &&
      model.outputs[0].shape[1] === FORECAST_LAYOUT.count
    );
  }

  private compileForecast(model: tfType.LayersModel) {
    // targets are standardized and clipped, so plain MSE is stable and matches the calibration below
    model.compile({ optimizer: tf.train.adam(cryptoConfig.forecast.learningRate), loss: "meanSquaredError" });
  }

  private hasInputShape(model: tfType.LayersModel, steps: number, features: number): boolean {
    const shape = model.inputs[0].shape;
    return shape[1] === steps && shape[2] === features;
  }

  private cloneWeights(source: tfType.LayersModel, target: tfType.LayersModel) {
    const clones = source.getWeights().map((w) => w.clone());
    target.setWeights(clones);
    clones.forEach((w) => w.dispose());
  }

  private loadModels = async () => {
    for (const pair of Object.values(CryptoPairs)) {
      await this.loadDQN(pair);
      await this.loadForecast(pair);
    }
  };

  private async loadDQN(pair: CryptoPairs) {
    let model: tfType.LayersModel | null = null;
    try {
      const dir = `${this.dqnDirectory}/${this.generateModelName(pair)}`;
      model = await tf.loadLayersModel(`file://${dir}/model.json`);
      if (
        !this.hasInputShape(model, this.dqnTimeSteps, DQN_FEATURE_COUNT) ||
        !this.sameArchitecture(model, this.createDQNmodel()) ||
        !fse.existsSync(`${dir}/scaler.json`)
      ) {
        log(`[**] Saved DQN for ${pair} has an old layout or size, creating a new one`, Colors.YELLOW);
        model.dispose();
        model = null;
      } else {
        this.dqnScalerMap.set(pair, fse.readJsonSync(`${dir}/scaler.json`));
        this.compileDQN(model);
        log(`[**] DQN model ${pair} loaded from file`, Colors.GREEN);
      }
    } catch {
      log(`[**] No DQN model for ${pair} yet, creating a new one`, Colors.YELLOW);
    }

    const policy = model ?? this.createDQNmodel();
    const target = this.createDQNmodel();
    this.cloneWeights(policy, target);
    this.modelsMap.set(pair, policy);
    this.targetModelsMap.set(pair, target);
  }

  private async loadForecast(pair: CryptoPairs) {
    const dir = `${this.forecastDirectory}/${this.generateForecastModelName(pair)}`;
    try {
      const model = await tf.loadLayersModel(`file://${dir}/model.json`);
      if (!this.isForecastModelCompatible(model) || !this.sameArchitecture(model, this.createForecastModel())) {
        log(`[**] Saved forecast model for ${pair} has an old layout or size, it will be retrained`, Colors.YELLOW);
        model.dispose();
        return;
      }
      const metrics: IForecastMetrics | null = fse.existsSync(`${dir}/metrics.json`) ? fse.readJsonSync(`${dir}/metrics.json`) : null;
      if (metrics?.version !== FORECAST_MODEL_VERSION) {
        log(`[**] Saved forecast model for ${pair} is from an older version, it will be retrained`, Colors.YELLOW);
        model.dispose();
        return;
      }
      this.compileForecast(model);
      this.forecastModelsMap.set(pair, model);
      this.forecastMetricsMap.set(pair, metrics);
      log(`[**] Forecast model ${pair} loaded from file`, Colors.GREEN);
    } catch {
      log(`[**] No forecast model for ${pair} yet, it will be created on next training`, Colors.YELLOW);
    }
  }

  private saveDQN = async (pair: CryptoPairs) => {
    const model = this.modelsMap.get(pair);
    if (!model) return;
    const path = `${this.dqnDirectory}/${this.generateModelName(pair)}`;
    fse.ensureDirSync(path);
    await model.save("file://" + path);
    fse.writeJsonSync(`${path}/scaler.json`, this.dqnScalerMap.get(pair));
    log(`[**] DQN model ${pair} saved to file`, Colors.GREEN);
  };

  private saveForecast = async (pair: CryptoPairs) => {
    const model = this.forecastModelsMap.get(pair);
    if (!model) return;
    const path = `${this.forecastDirectory}/${this.generateForecastModelName(pair)}`;
    fse.ensureDirSync(path);
    await model.save("file://" + path);
    fse.writeJsonSync(`${path}/metrics.json`, this.forecastMetricsMap.get(pair), { spaces: 2 });
  };

  // ---------- forecast ----------

  private isForecastReliable(pair: CryptoPairs): boolean {
    return this.forecastMetricsMap.get(pair)?.beatsNaive ?? false;
  }

  private reliableOutputs(pair: CryptoPairs): boolean[] {
    const outputs = this.forecastMetricsMap.get(pair)?.outputs;
    return Array.from({ length: FORECAST_LAYOUT.count }, (_, j) => outputs?.[j]?.reliable ?? false);
  }

  /** Standardized (and clipped) model inputs, written straight into typed arrays to keep memory low. */
  private forecastTensors(inputs: IForecastInput[], scaler: IFeatureScaler): tfType.Tensor[] {
    const n = inputs.length;
    const W = this.forecastWindow;
    const H = this.hourWindow;
    const F = CANDLE_FEATURE_COUNT;
    const C = CONTEXT_FEATURE_COUNT;
    const minute = new Float32Array(n * W * F);
    const hour = new Float32Array(n * H * F);
    const context = new Float32Array(n * C);
    const norm = (v: number, m: number, s: number) => Math.max(-5, Math.min(5, (v - m) / s));

    inputs.forEach((input, i) => {
      for (let w = 0; w < W; w++) {
        for (let f = 0; f < F; f++) {
          minute[(i * W + w) * F + f] = norm(input.minute[w][f], scaler.minuteMean[f], scaler.minuteStd[f]);
        }
      }
      for (let w = 0; w < H; w++) {
        for (let f = 0; f < F; f++) {
          hour[(i * H + w) * F + f] = norm(input.hour[w][f], scaler.hourMean[f], scaler.hourStd[f]);
        }
      }
      for (let c = 0; c < C; c++) {
        context[i * C + c] = norm(input.context[c], scaler.contextMean[c], scaler.contextStd[c]);
      }
    });

    return [tf.tensor3d(minute, [n, W, F]), tf.tensor3d(hour, [n, H, F]), tf.tensor2d(context, [n, C])];
  }

  /** Model outputs converted back to target units (before calibration), in chunks to bound memory. */
  private predictTargets(
    model: tfType.LayersModel,
    inputs: IForecastInput[],
    scaler: IFeatureScaler,
    targetMean: number[],
    targetStd: number[]
  ): number[][] {
    const result: number[][] = [];
    for (let start = 0; start < inputs.length; start += 2048) {
      const chunk = inputs.slice(start, start + 2048);
      const xs = this.forecastTensors(chunk, scaler);
      const out = tf.tidy(() => (model.predict(xs) as tfType.Tensor).arraySync() as number[][]);
      tf.dispose(xs);
      out.forEach((row) => result.push(row.map((v, j) => v * targetStd[j] + targetMean[j])));
    }
    return result;
  }

  private calibrate(rows: number[][], calibration: IOutputCalibration[]): number[][] {
    return rows.map((row) => row.map((v, j) => calibration[j].a + calibration[j].b * v));
  }

  /** Calibrated forecast for every candle from `fromIndex`, aligned with `candles`; null where history is missing. */
  private forecastSeries(
    pair: CryptoPairs,
    candles: IOHLCV[],
    features: number[][],
    hourly: IHourlyContext,
    futures: IFuturesContext,
    fromIndex = 0
  ): (number[] | null)[] {
    const series: (number[] | null)[] = new Array(candles.length).fill(null);
    const model = this.forecastModelsMap.get(pair);
    const metrics = this.forecastMetricsMap.get(pair);
    if (!model || !metrics) return series;

    const indexes: number[] = [];
    const inputs: IForecastInput[] = [];
    for (let t = Math.max(fromIndex, 0); t < candles.length; t++) {
      const input = forecastInputAt(t, candles, features, hourly, futures, this.forecastWindow, this.hourWindow);
      if (input) {
        indexes.push(t);
        inputs.push(input);
      }
    }

    const targets = this.predictTargets(model, inputs, metrics.scaler, metrics.targetMean, metrics.targetStd);
    this.calibrate(targets, metrics.calibration).forEach((row, k) => (series[indexes[k]] = row));
    return series;
  }

  /** What the DQN sees: only the outputs that proved useful on held-out data, the rest are zeros. */
  private dqnForecastFeature(pair: CryptoPairs, series: (number[] | null)[]): number[][] {
    const reliable = this.reliableOutputs(pair);
    // in units of each output's typical size, so the DQN sees values around ±1
    const scale = this.forecastMetricsMap.get(pair)?.targetStd ?? [];
    return series.map((row) => reliable.map((ok, j) => (ok && row ? row[j] / (scale[j] || 1) : 0)));
  }

  /**
   * Data is split by time: train (70%) → calibration (15%) → evaluation (15%), with an embargo of the longest
   * horizon between parts. Calibration part: early stopping and fitting a + b·x per output.
   * Evaluation part is never used for fitting, so its numbers are an honest estimate of live quality.
   */
  private trainForecast = async (
    pair: CryptoPairs,
    candles: IOHLCV[],
    features: number[][],
    hourly: IHourlyContext,
    futures: IFuturesContext,
    feedback: ILiveFeedback
  ): Promise<void> => {
    const layout = FORECAST_LAYOUT;
    const { maxTrainingSamples, sampleStride, epochs, patience, batchSize } = cryptoConfig.forecast;
    const all = buildForecastSamples(
      candles,
      features,
      hourly,
      futures,
      this.forecastWindow,
      this.hourWindow,
      layout,
      sampleStride
    );
    // newest samples only: keeps training time and memory bounded
    const indexes = all.indexes.slice(-maxTrainingSamples);
    const inputs = all.inputs.slice(-maxTrainingSamples);
    const ys = all.ys.slice(-maxTrainingSamples);
    const n = inputs.length;

    if (n < 1000) {
      log(`[**] ${pair}: not enough contiguous minute + hourly history to train forecast (${n} samples)`, Colors.RED);
      return;
    }

    const embargo = Math.ceil(layout.pathMinutes / sampleStride);
    const calStart = Math.floor(n * 0.7);
    const evalStart = Math.floor(n * 0.85);
    const trainEnd = calStart - embargo;
    const calEnd = evalStart - embargo;

    // self-correction: samples where the live forecast was badly wrong are seen twice
    const trainInputs: IForecastInput[] = [];
    const trainY: number[][] = [];
    let hardCount = 0;
    for (let i = 0; i < trainEnd; i++) {
      trainInputs.push(inputs[i]);
      trainY.push(ys[i]);
      if (feedback.hardSampleIndexes.has(indexes[i])) {
        trainInputs.push(inputs[i]);
        trainY.push(ys[i]);
        hardCount++;
      }
    }
    const calInputs = inputs.slice(calStart, calEnd);
    const calY = ys.slice(calStart, calEnd);
    const evalInputs = inputs.slice(evalStart);
    const evalY = ys.slice(evalStart);

    // warm start keeps the previous scalers, so the old weights still mean the same thing
    const previous = this.forecastModelsMap.get(pair);
    const previousMetrics = previous ? this.forecastMetricsMap.get(pair) : undefined;
    const scaler = previousMetrics?.scaler ?? fitFeatureScaler(trainInputs);
    const { targetMean, targetStd } = previousMetrics ?? fitTargetScaler(trainY, layout);
    const naiveValues = naiveForecastValues(trainY, layout);
    const normalizeY = (rows: number[][]) =>
      tf.tensor2d(rows.map((row) => row.map((v, j) => Math.max(-5, Math.min(5, (v - targetMean[j]) / targetStd[j])))));

    const xTrain = this.forecastTensors(trainInputs, scaler);
    const yTrain = normalizeY(trainY);
    const xCal = this.forecastTensors(calInputs, scaler);
    const yCal = normalizeY(calY);

    const model = this.createForecastModel();
    if (previous) {
      this.cloneWeights(previous, model);
    }

    // early stopping that also restores the best epoch (tfjs earlyStopping cannot restore weights)
    let bestLoss = Infinity;
    let bestWeights: tfType.Tensor[] | null = null;
    let badEpochs = 0;
    let epochsRun = 0;
    const keepBest = new tf.CustomCallback({
      onEpochEnd: async (_epoch, logs) => {
        epochsRun++;
        const valLoss = logs?.val_loss ?? Infinity;
        if (valLoss < bestLoss - 1e-5) {
          bestLoss = valLoss;
          bestWeights?.forEach((w) => w.dispose());
          bestWeights = model.getWeights().map((w) => w.clone());
          badEpochs = 0;
        } else if (++badEpochs >= patience) {
          model.stopTraining = true;
        }
      },
    });

    log(
      `[**] ${pair} forecast: ${previous ? "fine-tuning" : "training"} on ${trainY.length} samples ` +
        `(${hardCount} hard from live), calibration ${calY.length}, evaluation ${evalY.length}`,
      Colors.GREEN
    );
    console.time(`${pair}: Forecast Training Time`);

    try {
      await model.fit(xTrain, yTrain, {
        epochs: previous ? Math.ceil(epochs / 2) : epochs,
        batchSize,
        shuffle: true,
        validationData: [xCal, yCal],
        callbacks: keepBest,
        verbose: 0,
      });
      if (bestWeights) {
        model.setWeights(bestWeights);
        (bestWeights as tfType.Tensor[]).forEach((w) => w.dispose());
      }

      // calibration: how much of the raw forecast actually materializes, fitted per output
      const calPred = this.predictTargets(model, calInputs, scaler, targetMean, targetStd);
      const calibration = layout.names.map((_, j) =>
        fitCalibration(
          calPred.map((p) => p[j]),
          calY.map((y) => y[j]),
          j < layout.horizons.length
        )
      );

      // honest evaluation on data that took no part in training or calibration
      const evalPred = this.calibrate(this.predictTargets(model, evalInputs, scaler, targetMean, targetStd), calibration);
      const val = computeOutputErrors(evalPred, evalY, naiveValues, layout.mainIndex);
      const live = feedback.outputs;

      const outputs: IForecastOutputMetrics[] = layout.names.map((name, j) => {
        const icT = correlationT(val.ic[j], evalY.length, outputOverlap(layout, j, sampleStride));
        // live results outweigh evaluation once there are enough of them
        const liveSaysWorse = !!live && live.count >= 30 && (live.ic[j] <= 0 || live.mse[j] >= live.naiveMse[j]);
        return {
          name,
          mae: val.mae[j],
          naiveMae: val.naiveMae[j],
          mse: val.mse[j],
          naiveMse: val.naiveMse[j],
          ic: val.ic[j],
          icT,
          // useful = forecast correlates with reality significantly AND beats the naive guess in squared error
          reliable: calibration[j].b > 0 && val.ic[j] > 0 && icT > 2 && val.mse[j] < val.naiveMse[j] && !liveSaysWorse,
          live: live ? { count: live.count, mse: live.mse[j], naiveMse: live.naiveMse[j], ic: live.ic[j] } : undefined,
        };
      });

      const metrics: IForecastMetrics = {
        version: FORECAST_MODEL_VERSION,
        trainedAt: Date.now(),
        samples: n,
        evalSamples: evalY.length,
        directionAccuracy: val.directionAccuracy,
        naiveValues,
        scaler,
        targetMean,
        targetStd,
        calibration,
        outputs,
        beatsNaive: outputs[layout.mainIndex].reliable,
      };

      previous?.dispose();
      this.forecastModelsMap.set(pair, model);
      this.forecastMetricsMap.set(pair, metrics);
      await this.saveForecast(pair);

      log(
        `[**] ${pair} forecast ready after ${epochsRun} epochs (best val loss ${bestLoss.toFixed(4)}), ` +
          `direction (${this.horizon}m) on evaluation = ${(val.directionAccuracy * 100).toFixed(1)}%`,
        Colors.GREEN
      );
      outputs.forEach((o, j) =>
        log(
          `      ${o.name.padEnd(12)} IC=${o.ic.toFixed(3)} (t=${o.icT.toFixed(1)}) ` +
            `MSE vs naive ${((1 - o.mse / o.naiveMse) * 100).toFixed(2)}% better, b=${calibration[j].b.toFixed(2)} ` +
            `${o.reliable ? "reliable" : "not reliable"}`,
          o.reliable ? Colors.GREEN : Colors.YELLOW
        )
      );
    } catch (error) {
      log(`[**] ${pair}: error while training forecast model: ${error}`, Colors.RED);
      model.dispose();
    } finally {
      console.timeEnd(`${pair}: Forecast Training Time`);
      tf.dispose([...xTrain, yTrain, ...xCal, yCal]);
    }
  };

  /** Human-readable price path from raw outputs. */
  private toForecastPath(pair: CryptoPairs, raw: number[]): IForecastPath {
    const layout = FORECAST_LAYOUT;
    const reliable = this.reliableOutputs(pair);
    const toReturn = (scaled: number) => Math.exp(scaled / FORECAST_TARGET_SCALE) - 1;
    const toMinutes = (fraction: number) =>
      Math.min(layout.pathMinutes, Math.max(1, Math.round(fraction * layout.pathMinutes)));

    return {
      horizons: layout.horizons.map((minutes, j) => ({ minutes, return: toReturn(raw[j]), reliable: reliable[j] })),
      max: {
        return: toReturn(raw[layout.maxIndex]),
        inMinutes: toMinutes(raw[layout.timeToMaxIndex]),
        reliable: reliable[layout.maxIndex],
        timeReliable: reliable[layout.timeToMaxIndex],
      },
      min: {
        return: toReturn(raw[layout.minIndex]),
        inMinutes: toMinutes(raw[layout.timeToMinIndex]),
        reliable: reliable[layout.minIndex],
        timeReliable: reliable[layout.timeToMinIndex],
      },
    };
  }

  // ---------- DQN ----------

  private predictQ(model: tfType.LayersModel, state: number[][]): number[] {
    return tf.tidy(() => {
      const input = tf.tensor3d([state], [1, this.dqnTimeSteps, DQN_FEATURE_COUNT]);
      return Array.from((model.predict(input) as tfType.Tensor).dataSync());
    });
  }

  /** Mixes simulated experience with real production outcomes (`liveShare` of every batch). */
  private async trainOnBatch(
    model: tfType.LayersModel,
    target: tfType.LayersModel,
    buffer: ReplayBuffer,
    liveBuffer: ReplayBuffer
  ): Promise<void> {
    const { batchSize, gamma, liveSampleShare } = cryptoConfig.rl;
    if (buffer.size < batchSize) {
      return;
    }

    const liveCount = liveBuffer.size ? Math.round(batchSize * liveSampleShare) : 0;
    const batch = [...buffer.sample(batchSize - liveCount), ...liveBuffer.sample(liveCount)];
    const states = batch.map((b) => b.state);
    const nextStates = batch.map((b) => b.nextState);
    const shape: [number, number, number] = [batch.length, this.dqnTimeSteps, DQN_FEATURE_COUNT];

    const [qValues, nextQValues] = tf.tidy(() => {
      const q = (model.predict(tf.tensor3d(states, shape)) as tfType.Tensor).arraySync() as number[][];
      const nq = (target.predict(tf.tensor3d(nextStates, shape)) as tfType.Tensor).arraySync() as number[][];
      return [q, nq] as [number[][], number[][]];
    });

    const targets = qValues.map((row) => [...row]);
    for (let i = 0; i < batch.length; i++) {
      const { action, reward, done } = batch[i];
      targets[i][action] = done ? reward : reward + gamma * Math.max(...nextQValues[i]);
    }

    const xs = tf.tensor3d(states, shape);
    const ys = tf.tensor2d(targets, [batch.length, 3]);
    await model.fit(xs, ys, { epochs: 1, verbose: 0 });
    xs.dispose();
    ys.dispose();
  }

  /**
   * Turns real production decisions into terminal transitions:
   * reward = what that action actually earned over the forecast horizon.
   */
  private buildLiveTransitions(env: TradingEnvironment, feedback: ILiveFeedback, drift: number): ITransition[] {
    const terminal = Array.from({ length: this.dqnTimeSteps }, () => new Array(DQN_FEATURE_COUNT).fill(0));
    const transitions: ITransition[] = [];
    let earned = 0;
    let trades = 0;

    for (const d of feedback.decisions) {
      if (d.candleIndex < env.startIndex) continue;

      // what the decision actually earned until the next one, from the position the bot really had
      let action: RLActionIndex = RLAction.Hold;
      let positionAfter = d.position;
      let traded = 0;
      if (d.command === "Buy") {
        action = RLAction.Buy;
        if (d.position === 0) {
          positionAfter = 1;
          traded = 1;
        }
      } else if (d.command === "Sell") {
        action = RLAction.Sell;
        if (d.position === 1) {
          positionAfter = 0;
          traded = 1;
        }
      }
      const reward = positionAfter * (d.realizedReturn - drift) - this.tradeCost * traded;
      if (traded) {
        earned += reward;
        trades++;
      }

      transitions.push({
        state: env.stateAt(d.candleIndex, d.position),
        action,
        reward: reward * cryptoConfig.rl.rewardScale,
        nextState: terminal,
        done: true,
      });
    }

    if (trades) {
      log(
        `[**] Live DQN decisions: ${trades} trades, avg result incl. costs ${((earned / trades) * 100).toFixed(4)}%`,
        earned > 0 ? Colors.GREEN : Colors.YELLOW
      );
    }
    return transitions;
  }

  /** Full cost of one swap as a share of the traded amount: exchange fee + spread + network fee. */
  private get tradeCost(): number {
    const { feeRate, gasUsd, tradeSizeUsd } = cryptoConfig.rl;
    return feeRate + gasUsd / tradeSizeUsd;
  }

  /** Standardized DQN features; the scaler is fitted once and kept, so saved weights keep their meaning. */
  private dqnFeatures(pair: CryptoPairs, features: number[][]): number[][] {
    let scaler = this.dqnScalerMap.get(pair);
    if (!scaler) {
      scaler = fitColumnScaler(features.slice(INDICATOR_WARMUP));
      this.dqnScalerMap.set(pair, scaler);
    }
    return applyColumnScaler(features, scaler);
  }

  private trainDQN = async (
    pair: CryptoPairs,
    candles: IOHLCV[],
    features: number[][],
    forecasts: number[][],
    feedback: ILiveFeedback
  ) => {
    const model = this.modelsMap.get(pair)!;
    const target = this.targetModelsMap.get(pair)!;
    const {
      episodes,
      episodeSteps,
      decisionMinutes,
      replaySize,
      epsilonStart,
      epsilonMin,
      explorationShare,
      invalidActionPenalty,
      trainEvery,
      targetUpdateEvery,
    } = cryptoConfig.rl;

    const drift = cryptoConfig.rl.removeDrift ? TradingEnvironment.averageStepReturn(candles, decisionMinutes) : 0;
    const env = new TradingEnvironment(
      candles,
      this.dqnFeatures(pair, features),
      forecasts,
      this.dqnTimeSteps,
      this.tradeCost,
      invalidActionPenalty,
      decisionMinutes,
      drift
    );
    const replay = new ReplayBuffer(replaySize);
    const liveTransitions = this.buildLiveTransitions(env, feedback, drift);
    const liveReplay = new ReplayBuffer(Math.max(liveTransitions.length, 1));
    liveTransitions.forEach((t) => liveReplay.push(t));

    // linear decrease: full exploration at the start, epsilonMin after `explorationShare` of the episodes
    const epsilonAt = (episode: number) =>
      Math.max(epsilonMin, epsilonStart - ((epsilonStart - epsilonMin) * episode) / Math.max(1, episodes * explorationShare));
    let globalStep = 0;
    let episodeReturns = 0;

    log(
      `[**] Training ${pair} DQN: ${episodes} episodes × ${episodeSteps} decisions every ${decisionMinutes} min, ` +
        `cost per swap ${(this.tradeCost * 100).toFixed(2)}%, market drift removed ${(drift * 100).toFixed(4)}% per step, ` +
        `${liveTransitions.length} live experiences`,
      Colors.GREEN
    );
    console.time(`${pair}: DQN Training Time`);

    try {
      for (let episode = 0; episode < episodes; episode++) {
        // random segment of the history: fast on long datasets and every episode sees a different market
        const span = episodeSteps * decisionMinutes;
        const maxStart = env.length - 1 - span;
        const start = maxStart > env.startIndex ? env.startIndex + Math.floor(Math.random() * (maxStart - env.startIndex)) : env.startIndex;
        const epsilon = epsilonAt(episode);
        let state = env.reset(start, episodeSteps);
        let trades = 0;
        let done = false;
        let totalReward = 0;

        while (!done) {
          const action = (
            Math.random() < epsilon ? Math.floor(Math.random() * 3) : argmax(this.predictQ(model, state))
          ) as RLActionIndex;
          const positionBefore = state[state.length - 1][DQN_FEATURE_COUNT - 2];
          const result = env.step(action);
          if (
            (action === RLAction.Buy && positionBefore === 0) ||
            (action === RLAction.Sell && positionBefore === 1)
          ) {
            trades++;
          }

          replay.push({
            state,
            action,
            reward: result.reward * cryptoConfig.rl.rewardScale,
            nextState: result.state,
            done: result.done,
          });

          state = result.state;
          done = result.done;
          totalReward += result.reward;
          globalStep += 1;

          if (globalStep % trainEvery === 0) {
            await this.trainOnBatch(model, target, replay, liveReplay);
          }
          if (globalStep % targetUpdateEvery === 0) {
            this.cloneWeights(model, target);
          }
        }

        episodeReturns += totalReward;
        log(
          `[**] ${pair} episode ${episode + 1}/${episodes} reward=${totalReward.toFixed(5)} ` +
            `trades=${trades} epsilon=${epsilon.toFixed(3)}`,
          Colors.CYAN
        );
      }

      await this.saveDQN(pair);
      log(`[**] ${pair} DQN training completed. Avg episode reward=${(episodeReturns / episodes).toFixed(5)}`, Colors.GREEN);
      return true;
    } catch (error) {
      console.error("Error during DQN training:", error);
      return false;
    } finally {
      console.timeEnd(`${pair}: DQN Training Time`);
    }
  };

  // ---------- backtest support ----------

  /**
   * Everything the DQN and the range rule see, computed once for a period. Every value at candle i uses only
   * candles up to i, the same as in live trading.
   */
  public prepareBacktest(pair: CryptoPairs, dataset: IMarketDataset, fromTime: number): IBacktestInputs {
    const { candles, features, hourly, futures } = this.prepareInputs(dataset, false);
    const startIndex = candles.findIndex((c) => c.time >= fromTime);
    const raw = this.forecastSeries(pair, candles, features, hourly, futures, Math.max(0, startIndex - this.dqnTimeSteps));
    return {
      pair,
      candles,
      startIndex,
      dqn: this.dqnFeatures(pair, features),
      forecast: this.dqnForecastFeature(pair, raw),
      raw,
    };
  }

  /** The decision the live bot would make at candle i while holding `position` (same state layout as training). */
  public decideAt(pre: IBacktestInputs, i: number, position: number, entryPrice: number) {
    const model = this.modelsMap.get(pre.pair)!;
    const price = pre.candles[i].close;
    const unrealized = position === 1 && entryPrice > 0 ? (price - entryPrice) / entryPrice : 0;

    const window: number[][] = [];
    for (let k = i - this.dqnTimeSteps + 1; k <= i; k++) {
      window.push(
        k < 0 ? new Array(DQN_FEATURE_COUNT).fill(0) : [...pre.dqn[k], ...pre.forecast[k], position, unrealized]
      );
    }

    const q = this.predictQ(model, window);
    const action = RL_ACTION_LABELS[argmax(q) as RLActionIndex];

    // range forecast for the rule-based baseline: only the parts that proved reliable
    let expectedMax = 0;
    let expectedMin = 0;
    const raw = pre.raw[i];
    if (raw) {
      const path = this.toForecastPath(pre.pair, raw);
      expectedMax = path.max.reliable ? path.max.return : 0;
      expectedMin = path.min.reliable ? path.min.return : 0;
    }

    return { action, q, expectedMax, expectedMin };
  }

  // ---------- public API ----------

  /** Candles, features and context built the same way for training and inference. */
  private prepareInputs(dataset: IMarketDataset, closedOnly: boolean) {
    const now = Math.floor(Date.now() / 1000);
    // keep the reference list aligned with the config even if some reference data is missing
    const references = cryptoConfig.marketData.referencePairs.map((_, i) => dataset.references[i] ?? { minute: [], hour: [] });
    const candles = toOHLCV(dataset.minute).filter((c) => !closedOnly || c.time + 60 <= now);
    return {
      candles,
      features: buildCandleFeatures(
        candles,
        references.map((r) => toOHLCV(r.minute)),
        60
      ),
      hourly: buildHourlyContext(
        toOHLCV(dataset.hour),
        references.map((r) => toOHLCV(r.hour))
      ),
      futures: buildFuturesContext(dataset.futures, dataset.funding),
    };
  }

  public async trainAllModels(
    datasets: Map<CryptoPairs, IMarketDataset>,
    predictionHistory: Map<CryptoPairs, ITensorflowPrediction[]> = new Map()
  ): Promise<boolean> {
    for (const [pair, dataset] of datasets) {
      await this.trainModel(pair, dataset, predictionHistory.get(pair) ?? []);
    }
    return true;
  }

  /**
   * 1) compare saved predictions with real prices; 2) correct the forecast model;
   * 3) train the DQN on market features + forecast, mixing in real outcomes of its past decisions.
   */
  public trainModel = async (
    pair: CryptoPairs,
    dataset: IMarketDataset,
    predictionHistory: ITensorflowPrediction[] = []
  ): Promise<boolean> => {
    if (!this.modelsMap.has(pair)) {
      log(`[**] Model ${pair} not found`, Colors.RED);
      return false;
    }

    const { candles, features, hourly, futures } = this.prepareInputs(dataset, false);
    if (candles.length < Math.max(INDICATOR_WARMUP, this.dqnTimeSteps) + 50) {
      log(`[**] Not enough candles to train ${pair}`, Colors.RED);
      return false;
    }

    const previousNaive = this.forecastMetricsMap.get(pair)?.naiveValues;
    const feedback = evaluateLivePredictions(
      predictionHistory,
      candles,
      FORECAST_LAYOUT,
      previousNaive,
      cryptoConfig.rl.decisionMinutes
    );

    if (feedback.outputs) {
      const f = feedback.outputs;
      const j = FORECAST_LAYOUT.mainIndex;
      log(
        `[**] ${pair} live forecast check on ${f.count} saved predictions (${this.horizon}m): IC=${f.ic[j].toFixed(3)}, ` +
          `MSE ${((1 - f.mse[j] / f.naiveMse[j]) * 100).toFixed(2)}% vs naive, direction=${((feedback.directionAccuracy ?? 0) * 100).toFixed(1)}%`,
      );
    }

    await this.trainForecast(pair, candles, features, hourly, futures, feedback);
    const forecasts = this.dqnForecastFeature(pair, this.forecastSeries(pair, candles, features, hourly, futures));

    return this.trainDQN(pair, candles, features, forecasts, feedback);
  };

  public async predictNextPrices(
    datasets: Map<CryptoPairs, IMarketDataset>,
    // what the bot currently holds; the DQN was trained with the position as an input
    positions: Map<CryptoPairs, { position: number; entryPrice: number }> = new Map()
  ): Promise<Map<CryptoPairs, ITensorflowPrediction>> {
    const results: Map<CryptoPairs, ITensorflowPrediction> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      try {
        const model = this.modelsMap.get(pair);
        const dataset = datasets.get(pair);

        if (!model || !dataset) {
          log(`[**] Model or dataset for ${pair} not found`, Colors.RED);
          continue;
        }

        // the still-open current minute is never used
        const now = Math.floor(Date.now() / 1000);
        const { candles, features, hourly, futures } = this.prepareInputs(dataset, true);
        const last = candles[candles.length - 1];

        // forecast only for the candles the DQN window needs
        const rawSeries = this.forecastSeries(pair, candles, features, hourly, futures, candles.length - this.dqnTimeSteps);
        const raw = rawSeries[rawSeries.length - 1];
        if (this.forecastModelsMap.has(pair) && !raw) {
          log(`[**] ${pair}: forecast skipped — not enough fresh minute / hourly candles`, Colors.YELLOW);
        }
        const path = raw ? this.toForecastPath(pair, raw) : undefined;
        const main = path?.horizons[FORECAST_LAYOUT.mainIndex];
        const reliable = !!main?.reliable;
        // an unproven forecast must not pretend to know the future: fall back to "no change"
        const predictedReturn = reliable && main ? main.return : 0;

        const { position, entryPrice } = positions.get(pair) ?? { position: 0, entryPrice: 0 };
        const state = buildInferenceState(
          candles,
          this.dqnFeatures(pair, features),
          this.dqnForecastFeature(pair, rawSeries),
          this.dqnTimeSteps,
          position,
          entryPrice
        );
        const [hold, buy, sell] = this.predictQ(model, state);
        const action = argmax([hold, buy, sell]) as RLActionIndex;

        results.set(pair, {
          timestamp: now * 1000,
          pair,
          current_value: last.close,
          // prediction is anchored to the close of the last closed candle
          lstm_timestamp: (last.time + 60 + this.horizon * 60) * 1000,
          predicted_value: last.close * (1 + predictedReturn),
          predicted_return: predictedReturn,
          forecast_raw: raw ?? undefined,
          forecast_path: path,
          forecast_reliable: reliable,
          position,
          predicted_command: RL_ACTION_LABELS[action],
          q_values: { hold, buy, sell },
        });
      } catch (error) {
        log(`Error while predicting next prices: ${error}`, Colors.RED);
      }
    }

    results.forEach((result) => {
      const now = format(new Date(result.timestamp), "dd/MM/yy HH:mm");
      const horizon = format(new Date(result.lstm_timestamp), "dd/MM/yy HH:mm");
      const q = result.q_values;
      const ret = ((result.predicted_return ?? 0) * 100).toFixed(3);
      const reliability = result.forecast_reliable ? "" : " (forecast unreliable)";
      const p = result.forecast_path;
      const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%`;
      const mark = (ok: boolean) => (ok ? "" : "?");
      const pathText = p
        ? ` | path ${p.horizons.map((h) => `${h.minutes}m ${pct(h.return)}${mark(h.reliable)}`).join(", ")}` +
          ` | best sell ${pct(p.max.return)}${mark(p.max.reliable)} in ~${p.max.inMinutes}m${mark(p.max.timeReliable)}` +
          `, best buy ${pct(p.min.return)}${mark(p.min.reliable)} in ~${p.min.inMinutes}m${mark(p.min.timeReliable)}`
        : "";
      const qText = q ? ` Q[H=${q.hold.toFixed(4)} B=${q.buy.toFixed(4)} S=${q.sell.toFixed(4)}]` : "";

      log(
        `[**] ${now} ${result.pair} Current: ${result.current_value}. DQN: ${result.predicted_command}. Forecast ~${result.predicted_value.toFixed(4)} (${ret}%) at ${horizon}${reliability}${qText}${pathText}`,
        getRandomEnumValue(Colors)
      );
    });

    return results;
  }
}

export default new TensorflowAI();
