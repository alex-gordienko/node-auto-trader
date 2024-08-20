import aws from "aws-sdk";
import axios from "axios";
import { readdirSync, readFileSync } from "fs";

import config from "../config/digitalOcean.config";
import {
  ICyptoCompareData,
  ICyptoCompareHistoryMinutePair,
} from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";

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

  private uploadFile = async (
    bucketName: string,
    input: aws.S3.PutObjectRequest
  ) => {
    try {
      await this.s3.putObject(input, (err, data) => {
        if (err) {
          log(err, Colors.RED);
          log(`Error uploading data: ${data}`, Colors.RED);
        } else {
          log(`[**] Successfully uploaded the file for ${input.Key}`, Colors.BLUE);
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

  private getSavedFile = async (
    name: string,
    bucketName: string
  ): Promise<Map<number, ICyptoCompareData> | null> => {
    try {
      const splittedEndpoint = config.endpoint.split("//");
      const fileURL = `${splittedEndpoint[0]}//${bucketName}.${splittedEndpoint[1]}/${name}`;

      const response = await axios.get(fileURL);

      if (response.data) {
        // pre-saved file has Map<number, ICyptoCompareData> format
        return new Map<number, ICyptoCompareData>(response.data);
      } else return null;
    } catch (error) {
      log("Error while getting saved file", Colors.RED);
      return null;
    }
  };

  public pushTradingHistory = async (
    name: string,
    data: ICyptoCompareHistoryMinutePair
  ): Promise<string | null> => {
    const bucketName = config.bucket;
    const fileName = name + "-trading-history.json";

    const newDataMap = new Map<number, ICyptoCompareData>(
      data.Data.Data.map((d) => [d.time, d])
    );

    let savedDataMap = await this.getSavedFile(fileName, bucketName);

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
    historyName: "XMR-ETH-minute" | "XMR-ETH-hours"
  ): Promise<ICyptoCompareData[]> => {
    const bucketName = config.bucket;
    const fileName = `${historyName}-trading-history.json`;

    const result = await this.getSavedFile(fileName, bucketName);

    if (!result) {
      return [];
    }

    return Array.from(result.values());
  };

  public saveModel = async (
    localPath: string,
    cloudPath: string,
    modelType: "minutePair" | "hourlyPair"
  ) => {
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

      log(`[**] Uploading ${modelType}: ${file}`, Colors.BLUE);
      await this.uploadFile(bucketName, input);
    }
  };
}

export default new DigitalOceanStorageService();
