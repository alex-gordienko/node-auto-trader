/**
 * Fills (or tops up) Binance datasets without starting the bot — the traded pair, reference markets
 * (BTC-USDT by default) and futures metrics / funding:
 *   yarn backfill:binance [minuteDays] [hourDays]
 * Missing or outdated data (e.g. candles without trade-flow fields) is downloaded from archives,
 * otherwise only the tail since the last stored row is requested.
 */
import cryptoConfig from "../config/crypto.config";
import MarketDataService from "../services/MarketData.service";
import { CryptoPairs } from "../types/basic.types";

const minuteDays = Number(process.argv[2] || cryptoConfig.marketData.backfillMinuteDays);
const hourDays = Number(process.argv[3] || cryptoConfig.marketData.backfillHourDays);

(async () => {
  for (const pair of Object.values(CryptoPairs)) {
    await MarketDataService.backfill(pair, minuteDays, hourDays);
  }
  process.exit(0);
})();
