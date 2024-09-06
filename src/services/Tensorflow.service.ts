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
      log("[*] Loading model from pre-saved file", Colors.GREEN);

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
        [-Infinity, - Infinity, -Infinity, -Infinity, -Infinity]
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

  public async predictNextPrices(
    input: ICyptoCompareData[]
  ): Promise<{ time: number; predictedValue: number; command: string }[]> {
    if (!this.minuteModel) {
      throw new Error("Model not loaded");
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
      const x = normalizedData.slice(i, i + timeSteps) // Ensure each value is wrapped in an array to create a 2D array [timeSteps, 1]
      xs.push(x);
    }

    const xsTensor = tf.tensor3d(xs, [xs.length, timeSteps, 5]); // Create 3D tensor with shape [batchSize, timeSteps, features]

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
      const time = (input[index + timeSteps].time + 60) * 1000; // Predicting for the next minute

      const actualValue = input[input.length - 1].close; // Last known price

      // predicted value by AI
      const normalizedPredictedValue = pred[0]; // Single value for regression
      const predictedValue = denormalize(normalizedPredictedValue, minValues[4], maxValues[4]); // Denormalize using 'close' price min and max

      // predicted command by AI
      const [buy, sell, hold] = classificationPredictionsArray[index];

      let command: string;
      const profitWhenBuy = (predictedValue - actualValue) / actualValue;
      const profitWhenSell = (actualValue - predictedValue) / actualValue;

      if (buy > sell && buy > hold && profitWhenBuy > feeAdjustedThreshold) {
        command = "Buy";
      } else if (sell > buy && sell > hold && profitWhenSell > feeAdjustedThreshold) {
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
        `[**] Current currency: ${data[data.length - 1]}. Singal from AI: at ${format(
          new Date(result.time),
          "dd/MM/yyyy HH:mm"
        )} - ${result.command}, predicted currency: ${result.predictedValue}`,
        Colors.YELLOW
      );
    });

    return results;
  }
}

export default new TensorflowAI();
