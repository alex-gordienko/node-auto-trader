import * as fs from "fs";
import * as path from "path";

import { TransactionResponse } from "ethers";

import { CandleTimeframe, IMarketCandle, MarketSymbol } from "../types/marketData.types";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import {
  ICryproExchangeWalletHistory,
  ICryptoExchangeSwapResponse,
  ICryptoExchangeTransactionsHistory,
  ITensorflowPrediction,
} from "../types/cryptoExchange.types";
import { CryptoBase, CryptoPairs } from "../types/basic.types";
import EtheriumWalletService from "./EtheriumWallet.service";

// "1m" / "1h" candles keep the folder names of the first Binance datasets
export type MarketSeries =
  | "1m"
  | "1h"
  | "futures-metrics"
  | "funding"
  | "premium-1m"
  | "premium-1h"
  | "coinbase-1m"
  | "coinbase-1h"
  | "dvol-1h"
  | "stablecoins-1d"
  | "fear-greed-1d";

// datasets/<source>/<symbol>/<series>/<yyyy-MM>.json
const SERIES_SOURCE: Record<MarketSeries, string> = {
  "1m": "binance",
  "1h": "binance",
  "futures-metrics": "binance",
  funding: "binance",
  "premium-1m": "binance",
  "premium-1h": "binance",
  "coinbase-1m": "coinbase",
  "coinbase-1h": "coinbase",
  "dvol-1h": "deribit",
  "stablecoins-1d": "defillama",
  "fear-greed-1d": "alternative-me",
};
const CANDLE_SERIES: Record<CandleTimeframe, MarketSeries> = { minute: "1m", hour: "1h" };

interface ITransactionHistoryETHProps {
  from: CryptoBase;
  to: CryptoBase;
  coins: CryptoBase[];
  exchangeAPIResponse: ICryptoExchangeSwapResponse;
  transactionResponse: TransactionResponse | null;
}

type TransactionHistoryProps = ITransactionHistoryETHProps;

class LocalStorageService {
  private storagePath: string;

  constructor() {
    this.storagePath = cryptoConfig.paths.storageDir;
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
    if (!fs.existsSync(path.join(this.storagePath, "datasets"))) { 
      fs.mkdirSync(path.join(this.storagePath, "datasets"), { recursive: true });
    }
    if (!fs.existsSync(path.join(this.storagePath, "predictions"))) { 
      fs.mkdirSync(path.join(this.storagePath, "predictions"), { recursive: true });
    }
    if (!fs.existsSync(path.join(this.storagePath, "balances"))) { 
      fs.mkdirSync(path.join(this.storagePath, "balances"), { recursive: true });
    }
    if (!fs.existsSync(path.join(this.storagePath, "transactions"))) { 
      fs.mkdirSync(path.join(this.storagePath, "transactions"), { recursive: true });
    }

    log("[*] Initializing Local Storage Service", Colors.BLUE);
  }

  private uploadFile = async (fileName: string, jsonString: string) => {
    try {
      const filePath = path.join(this.storagePath, fileName);
      // write + rename is atomic: a process killed mid-write must not leave a cut file, because an unreadable
      // file is replaced on the next update by only the new rows (a month of candles or all saved predictions)
      fs.writeFileSync(`${filePath}.tmp`, jsonString, "utf-8");
      fs.renameSync(`${filePath}.tmp`, filePath);

      return filePath;
    } catch (error) {
      log(`Error uploading data: ${error}`, Colors.RED);
      return null;
    }
  };

  private getSavedFile = async <T>(name: string): Promise<Map<number, T> | null> => {
    try {
      const filePath = path.join(this.storagePath, name);
      if (!fs.existsSync(filePath)) {
        throw new Error("File not found");
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const parsedContent = JSON.parse(content);
      return new Map<number, T>(parsedContent);
    } catch (error) {
      log("Error while getting saved file", Colors.RED);
      return null;
    }
  };

  // ---------- Binance market data: one file per month per series ----------

  private seriesDir = (symbol: MarketSymbol, series: MarketSeries) =>
    path.join("datasets", SERIES_SOURCE[series], symbol, series);

  private monthKey = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 7);

  /**
   * Merges rows (by `time`) into monthly files, so a 10-minute update rewrites only the current month.
   * Existing rows are overwritten, so re-downloading enriches older data with new fields.
   */
  public pushSeries = async <T extends { time: number }>(symbol: MarketSymbol, series: MarketSeries, rows: T[]): Promise<number> => {
    if (!rows.length) return 0;
    const dir = this.seriesDir(symbol, series);
    fs.mkdirSync(path.join(this.storagePath, dir), { recursive: true });

    const byMonth = new Map<string, T[]>();
    rows.forEach((row) => {
      const key = this.monthKey(row.time);
      byMonth.set(key, [...(byMonth.get(key) ?? []), row]);
    });

    let newRowsCount = 0;
    for (const [month, monthRows] of byMonth) {
      const fileName = path.join(dir, `${month}.json`);
      const saved = fs.existsSync(path.join(this.storagePath, fileName))
        ? ((await this.getSavedFile<T>(fileName)) ?? new Map<number, T>())
        : new Map<number, T>();

      monthRows.forEach((row) => {
        if (!saved.has(row.time)) newRowsCount++;
        saved.set(row.time, row);
      });
      const sorted = Array.from(saved).sort((x, y) => x[0] - y[0]);
      await this.uploadFile(fileName, JSON.stringify(sorted));
    }

    log(`[**] ${symbol} ${series}: ${newRowsCount} new rows in ${byMonth.size} month file(s)`, Colors.BLUE);
    return newRowsCount;
  };

  /** Rows since `sinceSec` (reads only the month files it needs), oldest first. */
  public getSeries = async <T extends { time: number }>(symbol: MarketSymbol, series: MarketSeries, sinceSec = 0): Promise<T[]> => {
    const dir = this.seriesDir(symbol, series);
    const fullDir = path.join(this.storagePath, dir);
    if (!fs.existsSync(fullDir)) return [];

    const sinceMonth = this.monthKey(sinceSec);
    const files = fs
      .readdirSync(fullDir)
      .filter((f) => f.endsWith(".json") && f.slice(0, 7) >= sinceMonth)
      .sort();

    const result: T[] = [];
    for (const file of files) {
      const saved = await this.getSavedFile<T>(path.join(dir, file));
      saved?.forEach((row) => row.time >= sinceSec && result.push(row));
    }
    return result.sort((x, y) => x.time - y.time);
  };

  public pushCandles = (symbol: MarketSymbol, timeframe: CandleTimeframe, candles: IMarketCandle[]) =>
    this.pushSeries(symbol, CANDLE_SERIES[timeframe], candles);

  public getCandles = (symbol: MarketSymbol, timeframe: CandleTimeframe, sinceSec = 0) =>
    this.getSeries<IMarketCandle>(symbol, CANDLE_SERIES[timeframe], sinceSec);

  public pushTensorflowPredictionHistory = async (
    pair: CryptoPairs,
    prediction: ITensorflowPrediction
  ): Promise<string | null> => {
    const fileName = `predictions/${pair}-prediction-history.json`;

    let savedDataMap = await this.getSavedFile<ITensorflowPrediction>(fileName);

    if (!savedDataMap) {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = new Map<number, ITensorflowPrediction>();
    }

    savedDataMap.set(prediction.timestamp, prediction);

    return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
  };

  public getTensorflowPredictionHistory = async (pair: CryptoPairs): Promise<ITensorflowPrediction[]> => {
    const fileName = `predictions/${pair}-prediction-history.json`;

    const result = await this.getSavedFile<ITensorflowPrediction>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public pushWalletBalanceHistory = async (
    coin: CryptoBase,
    data: ICryproExchangeWalletHistory
  ): Promise<string | null> => {
    const fileName = `balances/${coin}-wallet-balance-history.json`;

    let savedDataMap = await this.getSavedFile<ICryproExchangeWalletHistory>(fileName);

    if (!savedDataMap) {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = new Map<number, ICryproExchangeWalletHistory>();
    }

    savedDataMap.set(data.timestamp, data);

    return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
  };

  public getWalletBalanceHistory = async (coin: CryptoBase): Promise<ICryproExchangeWalletHistory[]> => {
    const fileName = `balances/${coin}-wallet-balance-history.json`;

    const result = await this.getSavedFile<ICryproExchangeWalletHistory>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public pushTransactionsHistory = async (props: TransactionHistoryProps): Promise<string | null> => {
    try {
      const fileName = `transactions/${props.coins[0]}-${props.coins[1]}-transactions-history.json`;


      const amount = Number(EtheriumWalletService.convertBigIntToETH(props.transactionResponse?.value || BigInt(0)))

      const walletFrom = EtheriumWalletService.getAddress();
      const walletTo = props.exchangeAPIResponse.payinAddress;

      const transactionHash = props.transactionResponse?.hash;

      const networkFee = await EtheriumWalletService.getTransactionFee(transactionHash || "")

      const transactionHistory: ICryptoExchangeTransactionsHistory = {
        timestamp: new Date().getTime(),
        exchangeAPItransactionId: props.exchangeAPIResponse.id,
        fromCoin: props.from,
        toCoin: props.to,
        amount,
        walletFrom,
        walletTo,
        transactionHash: transactionHash || "",
        networkFee,
      };

      let savedDataMap = await this.getSavedFile<ICryptoExchangeTransactionsHistory>(fileName);

      if (!savedDataMap) {
        log("[**] No saved file found", Colors.BLUE);
        savedDataMap = new Map<number, ICryptoExchangeTransactionsHistory>();
      }

      savedDataMap.set(transactionHistory.timestamp, transactionHistory);

      return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
    } catch (error) {
      log("Error while pushing transaction history", Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public getTransactionsHistory = async (coins: CryptoBase[]): Promise<ICryptoExchangeTransactionsHistory[]> => {
    const fileName = `transactions/${coins[0]}-${coins[1]}-transactions-history.json`;

    const result = await this.getSavedFile<ICryptoExchangeTransactionsHistory>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };
}

export default new LocalStorageService();
