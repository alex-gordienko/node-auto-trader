import { Router } from "express";
import { format } from "date-fns";
import routes from "../config/routes.config";

import CryproCompareService from "../services/CryptoCompare.service";
import TensorflowService from "../services/Tensorflow.service";
import DigitalOceanStorageService from "../services/DigitalOcean.storage.service";
import { CryptoBase } from "../types/basic.types";

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
    const trainDataByMinutes = await DigitalOceanStorageService.getTradingHistory("WAVES-ETH-minute");

    TensorflowService.trainModel("minutePair", trainDataByMinutes);

    res.json({
      status: "ok",
      message: "Training model's started",
    });
  });

  router.get(routes.REST.GET_PREDICTION, async (req, res) => {
    const testHourData = await CryproCompareService.getMinutePairOHLCV(CryptoBase.WAVES, CryptoBase.ETH, 5);
    if (!testHourData) { 
      res.json({
        status: "error",
        message: "Error getting test data",
      });
      return;
    }
    const predictionByMinute = await TensorflowService.predictNextPrices(testHourData.Data.Data);

    res.json({
      status: "ok",
      message: "Prediction",
      predictionByMinute,
    });
  });

  router.get(routes.REST.SAVE_HISTORY, async (req, res) => {
    const trainDataByMinutes = await CryproCompareService.getMinutePairOHLCV(CryptoBase.WAVES, CryptoBase.ETH, 2000);
    if (!trainDataByMinutes) {
      res.json({
        status: "error",
        message: "Error getting train data",
      });
      return;
    }

    const tradingMinuteHistoryLink = await DigitalOceanStorageService.pushTradingHistory(
      "WAVES-ETH-minute",
      trainDataByMinutes
    );

    res.json({
      status: "ok",
      message: "Trading history saved",
      tradingMinuteHistoryLink,
    });
  });

  return router;
};
