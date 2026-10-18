import MarketDataService from "./MarketData.service";
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
import { IMarketDataset } from "../types/marketData.types";

// the bot's minimal swap (~$15): smaller ETH balances count as "not in position"
const MIN_SWAP_USD = 15;

class StatisticAndPredictionService {
  private isAbleToTrade: boolean = true;
  // timers for updating trading history dataset
  private historyMinutePairTimer: NodeJS.Timeout | null = null;

  // timers for prediction and trading
  private tradingTimer: NodeJS.Timeout | null = null;

  // timers for retraining models
  private retrainingMinuteModelTimer: NodeJS.Timeout | null = null;

  private walletETHtimer: NodeJS.Timeout | null = null;

  // when the DQN last made a trading decision, per pair: trades happen at most once per rl.decisionMinutes
  private lastDecisionAt: Map<CryptoPairs, number> = new Map();


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
        // usually a no-op or a tiny request: autoTrade keeps the datasets up to date incrementally
        for (const pair of Object.values(CryptoPairs)) {
          await MarketDataService.syncAll(pair);
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
          const dataset = await MarketDataService.getTrainingDataset(pair);
          // saved predictions are compared with real prices so the models correct themselves
          const predictionHistory = await DigitalOceanStorageService.getTensorflowPredictionHistory(pair);
          log(
            `[**] Retraining models: ${dataset.minute.length} minute / ${dataset.hour.length} hour candles, ` +
              `${dataset.futures.length} futures rows, ${predictionHistory.length} saved predictions`,
            Colors.GREEN
          );
          await TensorflowService.trainModel(pair, dataset, predictionHistory);
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
        const datasets: Map<CryptoPairs, IMarketDataset> = new Map();

        for (const pair of Object.values(CryptoPairs)) {
          // incremental update: only candles / futures rows missing since the last call are requested
          const dataset = await MarketDataService.getInferenceDataset(pair);

          if (dataset.minute.length < cryptoConfig.marketData.inferenceCandles / 2) {
            log(`No trading history for ${pair}`, Colors.RED);
            continue;
          }

          datasets.set(pair, dataset);
        }

        // the DQN decides from what the bot actually holds: ETH worth more than the minimal swap = in position
        const positions = new Map<CryptoPairs, { position: number; entryPrice: number }>();
        const ethBalance = await EtheriumWalletService.getBalance();
        for (const [pair, dataset] of datasets) {
          const price = dataset.minute[dataset.minute.length - 1]?.close ?? 0;
          positions.set(pair, { position: ethBalance * price >= MIN_SWAP_USD ? 1 : 0, entryPrice: 0 });
        }

        const predictionByMinute = await TensorflowService.predictNextPrices(datasets, positions);

        for (const predictionMap of predictionByMinute) {
          const [pair, prediction] = predictionMap;

          await DigitalOceanStorageService.pushTensorflowPredictionHistory(pair, prediction);

          // making swipe due to prediction (THE MOST IMPORTANT PART)
          if (cryptoConfig.environment === "production") {
            const currentPrice = prediction.current_value;
            const predictedPrice = prediction.predicted_value;

            await this.possibleProfit(prediction.predicted_command, currentPrice, predictedPrice, prediction.q_values);

            const ETHBalance = await EtheriumWalletService.getBalance();
            const position = prediction.position ?? 0;
            const sinceDecision = Date.now() - (this.lastDecisionAt.get(pair) ?? 0);

            if (!this.isAbleToTrade) {
              log(`[**] Cannot trade now, because models are retraining`, Colors.RED);
              continue;
            } else if (sinceDecision < cryptoConfig.rl.decisionMinutes * 60 * 1000 - 30 * 1000) {
              // predictions are saved every run for self-correction, but trades follow the DQN's training cadence
              log(`[**] Next trading decision in ${Math.ceil((cryptoConfig.rl.decisionMinutes * 60 * 1000 - sinceDecision) / 60000)} min`, Colors.YELLOW);
              continue;
            }

            this.lastDecisionAt.set(pair, Date.now());

            if (prediction.predicted_command === "Buy") {
              // buy only when not holding ETH yet (the USDT balance is checked by the exchange)
              if (position === 0) {
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
                log(`[**] Already holding ETH (${ETHBalance}), nothing to buy`, Colors.YELLOW);
              }
            } else if (prediction.predicted_command === "Sell") {
              if (position === 1) {
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

        const ETHtoUSD = await MarketDataService.getCurrentPrice(CryptoBase.ETH, CryptoBase.USDT);
        const USDtoETH = await MarketDataService.getCurrentPrice(CryptoBase.USDT, CryptoBase.ETH);

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
