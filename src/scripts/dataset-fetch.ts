/**
 * Reproducible, explicitly-bounded fetch of one OHLCV window — independent of the live incremental
 * sync in MarketData.service.ts, which always walks forward from "now" and has no fixed end, so it
 * cannot be re-run later to reproduce a specific past window.
 *   yarn dataset:fetch --symbol=ETH-USDT --interval=minute --start=2025-01-01 --end=2025-01-02
 *
 * Writes the rows and a manifest (source, exact params, fetch timestamp, row count, content hash,
 * recorded command) under src/Storage/datasets/_fetches/<symbol>/<interval>/<start>_<end>.*.
 * Re-running with the same parameters re-fetches from Binance and compares the content hash against
 * the existing manifest: a match proves reproducibility; a mismatch is reported precisely (rows
 * added/removed/changed) and written to a separate conflict file — the existing data and manifest are
 * never silently overwritten.
 *
 * v1 covers Binance spot candles only (the "own" OHLCV series). Reference pairs, futures metrics,
 * funding, premium index, Coinbase, Deribit DVOL and the daily market-wide series are not yet
 * fetchable through this explicit-window path — see TRA-10 for the plan to extend it.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import BinanceClient from "../services/collectors/BinanceClient";
import { CandleTimeframe, IMarketCandle, MarketSymbol } from "../types/marketData.types";

const INTERVAL: Record<CandleTimeframe, string> = { minute: "1m", hour: "1h" };
const STEP_SECONDS: Record<CandleTimeframe, number> = { minute: 60, hour: 3600 };
const MAX_KLINES_PER_REQUEST = 1000;

// Binance kline row: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
type BinanceKline = (string | number)[];

const toCandle = (row: BinanceKline): IMarketCandle => ({
  time: BinanceClient.toSeconds(Number(row[0])),
  open: Number(row[1]),
  high: Number(row[2]),
  low: Number(row[3]),
  close: Number(row[4]),
  volumefrom: Number(row[5]),
  volumeto: Number(row[7]),
  trades: Number(row[8]),
  takerBuyBase: Number(row[9]),
  takerBuyQuote: Number(row[10]),
});

interface IArgs {
  symbol: MarketSymbol;
  interval: CandleTimeframe;
  startSec: number;
  endSec: number;
}

const parseArgs = (): IArgs => {
  const flags = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value];
    })
  );
  const symbol = flags.get("symbol") ?? "";
  const interval = flags.get("interval") as CandleTimeframe;
  const start = flags.get("start") ?? "";
  const end = flags.get("end") ?? "";
  const startSec = Math.floor(Date.parse(start) / 1000);
  const endSec = Math.floor(Date.parse(end) / 1000);

  if (!symbol || !STEP_SECONDS[interval] || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    console.error("Usage: yarn dataset:fetch --symbol=ETH-USDT --interval=minute|hour --start=YYYY-MM-DD --end=YYYY-MM-DD");
    process.exit(1);
  }
  return { symbol, interval, startSec, endSec };
};

/** Binance spot klines in [startSec, endSec), paginated — bounded on both ends (the live sync's fetchRange only bounds the start). */
const fetchBoundedRange = async (symbol: MarketSymbol, interval: CandleTimeframe, startSec: number, endSec: number): Promise<IMarketCandle[]> => {
  const step = STEP_SECONDS[interval];
  const result: IMarketCandle[] = [];
  let cursor = startSec;

  while (cursor < endSec) {
    const rows = await BinanceClient.getSpot<BinanceKline[]>("/api/v3/klines", {
      symbol: BinanceClient.symbol(symbol),
      interval: INTERVAL[interval],
      startTime: cursor * 1000,
      endTime: endSec * 1000 - 1,
      limit: MAX_KLINES_PER_REQUEST,
    });
    if (!rows) throw new Error(`Binance request failed at cursor ${new Date(cursor * 1000).toISOString()}`);
    if (!rows.length) break;

    result.push(...rows.map(toCandle).filter((c) => c.time >= startSec && c.time < endSec));
    cursor = BinanceClient.toSeconds(Number(rows[rows.length - 1][0])) + step;
    if (rows.length < MAX_KLINES_PER_REQUEST) break;
  }
  return result;
};

const contentHash = (rows: IMarketCandle[]): string => crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");

(async () => {
  const { symbol, interval, startSec, endSec } = parseArgs();
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date(endSec * 1000).toISOString();
  const base = `${startIso.slice(0, 10)}_${endIso.slice(0, 10)}`;
  const command = `yarn dataset:fetch --symbol=${symbol} --interval=${interval} --start=${startIso.slice(0, 10)} --end=${endIso.slice(0, 10)}`;

  console.log(`Fetching ${symbol} ${interval} candles from Binance spot REST, [${startIso}, ${endIso})`);
  const rows = await fetchBoundedRange(symbol, interval, startSec, endSec);
  rows.sort((a, b) => a.time - b.time);

  const dir = path.join(cryptoConfig.paths.storageDir, "datasets", "_fetches", symbol, interval);
  fs.mkdirSync(dir, { recursive: true });
  const dataFile = path.join(dir, `${base}.json`);
  const manifestFile = path.join(dir, `${base}.manifest.json`);

  const manifest = {
    symbol,
    interval,
    source: "binance-spot-rest",
    start: startIso,
    end: endIso,
    requestedAtUtc: new Date().toISOString(),
    rowCount: rows.length,
    contentSha256: contentHash(rows),
    command,
  };

  if (fs.existsSync(manifestFile)) {
    const previous = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    if (previous.contentSha256 === manifest.contentSha256) {
      const onDiskHash = fs.existsSync(dataFile) ? contentHash(JSON.parse(fs.readFileSync(dataFile, "utf-8"))) : null;
      if (onDiskHash !== manifest.contentSha256) {
        fs.writeFileSync(dataFile, JSON.stringify(rows));
        console.warn(
          `${dataFile} did not match its own manifest (missing, edited or corrupted on disk) — restored from a fresh ` +
            `re-fetch that reproduces the recorded hash.`
        );
      }
      console.log(`Reproducible: hash matches the manifest fetched at ${previous.requestedAtUtc} (${previous.rowCount} rows).`);
      return;
    }

    const previousRows: IMarketCandle[] = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    const byTime = new Map(previousRows.map((r) => [r.time, r]));
    let added = 0;
    let changed = 0;
    rows.forEach((row) => {
      const prior = byTime.get(row.time);
      if (!prior) added++;
      else if (JSON.stringify(prior) !== JSON.stringify(row)) changed++;
      byTime.delete(row.time);
    });
    const removed = byTime.size;

    const conflictFile = path.join(dir, `${base}.conflict-${Date.now()}.json`);
    fs.writeFileSync(
      conflictFile,
      JSON.stringify({ ...manifest, previousManifest: previous, diff: { added, removed, changed, previousRowCount: previousRows.length } }, null, 2)
    );
    console.error(
      `NOT REPRODUCIBLE: re-fetching ${symbol} ${interval} [${startIso}, ${endIso}) with the same parameters produced a ` +
        `different dataset than the one fetched at ${previous.requestedAtUtc}. added=${added} removed=${removed} changed=${changed} ` +
        `(was ${previousRows.length} rows, now ${rows.length}). Existing data and manifest left untouched; details in ${conflictFile}.`
    );
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(dataFile, JSON.stringify(rows));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${rows.length} rows to ${dataFile}\nManifest: ${manifestFile}`);
})();
