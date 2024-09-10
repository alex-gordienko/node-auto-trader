import aws from "aws-sdk";
import axios from "axios";
import { readdirSync, readFileSync } from "fs";

import { TransactionResponse } from "ethers";
import { WithId, WithProofs } from "@waves/waves-transactions";
import { TransferTransaction } from "@waves/ts-types";

import config from "../config/digitalOcean.config";
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

class DigitalOceanStorageService {
  public spacesEndpoint: aws.Endpoint;
  private s3: aws.S3;

  constructor() {
    const spacesEndpoint = new aws.Endpoint(config.endpoint);
    this.spacesEndpoint = spacesEndpoint;

    this.s3 = new aws.S3({
      s3ForcePathStyle: false,
      endpoint: spacesEndpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    log("[*] Initializing Digital Ocean Storage Service", Colors.BLUE);
  }

  private uploadFile = async (bucketName: string, input: aws.S3.PutObjectRequest) => {
    try {
      await this.s3.putObject(input, (err, data) => {
        if (err) {
          log(err, Colors.RED);
          log(`Error uploading data: ${data}`, Colors.RED);
        }
      });

      const splittedEndpoint = config.endpoint.split("//");
      const fileURL = `${splittedEndpoint[0]}//${bucketName}.${splittedEndpoint[1]}/${input.Key}`;

      return fileURL;
    } catch (error) {
      log(`Error uploading data: ${error}`, Colors.RED);
      return null;
    }
  };

  private getSavedFile = async <T>(name: string, bucketName: string): Promise<Map<number, T> | null> => {
    try {
      const splittedEndpoint = config.endpoint.split("//");
      const fileURL = `${splittedEndpoint[0]}//${bucketName}.${splittedEndpoint[1]}/${name}`;

      const response = await axios.get(fileURL);

      if (response.data) {
        // pre-saved file has Map<number, ICyptoCompareData> format
        return new Map<number, T>(response.data);
      } else return null;
    } catch (error) {
      log("Error while getting saved file", Colors.RED);
      return null;
    }
  };

  public pushTradingHistory = async (name: string, data: ICyptoCompareHistoryMinutePair): Promise<string | null> => {
    const bucketName = config.bucket;
    const fileName = name + "-trading-history.json";

    const newDataMap = new Map<number, ICyptoCompareData>(data.Data.Data.map((d) => [d.time, d]));

    let savedDataMap = await this.getSavedFile<ICyptoCompareData>(fileName, bucketName);

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

    const input: aws.S3.PutObjectRequest = {
      Bucket: config.bucket,
      Key: fileName,
      Body: JSON.stringify(Array.from(savedDataMap)),
      ContentType: "plain/json",
      ACL: "public-read",
    };

    log(`[**] New rows count: ${newRowsCount}`, Colors.BLUE);
    log(`[**] Total rows count: ${savedDataMap?.size || 0}`, Colors.BLUE);

    return this.uploadFile(bucketName, input);
  };

  public getTradingHistory = async (
    historyName: "WAVES-ETH-minute" | "WAVES-ETH-hours"
  ): Promise<ICyptoCompareData[]> => {
    const bucketName = config.bucket;
    const fileName = `${historyName}-trading-history.json`;

    const result = await this.getSavedFile<ICyptoCompareData>(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public pushTensorflowPredictionHistory = async (prediction: ITensorflowPrediction[]): Promise<string | null> => {
    const bucketName = config.bucket;
    const fileName = `WAVES-ETH-prediction-history.json`;

    let savedDataMap = await this.getSavedFile<ITensorflowPrediction>(fileName, bucketName);

    if (!savedDataMap) {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = new Map<number, ITensorflowPrediction>();
    }

    prediction.forEach((prediction) => {
      savedDataMap.set(prediction.timestamp, prediction);
    });

    const input: aws.S3.PutObjectRequest = {
      Bucket: config.bucket,
      Key: fileName,
      Body: JSON.stringify(Array.from(savedDataMap)),
      ContentType: "plain/json",
      ACL: "public-read",
    };

    return this.uploadFile(bucketName, input);
  }

  public getTensorflowPredictionHistory = async (): Promise<ITensorflowPrediction[]> => {
    const bucketName = config.bucket;
    const fileName = `WAVES-ETH-prediction-history.json`;

    const result = await this.getSavedFile<ITensorflowPrediction>(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };
   

  public pushWalletBalanceHistory = async (
    coin: CryptoBase,
    data: ICryproExchangeWalletHistory
  ): Promise<string | null> => {
    const bucketName = config.bucket;
    const fileName = `${coin}-wallet-balance-history.json`;

    let savedDataMap = await this.getSavedFile<ICryproExchangeWalletHistory>(fileName, bucketName);

    if (!savedDataMap) {
      log("[**] No saved file found", Colors.BLUE);
      savedDataMap = new Map<number, ICryproExchangeWalletHistory>();
    }

    savedDataMap.set(data.timestamp, data);

    const input: aws.S3.PutObjectRequest = {
      Bucket: config.bucket,
      Key: fileName,
      Body: JSON.stringify(Array.from(savedDataMap)),
      ContentType: "plain/json",
      ACL: "public-read",
    };

    return this.uploadFile(bucketName, input);
  };

  public getWalletBalanceHistory = async (coin: CryptoBase): Promise<ICryproExchangeWalletHistory[]> => {
    const bucketName = config.bucket;
    const fileName = `${coin}-wallet-balance-history.json`;

    const result = await this.getSavedFile<ICryproExchangeWalletHistory>(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public pushTransactionsHistory = async (props: TransactionHistoryProps): Promise<string | null> => {
    try {
      const bucketName = config.bucket;
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

      let savedDataMap = await this.getSavedFile<ICryptoExchangeTransactionsHistory>(fileName, bucketName);

      if (!savedDataMap) {
        log("[**] No saved file found", Colors.BLUE);
        savedDataMap = new Map<number, ICryptoExchangeTransactionsHistory>();
      }

      savedDataMap.set(transactionHistory.timestamp, transactionHistory);

      const input: aws.S3.PutObjectRequest = {
        Bucket: config.bucket,
        Key: fileName,
        Body: JSON.stringify(Array.from(savedDataMap)),
        ContentType: "plain/json",
        ACL: "public-read",
      };

      return this.uploadFile(bucketName, input);
    } catch (error) {
      log("Error while pushing transaction history", Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public getTransactionsHistory = async (coins: CryptoBase[]): Promise<ICryptoExchangeTransactionsHistory[]> => {
    const bucketName = config.bucket;
    const fileName = `${coins[0]}-${coins[1]}-transactions-history.json`;

    const result = await this.getSavedFile<ICryptoExchangeTransactionsHistory>(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public saveModel = async (localPath: string, cloudPath: string) => {
    const files = readdirSync(localPath);
    const bucketName = config.bucket;

    for (const file of files) {
      const input: aws.S3.PutObjectRequest = {
        Bucket: bucketName,
        Key: `${cloudPath}/${file}`,
        Body: readFileSync(`${localPath}/${file}`),
        ContentEncoding: "base64",
        ACL: "public-read",
      };

      log(`[**] Uploading model: ${file}`, Colors.BLUE);
      await this.uploadFile(bucketName, input);
    }
  };
}

export default new DigitalOceanStorageService();
