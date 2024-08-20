import { Router } from "express";
import { format } from "date-fns";
import routes from "../config/routes.config";

import CryproCompareService from "../services/CryproCompare.service";
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
    const trainDataByMinutes = await DigitalOceanStorageService.getTradingHistory('XMR-ETH-minute')
    const trainDataByHours = await DigitalOceanStorageService.getTradingHistory('XMR-ETH-hours')

    TensorflowService.trainModel("minutePair", trainDataByMinutes);
    TensorflowService.trainModel("hourlyPair", trainDataByHours);

    res.json({
      status: "ok",
      message: "Training model's started",
    });
  });

  router.get(routes.REST.GET_PREDICTION, async (req, res) => {
    const testHourData = await CryproCompareService.getHourPairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      5
    );
    const predictionByHour = await TensorflowService.predictNextPrices(
      testHourData
    );

    res.json({
      status: "ok",
      message: "Prediction",
      predictionByHour,
    });
  });

  router.get(routes.REST.SAVE_HISTORY, async (req, res) => {
    const trainDataByMinutes = await CryproCompareService.getMinutePairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      2000
    );

    const trainDataByHours = await CryproCompareService.getHourPairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      2000
    );

    const tradingMinuteHistoryLink =
      await DigitalOceanStorageService.pushTradingHistory(
        "XMR-ETH-minute",
        trainDataByMinutes
      );

    const tradingHourlyHistoryLink =
      await DigitalOceanStorageService.pushTradingHistory(
        "XMR-ETH-hours",
        trainDataByHours
      );

    res.json({
      status: "ok",
      message: "Trading history saved",
      tradingMinuteHistoryLink,
      tradingHourlyHistoryLink,
    });
  });

  return router;
};
