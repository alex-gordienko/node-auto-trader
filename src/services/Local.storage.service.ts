import * as fs from "fs";
import * as path from "path";

import { TransactionResponse } from "ethers";
import { WithId, WithProofs } from "@waves/waves-transactions";
import { TransferTransaction } from "@waves/ts-types";

import { ICyptoCompareData, ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";
import {
  ICryproExchangeWalletHistory,
  ICryptoExchangeResponse,
  ICryptoExchangeTransactionsHistory,
  ITensorflowPrediction,
} from "../types/cryptoExchange.types";
import { CryptoBase } from "../types/basic.types";
import EtheriumWalletService from "./EtheriumWallet.service";
import WavesWalletService from "./WavesWallet.service";

interface ITransactionHistoryETHProps {
  from: CryptoBase.ETH;
  to: CryptoBase.WAVES;
  coins: CryptoBase[];
  exchangeAPIResponse: ICryptoExchangeResponse;
  transactionResponse: TransactionResponse | null;
}

interface ITransactionHistoryWAVESProps {
  from: CryptoBase.WAVES;
  to: CryptoBase.ETH;
  coins: CryptoBase[];
  exchangeAPIResponse: ICryptoExchangeResponse;
  transactionResponse: (TransferTransaction & WithId & WithProofs) | null;
}

type TransactionHistoryProps = ITransactionHistoryETHProps | ITransactionHistoryWAVESProps;

class LocalStorageService {
  private storagePath: string;

  constructor() {
    this.storagePath = path.join(`${__dirname}/..`, "Storage");
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
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
    name: "WAVES-ETH" | "WAVES-USD" | "ETH-USD",
    data: ICyptoCompareHistoryMinutePair
  ): Promise<string | null> => {
    const fileName = name + "-trading-history.json";

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

    log(`[**] New rows count: ${newRowsCount}`, Colors.BLUE);
    log(`[**] Total rows count: ${savedDataMap?.size || 0}`, Colors.BLUE);

    return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
  };

  public getTradingHistory = async (
    historyName: "WAVES-ETH" | "WAVES-USD" | "ETH-USD"
  ): Promise<ICyptoCompareData[]> => {
    const fileName = `${historyName}-trading-history.json`;

    const result = await this.getSavedFile<ICyptoCompareData>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public pushTensorflowPredictionHistory =  async (prediction: ITensorflowPrediction[]): Promise<string | null> => {
    const fileName = `WAVES-ETH-prediction-history.json`;

    let savedDataMap = await this.getSavedFile<ITensorflowPrediction>(fileName);

    if (!savedDataMap) {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = new Map<number, ITensorflowPrediction>();
    }

    prediction.forEach((prediction) => {
      savedDataMap.set(prediction.timestamp, prediction);
    });

    return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
  };

  public getTensorflowPredictionHistory = async (): Promise<ITensorflowPrediction[]> => {
    const fileName = `WAVES-ETH-prediction-history.json`;

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
    const fileName = `${coin}-wallet-balance-history.json`;

    let savedDataMap = await this.getSavedFile<ICryproExchangeWalletHistory>(fileName);

    if (!savedDataMap) {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = new Map<number, ICryproExchangeWalletHistory>();
    }

    savedDataMap.set(data.timestamp, data);

    return this.uploadFile(fileName, JSON.stringify(Array.from(savedDataMap)));
  };

  public getWalletBalanceHistory = async (coin: CryptoBase): Promise<ICryproExchangeWalletHistory[]> => {
    const fileName = `${coin}-wallet-balance-history.json`;

    const result = await this.getSavedFile<ICryproExchangeWalletHistory>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public pushTransactionsHistory = async (props: TransactionHistoryProps): Promise<string | null> => {
    try {
      const fileName = `${props.coins[0]}-${props.coins[1]}-transactions-history.json`;

      const ethToWave = props.from === CryptoBase.ETH && props.to === CryptoBase.WAVES;

      const amount = ethToWave
        ? Number(EtheriumWalletService.convertBigIntToETH(props.transactionResponse?.value || BigInt(0)))
        : WavesWalletService.convertLongToWaves(props.transactionResponse?.amount);

      const walletFrom = ethToWave ? EtheriumWalletService.getAddress() : WavesWalletService.getAddress();
      const walletTo = props.exchangeAPIResponse.payinAddress;

      const transactionHash = ethToWave ? props.transactionResponse?.hash : props.transactionResponse?.id;

      const networkFee = ethToWave
        ? await EtheriumWalletService.getTransactionFee(transactionHash || "")
        : WavesWalletService.convertLongToWaves(props.transactionResponse?.fee);

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
    const fileName = `${coins[0]}-${coins[1]}-transactions-history.json`;

    const result = await this.getSavedFile<ICryptoExchangeTransactionsHistory>(fileName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };
}

export default new LocalStorageService();
