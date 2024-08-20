import * as tf from "@tensorflow/tfjs-node";
import fse from "fs-extra";
import { format } from "date-fns";
import config from "../config/digitalOcean.config";

import {
  ICyptoCompareData,
  ICyptoCompareHistoryMinutePair,
} from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import repeatEvent from "../utils/timer";

class TensorflowAI {
  private readonly hourlyModelLocalDir: string = `${__dirname}/../miner/models/hourly`;
  private readonly minuteModelLocalDir: string = `${__dirname}/../miner/models/minute`;
  private readonly hourlyModelCloudDir = "models/hourly";
  private readonly minuteModelCloudDir = "models/minute";

  private readonly splittedEndpoint = config.endpoint.split("//");
  private readonly baseURL = `${this.splittedEndpoint[0]}//${config.bucket}.${this.splittedEndpoint[1]}`;
  private hourlyModel: tf.LayersModel | null = null;
  private minuteModel: tf.LayersModel | null = null;

  private pairMinuteTimer: NodeJS.Timeout | null = null;
  private pairHourTimer: NodeJS.Timeout | null = null;

  constructor() {
    log("[*] Initializing Tensorflow AI Service", Colors.GREEN);

    this.loadModels().then(() => this.startAutoTraining());
  }

  public stopPairMinuteTimer = () => {
    if (this.pairMinuteTimer) {
      clearInterval(this.pairMinuteTimer);
    }
  };

  public stopPairHourTimer = () => {
    if (this.pairHourTimer) {
      clearInterval(this.pairHourTimer);
    }
  };

  private startAutoTraining = async () => {
    const unitsForMinutes = "hours";
    const intervalForMinutes = 12;
    const unitsForHours = "hours";
    const intervalForHours = 24;
    log(
      `[**] Minute Model would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`,
      Colors.GREEN
    );

    log(
      `[**] Hourly Model would be auto-updated each ${intervalForHours} ${unitsForHours}`,
      Colors.GREEN
    );

    const trainDataByMinutes =
      await DigitalOceanStorageService.getTradingHistory("XMR-ETH-minute");
    const trainDataByHours = await DigitalOceanStorageService.getTradingHistory(
      "XMR-ETH-hours"
    );

    this.pairMinuteTimer = repeatEvent({
      callback: () => this.trainModel("minutePair", trainDataByMinutes),
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });

    this.pairHourTimer = repeatEvent({
      callback: () => this.trainModel("hourlyPair", trainDataByHours),
      units: unitsForHours,
      interval: intervalForHours,
    });
  };

  private createModel = () => {
    const model = tf.sequential();

    model.add(
      tf.layers.dense({ units: 10, activation: "relu", inputShape: [1] })
    );

    model.add(tf.layers.dense({ units: 50, activation: "softmax" }));

    model.add(
      tf.layers.dense({ units: 10, activation: "relu", inputShape: [50] })
    );

    model.add(tf.layers.dense({ units: 1 }));

    model.compile({
      optimizer: tf.train.adam(0.02),
      loss: "meanSquaredError",
    });

    log("[**] New model created", Colors.GREEN);

    return model;
  };

  private loadModels = async () => {
    try {
      log("[*] Loading model from pre-saved file", Colors.GREEN);

      const hourlyModel = await tf.loadLayersModel(
        `${this.baseURL}/${this.hourlyModelCloudDir}/model.json`
      );
      // const hourlyModel = await tf.loadLayersModel(
      //   `file://${this.hourlyModelDir}/model.json`
      // );

      hourlyModel.compile({
        optimizer: tf.train.adam(0.02),
        loss: "meanSquaredError",
      });

      this.hourlyModel = hourlyModel;

      const minuteModel = await tf.loadLayersModel(
        `${this.baseURL}/${this.minuteModelCloudDir}/model.json`
      );
      // const minuteModel = await tf.loadLayersModel(
      //   `file://${this.minuteModelDir}/model.json`
      // );

      minuteModel.compile({
        optimizer: tf.train.adam(0.02),
        loss: "meanSquaredError",
      });

      this.minuteModel = minuteModel;

      log("[**] Model loaded from pre-saved file", Colors.GREEN);
    } catch (error) {
      log(`Error while loading model: ${error}`, Colors.RED);
      log("[**] Creating new model", Colors.GREEN);
      this.hourlyModel = this.createModel();
      this.minuteModel = this.createModel();
    }
  };

  private saveModel = async (modelType: "minutePair" | "hourlyPair") => {
    if (modelType === "minutePair") {
      fse.ensureDirSync(this.minuteModelLocalDir);
      // await this.minuteModel?.save(`${this.baseURL}/${this.hourlyModelDir}`);
      await DigitalOceanStorageService.saveModel(
        this.minuteModelLocalDir,
        this.minuteModelCloudDir,
        modelType
      );
      log("[**] Minute Model saved to file", Colors.GREEN);
    } else if (modelType === "hourlyPair") {
      fse.ensureDirSync(this.hourlyModelLocalDir);
      // await this.hourlyModel?.save(`${this.baseURL}/${this.hourlyModelDir}`);
      await DigitalOceanStorageService.saveModel(
        this.hourlyModelLocalDir,
        this.hourlyModelCloudDir,
        modelType
      );
      log("[**] Hourly Model saved to file", Colors.GREEN);
    }
  };

  public trainModel = async (
    modelType: "minutePair" | "hourlyPair",
    input: ICyptoCompareData[]
  ) => {
    try {
      if (
        (modelType === "hourlyPair" && !this.hourlyModel) ||
        (modelType === "minutePair" && !this.minuteModel)
      ) {
        console.error("Model not initialized");
        return;
      }

      const epochs = 100;
      const batchSize = 2;

      const data = input.map((d) => ({
        time: d.time,
        close: d.close,
      }));

      const startTime = data[0].time;
      const inputs = data.map((d) => [(d.time - startTime) / 60]);
      const outputs = data.map((d) => d.close);

      // Normalize inputs and outputs
      const minClose = Math.min(...outputs);
      const maxClose = Math.max(...outputs);

      const normalizedOutputs = outputs.map(
        (price) => (price - minClose) / (maxClose - minClose)
      );

      const inputTensor = tf.tensor2d(inputs);
      const outputTensor = tf.tensor2d(normalizedOutputs, [
        normalizedOutputs.length,
        1,
      ]);

      log(`[**] Training ${modelType} model`, Colors.GREEN);
      console.time(`${modelType}: Training Time`);
      if (modelType === "hourlyPair") {
        await this.hourlyModel!.fit(inputTensor, outputTensor, {
          shuffle: true,
          epochs,
          batchSize,
          callbacks: {
            onTrainEnd: () => {
              log("[**] Training completed", Colors.GREEN);
              console.timeEnd(`${modelType}: Training Time`);
            },
          },
        });

        await this.saveModel("hourlyPair");
      } else if (modelType === "minutePair") {
        await this.minuteModel!.fit(inputTensor, outputTensor, {
          shuffle: true,
          epochs,
          batchSize,
          callbacks: {
            onTrainEnd: () => {
              log("[**] Training completed", Colors.GREEN);
              console.timeEnd(`${modelType}: Training Time`);
            },
          },
        });

        await this.saveModel("minutePair");
      }
    } catch (error) {
      console.error("Error while training model", error);
    }
  };

  public predictNextPrices = async (input: ICyptoCompareHistoryMinutePair) => {
    if (!this.hourlyModel || !this.minuteModel) {
      console.error("Model not initialized");
      return;
    }

    const data = input.Data.Data.map((d) => ({ time: d.time, close: d.close }));
    const startTime = data[0].time;
    const outputs = data.map((d) => d.close);

    // Normalize inputs and outputs
    const minClose = Math.min(...outputs);
    const maxClose = Math.max(...outputs);

    // Define the future times in minutes since the start
    const futureMinutes = [11, 12, 13]; // Minutes after the last timestamp in the data

    // Convert to tensor
    const futureInputs = tf.tensor2d(futureMinutes.map((minute) => [minute]));

    // Predict and denormalize the results
    const predictionsByMinutes = this.minuteModel.predict(
      futureInputs
    ) as tf.Tensor;
    const predictedPricesByMinutes = predictionsByMinutes
      .dataSync()
      .map((normPrice) => normPrice * (maxClose - minClose) + minClose);

    // Display predictions as time-value pairs with Buy/Sell command
    const predictionResultsByMinutes = futureMinutes.map((minute, index) => {
      const predictedTime = startTime + minute * 60; // Convert back to Unix timestamp
      const predictedValue = predictedPricesByMinutes[index];
      const actualValue = outputs[outputs.length - 1]; // Last known price

      // Determine buy/sell command based on a simple strategy
      const priceChangeThreshold = 0.0005; // 0.05% threshold
      let action: string;
      if ((predictedValue - actualValue) / actualValue > priceChangeThreshold) {
        action = "Buy";
      } else if (
        (actualValue - predictedValue) / actualValue >
        priceChangeThreshold
      ) {
        action = "Sell";
      } else {
        action = "Hold";
      }

      return {
        time: format(predictedTime * 1000, "dd/MM HH:mm"),
        predictedValue,
        action,
      };
    });

    return {
      last5: data.map((d) => ({
        time: format(d.time * 1000, "dd/MM/yyyy hh:mm"),
        close: d.close,
      })),
      predictionResultsByMinutes,
    };
  };
}

export default new TensorflowAI();
