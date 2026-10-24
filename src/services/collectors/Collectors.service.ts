import path from "path";
import { Worker } from "worker_threads";

import cryptoConfig from "../../config/crypto.config";
import OrderFlowService from "../OrderFlow.service";
import HealthService from "../HealthService";
import AlertService from "../AlertService";
import { createLogger, Colors } from "../../utils/colored-console";

const log = createLogger("recorders");

const RESTART_DELAY_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;
// a crash-loop is a real failure, not transient noise: 4 restarts inside 10 minutes gives up loudly instead of
// looping forever and silently producing gaps in the order-book history the OrderFlow model trains on
const RESTART_BUDGET_WINDOW_MS = 10 * 60_000;
const RESTART_BUDGET_MAX = 4;

/**
 * Runs the market data recorders as part of the server: a worker thread inside the same Node process
 * (see collectors.worker.ts), not a separate process. It has its own event loop, so model training on the
 * main thread does not delay WebSocket data. Restarts the worker if it crashes, stops it with the server.
 */
class CollectorsService {
  private worker: Worker | null = null;
  private stopping = false;
  private locked = false;
  private recentRestartsAt: number[] = [];

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
      if (message === "locked") {
        this.locked = true;
        HealthService.recordCollectorLocked();
        AlertService.notify("critical", "collectors-locked", "collector worker reported a second instance; this process now has zero collectors");
      }
      // live order-flow features for the order-book model
      if (message?.type === "orderflow") OrderFlowService.addLive(message.symbol, message.second, message.vector);
    });
    worker.on("error", (error) => log(`Worker error: ${error.message}`, Colors.RED));
    worker.on("exit", (code) => {
      this.worker = null;
      if (this.stopping || this.locked) return;

      const now = Date.now();
      this.recentRestartsAt = [...this.recentRestartsAt, now].filter((t) => now - t < RESTART_BUDGET_WINDOW_MS);
      HealthService.recordCollectorRestart();
      if (this.recentRestartsAt.length > RESTART_BUDGET_MAX) {
        log(`Worker exited (code ${code}) ${this.recentRestartsAt.length} times in ${RESTART_BUDGET_WINDOW_MS / 60_000} min — giving up`, Colors.RED);
        AlertService.notify("critical", "collectors-crash-loop", `collector worker restarted ${this.recentRestartsAt.length} times in ${RESTART_BUDGET_WINDOW_MS / 60_000} min; no longer restarting`);
        return;
      }

      log(`Worker exited (code ${code}), restarting in ${RESTART_DELAY_MS / 1000}s`, Colors.RED);
      AlertService.notify("warning", "collectors-restart", `collector worker exited (code ${code}) and is restarting`);
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
