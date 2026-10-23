/**
 * What is actually on disk under src/Storage/datasets: per source/symbol/series, the date range, row
 * count and fetch-quality signals (gaps, duplicate/out-of-order timestamps, zero-volume bars, price
 * outliers). Read-only — nothing here repairs or re-fetches data.
 *   yarn dataset:inventory
 */
import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";

const root = path.join(cryptoConfig.paths.storageDir, "datasets");

// nominal spacing between rows, used only to detect gaps — irregular series (funding) are skipped
const STEP_SECONDS: Record<string, number> = {
  "1m": 60,
  "1h": 3600,
  "premium-1m": 60,
  "premium-1h": 3600,
  "coinbase-1m": 60,
  "coinbase-1h": 3600,
  "futures-metrics": 300,
  "dvol-1h": 3600,
  "stablecoins-1d": 86400,
  "fear-greed-1d": 86400,
};

interface IRow {
  time: number;
  [key: string]: unknown;
}

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const subdirs = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** Reads every monthly file of a series back-to-back, in file order (each file is already sorted by time). */
const readSeries = (dir: string): { rows: IRow[]; files: string[] } => {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const rows: IRow[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      // storage format: [[time, row], ...] pairs (Local.storage.service writes Map entries)
      for (const entry of parsed) {
        rows.push(Array.isArray(entry) ? entry[1] : entry);
      }
    } catch (error) {
      console.log(`  !! ${file}: failed to parse (${(error as Error).message})`);
    }
  }
  return { rows, files: files.map((f) => path.join(dir, f)) };
};

/** Robust outlier check on bar-to-bar returns: median absolute deviation, flagged beyond 10x MAD. */
const countPriceOutliers = (rows: IRow[]): number => {
  const closes = rows.map((r) => Number(r.close)).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 3) return 0;
  const returns = closes.slice(1).map((c, i) => Math.abs(c / closes[i] - 1));
  const sorted = [...returns].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = returns.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] || 1e-9;
  return returns.filter((r) => Math.abs(r - median) > 10 * mad && r > 0.02).length;
};

const inspectSeries = (source: string, symbol: string, series: string, dir: string) => {
  const { rows, files } = readSeries(dir);
  if (!rows.length) {
    console.log(`${source}/${symbol}/${series}: 0 rows (${files.length} file(s))`);
    return;
  }

  const times = rows.map((r) => r.time);
  let duplicates = 0;
  let outOfOrder = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] === times[i - 1]) duplicates++;
    else if (times[i] < times[i - 1]) outOfOrder++;
  }

  const step = STEP_SECONDS[series];
  let gaps = 0;
  let missingBars = 0;
  if (step) {
    for (let i = 1; i < times.length; i++) {
      const diff = times[i] - times[i - 1];
      if (diff > step) {
        gaps++;
        missingBars += Math.round(diff / step) - 1;
      }
    }
  }

  const hasVolume = rows[0].volumefrom !== undefined;
  const zeroVolume = hasVolume ? rows.filter((r) => Number(r.volumefrom) === 0).length : 0;
  const hasClose = rows[0].close !== undefined;
  const outliers = hasClose ? countPriceOutliers(rows) : 0;

  let first = times[0];
  let last = times[0];
  for (const t of times) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  console.log(
    `${source}/${symbol}/${series}: ${rows.length} rows, ${files.length} file(s), ` +
      `${iso(first)} -> ${iso(last)}` +
      (step ? `  gaps=${gaps} (${missingBars} missing bars)` : "  gaps=n/a (irregular series)") +
      (duplicates ? `  DUPLICATES=${duplicates}` : "") +
      (outOfOrder ? `  OUT_OF_ORDER=${outOfOrder}` : "") +
      (hasVolume ? `  zero-volume=${zeroVolume}` : "") +
      (hasClose ? `  price-outliers=${outliers}` : "")
  );
};

(() => {
  if (!isDir(root)) {
    console.log(`Nothing at ${root} yet.`);
    return;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (!entry.isDirectory()) {
      if (entry.name.endsWith(".json")) {
        console.log(
          `(unrouted) ${entry.name}: not under a <source>/<symbol>/<series> folder — not reachable by any ` +
            `current collector, so it cannot be reproduced or kept up to date by this pipeline`
        );
      }
      continue;
    }

    const source = entry.name;
    for (const symbol of subdirs(entryPath)) {
      const symbolPath = path.join(entryPath, symbol);
      for (const series of subdirs(symbolPath)) {
        inspectSeries(source, symbol, series, path.join(symbolPath, series));
      }
    }
  }
})();
