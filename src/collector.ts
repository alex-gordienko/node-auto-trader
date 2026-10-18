/**
 * Standalone market microstructure recorder (the server also runs it embedded, see Collectors.service):
 *   yarn collect            (development, ts-node)
 *   yarn collect:start      (compiled)
 * Use it when the recorders should run on a different machine or without the bot; set
 * COLLECTORS_EMBEDDED=false for the server then. A lock file prevents two recorders writing the same files.
 */
import { startCollectors } from "./services/collectors/runCollectors";
import { log, Colors } from "./utils/colored-console";

const handle = startCollectors();
if (!handle) process.exit(1);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping || !handle) return;
  stopping = true;
  log(`[collector] ${signal}: closing files`, Colors.YELLOW);
  await handle.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
