import axios from "axios";

import cryptoConfig from "../../config/crypto.config";
import { ISeriesPoint } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("stablecoins");

/**
 * Total supply of stablecoins (USDT, USDC, …) in USD from DefiLlama. New stablecoins being issued means new
 * money ready to buy crypto; shrinking supply means money leaving. Daily, free, full history in one request.
 * A day's value is published with a delay, so a point stamped D is only used from D + 2 days.
 */
class StablecoinsCollector {
  constructor() {
    log("initializing DefiLlama stablecoin supply collector", Colors.WHITE);
  }

  /** The whole daily history; null if the request failed. */
  public fetchAll = async (): Promise<ISeriesPoint[] | null> => {
    try {
      const response = await axios.get<{ date: string; totalCirculatingUSD: Record<string, number> }[]>(
        cryptoConfig.marketData.stablecoinsUrl,
        { timeout: 30000 }
      );
      const points = response.data
        .map((day) => ({
          time: Number(day.date),
          // every stablecoin converted to USD, not only dollar-pegged ones
          value: Object.values(day.totalCirculatingUSD ?? {}).reduce((sum, v) => sum + (Number(v) || 0), 0),
        }))
        .filter((p) => p.time > 0 && p.value > 0)
        .sort((a, b) => a.time - b.time);
      log(`loaded ${points.length} days of stablecoin supply`, Colors.BLUE);
      return points;
    } catch (error: any) {
      log(`request failed: ${error?.message}`, Colors.YELLOW);
      return null;
    }
  };
}

export default new StablecoinsCollector();
