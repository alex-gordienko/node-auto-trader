import { S3, ListObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";

import config from "../digitalOcean.config";

class DigitalOceanStorageService {
  s3;

  constructor() {
    const authorization = {
      region: "nyc3",
      bucket: config.bucket,
      forcePathStyle: true,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      }
    }

    this.s3 = new S3(authorization);
    console.log("[*] Initializing Digital Ocean Storage Service");
  }

  checkConnection = async () => {
    try {
      console.log("[*] Checking connection to Digital Ocean Storage Service");

      const check = await this.s3.send(new ListObjectsCommand({ Bucket: config.bucket }));
      console.log('resultCheck', check);
      return true;
    } catch (error) {
      console.log("Error while checking connection to Digital Ocean Storage Service", error);
      return false;
    }
  }

  getSavedFile = async (name, bucketName) => {
    try {
      const isRequestAvailable = await this.checkConnection();
      if (isRequestAvailable) {
        console.log(`[*] Getting saved file ${name} from bucket ${bucketName}`);
        const data = await this.s3.send(new GetObjectCommand({ Bucket: bucketName, Key: name }));

        if (data && data.Body) {
          // Assuming the data is in JSON format
          const jsonData = JSON.parse(await data.Body.transformToString());
          // pre-saved file has Map<number, ICyptoCompareData> format
          const map = new Map(jsonData);
          return map
        } else {
          console.log("No data found for the specified file.");
          return null;
        }
      }
    } catch (error) {
      console.log("Error while getting saved file", error);
      return null;
    }
  };

  getTradingHistory = async (historyName) => {
    const bucketName = config.bucket;
    const fileName = `${historyName}-trading-history.json`;

    const result = await this.getSavedFile(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  getTensorflowPredictionHistory = async () => {
    const bucketName = config.bucket;
    const fileName = `WAVES-ETH-prediction-history.json`;

    const result = await this.getSavedFile(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  getWalletBalanceHistory = async (coin) => {
    const bucketName = config.bucket;
    const fileName = `${coin}-wallet-balance-history.json`;

    const result = await this.getSavedFile(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  getTransactionsHistory = async (coins) => {
    const bucketName = config.bucket;
    const fileName = `${coins[0]}-${coins[1]}-transactions-history.json`;

    const result = await this.getSavedFile(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };
}

export default new DigitalOceanStorageService();
