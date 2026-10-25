import MarketDataService from "./collectors/MarketData.service";
// import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import DigitalOceanStorageService from "./Local.storage.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import TensorflowService from "./Tensorflow.service";
import RebalanceService from "./Rebalance.service";
import VoteTraderService from "./VoteTrader.service";
import HorizonTraderService from "./HorizonTrader.service";
import BinanceExecutionService from "./BinanceExecution.service";

import cryptoConfig from "../config/crypto.config";
import { Colors, log } from "../utils/colored-console";
import repeatEvent from "../utils/timer";
import { CryptoBase, CryptoPairs } from "../types/basic.types";
import { ICryproExchangeWalletHistory } from "../types/cryptoExchange.types";
import { IMarketDataset } from "../types/marketData.types";

class StatisticAndPredictionService {
  // models are retrained on copies and swapped in when ready, so trading never pauses; this only
  // prevents a second retraining from starting while the previous one is still running
  private isRetraining = false;
  // timers for updating trading history dataset
  private historyMinutePairTimer: NodeJS.Timeout | null = null;

  // timers for prediction and trading
  private tradingTimer: NodeJS.Timeout | null = null;

  // timers for retraining models
  private retrainingMinuteModelTimer: NodeJS.Timeout | null = null;

  private walletETHtimer: NodeJS.Timeout | null = null;

  // timer of the trend-vote strategy (paper trading)
  private rebalanceTimer: NodeJS.Timeout | null = null;

  // timer of the horizon-search candidates (paper trading)
  private horizonTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.autoUpdateDatasets();
    this.logExecution();
    this.autoRebalance();
    this.autoHorizon();
    this.autoLogWalletBalances();

    if (!cryptoConfig.modelsEnabled) {
      log(`[**] Neural networks are off (MODELS_ENABLED=false): no predictions or retraining, market data is still collected`, Colors.YELLOW);
      return;
    }
    this.autoRetrainModels();
    this.autoTrade();
    this.trainIfNoModels();
  }

  /**
   * A fresh server (or a model layout change) starts without trained models: train right away instead of
   * waiting for the retraining schedule. Trading stays off for those pairs until training succeeds.
   */
  private trainIfNoModels = async () => {
    await TensorflowService.ready;
    const untrained = Object.values(CryptoPairs).filter((pair) => !TensorflowService.isTrained(pair));
    if (!untrained.length) return;
    log(`[**] No trained models for ${untrained.join(", ")}: downloading history and training now`, Colors.YELLOW);
    await this.retrainAll();
  };

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
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer);
    }
    if (this.horizonTimer) {
      clearInterval(this.horizonTimer);
    }
  };

  private autoUpdateDatasets = async () => {
    const unitsForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.units;
    const intervalForMinutes = cryptoConfig.autoDatasetForMinuteModelUpdateInterval.interval;

    log(
      `[**] Training datasets for Models would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`,
      Colors.WHITE
    );

    // only the rows missing since the last update are requested (with the models on, autoTrade does it every few minutes)
    const sync = async () => {
      for (const pair of Object.values(CryptoPairs)) {
        await MarketDataService.syncAll(pair);
      }
    };
    const safeSync = () => sync().catch((error) => log(`[**] Dataset update failed: ${error}`, Colors.RED));
    // without the models nothing else updates the datasets: once at start too, so short runs keep the history whole
    if (!cryptoConfig.modelsEnabled) safeSync();
    this.historyMinutePairTimer = repeatEvent({
      callback: safeSync,
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });
  };

  private retrainAll = async () => {
    if (this.isRetraining) {
      log(`[**] Previous retraining is still running, skipping this one`, Colors.YELLOW);
      return;
    }
    this.isRetraining = true;

    try {
      for (const pair of Object.values(CryptoPairs)) {
        // brings the history up to date first (on a fresh server this downloads it)
        await MarketDataService.syncAll(pair);
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
    } catch (error) {
      log(`[**] Retraining failed: ${error}`, Colors.RED);
    } finally {
      this.isRetraining = false;
    }
  };

  private autoRetrainModels = async () => {
    const unitsForMinutes = cryptoConfig.autoRetrainingMinuteModelInterval.units;
    const intervalForMinutes = cryptoConfig.autoRetrainingMinuteModelInterval.interval;

    log(`[**] Models would be automatically re-trained each ${intervalForMinutes} ${unitsForMinutes}`, Colors.GREEN);

    this.retrainingMinuteModelTimer = repeatEvent({
      callback: () => this.retrainAll(),
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

        // the DQN decides from the position of its shadow paper portfolio (see Rebalance.service)
        const predictionByMinute = await TensorflowService.predictNextPrices(datasets, RebalanceService.dqnPositions());

        for (const [pair, prediction] of predictionByMinute) {
          await DigitalOceanStorageService.pushTensorflowPredictionHistory(pair, prediction);
          // the 50/50 rule trades; the DQN only moves its shadow portfolio, to compare the two on live data
          if (TensorflowService.isTrained(pair)) RebalanceService.followDqn(pair, prediction.predicted_command, prediction.current_value);
        }
      },
      units,
      interval,
    });
  };

  /** The BTC + ETH trend vote on paper: checked at start and every vote.checkMinutes; errors never stop the server. */
  private autoRebalance = () => {
    const { checkMinutes, stepDays } = cryptoConfig.vote;
    log(`[**] BTC+ETH trend vote (paper): checked every ${checkMinutes} min, decided every ${stepDays} days after 00:00 UTC`, Colors.CYAN);
    const check = () => VoteTraderService.check().catch((error) => log(`[**] Vote check failed: ${error}`, Colors.RED));
    check();
    this.rebalanceTimer = repeatEvent({ callback: check, units: "minutes", interval: checkMinutes });
  };

  /** EXECUTION_MODE=testnet: says where orders go and what the account holds; a refused URL or missing keys are shown here. */
  private logExecution = async () => {
    if (!BinanceExecutionService.enabled) return log(`[**] Execution: paper only (EXECUTION_MODE=paper), no orders are sent`, Colors.CYAN);
    const refused = BinanceExecutionService.refusal();
    if (refused) return log(`[**] Execution: testnet orders are OFF — ${refused}`, Colors.RED);
    try {
      const b = await BinanceExecutionService.balances(["USDT", "BTC", "ETH", "BNB"]);
      log(`[**] Execution: paper fills are mirrored on ${cryptoConfig.execution.baseUrl} (${cryptoConfig.execution.orderType}); free ${Object.entries(b).map(([a, v]) => `${a} ${v}`).join(", ")}`, Colors.CYAN);
    } catch (error) {
      log(`[**] Execution: testnet account not reachable: ${error}`, Colors.RED);
    }
  };

  /** The horizon-search candidates on paper: checked at start and every horizon.checkMinutes; errors never stop the server. */
  private autoHorizon = () => {
    const { enabled, checkMinutes, tracks } = cryptoConfig.horizon;
    if (!enabled) return;
    log(`[**] Horizon candidates (paper): ${tracks.map((t) => t.name).join(", ")}, checked every ${checkMinutes} min`, Colors.CYAN);
    const check = () => HorizonTraderService.check().catch((error) => log(`[**] Horizon check failed: ${error}`, Colors.RED));
    check();
    this.horizonTimer = repeatEvent({ callback: check, units: "minutes", interval: checkMinutes });
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

        this.walletAmountStatistic(balanceETH, walletETHHistory, ETHtoUSD, USDtoETH);

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

      let message = Colors.GREEN + `Balance: ~$${ETHusd.toFixed(3)} `;

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
}

export default new StatisticAndPredictionService();
