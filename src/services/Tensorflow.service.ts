import fse from "fs-extra";
import config from "../config/digitalOcean.config";
import type * as tfType from "@tensorflow/tfjs-node";
import { format } from "date-fns";

import cryptoConfig from "../config/crypto.config";

import { ICyptoCompareData } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";

// Import TensorFlow.js types

// Dynamically import the appropriate TensorFlow.js backend
const tf: typeof tfType = cryptoConfig.useGPU ? require("@tensorflow/tfjs-node-gpu") : require("@tensorflow/tfjs-node");

class TensorflowAI {
  private readonly minuteModelLocalDir: string = `${__dirname}/../models/minute`;
  private readonly longTermModelLocalDir: string = `${__dirname}/../models/long-term`;
  private readonly minuteModelCloudDir = "models/minute";
  private readonly longTermModelCloudDir = "models/long-term";

  private readonly splittedEndpoint = config.endpoint.split("//");
  private readonly baseURL = `${this.splittedEndpoint[0]}//${config.bucket}.${this.splittedEndpoint[1]}`;

  // Model for prediction currency for the next minute in future
  private minuteModel: tfType.LayersModel | null = null;
  // Model for prediction currency for the next 5-15 minutes in future
  private longTermModel: tfType.LayersModel | null = null;

  constructor() {
    log("[*] Initializing Tensorflow AI Service", Colors.GREEN);

    this.loadModel();
  }

  private createMinuteModel = () => {
    const timeSteps = cryptoConfig.shortTermMinuteWindowPrediction;
    const features = 5; // open, high, low, close

    const input = tf.input({ shape: [timeSteps, features] });

    const convLayer = tf.layers
      .conv1d({ filters: 32, kernelSize: 3, activation: "relu", inputShape: [timeSteps, features] })
      .apply(input);
    const maxPoolLayer = tf.layers.maxPooling1d({ poolSize: 2 }).apply(convLayer);
    const flattenLayer = tf.layers.flatten().apply(maxPoolLayer);
    const denseLayer = tf.layers.dense({ units: 50, activation: "relu" }).apply(flattenLayer);

    // Output for regression (predicting the currency value)
    const regressionOutput = tf.layers
      .dense({ units: 1, name: "regressionOutput" })
      .apply(denseLayer) as tfType.SymbolicTensor;

    // Output for classification (predicting the command)
    const classificationOutput = tf.layers
      .dense({ units: 3, activation: "softmax", name: "classificationOutput" })
      .apply(denseLayer) as tfType.SymbolicTensor;

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

    log("[**] New CNN model created for regression and classification", Colors.GREEN);

    return model;
  };

  private createLongTermModel = () => {
    const timeSteps = cryptoConfig.longTermMinuteWindowPrediction;
    const features = 5; // open, high, low, close

    const input = tf.input({ shape: [timeSteps, features] });

    const lstmLayer1 = tf.layers
      .lstm({ units: 30, returnSequences: true, kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) })
      .apply(input);
    const lstmLayer2 = tf.layers
      .lstm({ units: 60, returnSequences: true, kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) })
      .apply(lstmLayer1);
    const lstmLayer3 = tf.layers
      .lstm({ units: 30, returnSequences: false, kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) })
      .apply(lstmLayer2);

    // Output for regression (predicting the currency value)
    const regressionOutput = tf.layers
      .dense({ units: 1, name: "regressionOutput" })
      .apply(lstmLayer3) as tfType.SymbolicTensor;

    // Output for classification (predicting the command)
    const classificationOutput = tf.layers
      .dense({ units: 3, activation: "softmax", name: "classificationOutput" })
      .apply(lstmLayer3) as tfType.SymbolicTensor;

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

  private loadModel = async () => {
    try {
      log("[*] Loading CNN model from pre-saved file", Colors.GREEN);

      const minuteModel = await tf.loadLayersModel(`${this.baseURL}/${this.minuteModelCloudDir}/model.json`);
      minuteModel.compile({
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

      this.minuteModel = minuteModel;

      log("[**] CNN Model loaded from pre-saved file", Colors.GREEN);
    } catch (error) {
      log(`Error while loading CNN model: ${error}`, Colors.RED);
      log("[**] Creating new model", Colors.GREEN);
      this.minuteModel = this.createMinuteModel();
    }

    try {
      log("[*] Loading LSTM model from pre-saved file", Colors.GREEN);

      const longTermModel = await tf.loadLayersModel(`${this.baseURL}/${this.longTermModelCloudDir}/model.json`);
      longTermModel.compile({
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

      this.longTermModel = longTermModel;

      log("[**] LSTM Model loaded from pre-saved file", Colors.GREEN);
    } catch (error) {
      log(`Error while loading LSTM model: ${error}`, Colors.RED);
      log("[**] Creating new model", Colors.GREEN);
      this.longTermModel = this.createLongTermModel();
    }
  };

  private saveMinuteModel = async () => {
    fse.ensureDirSync(this.minuteModelLocalDir);
    await this.minuteModel?.save("file://" + this.minuteModelLocalDir);
    await DigitalOceanStorageService.saveModel(this.minuteModelLocalDir, this.minuteModelCloudDir);
    log("[**] Minute Model (CNN) saved to file", Colors.GREEN);
  };

  private saveLongTermModel = async () => {
    fse.ensureDirSync(this.minuteModelLocalDir);
    await this.longTermModel?.save("file://" + this.longTermModelLocalDir);
    await DigitalOceanStorageService.saveModel(this.longTermModelLocalDir, this.longTermModelCloudDir);
    log("[**] Long Term (LSTM) Model saved to file", Colors.GREEN);
  };

  public trainModel = async (model: "minute" | "long-term", input: ICyptoCompareData[]): Promise<boolean> => {
    const modetToTrain = model === "minute" ? this.minuteModel : this.longTermModel;
    try {
      if (!modetToTrain) {
        console.error("Model not initialized");
        return false;
      }

      const epochs = 50;
      const batchSize = 64;
      const timeSteps =
        model === "minute" ? cryptoConfig.shortTermMinuteWindowPrediction : cryptoConfig.longTermMinuteWindowPrediction;

      // Normalize the data
      const normalize = (data: number[], min: number[], max: number[]) => {
        return data.map((value, index) => (value - min[index]) / (max[index] - min[index]));
      };

      const data = input.map((d) => [d.time, d.open, d.high, d.low, d.close]);

      const minValues = data.reduce(
        (acc, val) => val.map((v, i) => Math.min(v, acc[i])),
        [Infinity, Infinity, Infinity, Infinity, Infinity]
      );
      const maxValues = data.reduce(
        (acc, val) => val.map((v, i) => Math.max(v, acc[i])),
        [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity]
      );

      const normalizedData = data.map((d) => normalize(d, minValues, maxValues));

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
      const xsTensor = tf.tensor3d(xs, [xs.length, timeSteps, 5]);
      const ysRegressionTensor = tf.tensor2d(ysRegression, [ysRegression.length, 1]); // Single value for regression
      const ysClassificationTensor = tf.tensor2d(ysClassification, [ysClassification.length, 3]); // One-hot encoded for classification

      log(`[**] Training ${model} model`, Colors.GREEN);

      console.time(`${model}: Training Time`);

      await modetToTrain.fit(
        xsTensor,
        { regressionOutput: ysRegressionTensor, classificationOutput: ysClassificationTensor },
        {
          epochs,
          batchSize,
          callbacks: {
            onEpochEnd: (epoch, logs) => {
              if (logs && logs.loss < 0.2) {
                // Early stopping condition
                this.minuteModel!.stopTraining = true;
              }
            },
            onTrainEnd: () => {
              log("[**] Training completed", Colors.GREEN);
              console.timeEnd(`${model}: Training Time`);
            },
          },
        }
      );

      model === "minute" ? await this.saveMinuteModel() : await this.saveLongTermModel();

      log(`[**] ${model} Model training completed`, Colors.GREEN);
      return true;
    } catch (error) {
      console.error("Error during training:", error);
      return false;
    }
  };

  private prepareInputData(data: number[][], timeSteps: number): tfType.Tensor {
    // Нормализация данных
    const normalizedData = this.normalizeData(data);

    // Подготовка входных данных для модели
    const inputData = [];
    for (let i = 0; i < normalizedData.length - timeSteps; i++) {
      const x = normalizedData.slice(i, i + timeSteps);
      inputData.push(x);
    }

    // Преобразование в тензор
    return tf.tensor3d(inputData, [inputData.length, timeSteps, data[0].length]);
  }

  private normalizeData(data: number[][]): number[][] {
    // Пример нормализации данных (может быть изменен в зависимости от требований)
    const min = Math.min(...data.flat());
    const max = Math.max(...data.flat());
    return data.map((row) => row.map((value) => (value - min) / (max - min)));
  }

  public async predictNextPrices(input: ICyptoCompareData[]): Promise<ITensorflowPrediction[]> {
    if (!this.minuteModel || !this.longTermModel) {
      throw new Error("Models not loaded");
    }

    const data = input.map((d) => [d.time, d.open, d.high, d.low, d.close]);
    const timeStepsShort = cryptoConfig.shortTermMinuteWindowPrediction;
    const timeStepsLong = cryptoConfig.longTermMinuteWindowPrediction;

    const xsShortTensor = this.prepareInputData(data, timeStepsShort);
    const xsLongTensor = this.prepareInputData(data, timeStepsLong);

    // Make predictions by CNN Model
    const [CNNregressionPredictions, CNNclassificationPredictions] = this.minuteModel.predict(
      xsShortTensor
    ) as tfType.Tensor[];
    const CNNregressionPredictionsArray = (await CNNregressionPredictions.array()) as number[][];
    const CNNclassificationPredictionsArray = (await CNNclassificationPredictions.array()) as number[][];

    // Make predictions by LSTM Model
    const [LSTMregressionPredictions, LSTMclassificationPredictions] = this.longTermModel.predict(
      xsLongTensor
    ) as tfType.Tensor[];
    const LSTMregressionPredictionsArray = (await LSTMregressionPredictions.array()) as number[][];
    const LSTMclassificationPredictionsArray = (await LSTMclassificationPredictions.array()) as number[][];

    // Define a threshold for Buy/Sell/Hold decision
    const threshold = 0.0000001;
    //   // Define the network fee as a percentage of the transaction
    const networkFeePercentage = 0.0005; // 0.05% fee

    const feeAdjustedThreshold = threshold + networkFeePercentage;

    // Interpret predictions
    const results: ITensorflowPrediction[] = [];

    // Get min and max values for denormalization
    const minValues = data.reduce(
      (acc, val) => val.map((v, i) => Math.min(v, acc[i])),
      [Infinity, Infinity, Infinity, Infinity, Infinity]
    );
    const maxValues = data.reduce(
      (acc, val) => val.map((v, i) => Math.max(v, acc[i])),
      [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity]
    );

    // Function to denormalize values
    const denormalize = (value: number, min: number, max: number) => {
      return value * (max - min) + min;
    };

    // Predict for 5 minutes using CNN Model
    const cnnIndex = xsShortTensor.shape[0] - 1;
    const cnnTime = (input[input.length - 1].time + 5 * 60) * 1000; // Predicting for the next 5 minutes
    const cnnActualValue = input[input.length - 1].close; // Last known price
    const cnnPredictedValue = denormalize(CNNregressionPredictionsArray[cnnIndex][0], minValues[4], maxValues[4]);

    const [CNNbuy, CNNsell, CNNhold] = CNNclassificationPredictionsArray[cnnIndex];
    let cnnCommand: string;
    const cnnProfitWhenBuy = (cnnPredictedValue - cnnActualValue) / cnnActualValue;
    const cnnProfitWhenSell = (cnnActualValue - cnnPredictedValue) / cnnActualValue;
    if (CNNbuy > CNNsell && CNNbuy > CNNhold && cnnProfitWhenBuy > feeAdjustedThreshold) {
      cnnCommand = "Buy";
    } else if (CNNsell > CNNbuy && CNNsell > CNNhold && cnnProfitWhenSell > feeAdjustedThreshold) {
      cnnCommand = "Sell";
    } else {
      cnnCommand = "Hold";
    }

    // Predict for 15 minutes using LSTM Model
    const lstmIndex = xsLongTensor.shape[0] - 1;
    const lstmTime = (input[input.length - 1].time + 15 * 60) * 1000; // Predicting for the next 15 minutes
    const lstmActualValue = input[input.length - 1].close; // Last known price
    const lstmPredictedValue = denormalize(LSTMregressionPredictionsArray[lstmIndex][0], minValues[4], maxValues[4]);

    const [LSTMbuy, LSTMsell, LSTMhold] = LSTMclassificationPredictionsArray[lstmIndex];
    let lstmCommand: string;
    const lstmProfitWhenBuy = (lstmPredictedValue - lstmActualValue) / lstmActualValue;
    const lstmProfitWhenSell = (lstmActualValue - lstmPredictedValue) / lstmActualValue;
    if (LSTMbuy > LSTMsell && LSTMbuy > LSTMhold && lstmProfitWhenBuy > feeAdjustedThreshold) {
      lstmCommand = "Buy";
    } else if (LSTMsell > LSTMbuy && LSTMsell > LSTMhold && lstmProfitWhenSell > feeAdjustedThreshold) {
      lstmCommand = "Sell";
    } else {
      lstmCommand = "Hold";
    }

    results.push({
      timestamp: Math.floor(Date.now() / 1000) * 1000,
      CNNtimestamp: cnnTime,
      CNNpredictedValue: cnnPredictedValue,
      CNNcommand: cnnCommand,
      LSTMtimestamp: lstmTime,
      LSTMpredictedValue: lstmPredictedValue,
      LSTMcommand: lstmCommand,
    });

    results.forEach((result) => {
      const currentCurrency = data[data.length - 1][4];
      const now = format(new Date(result.timestamp), "dd/MM/yy HH:mm");
      const lstmDate = format(new Date(result.LSTMtimestamp), "dd/MM/yy HH:mm");
      const cnnDate = format(new Date(result.CNNtimestamp), "dd/MM/yy HH:mm");
      const LSTMpredictedValue = result.LSTMpredictedValue;
      const LSTMcommand = result.LSTMcommand;
      const CNNpredictedValue = result.CNNpredictedValue;
      const CNNcommand = result.CNNcommand;

      log(
        `[**] ${now} Current currency: ${currentCurrency}. CNN: ${CNNcommand}: ${CNNpredictedValue} at ${cnnDate}, LSTM: ${LSTMcommand}: ${LSTMpredictedValue} at ${lstmDate}`,
        Colors.YELLOW
      );
    });

    return results;
  }
}

export default new TensorflowAI();
