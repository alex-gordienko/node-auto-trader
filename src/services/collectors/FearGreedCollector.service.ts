import axios from "axios";

import cryptoConfig from "../../config/crypto.config";
import { ISeriesPoint } from "../../types/marketData.types";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("fear-greed");

/**
 * Crypto Fear & Greed Index (alternative.me), 0 = extreme fear, 100 = extreme greed: a daily summary of
 * market mood from volatility, volume, social media and dominance. Free, history since 2018.
 * A day's value appears with a delay, so a point stamped D is only used from D + 2 days.
 */
class FearGreedCollector {
  constructor() {
    log("initializing fear & greed index collector", Colors.WHITE);
  }

  /** The whole daily history; null if the request failed. */
  public fetchAll = async (): Promise<ISeriesPoint[] | null> => {
    try {
      const response = await axios.get<{ data: { value: string; timestamp: string }[] }>(
        cryptoConfig.marketData.fearGreedUrl,
        { params: { limit: 0, format: "json" }, timeout: 30000 }
      );
      const points = response.data.data
        .map((d) => ({ time: Number(d.timestamp), value: Number(d.value) }))
        .filter((p) => p.time > 0 && Number.isFinite(p.value))
        .sort((a, b) => a.time - b.time);
      log(`loaded ${points.length} days of fear & greed index`, Colors.BLUE);
      return points;
    } catch (error: any) {
      log(`request failed: ${error?.message}`, Colors.YELLOW);
      return null;
    }
  };
}

export default new FearGreedCollector();
