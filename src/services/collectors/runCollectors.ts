import fs from "fs";
import path from "path";

import cryptoConfig from "../../config/crypto.config";
import { log, Colors } from "../../utils/colored-console";
import { BinanceStreamCollector } from "./BinanceStreamCollector";
import { LiquidationsCollector } from "./LiquidationsCollector.service";
import { OrderBookCollector } from "./OrderBookCollector.service";
import { TradesCollector } from "./TradesCollector.service";

const STATUS_EVERY_MS = 5 * 60 * 1000;
const LOCK_FILE = "collector.lock";

export interface ICollectorsHandle {
  collectors: BinanceStreamCollector[];
  stop: () => Promise<void>;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Takes the storage folder for this process. Two recorders writing the same files would corrupt them, so if
 * another live server process (e.g. a second instance started on the same folder) holds the lock, nothing starts.
 */
const acquireLock = (): string | null => {
  const dir = cryptoConfig.collectors.storageDir;
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);

  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf-8"));
    if (pid && pid !== process.pid && isAlive(pid)) {
      log(`[collector] Already recording in process ${pid} (${lockPath}), not starting a second recorder`, Colors.YELLOW);
      return null;
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
};

/** Starts every configured recorder; null if another process is already recording. */
export const startCollectors = (): ICollectorsHandle | null => {
  const lockPath = acquireLock();
  if (!lockPath) return null;

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
  const statusTimer = setInterval(() => {
    const status = collectors.map((c) => {
      const added = c.rows - (previousRows.get(c.name) ?? 0);
      previousRows.set(c.name, c.rows);
      return `${c.name} +${added}${c.reconnects ? ` (${c.reconnects} reconnects)` : ""}`;
    });
    log(`[collector] last ${STATUS_EVERY_MS / 60000} min: ${status.join(" | ")}`, Colors.CYAN);
  }, STATUS_EVERY_MS);

  return {
    collectors,
    stop: async () => {
      clearInterval(statusTimer);
      await Promise.all(collectors.map((c) => c.stop()));
      if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf-8") === String(process.pid)) {
        fs.unlinkSync(lockPath);
      }
    },
  };
};
