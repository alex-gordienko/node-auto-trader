import axios from "axios";
import AdmZip from "adm-zip";

import cryptoConfig from "../../config/crypto.config";
import { MarketSymbol } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("binance");

/**
 * Shared access to Binance public data for the collectors: REST with rate-limit handling
 * (spot and USDⓈ-M futures) and data.binance.vision ZIP archives. No API key is needed.
 */
class BinanceClient {
  private blockedUntil = 0;

  /** "ETH-USDT" → "ETHUSDT" */
  public symbol(pair: MarketSymbol): string {
    return pair.replace("-", "");
  }

  /** Archive timestamps are in microseconds since 2025, REST ones in milliseconds. */
  public toSeconds(timestamp: number): number {
    return timestamp > 1e14 ? Math.floor(timestamp / 1e6) : Math.floor(timestamp / 1e3);
  }

  /** Tries each base URL in turn; pauses all requests if Binance asks to back off. */
  private async get<T>(baseUrls: string[], path: string, params: Record<string, string | number>): Promise<T | null> {
    if (Date.now() < this.blockedUntil) {
      log(`rate limited until ${new Date(this.blockedUntil).toLocaleTimeString()}, skipping request`, Colors.YELLOW);
      return null;
    }

    for (const baseUrl of baseUrls) {
      try {
        const response = await axios.get<T>(`${baseUrl}${path}`, { params, timeout: 15000 });
        return response.data;
      } catch (error: any) {
        const status = error?.response?.status;
        if (status === 429 || status === 418) {
          const retryAfter = Number(error.response.headers?.["retry-after"] ?? 60);
          this.blockedUntil = Date.now() + retryAfter * 1000;
          log(`rate limit reached (${status}), pausing requests for ${retryAfter}s`, Colors.RED);
          return null;
        }
        if (status === 400) {
          log(`rejected ${path}: ${JSON.stringify(error.response.data)}`, Colors.RED);
          return null;
        }
        log(`request to ${baseUrl}${path} failed: ${error?.message}`, Colors.YELLOW);
      }
    }
    return null;
  }

  public getSpot<T>(path: string, params: Record<string, string | number>) {
    return this.get<T>(cryptoConfig.marketData.binanceApiUrls, path, params);
  }

  public getFutures<T>(path: string, params: Record<string, string | number>) {
    return this.get<T>([cryptoConfig.marketData.binanceFuturesApiUrl], path, params);
  }

  /** Downloads a data.binance.vision ZIP and returns its CSV rows (header skipped); null if not published yet. */
  public async downloadArchiveRows(path: string): Promise<string[][] | null> {
    const url = `${cryptoConfig.marketData.binanceArchiveUrl}/data/${path}`;
    try {
      const response = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 60000 });
      const zip = new AdmZip(Buffer.from(response.data));
      const csv = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
      if (!csv) return null;
      return csv
        .getData()
        .toString("utf-8")
        .split("\n")
        .map((line) => line.trim())
        // skip empty lines and a header row if present
        .filter((line) => line && /^\d/.test(line))
        .map((line) => line.split(","));
    } catch (error: any) {
      if (error?.response?.status !== 404) {
        log(`archive ${path} download failed: ${error?.message}`, Colors.YELLOW);
      }
      return null;
    }
  }

  /** Calendar days (UTC, "yyyy-MM-dd") from `fromSec` up to yesterday — the ones daily archives can exist for. */
  public pastDays(fromSec: number): string[] {
    const days: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (let t = fromSec; ; t += 86400) {
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      if (day >= today) break;
      days.push(day);
    }
    return days;
  }

  /** Full past months ("yyyy-MM") from `fromSec` up to the previous month — the ones monthly archives exist for. */
  public pastMonths(fromSec: number): string[] {
    const months: string[] = [];
    const currentMonth = new Date().toISOString().slice(0, 7);
    const cursor = new Date(fromSec * 1000);
    cursor.setUTCDate(1);
    for (let month = cursor.toISOString().slice(0, 7); month < currentMonth; month = cursor.toISOString().slice(0, 7)) {
      months.push(month);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return months;
  }
}

export default new BinanceClient();
