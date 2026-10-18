import { Router } from "express";
import { format } from "date-fns";
import routes from "../config/routes.config";

import TensorflowService from "../services/Tensorflow.service";
import MarketDataService from "../services/MarketData.service";
// import DigitalOceanStorageService from "../services/DigitalOcean.storage.service";
import DigitalOceanStorageService from "../services/Local.storage.service";
import { CryptoPairs } from "../types/basic.types";
import { Colors, log } from "../utils/colored-console";
import { IMarketDataset } from "../types/marketData.types";
import { ITensorflowPrediction } from "../types/cryptoExchange.types";

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
    const datasets: Map<CryptoPairs, IMarketDataset> = new Map();
    const predictionHistory: Map<CryptoPairs, ITensorflowPrediction[]> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      const dataset = await MarketDataService.getTrainingDataset(pair);
      predictionHistory.set(pair, await DigitalOceanStorageService.getTensorflowPredictionHistory(pair));

      if (!dataset.minute.length) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      datasets.set(pair, dataset);
    }

    TensorflowService.trainAllModels(datasets, predictionHistory);

    res.json({
      status: "ok",
      message: "Training model's started",
      ...Object.fromEntries(
        Object.values(CryptoPairs).map((pair) => [pair, datasets.has(pair) ? "Training started" : "No training data"])
      ),
    });
  });

  router.get(routes.REST.GET_PREDICTION, async (req, res) => {
    const datasets: Map<CryptoPairs, IMarketDataset> = new Map();

    for (const pair of Object.values(CryptoPairs)) {
      const dataset = await MarketDataService.getInferenceDataset(pair);

      if (!dataset.minute.length) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      datasets.set(pair, dataset);
    }

    const predictionByMinute = await TensorflowService.predictNextPrices(datasets);

    res.json({
      status: "ok",
      message: "Prediction",
      predictionByMinute,
    });
  });

  router.get(routes.REST.SAVE_HISTORY, async (req, res) => {
    for (const pair of Object.values(CryptoPairs)) {
      // fetches only the missing candles / futures rows and saves them
      await MarketDataService.syncAll(pair);
    }

    res.json({
      status: "ok",
      message: "Market data updated",
    });
  });

  return router;
};
