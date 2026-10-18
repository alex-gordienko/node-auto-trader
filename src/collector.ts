/**
 * Market microstructure recorder — a separate process from the trading bot:
 *   yarn collect            (development, ts-node)
 *   yarn collect:start      (compiled)
 * Kept apart because model training blocks the bot's process for minutes, which would drop WebSocket data.
 * Records order books, trades and liquidations to src/Storage/collectors (see services/collectors).
 */
import cryptoConfig from "./config/crypto.config";
import { BinanceStreamCollector } from "./services/collectors/BinanceStreamCollector";
import { LiquidationsCollector } from "./services/collectors/LiquidationsCollector.service";
import { OrderBookCollector } from "./services/collectors/OrderBookCollector.service";
import { TradesCollector } from "./services/collectors/TradesCollector.service";
import { log, Colors } from "./utils/colored-console";

const STATUS_EVERY_MS = 5 * 60 * 1000;

const collectors: BinanceStreamCollector[] = [];
for (const symbol of cryptoConfig.collectors.symbols) {
  collectors.push(
    new OrderBookCollector(symbol, "spot"),
    new OrderBookCollector(symbol, "futures"),
    new TradesCollector(symbol, "spot"),
    new TradesCollector(symbol, "futures")
  );
}
collectors.push(new LiquidationsCollector());

log(
  `[collector] Recording ${collectors.map((c) => c.name).join(", ")} to ${cryptoConfig.collectors.storageDir}`,
  Colors.GREEN
);
collectors.forEach((c) => c.start());

const previousRows = new Map<string, number>();
setInterval(() => {
  const status = collectors.map((c) => {
    const added = c.rows - (previousRows.get(c.name) ?? 0);
    previousRows.set(c.name, c.rows);
    return `${c.name} +${added}${c.reconnects ? ` (${c.reconnects} reconnects)` : ""}`;
  });
  log(`[collector] last ${STATUS_EVERY_MS / 60000} min: ${status.join(" | ")}`, Colors.CYAN);
}, STATUS_EVERY_MS);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`[collector] ${signal}: closing files`, Colors.YELLOW);
  await Promise.all(collectors.map((c) => c.stop()));
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
