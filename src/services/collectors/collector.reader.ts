import fs from "fs";
import path from "path";
import readline from "readline";
import zlib from "zlib";

import cryptoConfig from "../../config/crypto.config";

export interface ICollectorGap {
  from: number;
  to: number;
}

/** Hour files of a recorded stream (e.g. "ETH-USDT/futures-trades") overlapping [fromMs, toMs), oldest first. */
export const listStreamFiles = (stream: string, fromMs = 0, toMs = Infinity): string[] => {
  const root = path.join(cryptoConfig.collectors.storageDir, stream);
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const day of fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    for (const file of fs.readdirSync(path.join(root, day)).filter((f) => f.endsWith(".jsonl.gz")).sort()) {
      const start = Date.parse(`${day}T${file.slice(0, 2)}:00:00Z`);
      if (start + 3600_000 > fromMs && start < toMs) files.push(path.join(root, day, file));
    }
  }
  return files;
};

/**
 * Rows of a recorded stream. Files are routed by receive time and rows are stored by event time,
 * so rows are filtered by their first field (a timestamp in ms). A file still being written or cut by a
 * crash ends with an incomplete gzip block — it is read up to that point instead of failing.
 */
export async function* readStream<T extends unknown[]>(stream: string, fromMs = 0, toMs = Infinity): AsyncGenerator<T> {
  for (const file of listStreamFiles(stream, fromMs - 3600_000, toMs + 3600_000)) {
    const gunzip = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    gunzip.on("error", () => gunzip.end());
    const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(gunzip), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let row: T;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // last line of an interrupted file
      }
      const time = row[0] as number;
      if (time >= fromMs && time < toMs) yield row;
    }
  }
}

/** Periods without data: reconnects from the journal plus the time between a stop and the next start. */
export const readGaps = (stream: string): ICollectorGap[] => {
  const file = path.join(cryptoConfig.collectors.storageDir, stream, "gaps.jsonl");
  if (!fs.existsSync(file)) return [];
  const gaps: ICollectorGap[] = [];
  let stoppedAt: number | null = null;
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.type === "gap") gaps.push({ from: entry.from, to: entry.to });
    if (entry.type === "stop") stoppedAt = entry.at;
    if (entry.type === "start" && stoppedAt) {
      gaps.push({ from: stoppedAt, to: entry.at });
      stoppedAt = null;
    }
  }
  return gaps;
};
