import fse from "fs-extra";
import type * as tfType from "@tensorflow/tfjs-node";
import { format } from "date-fns";

import cryptoConfig from "../config/crypto.config";

import { ICyptoCompareData } from "../types/cryptoCompare.types";
import { log, Colors, getRandomEnumValue } from "../utils/colored-console";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";
import { CryptoPairs } from "../types/basic.types";

// Import TensorFlow.js types
// Dynamically import the appropriate TensorFlow.js backend
const tf: typeof tfType = cryptoConfig.useGPU ? require("@tensorflow/tfjs-node-gpu") : require("@tensorflow/tfjs-node");

class TensorflowAI {
  private modelDirectory: string = `${__dirname}/../models/lstm_models`;

  private modelsMap: Map<CryptoPairs, tfType.LayersModel> = new Map();

  constructor() {
    log("[*] Initializing Tensorflow AI Service", Colors.GREEN);

    this.loadModels();

    this.createModelDirectory();
  }

  private createModelDirectory() {
    if (!fse.existsSync(this.modelDirectory)) {
      fse.mkdirSync(this.modelDirectory, { recursive: true });
    }
  }

  public generateModelName(pair: CryptoPairs): string {
    return `lstm_model_${pair}`;
  }

  private createLSTMmodel = () => {
    const timeSteps = cryptoConfig.longTermMinuteWindowPrediction;
    const features = 10; // time, open, high, low, close, volatility, price change, MA5, MA10, RSI14

    const input = tf.input({ shape: [timeSteps, features] });

    // Convolutional Layer for feature extraction
    const convLayer = tf.layers.conv1d({ filters: 64, kernelSize: 10, activation: "relu" }).apply(input);

    // LSTM Layers
    const lstmLayer1 = tf.layers
      .lstm({ units: 50, returnSequences: true, kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) })
      .apply(convLayer);
    const dropout1 = tf.layers.dropout({ rate: 0.2 }).apply(lstmLayer1);

    const lstmLayer2 = tf.layers
      .lstm({ units: 50, returnSequences: true, kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) })
      .apply(dropout1);
    const dropout2 = tf.layers.dropout({ rate: 0.2 }).apply(lstmLayer2);

    const lstmLayer3 = tf.layers
      .lstm({ units: 50, returnSequences: false, kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) })
      .apply(dropout2);
    const dropout3 = tf.layers.dropout({ rate: 0.2 }).apply(lstmLayer3);

    // Output for regression (predicting the currency value)
    const regressionOutput = tf.layers
      .dense({ units: 1, name: "regressionOutput" })
      .apply(dropout3) as tfType.SymbolicTensor;

    // Output for classification (predicting the command)
    const classificationOutput = tf.layers
      .dense({ units: 3, activation: "softmax", name: "classificationOutput" })
      .apply(dropout3) as tfType.SymbolicTensor;

    const model = tf.model({ inputs: input, outputs: [regressionOutput, classificationOutput] });

    model.compile({
      optimizer: tf.train.adam(0.02),
      loss: {
        regressionOutput: "meanSquaredError",
        classificationOutput: "categoricalCrossentropy",
      },
      metrics: {
        regressionOutput: "mse",
        classificationOutput: "accuracy",
      },
    });

    log("[**] New LSTM model created for regression and classification", Colors.GREEN);

    return model;
  };

  private async loadModel(modelPair: CryptoPairs): Promise<tfType.LayersModel> {
    const modelName = this.generateModelName(modelPair);
    const modelPath = `file://${this.modelDirectory}/${modelName}/model.json`;

    try {
      const model = await tf.loadLayersModel(modelPath);
      log(`[**] Model ${modelPair} loaded from file`, Colors.GREEN);
      return model;
    } catch (error) {
      log(`Error loading model ${modelPair}: ${error}`, Colors.RED);
      throw error;
    }
  }

  private loadModels = async () => {
    for (const pair of Object.values(CryptoPairs)) {
      try {
        log(`[*] Loading LSTM model for ${pair} currency from pre-saved file`, Colors.GREEN);

        const model = await this.loadModel(pair);
        model.compile({
          optimizer: tf.train.adam(0.02),
          loss: {
            regressionOutput: "meanSquaredError",
            classificationOutput: "categoricalCrossentropy",
          },
          metrics: {
            regressionOutput: "mse",
            classificationOutput: "accuracy",
          },
        });

        this.modelsMap.set(pair, model);

        log(`[**] LSTM model for ${pair} currency has been loaded from pre-saved file`, Colors.GREEN);
      } catch (error) {
        log(`Error while loading LSTM model for ${pair} currency: ${error}`, Colors.RED);
        log("[**] Creating new model", Colors.GREEN);

        const model = this.createLSTMmodel();

        this.modelsMap.set(pair, model);
      }
    }
  };

  private saveModel = async (modelPair: CryptoPairs) => {
    const model = this.modelsMap.get(modelPair);

    if (!model) {
      log(`[**] Model ${modelPair} not found`, Colors.RED);
      return;
    }

    const modelName = this.generateModelName(modelPair);
    const modelPath = `${this.modelDirectory}/${modelName}`;

    fse.ensureDirSync(modelPath);

    await model?.save("file://" + modelPath);
    log(`[**] Model ${modelPair} saved to file`, Colors.GREEN);
  };

  private prepareInputData(data: number[][], timeSteps: number): tfType.Tensor {
    // Нормализация данных
    const normalizedData = data;

    // Подготовка входных данных для модели
    const inputData = [];
    for (let i = 0; i < normalizedData.length - timeSteps; i++) {
      const x = normalizedData.slice(i, i + timeSteps);
      inputData.push(x);
    }

    // Преобразование в тензор
    return tf.tensor3d(inputData, [inputData.length, timeSteps, data[0].length]);
  }

  private normalize(data: number[][]): { normalizedData: number[][]; mean: number[]; std: number[] } {
    const timeFeature = data.map((row) => row[0]);
    const priceFeatures = data.map((row) => row.slice(1));

    // Normalize time feature
    const meanTime = timeFeature.reduce((a, b) => a + b, 0) / timeFeature.length;
    const stdTime = Math.sqrt(
      timeFeature.map((x) => Math.pow(x - meanTime, 2)).reduce((a, b) => a + b) / timeFeature.length
    );
    const normalizedTime = timeFeature.map((value) => (value - meanTime) / stdTime);

    // Normalize price features
    const meanPrices = Array(priceFeatures[0].length).fill(0);
    const stdPrices = Array(priceFeatures[0].length).fill(0);

    for (const row of priceFeatures) {
      row.forEach((value, index) => {
        meanPrices[index] += value;
      });
    }
    meanPrices.forEach((value, index, array) => {
      array[index] = value / priceFeatures.length;
    });

    for (const row of priceFeatures) {
      row.forEach((value, index) => {
        stdPrices[index] += Math.pow(value - meanPrices[index], 2);
      });
    }
    stdPrices.forEach((value, index, array) => {
      array[index] = Math.sqrt(value / priceFeatures.length);
    });

    const normalizedPriceFeatures = priceFeatures.map((row) =>
      row.map((value, index) => (value - meanPrices[index]) / stdPrices[index])
    );

    const normalizedData = normalizedTime.map((time, index) => [time, ...normalizedPriceFeatures[index]]);

    // Concatenate normalized time and price features
    return { normalizedData, mean: [meanTime, ...meanPrices], std: [stdTime, ...stdPrices] };
  }

  private denormalize = (value: number, mean: number, std: number): number => {
    return value * std + mean;
  };

  private calculateSMA(data: number[], period: number): number[] {
    const sma = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        sma.push(0);
      } else {
        const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
        sma.push(sum / period);
      }
    }
    return sma;
  }

  private calculateRSI(data: number[], period: number): number[] {
    const rsi = [];
    let gains = 0;
    let losses = 0;

    for (let i = 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses -= change;
      }

      if (i >= period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgGain / avgLoss;
        rsi.push(100 - 100 / (1 + rs));

        // Update gains and losses for the next period
        const prevChange = data[i - period + 1] - data[i - period];
        if (prevChange > 0) {
          gains -= prevChange;
        } else {
          losses += prevChange;
        }
      } else {
        rsi.push(0);
      }
    }
    return rsi;
  }

  private prepareDataset = (
    data: Pick<ICyptoCompareData, "time" | "high" | "low" | "open" | "close">[]
  ): { normalizedData: number[][]; mean: number[]; std: number[] } => {
    const closes = data.map((d) => d.close);
    const ma5 = this.calculateSMA(closes, 5);
    const ma10 = this.calculateSMA(closes, 10);
    const rsi14 = this.calculateRSI(closes, 14);

    const dataset = data.map((d, i) => [
      d.time,
      d.open,
      d.high,
      d.low,
      d.close,
      (d.high - d.low) / d.low,
      (d.close - d.open) / d.open,
      ma5[i] || 0, // MA5
      ma10[i] || 0, // MA10
      rsi14[i] || 0, // RSI14
    ]);

    return this.normalize(dataset);
  };

  public async trainAllModels(input: Map<CryptoPairs, ICyptoCompareData[]>): Promise<boolean> { 
    for (const [pair, data] of input) {
      await this.trainModel(pair, data);
    }

    return true;
  }

  public trainModel = async (modelPair: CryptoPairs, input: ICyptoCompareData[]): Promise<boolean> => {
    const modelToTrain = this.modelsMap.get(modelPair);

    if (!modelToTrain) {
      log(`[**] Model ${modelPair} not found`, Colors.RED);
      return false;
    }

    try {
      const epochs = 50;
      const batchSize = 128;
      const timeSteps = cryptoConfig.longTermMinuteWindowPrediction;
      const { normalizedData } = this.prepareDataset(input);

      // Prepare the data for LSTM
      const xs = [];
      const ysRegression = [];
      const ysClassification = [];
      for (let i = 0; i < normalizedData.length - timeSteps; i++) {
        const x = normalizedData.slice(i, i + timeSteps); // Reshape to [timeSteps, features]
        xs.push(x);

        // Generate labels for next price value (regression)
        const nextPrice = normalizedData[i + timeSteps][4]; // Use the 'close' price as the label
        ysRegression.push([nextPrice]); // Use the next price as the label

        // Generate labels for command (classification)
        const prevPrice = normalizedData[i + timeSteps - 1][4];
        let command = [0, 0, 0]; // [buy, sell, hold]
        if (nextPrice > prevPrice) {
          command = [1, 0, 0]; // Buy
        } else if (nextPrice < prevPrice) {
          command = [0, 1, 0]; // Sell
        } else {
          command = [0, 0, 1]; // Hold
        }
        ysClassification.push(command);
      }

      // Corrected tensor shape
      const xsTensor = tf.tensor3d(xs, [xs.length, timeSteps, normalizedData[0].length]);
      const ysRegressionTensor = tf.tensor2d(ysRegression, [ysRegression.length, 1]); // Single value for regression
      const ysClassificationTensor = tf.tensor2d(ysClassification, [ysClassification.length, 3]); // One-hot encoded for classification

      log(`[**] Training ${modelPair} model`, Colors.GREEN);

      console.time(`${modelPair}: Training Time`);

      await modelToTrain.fit(
        xsTensor,
        { regressionOutput: ysRegressionTensor, classificationOutput: ysClassificationTensor },
        {
          epochs,
          batchSize,
          callbacks: {
            onTrainEnd: () => {
              log("[**] Training completed", Colors.GREEN);
              console.timeEnd(`${modelPair}: Training Time`);
            },
          },
        }
      );

      await this.saveModel(modelPair);

      log(`[**] ${modelPair} Model training completed`, Colors.GREEN);
      return true;
    } catch (error) {
      console.timeEnd(`${modelPair}: Training Time`);
      console.error("Error during training:", error);
      return false;
    }
  };

  private async getModelPrediction(
    model: tfType.LayersModel,
    input: Pick<ICyptoCompareData, "time" | "high" | "low" | "open" | "close">[],
    threshold: number
  ): Promise<{ timestamp: number; predictedValue: number; command: "Buy" | "Sell" | "Hold" }> {
    const timeSteps = cryptoConfig.longTermMinuteWindowPrediction;

    const { normalizedData, mean, std } = this.prepareDataset(input);

    const xsTensor = this.prepareInputData(normalizedData, timeSteps);

    const [regressionPredictions, classificationPredictions] = model.predict(xsTensor) as tfType.Tensor[];

    const predictedValues = (await regressionPredictions.array()) as number[][];

    const predictedCommands = (await classificationPredictions.array()) as number[][];

    const predictedValue = this.denormalize(predictedValues[predictedValues.length - 1][0], mean[4], std[4]); // Use the 'close' price index for denormalization

    // Predict for 15 minutes using LSTM Model
    const lstmIndex = xsTensor.shape[0] - 1;
    const lstmTime = (input[input.length - 1].time + 15 * 60) * 1000; // Predicting for the next 15 minutes
    const lstmActualValue = input[input.length - 1].close; // Last known price

    const [buy, sell, hold] = predictedCommands[lstmIndex];

    let command: "Buy" | "Sell" | "Hold";

    const profitWhenBuy = (predictedValue - lstmActualValue) / lstmActualValue;

    const profitWhenSell = (lstmActualValue - predictedValue) / lstmActualValue;

    if (buy > sell && buy > hold && profitWhenBuy > threshold) {
      command = "Buy";
    } else if (sell > buy && sell > hold && profitWhenSell > threshold) {
      command = "Sell";
    } else {
      command = "Hold";
    }

    return {
      timestamp: lstmTime,
      predictedValue,
      command,
    };
  }

  public async predictNextPrices(
    input: Map<CryptoPairs, ICyptoCompareData[]>
  ): Promise<Map<CryptoPairs, ITensorflowPrediction>> {
    const results: Map<CryptoPairs, ITensorflowPrediction> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      try {
        const model = await this.modelsMap.get(pair);

        const dataset = input.get(pair);

        if (!model) {
          log(`[**] Model ${pair} not found`, Colors.RED);
          continue;
        }

        if (!dataset) {
          log(`[**] Dataset for ${pair} not found`, Colors.RED);
          continue;
        }

        // Define a threshold for Buy/Sell/Hold decision
        const threshold = 0.0000001;
        //   // Define the network fee as a percentage of the transaction
        const networkFeePercentage = 0.0005; // 0.05% fee

        const feeAdjustedThreshold = threshold + networkFeePercentage;

        const lstm_model_prediction = await this.getModelPrediction(
          model,
          dataset.map((data) => ({
            time: data.time,
            open: data.open,
            high: data.high,
            low: data.low,
            close: data.close,
          })),
          feeAdjustedThreshold
        );

        results.set(pair, {
          timestamp: Math.floor(Date.now() / 1000) * 1000,
          pair,
          current_value: dataset[dataset.length - 1].close,
          lstm_timestamp: lstm_model_prediction.timestamp,
          predicted_value: lstm_model_prediction.predictedValue,
          predicted_command: lstm_model_prediction.command,
        });
      } catch (error) {
        log(`Error while predicting next prices: ${error}`, Colors.RED);
        continue;
      }
    }

    results.forEach((result) => {
      const currentCurrency = result.current_value;

      const now = format(new Date(result.timestamp), "dd/MM/yy HH:mm");
      const lstmDate = format(new Date(result.lstm_timestamp), "dd/MM/yy HH:mm");

      const predictedValue = result.predicted_value.toFixed(7);
      const command = result.predicted_command;

      log(
        `[**] ${now} ${result.pair} Current currency: ${currentCurrency}. LSTM: ${command}: ${predictedValue} at ${lstmDate}`,
        getRandomEnumValue(Colors)
      );
    });

    return results;
  }
}

export default new TensorflowAI();
