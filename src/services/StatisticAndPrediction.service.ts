import CryptoCompareService from "./CryptoCompare.service";
import CryptoExchangeService from "./CryptoExchange.service";
// import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import DigitalOceanStorageService from "./Local.storage.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import WavesWalletService from "./WavesWallet.service";
import TensorflowService from "./Tensorflow.service";

import cryptoConfig from "../config/crypto.config";
import { Colors, log } from "../utils/colored-console";
import repeatEvent from "../utils/timer";
import { CryptoBase, CryptoExchangeCoins, CryptoPairs } from "../types/basic.types";
import { ICryproExchangeWalletHistory } from "../types/cryptoExchange.types";
import { ICyptoCompareData } from "../types/cryptoCompare.types";

class StatisticAndPredictionService {
  private isAbleToTrade: boolean = true;
  // timers for updating trading history dataset
  private historyMinutePairTimer: NodeJS.Timeout | null = null;

  // timers for prediction and trading
  private tradingTimer: NodeJS.Timeout | null = null;

  // timers for retraining models
  private retrainingMinuteModelTimer: NodeJS.Timeout | null = null;

  private walletETHtimer: NodeJS.Timeout | null = null;

  // closed minute candles kept in memory, so each API call only downloads what is missing
  private candlesCache: Map<CryptoPairs, ICyptoCompareData[]> = new Map();

  constructor() {
    this.autoRetrainModels();
    this.autoUpdateDatasets();

    this.autoTrade();

    this.autoLogWalletBalances();
  }

  public stopAllTimers = () => {
    if (this.historyMinutePairTimer) {
      clearInterval(this.historyMinutePairTimer);
    }
    if (this.tradingTimer) {
      clearInterval(this.tradingTimer);
    }
    if (this.retrainingMinuteModelTimer) {
      clearInterval(this.retrainingMinuteModelTimer);
    }
    if (this.walletETHtimer) {
      clearInterval(this.walletETHtimer);
    }
  };

  private autoUpdateDatasets = async () => {
    const unitsForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.units;
    const intervalForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.interval;

    log(
      `[**] Training datasets for Models would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`,
      Colors.WHITE
    );

    this.historyMinutePairTimer = repeatEvent({
      callback: async () => {
        // usually a no-op or a tiny request: autoTrade keeps the dataset up to date incrementally
        for (const pair of Object.values(CryptoPairs)) {
          await this.syncCandles(pair);
        }
      },
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });
  };

  private autoRetrainModels = async () => {
    const unitsForMinutes = cryptoConfig.autoRetrainingMinuteModelInterval.units;
    const intervalForMinutes = cryptoConfig.autoRetrainingMinuteModelInterval.interval;

    log(`[**] Models would be automatically re-trained each ${intervalForMinutes} ${unitsForMinutes}`, Colors.GREEN);

    this.retrainingMinuteModelTimer = repeatEvent({
      callback: async () => {
        this.isAbleToTrade = false;

        for (const pair of Object.values(CryptoPairs)) {
          const trainData = await DigitalOceanStorageService.getTradingHistory(pair);
          // saved predictions are compared with real prices so the models correct themselves
          const predictionHistory = await DigitalOceanStorageService.getTensorflowPredictionHistory(pair);
          log(
            `[**] Retraining models with dataset length = ${trainData.length}, saved predictions = ${predictionHistory.length}`,
            Colors.GREEN
          );
          await TensorflowService.trainModel(pair, trainData, predictionHistory);
        }

        this.isAbleToTrade = true;
      },
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });
  };

  private autoTrade = async () => {
    const units = cryptoConfig.autoPredictionInterval.units;
    const interval = cryptoConfig.autoPredictionInterval.interval;
    log(`[**] Prediction would be auto-updated each ${interval} ${units}`, Colors.WHITE);

    this.tradingTimer = repeatEvent({
      callback: async () => {
        const trainingDataset: Map<CryptoPairs, ICyptoCompareData[]> = new Map();

        for (const pair of Object.values(CryptoPairs)) {
          const candles = await this.syncCandles(pair);

          if (candles.length < cryptoConfig.cryptoCompare.inferenceCandles / 2) {
            log(`No trading history for ${pair}`, Colors.RED);
            continue;
          }

          trainingDataset.set(pair, candles.slice(-cryptoConfig.cryptoCompare.inferenceCandles));
        }

        const predictionByMinute = await TensorflowService.predictNextPrices(trainingDataset);

        for (const predictionMap of predictionByMinute) {
          const [pair, prediction] = predictionMap;

          await DigitalOceanStorageService.pushTensorflowPredictionHistory(pair, prediction);

          // making swipe due to prediction (THE MOST IMPORTANT PART)
          if (cryptoConfig.environment === "production") {
            const currentPrice = prediction.current_value;
            const predictedPrice = prediction.predicted_value;

            await this.possibleProfit(prediction.predicted_command, currentPrice, predictedPrice, prediction.q_values);

            const ETHBalance = await EtheriumWalletService.getBalance();

            if (!this.isAbleToTrade) {
              log(`[**] Cannot trade now, because models are retraining`, Colors.RED);
              continue;
            } else if (prediction.predicted_command === "Buy") {
              // The lowest amount of ETH (~$15)
              if (ETHBalance >= 0.0056) {
                log(`[**] Buying ETH by USDT`, Colors.GREEN);
                const transaction = await CryptoExchangeService.swapCoins(CryptoBase.USDT, CryptoBase.ETH);

                if (transaction) {
                  await DigitalOceanStorageService.pushTransactionsHistory({
                    from: CryptoBase.USDT,
                    to: CryptoBase.ETH,
                    coins: [CryptoBase.ETH, CryptoBase.USDT],
                    exchangeAPIResponse: transaction.exchangeAPIresponse,
                    transactionResponse: transaction.ethTransaction,
                  });
                }
              } else {
                log(`[**] Cannot buy ETH, because USDT amount is too low (${ETHBalance})`, Colors.RED);
              }
            } else if (prediction.predicted_command === "Sell") {
              // The lowest amount of ETH (~$15)
              if (ETHBalance >= 0.0056) {
                log(`[**] Selling ETH for USDT`, Colors.GREEN);
                const transaction = await CryptoExchangeService.swapCoins(CryptoBase.ETH, CryptoBase.USDT);

                if (transaction) {
                  await DigitalOceanStorageService.pushTransactionsHistory({
                    from: CryptoBase.ETH,
                    to: CryptoBase.USDT,
                    coins: [CryptoBase.ETH, CryptoBase.USDT],
                    exchangeAPIResponse: transaction.exchangeAPIresponse,
                    transactionResponse: transaction.ethTransaction,
                  });
                }
              } else {
                log(`[**] Cannot sell ETH, because ETH amount is too low (${ETHBalance})`, Colors.RED);
              }
            } else {
              log(`[**] No action`, Colors.YELLOW);
            }
          }
        }
      },
      units,
      interval,
    });
  };

  /**
   * Downloads only the minutes missing since the last stored candle (1 API call, up to 2000 rows),
   * saves them to the dataset and returns all cached closed candles, oldest first.
   */
  public syncCandles = async (pair: CryptoPairs): Promise<ICyptoCompareData[]> => {
    let cached = this.candlesCache.get(pair);
    if (!cached) {
      cached = (await DigitalOceanStorageService.getTradingHistory(pair)).sort((a, b) => a.time - b.time);
    }

    const now = Math.floor(Date.now() / 1000);
    const lastTime = cached.length ? cached[cached.length - 1].time : 0;
    const missingMinutes = lastTime
      ? Math.floor((now - lastTime) / 60) - 1
      : cryptoConfig.requestLimitMinutePairModelTraining;

    if (missingMinutes > 0) {
      const base = pair.split("-")[0] as CryptoBase;
      const to = pair.split("-")[1] as CryptoBase;
      // +1 to include the currently open minute, which is dropped below
      const response = await CryptoCompareService.getMinutePairOHLCV(base, to, missingMinutes + 1);

      if (response) {
        // never store the still-open minute: its close would be frozen with a wrong value
        const closed = response.Data.Data.filter((c) => c.time > lastTime && c.time + 60 <= now && c.close > 0);
        if (closed.length) {
          response.Data.Data = closed;
          await DigitalOceanStorageService.pushTradingHistory(pair, response);
          cached = [...cached, ...closed];
        }
      }
    }

    // memory only needs enough for inference; the full history lives in storage
    const keep = Math.max(cryptoConfig.requestLimitMinutePairModelTraining, cryptoConfig.cryptoCompare.inferenceCandles);
    cached = cached.slice(-keep);
    this.candlesCache.set(pair, cached);
    return cached;
  };

  private autoLogWalletBalances = async () => {
    const units = cryptoConfig.autoUpdateWalletBalanceInterval.units;
    const interval = cryptoConfig.autoUpdateWalletBalanceInterval.interval;

    log(`[**] Wallet balance would be auto-updated each ${interval} ${units}`, Colors.CYAN);

    this.walletETHtimer = repeatEvent({
      callback: async () => {
        // get history for statistics
        const walletETHHistory = await DigitalOceanStorageService.getWalletBalanceHistory(CryptoBase.ETH);

        // get current balance
        const balanceETH = await EtheriumWalletService.getBalance();

        const ETHtoUSD = await CryptoCompareService.getCurrentPrice(CryptoBase.ETH, CryptoBase.USDT);
        const USDtoETH = await CryptoCompareService.getCurrentPrice(CryptoBase.USDT, CryptoBase.ETH);

        if (ETHtoUSD === null || USDtoETH === null) {
          log(`Cannot get current price for ETH (${ETHtoUSD}) or USDT (${USDtoETH})`, Colors.RED);
          return;
        }

        if (!balanceETH) {
          log(`Cannot get current balance for ETH (${balanceETH})`, Colors.RED);
          return;
        }

        this.walletAmountStatistic(
          balanceETH,
          walletETHHistory,
          ETHtoUSD,
          USDtoETH
        );

        // push new value to DigitalOcean
        await DigitalOceanStorageService.pushWalletBalanceHistory(CryptoBase.ETH, {
          amount: balanceETH,
          timestamp: new Date().getTime(),
        });
      },
      units,
      interval,
    });
  };

  private walletAmountStatistic = (
    ethBalance: number,
    ethHistory: ICryproExchangeWalletHistory[],
    ethToUSD: number,
    USDtoETH: number
  ): void => {
    try {
      const firstETHamount = ethHistory[0].amount;

      const diffETHsinceStart = ethBalance - firstETHamount;

      const ETHusd = ethBalance * ethToUSD;

      const diffETHusd = diffETHsinceStart * ethToUSD;

      let message = Colors.GREEN + `Balance: ~$${(ETHusd).toFixed(3)} `;

      message += ` | ETH: ${ethBalance.toFixed(5)} ($${ETHusd.toFixed(3)}) `;

      if (diffETHsinceStart > 0) {
        message += Colors.GREEN + ` +${diffETHsinceStart.toFixed(5)} (+${diffETHusd.toFixed(3)} $) since start `;
      } else {
        message += Colors.RED + ` ${diffETHsinceStart.toFixed(5)} (${diffETHusd.toFixed(3)} $) since start `;
      }

      log(message);
    } catch (error) {
      log("Error while calculating wallet statistics", Colors.RED);
      log(error, Colors.RED);
    }
  };

  private possibleProfit = async (
    action: string,
    currentPrice: number,
    predictedPrice: number,
    qValues?: { hold: number; buy: number; sell: number }
  ) => {
    // prices are in USDT already, no extra API calls needed
    // Calculate possible profit for Buy action
    if (action === "Buy") {
      const amountToBuy = await CryptoExchangeService.minimalExchangeAmount(
        CryptoBase.USDT,
        CryptoBase.ETH
      );

      const potentialProfit = (predictedPrice - currentPrice) * amountToBuy;
      log(`[**] Potential profit from buying ETH: ~$${potentialProfit.toFixed(4)}`, Colors.GREEN);
    }

    // Calculate possible profit for Sell action
    if (action === "Sell") {
      const amountToSell = await CryptoExchangeService.minimalExchangeAmount(
        CryptoBase.ETH,
        CryptoBase.USDT
      );

      const potentialProfit = (currentPrice - predictedPrice) * amountToSell;
      log(`[**] Potential profit from selling ETH: ~$${potentialProfit.toFixed(4)}`, Colors.GREEN);
    }

    if (qValues) {
      log(
        `[**] DQN Q-values hold=${qValues.hold.toFixed(5)} buy=${qValues.buy.toFixed(5)} sell=${qValues.sell.toFixed(5)}`,
        Colors.CYAN
      );
    }
  };
}

export default new StatisticAndPredictionService();
