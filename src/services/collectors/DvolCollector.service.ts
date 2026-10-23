import axios from "axios";

import cryptoConfig from "../../config/crypto.config";
import { ISeriesPoint } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("dvol");

const HOUR_MS = 3600_000;
// one request covers this many hourly points
const HOURS_PER_REQUEST = 1000;

/**
 * DVOL — Deribit's implied volatility index: how large a move option traders price in for the next 30 days,
 * in annualized %. A rising DVOL means the market expects turbulence. Hourly, free, with years of history.
 * Value = hourly close; a point stamped T is known after T + 1h.
 */
class DvolCollector {
  constructor() {
    log("initializing Deribit DVOL collector", Colors.WHITE);
  }

  /** Hourly DVOL since `fromSec` for a currency ("ETH", "BTC"). Null if the first request failed. */
  public fetchSince = async (currency: string, fromSec: number): Promise<ISeriesPoint[] | null> => {
    const result: ISeriesPoint[] = [];
    const now = Date.now();

    for (let start = fromSec * 1000; start < now; start += HOURS_PER_REQUEST * HOUR_MS) {
      try {
        const response = await axios.get<{ result: { data: number[][] } }>(
          `${cryptoConfig.marketData.deribitApiUrl}/public/get_volatility_index_data`,
          {
            params: {
              currency,
              start_timestamp: start,
              end_timestamp: Math.min(now, start + HOURS_PER_REQUEST * HOUR_MS),
              resolution: 3600,
            },
            timeout: 15000,
          }
        );
        // [timestamp, open, high, low, close]; only hours that have ended
        response.data.result.data
          .filter(([time]) => time + HOUR_MS <= now)
          .forEach(([time, , , , close]) => result.push({ time: Math.floor(time / 1000), value: close }));
      } catch (error: any) {
        log(`request failed: ${error?.message}`, Colors.YELLOW);
        return result.length ? result : null;
      }
    }

    const unique = new Map(result.map((p) => [p.time, p]));
    return Array.from(unique.values()).sort((a, b) => a.time - b.time);
  };
}

export default new DvolCollector();
