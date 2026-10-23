/**
 * Worker thread that runs the recorders inside the server process. It has its own event loop, so model
 * training on the main thread (which blocks it for minutes) does not delay WebSocket data or pings.
 * Messages: main → worker "stop"; worker → main "locked" (another process is recording), "stopped" and
 * { type: "orderflow", symbol, second, vector } — live order-flow features of every second for traded pairs.
 */
import { parentPort } from "worker_threads";

import { CryptoPairs } from "../../types/basic.types";
import { DepthRow, LiquidationRow, OrderFlowSeconds, TradeRow } from "../../utils/orderflow.features";
import { startCollectors } from "./runCollectors";

// trades of a second keep arriving for a moment after it ends
const SEND_DELAY_SECONDS = 2;
const KEEP_SECONDS = 120;

const handle = startCollectors();

if (!handle) {
  parentPort?.postMessage("locked");
  process.exit(0);
}

// live order-flow state of every traded pair that is being recorded
const flows = new Map<string, OrderFlowSeconds>();
for (const pair of Object.values(CryptoPairs)) flows.set(pair, new OrderFlowSeconds(pair.replace("-", "")));

for (const collector of handle?.collectors ?? []) {
  const [symbol, stream] = collector.name.split("/");
  if (symbol === "ALL") {
    collector.onRow = (row) => flows.forEach((flow) => flow.addLiquidation(row as LiquidationRow));
    continue;
  }
  const flow = flows.get(symbol);
  if (!flow) continue;
  const market = stream.startsWith("spot") ? "spot" : "futures";
  if (stream.endsWith("depth")) collector.onRow = (row) => flow.addBook(market, row as DepthRow);
  if (stream.endsWith("trades")) collector.onRow = (row) => flow.addTrade(market, row as TradeRow);
}

let lastSent = Math.floor(Date.now() / 1000) - SEND_DELAY_SECONDS;
setInterval(() => {
  const until = Math.floor(Date.now() / 1000) - SEND_DELAY_SECONDS;
  // every second since the last send, so a late timer tick does not lose one
  for (let second = lastSent + 1; second <= until; second++) {
    for (const [symbol, flow] of flows) {
      const vector = flow.vectorAt(second);
      if (vector) parentPort?.postMessage({ type: "orderflow", symbol, second, vector });
    }
  }
  lastSent = until;
  flows.forEach((flow) => flow.prune(until - KEEP_SECONDS));
}, 1000);

parentPort?.on("message", async (message) => {
  if (message !== "stop" || !handle) return;
  await handle.stop();
  parentPort?.postMessage("stopped");
  process.exit(0);
});
