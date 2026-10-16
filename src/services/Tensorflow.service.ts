import "../utils/tfjs-node-compat";
import fse from "fs-extra";
import type * as tfType from "@tensorflow/tfjs-node";
import { format } from "date-fns";

import cryptoConfig from "../config/crypto.config";

import { ICyptoCompareData } from "../types/cryptoCompare.types";
import { log, Colors, getRandomEnumValue } from "../utils/colored-console";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";
import { CryptoPairs } from "../types/basic.types";
import { buildMarketFeatures, INDICATOR_WARMUP, IOHLCV, MARKET_FEATURE_COUNT } from "../utils/technical-indicators";
import {
  argmax,
  buildForecastSamples,
  computeForecastErrors,
  evaluateLivePredictions,
  featureWindow,
  FORECAST_TARGET_SCALE,
  IForecastMetrics,
  ILiveFeedback,
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
 * - forecast: supervised regressor, predicts the price `horizon` minutes ahead;
 * - DQN: chooses Hold / Buy / Sell and receives the forecast as an input feature.
 * Both self-correct on retraining using saved production predictions vs. prices that actually happened.
 */
class TensorflowAI {
  private dqnDirectory: string = `${__dirname}/../models/dqn_models`;
  private forecastDirectory: string = `${__dirname}/../models/forecast_models`;

  private modelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();
  private targetModelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();
  private forecastModelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();
  private forecastMetricsMap: Map<CryptoPairs, IForecastMetrics> = new Map();

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

  private createDQNmodel = (): tfType.LayersModel => {
    const model = tf.sequential();
    model.add(tf.layers.inputLayer({ inputShape: [this.dqnTimeSteps, DQN_FEATURE_COUNT] }));
    model.add(tf.layers.conv1d({ filters: 32, kernelSize: 3, activation: "relu" }));
    model.add(tf.layers.lstm({ units: 32 }));
    model.add(tf.layers.dense({ units: 32, activation: "relu" }));
    model.add(tf.layers.dense({ units: 3 }));
    this.compileDQN(model);
    return model;
  };

  private compileDQN(model: tfType.LayersModel) {
    model.compile({ optimizer: tf.train.adam(cryptoConfig.rl.learningRate), loss: "meanSquaredError" });
  }

  private createForecastModel(): tfType.LayersModel {
    const model = tf.sequential();
    model.add(tf.layers.inputLayer({ inputShape: [this.forecastWindow, MARKET_FEATURE_COUNT] }));
    model.add(tf.layers.lstm({ units: 32, dropout: 0.1 }));
    model.add(tf.layers.dense({ units: 16, activation: "relu" }));
    model.add(tf.layers.dense({ units: 1 }));
    this.compileForecast(model);
    return model;
  }

  private compileForecast(model: tfType.LayersModel) {
    model.compile({ optimizer: tf.train.adam(cryptoConfig.forecast.learningRate), loss: "meanAbsoluteError" });
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
      model = await tf.loadLayersModel(`file://${this.dqnDirectory}/${this.generateModelName(pair)}/model.json`);
      if (!this.hasInputShape(model, this.dqnTimeSteps, DQN_FEATURE_COUNT)) {
        log(`[**] Saved DQN for ${pair} has an old input shape, creating a new one`, Colors.YELLOW);
        model.dispose();
        model = null;
      } else {
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
      if (!this.hasInputShape(model, this.forecastWindow, MARKET_FEATURE_COUNT)) {
        log(`[**] Saved forecast model for ${pair} has an old input shape, it will be retrained`, Colors.YELLOW);
        model.dispose();
        return;
      }
      this.compileForecast(model);
      this.forecastModelsMap.set(pair, model);
      if (fse.existsSync(`${dir}/metrics.json`)) {
        this.forecastMetricsMap.set(pair, fse.readJsonSync(`${dir}/metrics.json`));
      }
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

  /**
   * Raw forecast (scaled horizon log-return) for every candle from `fromIndex`, aligned with `candles`.
   * Candles without enough history get 0.
   */
  private forecastSeries(pair: CryptoPairs, features: number[][], fromIndex = 0): number[] {
    const series = new Array(features.length).fill(0);
    const model = this.forecastModelsMap.get(pair);
    const start = Math.max(fromIndex, INDICATOR_WARMUP, this.forecastWindow - 1);
    if (!model || start >= features.length) {
      return series;
    }

    const windows: number[][][] = [];
    for (let t = start; t < features.length; t++) {
      windows.push(featureWindow(features, t, this.forecastWindow));
    }
    const output = tf.tidy(() => Array.from((model.predict(tf.tensor3d(windows)) as tfType.Tensor).dataSync()));
    output.forEach((v, i) => (series[start + i] = v));
    return series;
  }

  /** What the DQN sees: the forecast only when it has proven better than "no change", otherwise zeros. */
  private dqnForecastFeature(pair: CryptoPairs, rawSeries: number[]): number[] {
    return this.isForecastReliable(pair) ? rawSeries : rawSeries.map(() => 0);
  }

  private trainForecast = async (
    pair: CryptoPairs,
    candles: IOHLCV[],
    features: number[][],
    feedback: ILiveFeedback
  ): Promise<void> => {
    const { indexes, xs, ys } = buildForecastSamples(candles, features, this.forecastWindow, this.horizon);

    if (xs.length < 300) {
      log(`[**] ${pair}: not enough contiguous candles to train forecast (${xs.length} samples)`, Colors.RED);
      return;
    }

    // chronological split with a horizon-sized embargo, so validation is strictly "the future"
    const splitAt = Math.floor(xs.length * 0.8);
    const trainEnd = splitAt - this.horizon;

    // self-correction: samples where the live forecast was badly wrong are seen twice
    const trainX: number[][][] = [];
    const trainY: number[] = [];
    let hardCount = 0;
    for (let i = 0; i < trainEnd; i++) {
      trainX.push(xs[i]);
      trainY.push(ys[i]);
      if (feedback.hardSampleIndexes.has(indexes[i])) {
        trainX.push(xs[i]);
        trainY.push(ys[i]);
        hardCount++;
      }
    }

    const valY = ys.slice(splitAt);
    const xTrain = tf.tensor3d(trainX);
    const yTrain = tf.tensor2d(trainY, [trainY.length, 1]);
    const xVal = tf.tensor3d(xs.slice(splitAt));
    const yVal = tf.tensor2d(valY, [valY.length, 1]);

    // warm start: keep what the model already knows and correct it on new data
    const previous = this.forecastModelsMap.get(pair);
    const model = this.createForecastModel();
    const { epochs } = cryptoConfig.forecast;
    if (previous) {
      this.cloneWeights(previous, model);
    }

    console.time(`${pair}: Forecast Training Time`);
    try {
      await model.fit(xTrain, yTrain, {
        epochs: previous ? Math.ceil(epochs / 3) : epochs,
        batchSize: 64,
        shuffle: true,
        validationData: [xVal, yVal],
        callbacks: tf.callbacks.earlyStopping({ monitor: "val_loss", patience: 4 }),
        verbose: 0,
      });

      const predicted = tf.tidy(() => Array.from((model.predict(xVal) as tfType.Tensor).dataSync()));
      const val = computeForecastErrors(predicted, valY);
      const live = feedback.forecast;
      // live results outweigh validation once there are enough of them
      const liveSaysWorse = !!live && live.count >= 30 && live.mae >= live.naiveMae;

      const metrics: IForecastMetrics = {
        trainedAt: Date.now(),
        samples: xs.length,
        valSamples: valY.length,
        modelMae: val.mae,
        naiveMae: val.naiveMae,
        directionAccuracy: val.directionAccuracy,
        beatsNaive: val.mae < val.naiveMae && !liveSaysWorse,
        live: live ?? undefined,
      };

      previous?.dispose();
      this.forecastModelsMap.set(pair, model);
      this.forecastMetricsMap.set(pair, metrics);
      await this.saveForecast(pair);

      log(
        `[**] ${pair} forecast ${previous ? "fine-tuned" : "trained"} on ${trainY.length} samples (${hardCount} hard from live). ` +
          `Val MAE=${val.mae.toFixed(4)}% (naive ${val.naiveMae.toFixed(4)}%), direction=${(val.directionAccuracy * 100).toFixed(1)}%` +
          (metrics.beatsNaive ? "" : " — NOT better than naive, forecast falls back to current price"),
        metrics.beatsNaive ? Colors.GREEN : Colors.YELLOW
      );
    } catch (error) {
      log(`[**] ${pair}: error while training forecast model: ${error}`, Colors.RED);
      model.dispose();
    } finally {
      console.timeEnd(`${pair}: Forecast Training Time`);
      tf.dispose([xTrain, yTrain, xVal, yVal]);
    }
  };

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
  private buildLiveTransitions(env: TradingEnvironment, feedback: ILiveFeedback): ITransition[] {
    const { feeRate } = cryptoConfig.rl;
    const terminal = Array.from({ length: this.dqnTimeSteps }, () => new Array(DQN_FEATURE_COUNT).fill(0));
    const transitions: ITransition[] = [];
    let earned = 0;
    let trades = 0;

    for (const d of feedback.decisions) {
      if (d.candleIndex < env.startIndex) continue;

      let action: RLActionIndex = RLAction.Hold;
      let reward = 0;
      if (d.command === "Buy") {
        action = RLAction.Buy;
        reward = d.realizedReturn - feeRate;
      } else if (d.command === "Sell") {
        action = RLAction.Sell;
        reward = -d.realizedReturn - feeRate;
      }
      if (action !== RLAction.Hold) {
        earned += reward;
        trades++;
      }

      transitions.push({ state: env.stateAt(d.candleIndex), action, reward, nextState: terminal, done: true });
    }

    if (trades) {
      log(
        `[**] Live DQN decisions: ${trades} Buy/Sell, avg realized return per trade ${((earned / trades) * 100).toFixed(4)}%`,
        earned > 0 ? Colors.GREEN : Colors.YELLOW
      );
    }
    return transitions;
  }

  private trainDQN = async (pair: CryptoPairs, candles: IOHLCV[], forecasts: number[], feedback: ILiveFeedback) => {
    const model = this.modelsMap.get(pair)!;
    const target = this.targetModelsMap.get(pair)!;
    const { episodes, replaySize, epsilonStart, epsilonMin, epsilonDecay, feeRate, invalidActionPenalty, trainEvery, targetUpdateEvery } =
      cryptoConfig.rl;

    const env = new TradingEnvironment(candles, forecasts, this.dqnTimeSteps, feeRate, invalidActionPenalty);
    const replay = new ReplayBuffer(replaySize);
    const liveTransitions = this.buildLiveTransitions(env, feedback);
    const liveReplay = new ReplayBuffer(Math.max(liveTransitions.length, 1));
    liveTransitions.forEach((t) => liveReplay.push(t));

    let epsilon = epsilonStart;
    let globalStep = 0;
    let episodeReturns = 0;

    log(`[**] Training ${pair} DQN for ${episodes} episodes (${liveTransitions.length} live experiences)`, Colors.GREEN);
    console.time(`${pair}: DQN Training Time`);

    try {
      for (let episode = 0; episode < episodes; episode++) {
        let state = env.reset();
        let done = false;
        let totalReward = 0;

        while (!done) {
          const action = (
            Math.random() < epsilon ? Math.floor(Math.random() * 3) : argmax(this.predictQ(model, state))
          ) as RLActionIndex;
          const result = env.step(action);

          replay.push({ state, action, reward: result.reward, nextState: result.state, done: result.done });

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

        epsilon = Math.max(epsilonMin, epsilon * epsilonDecay);
        episodeReturns += totalReward;
        log(
          `[**] ${pair} episode ${episode + 1}/${episodes} reward=${totalReward.toFixed(5)} epsilon=${epsilon.toFixed(3)}`,
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

  // ---------- public API ----------

  public async trainAllModels(
    input: Map<CryptoPairs, ICyptoCompareData[]>,
    predictionHistory: Map<CryptoPairs, ITensorflowPrediction[]> = new Map()
  ): Promise<boolean> {
    for (const [pair, data] of input) {
      await this.trainModel(pair, data, predictionHistory.get(pair) ?? []);
    }
    return true;
  }

  /**
   * 1) compare saved predictions with real prices; 2) correct the forecast model;
   * 3) train the DQN on market features + forecast, mixing in real outcomes of its past decisions.
   */
  public trainModel = async (
    pair: CryptoPairs,
    input: ICyptoCompareData[],
    predictionHistory: ITensorflowPrediction[] = []
  ): Promise<boolean> => {
    if (!this.modelsMap.has(pair)) {
      log(`[**] Model ${pair} not found`, Colors.RED);
      return false;
    }

    const candles = toOHLCV(input);
    if (candles.length < Math.max(INDICATOR_WARMUP, this.dqnTimeSteps) + 50) {
      log(`[**] Not enough candles to train ${pair}`, Colors.RED);
      return false;
    }

    const features = buildMarketFeatures(candles);
    const feedback = evaluateLivePredictions(predictionHistory, candles, this.horizon);
    if (feedback.forecast) {
      const f = feedback.forecast;
      log(
        `[**] ${pair} live forecast check on ${f.count} saved predictions: MAE=${f.mae.toFixed(4)}% ` +
          `(naive ${f.naiveMae.toFixed(4)}%), direction=${(f.directionAccuracy * 100).toFixed(1)}%`,
        f.mae < f.naiveMae ? Colors.GREEN : Colors.YELLOW
      );
    }

    await this.trainForecast(pair, candles, features, feedback);
    const forecasts = this.dqnForecastFeature(pair, this.forecastSeries(pair, features));

    return this.trainDQN(pair, candles, forecasts, feedback);
  };

  public async predictNextPrices(
    input: Map<CryptoPairs, ICyptoCompareData[]>
  ): Promise<Map<CryptoPairs, ITensorflowPrediction>> {
    const results: Map<CryptoPairs, ITensorflowPrediction> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      try {
        const model = this.modelsMap.get(pair);
        const dataset = input.get(pair);

        if (!model || !dataset) {
          log(`[**] Model or dataset for ${pair} not found`, Colors.RED);
          continue;
        }

        // the last candle from the API is the still-open current minute: use closed candles only
        const now = Math.floor(Date.now() / 1000);
        const candles = toOHLCV(dataset).filter((c) => c.time + 60 <= now);
        const last = candles[candles.length - 1];
        const features = buildMarketFeatures(candles);

        // forecast only for the candles the DQN window needs
        const rawSeries = this.forecastSeries(pair, features, candles.length - this.dqnTimeSteps);
        const rawScaled = rawSeries[rawSeries.length - 1];
        const reliable = this.isForecastReliable(pair) && this.forecastModelsMap.has(pair);
        const rawReturn = Math.exp(rawScaled / FORECAST_TARGET_SCALE) - 1;
        // an unproven forecast must not pretend to know the future: fall back to "no change"
        const predictedReturn = reliable ? rawReturn : 0;

        const state = buildInferenceState(candles, this.dqnForecastFeature(pair, rawSeries), this.dqnTimeSteps, 0, 0);
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
          forecast_raw_return: this.forecastModelsMap.has(pair) ? rawReturn : undefined,
          forecast_reliable: reliable,
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
      const qText = q ? ` Q[H=${q.hold.toFixed(4)} B=${q.buy.toFixed(4)} S=${q.sell.toFixed(4)}]` : "";

      log(
        `[**] ${now} ${result.pair} Current: ${result.current_value}. DQN: ${result.predicted_command}. Forecast ~${result.predicted_value.toFixed(4)} (${ret}%) at ${horizon}${reliability}${qText}`,
        getRandomEnumValue(Colors)
      );
    });

    return results;
  }
}

export default new TensorflowAI();
