/**
 * Worker thread that runs the recorders inside the server process. It has its own event loop, so model
 * training on the main thread (which blocks it for minutes) does not delay WebSocket data or pings.
 * Messages: main → worker "stop"; worker → main "locked" (another process is recording) and "stopped".
 */
import { parentPort } from "worker_threads";

import { startCollectors } from "./runCollectors";

const handle = startCollectors();

if (!handle) {
  parentPort?.postMessage("locked");
  process.exit(0);
}

parentPort?.on("message", async (message) => {
  if (message !== "stop" || !handle) return;
  await handle.stop();
  parentPort?.postMessage("stopped");
  process.exit(0);
});
