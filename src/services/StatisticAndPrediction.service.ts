import CryptoCompareService from "./CryptoCompare.service";
import CryptoExchangeService from "./CryptoExchange.service";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import WavesWalletService from "./WavesWallet.service";
import TensorflowService from "./Tensorflow.service";

import cryptoConfig from "../config/crypto.config";
import { Colors, log } from "../utils/colored-console";
import repeatEvent from "../utils/timer";
import { CryptoBase, CryptoExchangeCoins } from "../types/basic.types";
import { ICryproExchangeWalletHistory } from "../types/cryptoExchange.types";

class StatisticAndPredictionService {
  // timers for updating trading history dataset
  private historyMinutePairTimer: NodeJS.Timeout | null = null;

  // timers for prediction and trading
  private tradingTimer: NodeJS.Timeout | null = null;

  // timers for retraining models
  private retrainingMinuteModelTimer: NodeJS.Timeout | null = null;

  private walletETHtimer: NodeJS.Timeout | null = null;
  private walletWAVEStimer: NodeJS.Timeout | null = null;

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
    if (this.walletWAVEStimer) {
      clearInterval(this.walletWAVEStimer);
    }
  };

  private autoUpdateDatasets = async () => {
    const unitsForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.units;
    const intervalForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.interval;

    log(
      `[**] Training dataset for Minute Model would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`,
      Colors.WHITE
    );

    this.historyMinutePairTimer = repeatEvent({
      callback: async () => {
        const tradingMinuteHistory = await CryptoCompareService.getMinutePairOHLCV(
          CryptoBase.WAVES,
          CryptoBase.ETH,
          cryptoConfig.requestLimitMinutePairModelTraining
        );

        if (!tradingMinuteHistory) { 
          log("No trading history for minute pair", Colors.RED);
          return;
        }

        DigitalOceanStorageService.pushTradingHistory("WAVES-ETH-minute", tradingMinuteHistory);
      },
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });
  };

  private autoRetrainModels = async () => {
    const unitsForMinutes = cryptoConfig.autoRetrainingMinuteModelInterval.units;
    const intervalForMinutes = cryptoConfig.autoRetrainingMinuteModelInterval.interval;

    log(`[**] Minute Model would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`, Colors.GREEN);

    this.retrainingMinuteModelTimer = repeatEvent({
      callback: async () => {
        const trainDataByMinutes = await DigitalOceanStorageService.getTradingHistory("WAVES-ETH-minute");

        TensorflowService.trainModel("minutePair", trainDataByMinutes);
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
        const testMinuteData = await CryptoCompareService.getMinutePairOHLCV(
          CryptoBase.WAVES,
          CryptoBase.ETH,
          cryptoConfig.requestLimitMinutePairPrediction
        );

        if (!testMinuteData) {
          log("No trading history for minute pair", Colors.RED);
          return;
        }

        const predictionByMinute = await TensorflowService.predictNextPrices(testMinuteData.Data.Data);

        if (!predictionByMinute) {
          log("Prediction by Minute model: No prediction", Colors.RED);
          return;
        }


        const currentPrice = testMinuteData.Data.Data[testMinuteData.Data.Data.length - 1].close;
        const predictedPrice = predictionByMinute[0].predictedValue;

        await this.possibleProfit(
          predictionByMinute[0].command,
          currentPrice,
          predictedPrice
        );

        const ETHBalance = await EtheriumWalletService.getBalance();
        const WAVESBalance = await WavesWalletService.getBalance();

        // making swipe due to prediction (THE MOST IMPORTANT PART)
        if (cryptoConfig.environment === "production") {
          if (predictionByMinute[0].command === "Buy") {
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
          } else if (predictionByMinute[0].command === "Sell") {
            // The lowest amount of WAVES (~$15)
            if (WAVESBalance >= 14.423) {
              log(`[**] Seling WAVES`, Colors.GREEN);
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

  private autoLogWalletBalances = async () => {
    const units = cryptoConfig.autoUpdateWalletBalanceInterval.units;
    const interval = cryptoConfig.autoUpdateWalletBalanceInterval.interval;

    log(`[**] Wallet balance would be auto-updated each ${interval} ${units}`, Colors.CYAN);

    this.walletETHtimer = repeatEvent({
      callback: async () => {
        // get history for statistics
        const walletETHHistory = await DigitalOceanStorageService.getWalletBalanceHistory(CryptoBase.ETH);
        const walletWAVESHistory = await DigitalOceanStorageService.getWalletBalanceHistory(CryptoBase.WAVES);

        // get current balance
        const balanceETH = await EtheriumWalletService.getBalance();
        const balanceWAVES = await WavesWalletService.getBalance();

        const ETHtoUSD = await CryptoCompareService.getCurrentPrice(CryptoBase.ETH, CryptoBase.USD);
        const WAVEStoUSD = await CryptoCompareService.getCurrentPrice(CryptoBase.WAVES, CryptoBase.USD);

        if (!ETHtoUSD || !WAVEStoUSD) { 
          log("Cannot get current price for ETH or WAVES", Colors.RED);
          return;
        }

        this.walletAmountStatistic(
          balanceETH,
          walletETHHistory,
          balanceWAVES,
          walletWAVESHistory,
          ETHtoUSD,
          WAVEStoUSD
        );

        // push new value to DigitalOcean
        await DigitalOceanStorageService.pushWalletBalanceHistory(CryptoBase.ETH, {
          amount: balanceETH,
          timestamp: new Date().getTime(),
        });

        await DigitalOceanStorageService.pushWalletBalanceHistory(CryptoBase.WAVES, {
          amount: balanceWAVES,
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
    wavesBalance: number,
    wavesHistory: ICryproExchangeWalletHistory[],
    ethToUSD: number,
    wavesToUSD: number
  ): void => {
    const firstETHamount = ethHistory[0].amount;
    const firstWAVESamount = wavesHistory[0].amount;

    const diffETHsinceStart = ethBalance - firstETHamount;
    const diffWAVESsinceStart = wavesBalance - firstWAVESamount;

    const ETHusd = ethBalance * ethToUSD;
    const WAVESusd = wavesBalance * wavesToUSD;

    const diffETHusd = diffETHsinceStart * ethToUSD;
    const diffWAVESusd = diffWAVESsinceStart * wavesToUSD;

    let message = Colors.GREEN + `Balance: ~$${(ETHusd + WAVESusd).toFixed(3)} `;

    message += ` | ETH: ${ethBalance.toFixed(5)} ($${ETHusd.toFixed(3)}) `;

    if (diffETHsinceStart > 0) {
      message += Colors.GREEN + ` +${diffETHsinceStart.toFixed(5)} (+${diffETHusd.toFixed(3)} $) since start `;
    } else {
      message += Colors.RED + ` ${diffETHsinceStart.toFixed(5)} (${diffETHusd.toFixed(3)} $) since start `;
    }

    message += Colors.GREEN + ` | WAVES: ${wavesBalance.toFixed(5)} ($${WAVESusd.toFixed(3)}) `;

    if (diffWAVESsinceStart > 0) {
      message += Colors.GREEN + ` +${diffWAVESsinceStart.toFixed(5)} (+${diffWAVESusd.toFixed(3)} $) since start `;
    } else {
      message += Colors.RED + ` ${diffWAVESsinceStart.toFixed(5)} (${diffWAVESusd.toFixed(3)} $) since start `;
    }

    log(message);
  };

  private possibleProfit = async (action: string, currentPrice: number, predictedPrice: number) => {
    const ETHtoUSD = await CryptoCompareService.getCurrentPrice(CryptoBase.ETH, CryptoBase.USD);
    const WAVEStoUSD = await CryptoCompareService.getCurrentPrice(CryptoBase.WAVES, CryptoBase.USD);

    if (!ETHtoUSD || !WAVEStoUSD) { 
      log("Cannot get current price for ETH or WAVES", Colors.RED);
      return;
    }

    // Calculate possible profit for Buy action
    if (action === "Buy") {
      const amountToBuy = await CryptoExchangeService.minimalExchangeAmount(
        CryptoExchangeCoins.ETH,
        CryptoExchangeCoins.WAVES
      );

      const potentialProfit = (predictedPrice - currentPrice) * amountToBuy;
      const profitInUSD = potentialProfit * WAVEStoUSD;
      log(
        `[**] Potential profit from buying WAVES: ${potentialProfit} ($${profitInUSD})`,
        Colors.GREEN
      );
    }

    // Calculate possible profit for Sell action
    if (action === "Sell") {
      const amountToSell = await CryptoExchangeService.minimalExchangeAmount(
        CryptoExchangeCoins.WAVES,
        CryptoExchangeCoins.ETH
      );

      const potentialProfit = (currentPrice - predictedPrice) * amountToSell;
      const profitInUSD = potentialProfit * ETHtoUSD;
      log(
        `[**] Potential profit from selling WAVES: ${potentialProfit} ($${profitInUSD})`,
        Colors.GREEN
      );
    }
  };
}

export default new StatisticAndPredictionService();
