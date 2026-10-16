import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { CryptoBase } from "../types/basic.types";
import { ICryptoCompareCurrency, ICyptoCompareHistoryMinutePair } from "../types/cryptoCompare.types";
import { log, Colors } from "../utils/colored-console";

class CryproCompareService {
  private readonly apiKey: string = cryptoConfig.cryptoCompareApiKey;
  private readonly apiUrl: string = "https://min-api.cryptocompare.com/data";

  private readonly priceCache: Map<string, { value: number; expiresAt: number }> = new Map();
  private blockedUntil = 0;
  private callsToday = 0;
  private callsDay = new Date().toDateString();

  constructor() {
    log("[*] Initializing Crypto Compare Service", Colors.WHITE);
  }

  /** Returns false (and skips the request) while we are cooling down after hitting the rate limit. */
  private canCall(): boolean {
    if (Date.now() < this.blockedUntil) {
      log(`CryptoCompare is rate limited until ${new Date(this.blockedUntil).toLocaleTimeString()}, skipping request`, Colors.YELLOW);
      return false;
    }

    const today = new Date().toDateString();
    if (today !== this.callsDay) {
      log(`[**] CryptoCompare API calls for ${this.callsDay}: ${this.callsToday}`, Colors.WHITE);
      this.callsDay = today;
      this.callsToday = 0;
    }
    this.callsToday++;
    return true;
  }

  private handleApiError(message: string | undefined, status?: number) {
    const isRateLimit = status === 429 || /rate limit|limit/i.test(message ?? "");
    if (isRateLimit) {
      this.blockedUntil = Date.now() + cryptoConfig.cryptoCompare.rateLimitCooldownMinutes * 60 * 1000;
      log(`CryptoCompare rate limit reached: ${message}. Pausing requests`, Colors.RED);
    }
  }

  public getMinutePairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = 100
  ) => {
    if (!this.canCall()) return null;
    try {
      const url = `${this.apiUrl}/v2/histominute`;

      const response = await axios.get<ICyptoCompareHistoryMinutePair>(url, {
        params: {
          fsym: base,
          tsym: to,
          // CryptoCompare caps one request at 2000 rows
          limit: Math.min(Math.max(limit, 1), 2000),
          api_key: this.apiKey,
        },
      });

      if(response.data.Response !== "Success") {
        this.handleApiError(response.data.Message);
        log(`${base}-${to}: Error getting minute pair OHLCV: ${response.data.Message}`, Colors.RED);
        return null;
      }

      return response.data;
    } catch (error: any) {
      this.handleApiError(error?.response?.data?.Message ?? error?.message, error?.response?.status);
      log(`${base}-${to}: Error getting minute pair OHLCV`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public getHourPairOHLCV = async (
    base: CryptoBase,
    to: CryptoBase,
    limit: number = Number(cryptoConfig.requestLimitMinutePairModelTraining)
  ) => {
    if (!this.canCall()) return null;
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

  /** Cached for a short TTL; the reverse pair is derived from the cached direct pair without a request. */
  public getCurrentPrice = async (base: CryptoBase, to: CryptoBase): Promise<number | null> => {
    const now = Date.now();
    const direct = this.priceCache.get(`${base}-${to}`);
    if (direct && direct.expiresAt > now) return direct.value;
    const reverse = this.priceCache.get(`${to}-${base}`);
    if (reverse && reverse.expiresAt > now && reverse.value > 0) return 1 / reverse.value;

    if (!this.canCall()) return null;
    try {
      const url = `${this.apiUrl}/price`;

      const response = await axios.get<ICryptoCompareCurrency>(url, {
        params: {
          fsym: base,
          tsyms: to,
          api_key: this.apiKey,
        },
      });

      const value = response.data[to];
      if (typeof value !== "number") {
        this.handleApiError((response.data as any).Message);
        return null;
      }

      this.priceCache.set(`${base}-${to}`, {
        value,
        expiresAt: now + cryptoConfig.cryptoCompare.priceCacheTtlSeconds * 1000,
      });
      return value;
    } catch (error: any) {
      this.handleApiError(error?.response?.data?.Message ?? error?.message, error?.response?.status);
      log(`Error getting current price`, Colors.RED);
      log(error, Colors.RED);
      return null
    }
  }
}

export default new CryproCompareService();
