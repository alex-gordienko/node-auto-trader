import path from "path";
import { Worker } from "worker_threads";

import cryptoConfig from "../../config/crypto.config";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("recorders");

const RESTART_DELAY_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;

/**
 * Runs the market data recorders as part of the server: a worker thread inside the same Node process
 * (see collectors.worker.ts), not a separate process. It has its own event loop, so model training on the
 * main thread does not delay WebSocket data. Restarts the worker if it crashes, stops it with the server.
 */
class CollectorsService {
  private worker: Worker | null = null;
  private stopping = false;
  private locked = false;

  public start(): void {
    if (!cryptoConfig.collectors.enabled) {
      log("Recorders are disabled (COLLECTORS_ENABLED=false)", Colors.YELLOW);
      return;
    }
    this.spawn();
  }

  private spawn(): void {
    // the same file is .ts under ts-node and .js when compiled
    const extension = path.extname(__filename);
    const file = path.join(__dirname, `collectors.worker${extension}`);
    const worker = new Worker(file, {
      execArgv: extension === ".ts" ? ["--require", "ts-node/register/transpile-only"] : [],
    });
    this.worker = worker;

    worker.on("message", (message) => {
      if (message === "locked") this.locked = true;
    });
    worker.on("error", (error) => log(`Worker error: ${error.message}`, Colors.RED));
    worker.on("exit", (code) => {
      this.worker = null;
      if (this.stopping || this.locked) return;
      log(`Worker exited (code ${code}), restarting in ${RESTART_DELAY_MS / 1000}s`, Colors.RED);
      setTimeout(() => !this.stopping && this.spawn(), RESTART_DELAY_MS);
    });
  }

  /** Lets the recorders finish their files; terminates the worker if it does not answer in time. */
  public async stop(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    if (!worker) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        worker.terminate().finally(resolve);
      }, STOP_TIMEOUT_MS);
      worker.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.postMessage("stop");
    });
  }
}

export default new CollectorsService();
