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
import WavesWalletService from "./WavesWallet.service";

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
    const unitsForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.units;
    const intervalForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.interval;
    const unitsForHours = cryptoConfig.autoDatasetForHourModelUpdateInterval.units;
    const intervalForHours = cryptoConfig.autoDatasetForHourModelUpdateInterval.interval;
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
        const tradingMinuteHistory = await this.getMinutePairOHLCV(
          CryptoBase.WAVES,
          CryptoBase.ETH,
          cryptoConfig.requestLimitMinutePairModelTraining
        );

        DigitalOceanStorageService.pushTradingHistory("WAVES-ETH-minute", tradingMinuteHistory);
      },
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });

    this.pairHourTimer = repeatEvent({
      callback: async () => {
        const tradingHourlyHistory = await this.getHourPairOHLCV(
          CryptoBase.WAVES,
          CryptoBase.ETH,
          cryptoConfig.requestLimitMinutePairModelTraining
        );

        DigitalOceanStorageService.pushTradingHistory("WAVES-ETH-hours", tradingHourlyHistory);
      },
      units: unitsForHours,
      interval: intervalForHours,
    });
  };

  private startAutoPrediction = async () => {
    const units = cryptoConfig.autoPredictionInterval.units;
    const interval = cryptoConfig.autoPredictionInterval.interval;
    log(`[**] Prediction would be auto-updated each ${interval} ${units}`, Colors.WHITE);

    this.predictionTimer = repeatEvent({
      callback: async () => {
        const testMinuteData = await this.getMinutePairOHLCV(
          CryptoBase.WAVES,
          CryptoBase.ETH,
          cryptoConfig.requestLimitMinutePairPrediction
        );

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
        const WAVESBalance = await WavesWalletService.getBalance();

        // making swipe due to prediction (THE MOST IMPORTANT PART)
        if (cryptoConfig.environment === "production") {
          if (predictionByMinute.predictionResultsByMinutes[0].action === "Sell") {
            // The lowest amount of ETH (~$15)
            if (ETHBalance >= 0.0056) {
              log(`[**] Buying WAVES`, Colors.GREEN);
              const transaction = await CryptoExchangeService.changeETHtoWAVES();

              if (transaction) {
                await DigitalOceanStorageService.pushTransactionsHistory({
                  from: CryptoBase.ETH,
                  to: CryptoBase.WAVES,
                  coins: [CryptoBase.ETH, CryptoBase.WAVES],
                  exchangeAPIResponse: transaction.exchangeAPIresponse,
                  transactionResponse: transaction.ethTransaction,
                });
              }
              
            } else {
              log(`[**] Cannot buy WAVES, because ETH amount is too low (${ETHBalance})`, Colors.RED);
            }
          } else if (predictionByMinute.predictionResultsByMinutes[0].action === "Buy") {
            // The lowest amount of WAVES (~$15)
            if (WAVESBalance >= 14.423) {
              log(`[**] Selling WAVES`, Colors.GREEN);
              const transaction = await CryptoExchangeService.changeWAVEStoETH();

              if (transaction) {
                await DigitalOceanStorageService.pushTransactionsHistory({
                  from: CryptoBase.WAVES,
                  to: CryptoBase.ETH,
                  coins: [CryptoBase.ETH, CryptoBase.WAVES],
                  exchangeAPIResponse: transaction.exchangeAPIresponse,
                  transactionResponse: transaction.wavesTransaction,
                });
              }
            } else {
              log(`[**] Cannot buy ETH, because WAVES amount is too low (${WAVESBalance})`, Colors.RED);
            }
          } else {
            log(`[**] No action`, Colors.YELLOW);
          }
        }
      },
      units,
      interval,
    });
  };

  public getMinutePairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePairPrediction)
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
    limit: number = Number(cryptoConfig.requestLimitMinutePairModelTraining)
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

  private calculatePredictedProfit = async () => {};
}

export default new CryproCompareService();
