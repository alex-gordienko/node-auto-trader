import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import TensorflowService from "./Tensorflow.service";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { CryptoBase } from "../types/basic.types";
import repeatEvent from "../utils/timer";
import { ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";
import { format } from "date-fns";
import CryptoExchangeService from "./CryptoExchange.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import MoneroWalletService from "./MoneroWallet.service";

class CryproCompareService {
  private readonly apiKey: string = cryptoConfig.cryptoCompareApiKey;
  private readonly apiUrl: string = "https://min-api.cryptocompare.com/data/v2";
  private pairMinuteTimer: NodeJS.Timeout | null = null;
  private pairHourTimer: NodeJS.Timeout | null = null;
  private predictionTimer: NodeJS.Timeout | null = null;

  constructor() {
    log("[*] Initializing Crypto Compare Service", Colors.WHITE);
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
      Colors.WHITE
    );

    log(
      `[**] Training dataset for Hourly Model would be auto-updated each ${intervalForHours} ${unitsForHours}`,
      Colors.WHITE
    );

    this.pairMinuteTimer = repeatEvent({
      callback: async () => {
        const tradingMinuteHistory = await this.getMinutePairOHLCV(CryptoBase.XMR, CryptoBase.ETH, 2000);

        DigitalOceanStorageService.pushTradingHistory("XMR-ETH-minute", tradingMinuteHistory);
      },
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });

    this.pairHourTimer = repeatEvent({
      callback: async () => {
        const tradingHourlyHistory = await this.getHourPairOHLCV(CryptoBase.XMR, CryptoBase.ETH, 2000);

        DigitalOceanStorageService.pushTradingHistory("XMR-ETH-hours", tradingHourlyHistory);
      },
      units: unitsForHours,
      interval: intervalForHours,
    });
  };

  private startAutoPrediction = async () => {
    const units = "minutes";
    const interval = 10;
    log(`[**] Prediction would be auto-updated each ${interval} ${units}`, Colors.WHITE);

    this.predictionTimer = repeatEvent({
      callback: async () => {
        const testMinuteData = await this.getMinutePairOHLCV(CryptoBase.XMR, CryptoBase.ETH, 10);

        const predictionByMinute = await TensorflowService.predictNextPrices(testMinuteData);

        if (!predictionByMinute) {
          log("Prediction by Minute model: No prediction", Colors.RED);
          return;
        }

        const formattedMinuteResult = predictionByMinute.predictionResultsByMinutes
          .map((r) => `${format(r.time * 1000, "dd/MM/yyyy hh:mm")}: ${r.action} (${r.predictedValue})`)
          .join(", ");

        log(`Prediction by Minute model: ${formattedMinuteResult}`, Colors.WHITE);

        const ETHBalance = await EtheriumWalletService.getBalance();
        const XMRBalance = await MoneroWalletService.getBalance();

        // making swipe due to prediction (THE MOST IMPORTANT PART)
        if (predictionByMinute.predictionResultsByMinutes[0].action === "Buy") {
          // The lowest amount of ETH (~$15)
          if (ETHBalance >= 0.0056) {
            log(`[**] Buying XMR`, Colors.GREEN);
            await CryptoExchangeService.changeETHtoXMR();
          } else {
            log(`[**] Cannot buy XMR, because ETH amount is too low (${ETHBalance})`, Colors.RED);
          }
        } else if (predictionByMinute.predictionResultsByMinutes[0].action === "Sell") {
          // The lowest amount of XMR (~$15)
          if (XMRBalance >= 0.093) {
            log(`[**] Selling XMR`, Colors.GREEN);
            await CryptoExchangeService.changeXMRtoETH();
          } else {
            log(`[**] Cannot buy ETH, because XMR amount is too low (${XMRBalance})`, Colors.RED);
          }
        } else {
          log(`[**] No action`, Colors.YELLOW);
        }
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
