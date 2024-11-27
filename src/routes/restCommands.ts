import { Router } from "express";
import { format } from "date-fns";
import routes from "../config/routes.config";

import CryptoCompareService from "../services/CryptoCompare.service";
import TensorflowService from "../services/Tensorflow.service";
// import DigitalOceanStorageService from "../services/DigitalOcean.storage.service";
import DigitalOceanStorageService from "../services/Local.storage.service";
import { CryptoBase } from "../types/basic.types";
import { mergeDatasets } from "../utils/mergeDatasets";
import { Colors, log } from "../utils/colored-console";

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
    let modelName = req.query.modelName as "WAVES-ETH" | "WAVES-USD" | "ETH-USD";

    console.log("modelName", modelName);

    if (!modelName || !["WAVES-ETH", "WAVES-USD", "ETH-USD"].includes(modelName)) {
      modelName = "WAVES-ETH";
    }
    const trainData = await DigitalOceanStorageService.getTradingHistory(modelName);

    log(`[**] Retraining models with dataset length = ${trainData.length}`, Colors.GREEN);

    TensorflowService.trainModel(modelName, trainData);

    res.json({
      status: "ok",
      modelName,
      message: "Training model's started",
      datasetLength: trainData.length,
      last10DatasetElements: trainData.slice(-10),
    });
  });

  router.get(routes.REST.GET_PREDICTION, async (req, res) => {
    const trainDataWAVES_ETH = await CryptoCompareService.getMinutePairOHLCV(CryptoBase.WAVES, CryptoBase.ETH, 50);

    const trainDataWAVES_USD = await CryptoCompareService.getMinutePairOHLCV(CryptoBase.WAVES, CryptoBase.USD, 50);
    const trainDataETH_USD = await CryptoCompareService.getMinutePairOHLCV(CryptoBase.ETH, CryptoBase.USD, 50);

    if (!trainDataWAVES_ETH || !trainDataWAVES_USD || !trainDataETH_USD) {
      res.json({
        status: "error",
        message: "Error getting test data",
      });
      return;
    }

    const formattedTrainData = mergeDatasets([
      trainDataWAVES_ETH.Data.Data,
      trainDataWAVES_USD.Data.Data,
      trainDataETH_USD.Data.Data,
    ]);

    const predictionByMinute = await TensorflowService.predictNextPrices(formattedTrainData);

    res.json({
      status: "ok",
      message: "Prediction",
      predictionByMinute,
    });
  });

  router.get(routes.REST.SAVE_HISTORY, async (req, res) => {
    const trainDataWAVES_ETH = await CryptoCompareService.getMinutePairOHLCV(CryptoBase.WAVES, CryptoBase.ETH, 2000);
    const trainDataWAVES_USD = await CryptoCompareService.getMinutePairOHLCV(CryptoBase.WAVES, CryptoBase.USD, 2000);

    const trainDataETH_USD = await CryptoCompareService.getMinutePairOHLCV(CryptoBase.ETH, CryptoBase.USD, 2000);

    if (!trainDataWAVES_ETH || !trainDataWAVES_USD || !trainDataETH_USD) {
      res.json({
        status: "error",
        message: "Error getting train data",
      });
      return;
    }

    const WAVES_ETH_HistoryLink = await DigitalOceanStorageService.pushTradingHistory(
      "WAVES-ETH",
      trainDataWAVES_ETH
    );

    const WAVES_USD_HistoryLink = await DigitalOceanStorageService.pushTradingHistory("WAVES-USD", trainDataWAVES_USD);
    const ETH_USD_HistoryLink = await DigitalOceanStorageService.pushTradingHistory("ETH-USD", trainDataETH_USD);

    res.json({
      status: "ok",
      message: "Trading history saved",
      WAVES_ETH_HistoryLink,
      WAVES_USD_HistoryLink,
      ETH_USD_HistoryLink,
    });
  });

  return router;
};
