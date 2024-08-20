import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { CryptoBase } from "../types/basic.types";
import repeatEvent from "../utils/timer";
import { ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";

class CryproCompareService {
  private readonly apiKey: string = cryptoConfig.cryptoCompareApiKey;
  private readonly apiUrl: string = "https://min-api.cryptocompare.com/data/v2";
  private pairMinuteTimer: NodeJS.Timeout | null = null;
  private pairHourTimer: NodeJS.Timeout | null = null;

  constructor() {
    log("[*] Initializing Crypto Compare Service", Colors.RED);
    this.startAutoUpdate();
  }

  public stopPairMinuteTimer = () => {
    if (this.pairMinuteTimer) {
      clearInterval(this.pairMinuteTimer);
    }
  };

  public stopPairHourTimer = () => {
    if (this.pairHourTimer) {
      clearInterval(this.pairHourTimer);
    }
  };

  private startAutoUpdate = async () => {
    const unitsForMinutes = "minutes";
    const intervalForMinutes = 4;
    const unitsForHours = "hours";
    const intervalForHours = 2;
    log(
      `[**] Training dataset for Minute Model would be auto-updated each ${intervalForMinutes} ${unitsForMinutes}`,
      Colors.BLUE
    );

    log(
      `[**] Training dataset for Hourly Model would be auto-updated each ${intervalForHours} ${unitsForHours}`,
      Colors.BLUE
    );

    const tradingMinuteHistory = await this.getMinutePairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      2000
    );

    const tradingHourlyHistory = await this.getHourPairOHLCV(
      CryptoBase.XMR,
      CryptoBase.ETH,
      2000
    );

    this.pairMinuteTimer = repeatEvent({
      callback: () =>
        DigitalOceanStorageService.pushTradingHistory(
          "XMR-ETH-minute",
          tradingMinuteHistory
        ),
      units: unitsForMinutes,
      interval: intervalForMinutes,
    });

    this.pairHourTimer = repeatEvent({
      callback: () =>
        DigitalOceanStorageService.pushTradingHistory(
          "XMR-ETH-hours",
          tradingHourlyHistory
        ),
      units: unitsForHours,
      interval: intervalForHours,
    });
  };

  public getMinutePairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePair)
  ) => {
    const url = `${this.apiUrl}/histominute`;

    const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
      params: {
        fsym: base,
        tsym: to,
        limit: limit,
        api_key: this.apiKey,
      },
    });

    return response.data;
  };

  public getHourPairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePair)
  ) => {
    const url = `${this.apiUrl}/histohour`;

    const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
      params: {
        fsym: base,
        tsym: to,
        limit: limit,
        api_key: this.apiKey,
      },
    });

    return response.data;
  };
}

export default new CryproCompareService();
