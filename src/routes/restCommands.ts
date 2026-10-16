import { Router } from "express";
import { format } from "date-fns";
import routes from "../config/routes.config";

import TensorflowService from "../services/Tensorflow.service";
import StatisticAndPredictionService from "../services/StatisticAndPrediction.service";
// import DigitalOceanStorageService from "../services/DigitalOcean.storage.service";
import DigitalOceanStorageService from "../services/Local.storage.service";
import { CryptoPairs } from "../types/basic.types";
import { Colors, log } from "../utils/colored-console";
import { ICyptoCompareData } from "../types/cryptoCompare.types";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";
import cryptoConfig from "../config/crypto.config";

export default () => {
  const router = Router();

  router.get(routes.REST.HEALTH, (req, res) => {
    const now = new Date();
    res.json({
      status: "ok",
      date: format(now, "yyyy-MM-dd HH:mm:ss"),
    });
  });

  router.get(routes.REST.LEARN_TENSORFLOW, async (req, res) => {
    const trainingDataset: Map<CryptoPairs, ICyptoCompareData[]> = new Map();
    const predictionHistory: Map<CryptoPairs, ITensorflowPrediction[]> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      const trainData = await DigitalOceanStorageService.getTradingHistory(pair);
      predictionHistory.set(pair, await DigitalOceanStorageService.getTensorflowPredictionHistory(pair));

      if (!trainData) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      trainingDataset.set(pair, trainData);
    }

    TensorflowService.trainAllModels(trainingDataset, predictionHistory);

    res.json({
      status: "ok",
      message: "Training model's started",
      ...Object.fromEntries(
        Object.values(CryptoPairs).map((pair) => [
          pair,
          trainingDataset.has(pair) ? "Training started" : "No training data",
        ])
      ),
    });
  });

  router.get(routes.REST.GET_PREDICTION, async (req, res) => {
    const trainingDataset: Map<CryptoPairs, ICyptoCompareData[]> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      const candles = await StatisticAndPredictionService.syncCandles(pair);

      if (!candles.length) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      trainingDataset.set(pair, candles.slice(-cryptoConfig.cryptoCompare.inferenceCandles));
    }

    const predictionByMinute = await TensorflowService.predictNextPrices(trainingDataset);

    res.json({
      status: "ok",
      message: "Prediction",
      predictionByMinute,
    });
  });

  router.get(routes.REST.SAVE_HISTORY, async (req, res) => {
    const links: Map<CryptoPairs, string> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      // fetches only the missing minutes and saves them to the dataset
      const candles = await StatisticAndPredictionService.syncCandles(pair);

      links.set(pair, candles.length ? `datasets/${pair}-trading-history.json` : "Not saved");
    }

    res.json({
      status: "ok",
      message: "Trading history saved",
      ...Object.fromEntries(links),
    });
  });

  return router;
};
