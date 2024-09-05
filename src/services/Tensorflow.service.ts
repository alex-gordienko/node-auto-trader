import fse from "fs-extra";
import config from "../config/digitalOcean.config";
import type * as tfType from "@tensorflow/tfjs-node";
import { format } from "date-fns";

import cryptoConfig from "../config/crypto.config";

import { ICyptoCompareData } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";

// Import TensorFlow.js types

// Dynamically import the appropriate TensorFlow.js backend
const tf: typeof tfType = cryptoConfig.useGPU ? require("@tensorflow/tfjs-node-gpu") : require("@tensorflow/tfjs-node");

class TensorflowAI {
  private readonly minuteModelLocalDir: string = `${__dirname}/../miner/models/minute`;
  private readonly minuteModelCloudDir = "models/minute";

  private readonly splittedEndpoint = config.endpoint.split("//");
  private readonly baseURL = `${this.splittedEndpoint[0]}//${config.bucket}.${this.splittedEndpoint[1]}`;
  private minuteModel: tfType.LayersModel | null = null;

  constructor() {
    log("[*] Initializing Tensorflow AI Service", Colors.GREEN);

    this.loadModel();
  }

  private createModel = () => {
    const input = tf.input({ shape: [10, 1] });

    const lstmLayer1 = tf.layers.lstm({ units: 30, returnSequences: true }).apply(input);
    const lstmLayer2 = tf.layers.lstm({ units: 30, returnSequences: false }).apply(lstmLayer1);

    // Output for regression (predicting the currency value)
    const regressionOutput = tf.layers
      .dense({ units: 1, name: "regressionOutput" })
      .apply(lstmLayer2) as tfType.SymbolicTensor;

    // Output for classification (predicting the command)
    const classificationOutput = tf.layers
      .dense({ units: 3, activation: "softmax", name: "classificationOutput" })
      .apply(lstmLayer2) as tfType.SymbolicTensor;

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
      log("[*] Loading model from pre-saved file", Colors.GREEN);

      const minuteModel = await tf.loadLayersModel(`${this.baseURL}/${this.minuteModelCloudDir}/model.json`);
      minuteModel.compile({
        optimizer: tf.train.adam(0.02),
        loss: "meanSquaredError",
      });

      this.minuteModel = minuteModel;

      log("[**] Model loaded from pre-saved file", Colors.GREEN);
    } catch (error) {
      log(`Error while loading model: ${error}`, Colors.RED);
      log("[**] Creating new model", Colors.GREEN);
      this.minuteModel = this.createModel();
    }
  };

  private saveModel = async (modelType: "minutePair") => {
    fse.ensureDirSync(this.minuteModelLocalDir);
    await this.minuteModel?.save("file://" + this.minuteModelLocalDir);
    await DigitalOceanStorageService.saveModel(this.minuteModelLocalDir, this.minuteModelCloudDir, modelType);
    log("[**] Minute Model saved to file", Colors.GREEN);
  };

  public trainModel = async (modelType: "minutePair", input: ICyptoCompareData[]) => {
    try {
      if (!this.minuteModel) {
        console.error("Model not initialized");
        return;
      }

      const epochs = 50;
      const batchSize = 16;

      const data = input.map((d) => d.close);
      const timeSteps = 10;

      // Normalize the data
      const normalize = (data: number[]) => {
        const min = Math.min(...data);
        const max = Math.max(...data);
        return data.map((value) => (value - min) / (max - min));
      };

      const normalizedData = normalize(data);

      // Prepare the data for LSTM
      const xs = [];
      const ysRegression = [];
      const ysClassification = [];
      for (let i = 0; i < normalizedData.length - timeSteps; i++) {
        const x = normalizedData.slice(i, i + timeSteps).map((value) => [value]); // Reshape to [timeSteps, 1]
        xs.push(x);

        // Generate labels for next price value (regression)
        const nextPrice = normalizedData[i + timeSteps];
        ysRegression.push(nextPrice); // Use the next price as the label

        // Generate labels for command (classification)
        const prevPrice = normalizedData[i + timeSteps - 1];
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
      const xsTensor = tf.tensor3d(xs, [xs.length, timeSteps, 1]);
      const ysRegressionTensor = tf.tensor2d(ysRegression, [ysRegression.length, 1]); // Single value for regression
      const ysClassificationTensor = tf.tensor2d(ysClassification, [ysClassification.length, 3]); // One-hot encoded for classification

      log(`[**] Training ${modelType} model`, Colors.GREEN);

      log(`[**] Training ${modelType} model`, Colors.GREEN);
      console.time(`${modelType}: Training Time`);

      await this.minuteModel.fit(
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
              console.timeEnd(`${modelType}: Training Time`);
            },
          },
        }
      );

      await this.saveModel(modelType);

      log("[**] Model training completed", Colors.GREEN);
    } catch (error) {
      console.error("Error during training:", error);
    }
  };

  // public predictNextPrices = async (input: ICyptoCompareHistoryMinutePair) => {
  //   if (!this.minuteModel) {
  //     console.error("Model not initialized");
  //     return null;
  //   }

  //   const data = input.Data.Data.map((d) => ({ time: d.time, close: d.close }));
  //   const startTime = data[0].time;
  //   const outputs = data.map((d) => d.close);

  //   // Normalize inputs and outputs
  //   const minClose = Math.min(...outputs);
  //   const maxClose = Math.max(...outputs);

  //   // Define the future times in minutes since the start
  //   const futureMinutes = [11]; // Minutes after the last timestamp in the data

  //   // Convert to tensor
  //   const futureInputs = tf.tensor2d(futureMinutes.map((minute) => [minute]));

  //   // Predict and denormalize the results
  //   const predictionsByMinutes = this.minuteModel.predict(futureInputs) as tf.Tensor;
  //   const predictedPricesByMinutes = predictionsByMinutes
  //     .dataSync()
  //     .map((normPrice) => normPrice * (maxClose - minClose) + minClose);

  //   // Calculate short-term and long-term moving averages
  //   const shortTermPeriod = 5;
  //   const longTermPeriod = 10;

  //   const shortTermMA = outputs.slice(-shortTermPeriod).reduce((a, b) => a + b, 0) / shortTermPeriod;
  //   const longTermMA = outputs.slice(-longTermPeriod).reduce((a, b) => a + b, 0) / longTermPeriod;

  //   // Define the network fee as a percentage of the transaction
  //   const networkFeePercentage = 0.0005; // 0.05% fee

  //   // Display predictions as time-value pairs with Buy/Sell command
  //   const predictionResultsByMinutes = futureMinutes.map((minute, index) => {
  //     const predictedTime = startTime + minute * 60; // Convert back to Unix timestamp
  //     const predictedValue = predictedPricesByMinutes[index];
  //     const actualValue = outputs[outputs.length - 1]; // Last known price

  //     // Determine buy/sell command based on a moving average crossover strategy
  //     const priceChangeThreshold = 0.0000001; // Very tight threshold
  //     const feeAdjustedThreshold = priceChangeThreshold + networkFeePercentage;

  //     let action: string;
  //     if (shortTermMA > longTermMA && (predictedValue - actualValue) / actualValue > feeAdjustedThreshold) {
  //       action = "Buy";
  //     } else if (shortTermMA < longTermMA && (actualValue - predictedValue) / actualValue > feeAdjustedThreshold) {
  //       action = "Sell";
  //     } else {
  //       action = "Hold";
  //     }

  //     return {
  //       time: predictedTime,
  //       predictedValue,
  //       action,
  //     };
  //   });

  //   return {
  //     last10: data.map((d) => ({
  //       time: d.time,
  //       close: d.close,
  //     })),
  //     predictionResultsByMinutes,
  //   };
  // };

  public async predictNextPrices(
    input: ICyptoCompareData[]
  ): Promise<{ time: number; predictedValue: number; command: string }[]> {
    if (!this.minuteModel) {
      throw new Error("Model not loaded");
    }

    const data = input.map((d) => d.close);
    const timeSteps = 10;

    // Normalize the data
    const normalize = (data: number[]) => {
      const min = Math.min(...data);
      const max = Math.max(...data);
      return data.map((value) => (value - min) / (max - min));
    };

    const denormalize = (value: number, min: number, max: number) => {
      return value * (max - min) + min;
    };

    const normalizedData = normalize(data);
    const min = Math.min(...data);
    const max = Math.max(...data);

    // Prepare the data for LSTM
    const xs = [];
    for (let i = 0; i < normalizedData.length - timeSteps; i++) {
      const x = normalizedData.slice(i, i + timeSteps).map((value) => [value]); // Ensure each value is wrapped in an array to create a 2D array [timeSteps, 1]
      xs.push(x);
    }

    const xsTensor = tf.tensor3d(xs, [xs.length, timeSteps, 1]); // Create 3D tensor with shape [batchSize, timeSteps, features]

    // Make predictions
    const [regressionPredictions, classificationPredictions] = this.minuteModel.predict(xsTensor) as tfType.Tensor[];
    const regressionPredictionsArray = (await regressionPredictions.array()) as number[][];
    const classificationPredictionsArray = (await classificationPredictions.array()) as number[][];

    // Define a threshold for Buy/Sell/Hold decision
    const threshold = 0.0000001;
    //   // Define the network fee as a percentage of the transaction
    const networkFeePercentage = 0.0005; // 0.05% fee

    const feeAdjustedThreshold = threshold + networkFeePercentage;

    // Interpret predictions
    const results = regressionPredictionsArray.map((pred: number[], index: number) => {
      const time = input[index + timeSteps].time + 60; // Predicting for the next minute

      const actualValue = data[data.length - 1]; // Last known price

      // predicted value by AI
      const normalizedPredictedValue = pred[0]; // Single value for regression
      const predictedValue = denormalize(normalizedPredictedValue, min, max);

      // predicted command by AI
      const [buy, sell, hold] = classificationPredictionsArray[index];

      let command: string;
      if (buy > sell && buy > hold && (predictedValue - actualValue) / actualValue > feeAdjustedThreshold) {
        command = "Buy";
      } else if (sell > buy && sell > hold && (actualValue - predictedValue) / actualValue > feeAdjustedThreshold) {
        command = "Sell";
      } else {
        command = "Hold";
      }

      return {
        time,
        predictedValue,
        command,
      };
    });

    results.forEach((result) => {
      log(
        `[**] ${format(result.time, "dd/MM/yyyy HH:mm")} Singal from AI: ${result.command}, predicted value: ${
          result.predictedValue
        }`,
        Colors.YELLOW
      );
    });

    return results;
  }
}

export default new TensorflowAI();
