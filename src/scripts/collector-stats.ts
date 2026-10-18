/**
 * What the collectors have recorded so far:
 *   yarn collect:stats
 * Per stream: days covered, rows, disk size, first / last row and gaps.
 */
import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import { listStreamFiles, readGaps, readStream } from "../services/collectors/collector.reader";

const root = cryptoConfig.collectors.storageDir;
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

(async () => {
  if (!fs.existsSync(root)) {
    console.log(`Nothing recorded yet in ${root}. The recorders start together with the server (yarn start).`);
    return;
  }

  for (const symbol of fs.readdirSync(root).sort()) {
    for (const stream of fs.readdirSync(path.join(root, symbol)).sort()) {
      const name = `${symbol}/${stream}`;
      const files = listStreamFiles(name);
      const bytes = files.reduce((acc, f) => acc + fs.statSync(f).size, 0);
      let rows = 0;
      let first = Infinity;
      let last = 0;
      for await (const row of readStream<unknown[]>(name)) {
        rows++;
        const time = row[0] as number;
        first = Math.min(first, time);
        last = Math.max(last, time);
      }
      const gaps = readGaps(name);
      const gapMinutes = gaps.reduce((acc, g) => acc + (g.to - g.from), 0) / 60000;
      const hours = last > first ? (last - first) / 3600_000 : 0;

      console.log(
        `${name.padEnd(32)} rows ${String(rows).padStart(10)}  ` +
          `${(bytes / 1024 / 1024).toFixed(1).padStart(7)} MB  ` +
          (rows ? `${iso(first)} → ${iso(last)} (${hours.toFixed(1)} h)  ` : "") +
          `gaps ${gaps.length} (${gapMinutes.toFixed(1)} min)` +
          (hours > 0 ? `  ≈ ${((bytes / hours) * 24 / 1024 / 1024).toFixed(0)} MB/day` : "")
      );
    }
  }
})();
