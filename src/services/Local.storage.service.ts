import * as fs from "fs";
import * as path from "path";

import { TransactionResponse } from "ethers";

import { ICyptoCompareData, ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";
import {
  ICryproExchangeWalletHistory,
  ICryptoExchangeSwapResponse,
  ICryptoExchangeTransactionsHistory,
  ITensorflowPrediction,
} from "../types/cryptoExchange.types";
import { CryptoBase, CryptoPairs } from "../types/basic.types";
import EtheriumWalletService from "./EtheriumWallet.service";

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
    this.storagePath = path.join(`${__dirname}/..`, "Storage");
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
      fs.writeFileSync(filePath, jsonString, "utf-8");

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

  public pushTradingHistory = async (
    name: CryptoPairs,
    data: ICyptoCompareHistoryMinutePair
  ): Promise<string | null> => {
    const fileName = `datasets/${name}-trading-history.json`;

    const newDataMap = new Map<number, ICyptoCompareData>(data.Data.Data.map((d) => [d.time, d]));

    let savedDataMap = await this.getSavedFile<ICyptoCompareData>(fileName);

    let newRowsCount = 0;
    if (savedDataMap) {
      newDataMap.forEach((value, key) => {
        if (!savedDataMap!.has(key)) {
          savedDataMap!.set(key, value);
          newRowsCount++;
        }
      });
    } else {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = newDataMap;
    }

    log(`[**] ${name}: New rows count: ${newRowsCount}. Total rows count: ${savedDataMap?.size || 0}`, Colors.BLUE);

    return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
  };

  public getTradingHistory = async (historyName: CryptoPairs): Promise<ICyptoCompareData[]> => {
    const fileName = `datasets/${historyName}-trading-history.json`;

    const result = await this.getSavedFile<ICyptoCompareData>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

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
