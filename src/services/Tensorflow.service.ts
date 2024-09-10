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
    const timeSteps = cryptoConfig.requestLimitMinutePairPrediction;
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
    const timeSteps = cryptoConfig.requestLimitMinutePairPrediction;
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
      const timeSteps = cryptoConfig.requestLimitMinutePairPrediction;

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

  public async predictNextPrices(input: ICyptoCompareData[]): Promise<ITensorflowPrediction[]> {
    if (!this.minuteModel || !this.longTermModel) {
      throw new Error("Models not loaded");
    }

    const data = input.map((d) => [d.time, d.open, d.high, d.low, d.close]);
    const timeSteps = cryptoConfig.requestLimitMinutePairPrediction;

    // Normalize the data
    const normalize = (data: number[], min: number[], max: number[]) => {
      return data.map((value, index) => (value - min[index]) / (max[index] - min[index]));
    };

    const denormalize = (value: number, min: number, max: number) => {
      return value * (max - min) + min;
    };

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
    for (let i = 0; i < normalizedData.length - timeSteps; i++) {
      const x = normalizedData.slice(i, i + timeSteps); // Ensure each value is wrapped in an array to create a 2D array [timeSteps, 1]
      xs.push(x);
    }

    const xsTensor = tf.tensor3d(xs, [xs.length, timeSteps, 5]); // Create 3D tensor with shape [batchSize, timeSteps, features]

    // Make predictions by CNN Model
    const [CNNregressionPredictions, CNNclassificationPredictions] = this.minuteModel.predict(
      xsTensor
    ) as tfType.Tensor[];
    const CNNregressionPredictionsArray = (await CNNregressionPredictions.array()) as number[][];
    const CNNclassificationPredictionsArray = (await CNNclassificationPredictions.array()) as number[][];

    // Make predictions by LSTM Model
    const [LSTMregressionPredictions, LSTMclassificationPredictions] = this.longTermModel.predict(
      xsTensor
    ) as tfType.Tensor[];
    const LSTMregressionPredictionsArray = (await LSTMregressionPredictions.array()) as number[][];
    const LSTMclassificationPredictionsArray = (await LSTMclassificationPredictions.array()) as number[][];

    // Define a threshold for Buy/Sell/Hold decision
    const threshold = 0.0000001;
    //   // Define the network fee as a percentage of the transaction
    const networkFeePercentage = 0.0005; // 0.05% fee

    const feeAdjustedThreshold = threshold + networkFeePercentage;

    log(`LSTMregressionPredictionsArray: ${LSTMregressionPredictionsArray[0].length}`, Colors.YELLOW);
    log(`CNNregressionPredictionsArray: ${CNNregressionPredictionsArray[0].length}`, Colors.YELLOW);
    // Interpret predictions
    const results = LSTMregressionPredictionsArray.map((pred: number[], index: number) => {
      const time = (input[index + timeSteps].time + 60) * 1000; // Predicting for the next minute

      const actualValue = input[input.length - 1].close; // Last known price

      // predicted value by AI
      const LSTMpredictedValue = denormalize(pred[0], minValues[4], maxValues[4]); // Denormalize using 'close' price min and max

      const cnnPredictedValue = denormalize(CNNregressionPredictionsArray[index][0], minValues[4], maxValues[4]);

      // predicted command by AI
      const [LSTMbuy, LSTMsell, LSTMhold] = LSTMclassificationPredictionsArray[index];
      const [CNNbuy, CNNsell, CNNhold] = CNNclassificationPredictionsArray[index];

      let commandFromLSTM: string;
      const LSTMprofitWhenBuy = (LSTMpredictedValue - actualValue) / actualValue;
      const LSTMprofitWhenSell = (actualValue - LSTMpredictedValue) / actualValue;

      if (LSTMbuy > LSTMsell && LSTMbuy > LSTMhold && LSTMprofitWhenBuy > feeAdjustedThreshold) {
        commandFromLSTM = "Buy";
      } else if (LSTMsell > LSTMbuy && LSTMsell > LSTMhold && LSTMprofitWhenSell > feeAdjustedThreshold) {
        commandFromLSTM = "Sell";
      } else {
        commandFromLSTM = "Hold";
      }

      let commandFromCNN: string;
      const CNNprofitWhenBuy = (cnnPredictedValue - actualValue) / actualValue;
      const CNNprofitWhenSell = (actualValue - cnnPredictedValue) / actualValue;

      if (CNNbuy > CNNsell && CNNbuy > CNNhold && CNNprofitWhenBuy > feeAdjustedThreshold) {
        commandFromCNN = "Buy";
      } else if (CNNsell > CNNbuy && CNNsell > CNNhold && CNNprofitWhenSell > feeAdjustedThreshold) {
        commandFromCNN = "Sell";
      } else {
        commandFromCNN = "Hold";
      }

      return {
        timestamp: time,
        LSTMpredictedValue,
        LSTMcommand: commandFromLSTM,
        CNNpredictedValue: cnnPredictedValue,
        CNNcommand: commandFromCNN,
      };
    });

    results.forEach((result) => {
      const currentCurrency = data[data.length - 1][4];
      const nextMinute = format(new Date(result.timestamp), "dd/MM/yyyy HH:mm");
      const LSTMpredictedValue = result.LSTMpredictedValue;
      const LSTMcommand = result.LSTMcommand;
      const CNNpredictedValue = result.CNNpredictedValue;
      const CNNcommand = result.CNNcommand;

      log(
        `[**] Current currency: ${currentCurrency}. Singal from AI: at ${nextMinute} - LSTM: ${LSTMcommand}, predicted currency: ${LSTMpredictedValue}, CNN: ${CNNcommand}, predicted currency: ${CNNpredictedValue}`,
        Colors.YELLOW
      );
    });

    return results;
  }
}

export default new TensorflowAI();
