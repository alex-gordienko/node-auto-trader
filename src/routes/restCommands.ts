import { Router } from "express";
import { format } from "date-fns";
import routes from "../config/routes.config";

import CryptoCompareService from "../services/CryptoCompare.service";
import TensorflowService from "../services/Tensorflow.service";
// import DigitalOceanStorageService from "../services/DigitalOcean.storage.service";
import DigitalOceanStorageService from "../services/Local.storage.service";
import { CryptoBase, CryptoPairs } from "../types/basic.types";
import { Colors, log } from "../utils/colored-console";
import { ICyptoCompareData } from "../types/cryptoCompare.types";
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

    for (const pair of Object.values(CryptoPairs)) {
      const trainData = await DigitalOceanStorageService.getTradingHistory(pair);

      if (!trainData) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      trainingDataset.set(pair, trainData);
    }

    TensorflowService.trainAllModels(trainingDataset);

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
      const base = pair.split("-")[0] as CryptoBase;
      const to = pair.split("-")[1] as CryptoBase;

      const trainData = await CryptoCompareService.getMinutePairOHLCV(base, to, 200);

      if (!trainData) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      trainingDataset.set(pair, trainData.Data.Data);
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
      const base = pair.split("-")[0] as CryptoBase;
      const to = pair.split("-")[1] as CryptoBase;

      const tradingHistory = await CryptoCompareService.getMinutePairOHLCV(
        base,
        to,
        cryptoConfig.requestLimitMinutePairModelTraining
      );

      if (!tradingHistory) {
        log(`No trading history for ${pair}`, Colors.RED);
        continue;
      }

      const link = await DigitalOceanStorageService.pushTradingHistory(pair, tradingHistory);

      links.set(pair, link || "Not saved");
    }

    res.json({
      status: "ok",
      message: "Trading history saved",
      ...Object.fromEntries(links),
    });
  });

  return router;
};
