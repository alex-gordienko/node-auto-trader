import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import TensorflowService from "./Tensorflow.service";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { CryptoBase } from "../types/basic.types";
import repeatEvent from "../utils/timer";
import { ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";

class CryproCompareService {
  private readonly apiKey: string = cryptoConfig.cryptoCompareApiKey;
  private readonly apiUrl: string = "https://min-api.cryptocompare.com/data/v2";
  private pairMinuteTimer: NodeJS.Timeout | null = null;
  private pairHourTimer: NodeJS.Timeout | null = null;
  private predictionTimer: NodeJS.Timeout | null = null;

  constructor() {
    log("[*] Initializing Crypto Compare Service", Colors.RED);
    this.startAutoUpdate();
    this.startAutoPrediction();
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

  public stopPredictionTimer = () => {
    if (this.predictionTimer) {
      clearInterval(this.predictionTimer);
    }
  };

  private startAutoUpdate = async () => {
    const unitsForMinutes = "hours";
    const intervalForMinutes = 12;
    const unitsForHours = "hours";
    const intervalForHours = 24;
    log(
      `[**] Training dataset for Minute Model would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`,
      Colors.BLUE
    );

    log(
      `[**] Training dataset for Hourly Model would be auto-updated each ${intervalForHours} ${unitsForHours}`,
      Colors.BLUE
    );

    const tradingMinuteHistory = await this.getMinutePairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      2000
    );

    const tradingHourlyHistory = await this.getHourPairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      2000
    );

    this.pairMinuteTimer = repeatEvent({
      callback: () =>
        DigitalOceanStorageService.pushTradingHistory(
          "XMR-ETH-minute",
          tradingMinuteHistory
        ),
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });

    this.pairHourTimer = repeatEvent({
      callback: () =>
        DigitalOceanStorageService.pushTradingHistory(
          "XMR-ETH-hours",
          tradingHourlyHistory
        ),
      units: unitsForHours,
      interval: intervalForHours,
    });
  };

  private startAutoPrediction = async () => {
    const units = "minutes";
    const interval = 2;
    log(
      `[**] Prediction would be auto-updated each ${interval} ${units}`,
      Colors.BLUE
    );

    this.predictionTimer = repeatEvent({
      callback: async () => {
        const testMinuteData = await this.getMinutePairOHLCV(
          CryptoBase.XMR,
          CryptoBase.ETH,
          10
        );

        const predictionByMinute = await TensorflowService.predictNextPrices(
          testMinuteData
        );

        const formattedMinuteResult =
          predictionByMinute?.predictionResultsByMinutes
            .map((r) => `${r.time}: ${r.action}`)
            .join(", ");
        log(
          `Prediction by Minute model: ${formattedMinuteResult}`,
          Colors.BLUE
        );
      },
      units,
      interval,
    });
  };

  public getMinutePairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePair)
  ) => {
    const url = `${this.apiUrl}/histominute`;

    const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
      params: {
        fsym: base,
        tsym: to,
        limit: limit,
        api_key: this.apiKey,
      },
    });

    return response.data;
  };

  public getHourPairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePair)
  ) => {
    const url = `${this.apiUrl}/histohour`;

    const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
      params: {
        fsym: base,
        tsym: to,
        limit: limit,
        api_key: this.apiKey,
      },
    });

    return response.data;
  };
}

export default new CryproCompareService();
