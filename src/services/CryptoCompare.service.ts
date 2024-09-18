import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { CryptoBase } from "../types/basic.types";
import { ICryptoCompareCurrency, ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";

class CryproCompareService {
  private readonly apiKey: string = cryptoConfig.cryptoCompareApiKey;
  private readonly apiUrl: string = "https://min-api.cryptocompare.com/data";

  constructor() {
    log("[*] Initializing Crypto Compare Service", Colors.WHITE);
  }

  public getMinutePairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = 100
  ) => {
    try {
      const url = `${this.apiUrl}/v2/histominute`;

      const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
        params: {
          fsym: base,
          tsym: to,
          limit: limit,
          api_key: this.apiKey,
        },
      });

      return response.data;
    } catch (error) {
      log(`Error getting minute pair OHLCV`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public getHourPairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePairModelTraining)
  ) => {
    try {
      const url = `${this.apiUrl}/v2/histohour`;

      const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
        params: {
          fsym: base,
          tsym: to,
          limit: limit,
          api_key: this.apiKey,
        },
      });

      return response.data;
    } catch (error) {
      log(`Error getting hour pair OHLCV`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public getCurrentPrice = async (base: CryptoBase, to: CryptoBase): Promise<number | null> => { 
    try {
      const url = `${this.apiUrl}/price`;

      const response = await axios.get<ICryptoCompareCurrency>(url, {
        params: {
          fsym: base,
          tsyms: to,
          api_key: this.apiKey,
        },
      });

      return response.data[to];
    } catch (error) {
      log(`Error getting current price`, Colors.RED);
      log(error, Colors.RED);
      return null
    }
  }
}

export default new CryproCompareService();
