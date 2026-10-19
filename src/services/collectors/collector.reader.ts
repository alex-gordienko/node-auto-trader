import fs from "fs";
import path from "path";
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
    // "13.jsonl.gz" then "13-<restartTimeMs>.jsonl.gz" in order of the restarts
    const order = (f: string) => [Number(f.slice(0, 2)), Number(f.match(/^\d{2}-(\d+)/)?.[1] ?? 0)];
    const hourFiles = fs
      .readdirSync(path.join(root, day))
      .filter((f) => f.endsWith(".jsonl.gz"))
      .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
    for (const file of hourFiles) {
      const start = Date.parse(`${day}T${file.slice(0, 2)}:00:00Z`);
      if (start + 3600_000 > fromMs && start < toMs) files.push(path.join(root, day, file));
    }
  }
  return files;
};

// header of every gzip part Node writes: magic, deflate, no flags, mtime 0, xfl 0, os
const GZIP_HEADER = Buffer.from("1f8b08000000000000", "hex");

/**
 * Text of one hour file. A file can hold several gzip parts (older recorder versions appended after
 * a restart), and a part cut by a killed process has no proper end. Each part is decompressed on its
 * own and read as far as it goes, so a broken part never hides the data after it.
 */
const readHourFile = (file: string): string => {
  const data = fs.readFileSync(file);
  const starts: number[] = [];
  for (let i = data.indexOf(GZIP_HEADER); i >= 0; i = data.indexOf(GZIP_HEADER, i + 1)) starts.push(i);

  return starts
    .map((start, k) => {
      try {
        return zlib
          .gunzipSync(data.subarray(start, starts[k + 1] ?? data.length), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
          .toString("utf-8");
      } catch {
        return "";
      }
    })
    .join("\n");
};

/**
 * Rows of a recorded stream. Files are routed by receive time and rows are stored by event time,
 * so rows are filtered by their first field (a timestamp in ms). Unfinished lines at the end of an
 * interrupted part are skipped.
 */
export async function* readStream<T extends unknown[]>(stream: string, fromMs = 0, toMs = Infinity): AsyncGenerator<T> {
  for (const file of listStreamFiles(stream, fromMs - 3600_000, toMs + 3600_000)) {
    for (const line of readHourFile(file).split("\n")) {
      if (!line) continue;
      let row: T;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // last line of an interrupted part
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
