/**
 * Is there a signal about the coming price move in the recorded order books, trades and liquidations?
 *   yarn signal:orderflow
 *
 * Builds simple order-flow features per second from src/Storage/collectors and measures their correlation (IC)
 * with the future futures mid-price move at several horizons. Every feature uses only data up to that second.
 * The data is also split in two halves: a real signal keeps its sign in both. No model is trained.
 */
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import { readStream } from "../services/collectors/collector.reader";
import { correlation } from "../utils/tensorflow.helpers";
import { createLogger, Colors } from "../utils/colored-console";

const log = createLogger("orderflow-signal");

const SYMBOL = "ETH-USDT";
const BINANCE_SYMBOL = "ETHUSDT";
const HORIZONS_SECONDS = [10, 60, 300, 900, 3600];
// one sample every 10 s: neighbouring seconds are nearly identical
const SAMPLE_STEP = 10;
// with ~50 feature × horizon checks, a |t| of 3 is the bar for "not chance"
const SIGNIFICANT_T = 3;

type Level = [number, number];
type DepthRow = [number, number | null, Level[], Level[]];
type TradeRow = [number, number, number, number];
type LiquidationRow = [number, string, string, number, number, number];

interface IBook {
  mid: number;
  imbalance1: number;
  imbalance5: number;
  imbalance20: number;
  micropriceBps: number;
}

const imbalance = (bids: Level[], asks: Level[], levels: number) => {
  const b = bids.slice(0, levels).reduce((sum, [, q]) => sum + q, 0);
  const a = asks.slice(0, levels).reduce((sum, [, q]) => sum + q, 0);
  return b + a > 0 ? (b - a) / (b + a) : 0;
};

/** Per-second order book state (last snapshot of the second), by event time when the stream has one. */
const readBooks = async (stream: string): Promise<Map<number, IBook>> => {
  const books = new Map<number, IBook>();
  for await (const [receivedAt, eventTime, bids, asks] of readStream<DepthRow>(stream)) {
    if (!bids.length || !asks.length) continue;
    const [bidPrice, bidQty] = bids[0];
    const [askPrice, askQty] = asks[0];
    const mid = (bidPrice + askPrice) / 2;
    // microprice: the mid shifted toward the side with less quantity waiting
    const microprice = (bidPrice * askQty + askPrice * bidQty) / (bidQty + askQty);
    books.set(Math.floor((eventTime ?? receivedAt) / 1000), {
      mid,
      imbalance1: imbalance(bids, asks, 1),
      imbalance5: imbalance(bids, asks, 5),
      imbalance20: imbalance(bids, asks, 20),
      micropriceBps: ((microprice - mid) / mid) * 1e4,
    });
  }
  return books;
};

/** Per-second aggressive buy and sell volume. */
const readTrades = async (stream: string): Promise<Map<number, { buy: number; sell: number }>> => {
  const seconds = new Map<number, { buy: number; sell: number }>();
  for await (const [time, , qty, buyerIsMaker] of readStream<TradeRow>(stream)) {
    const second = Math.floor(time / 1000);
    const bucket = seconds.get(second) ?? { buy: 0, sell: 0 };
    // buyer is maker = the seller hit the bid (aggressive sell)
    if (buyerIsMaker) bucket.sell += qty;
    else bucket.buy += qty;
    seconds.set(second, bucket);
  }
  return seconds;
};

/** Per-second liquidated USD: ETH longs (side SELL), ETH shorts (side BUY), and the whole market. */
const readLiquidations = async () => {
  const seconds = new Map<number, { ethLong: number; ethShort: number; all: number }>();
  for await (const [time, symbol, side, , avgPrice, qty] of readStream<LiquidationRow>("ALL/futures-liquidations")) {
    const second = Math.floor(time / 1000);
    const bucket = seconds.get(second) ?? { ethLong: 0, ethShort: 0, all: 0 };
    const usd = avgPrice * qty;
    bucket.all += usd;
    if (symbol === BINANCE_SYMBOL) {
      if (side === "SELL") bucket.ethLong += usd;
      else bucket.ethShort += usd;
    }
    seconds.set(second, bucket);
  }
  return seconds;
};

/** Sum of a per-second value over (t − window, t]. */
const windowSum = <T>(map: Map<number, T>, t: number, window: number, pick: (v: T) => number) => {
  let sum = 0;
  for (let s = t - window + 1; s <= t; s++) {
    const v = map.get(s);
    if (v) sum += pick(v);
  }
  return sum;
};

/** The book at second t, or the latest one at most 2 s before it. */
const bookAt = (books: Map<number, IBook>, t: number) => books.get(t) ?? books.get(t - 1) ?? books.get(t - 2);

(async () => {
  log(`reading recorded data from ${cryptoConfig.collectors.storageDir}`, Colors.BLUE);
  const futuresBooks = await readBooks(`${SYMBOL}/futures-depth`);
  const spotBooks = await readBooks(`${SYMBOL}/spot-depth`);
  const futuresTrades = await readTrades(`${SYMBOL}/futures-trades`);
  const spotTrades = await readTrades(`${SYMBOL}/spot-trades`);
  const liquidations = await readLiquidations();
  log(
    `futures books ${futuresBooks.size}, spot books ${spotBooks.size}, futures trade seconds ${futuresTrades.size}, ` +
      `spot trade seconds ${spotTrades.size}, liquidation seconds ${liquidations.size}`,
    Colors.BLUE
  );

  const flow = (map: Map<number, { buy: number; sell: number }>, t: number, window: number) => {
    const buy = windowSum(map, t, window, (v) => v.buy);
    const sell = windowSum(map, t, window, (v) => v.sell);
    return buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
  };

  const features: Record<string, (t: number, book: IBook) => number | null> = {
    "book imbalance L1 (fut)": (_, b) => b.imbalance1,
    "book imbalance L5 (fut)": (_, b) => b.imbalance5,
    "book imbalance L20 (fut)": (_, b) => b.imbalance20,
    "book imbalance L5 (spot)": (t) => bookAt(spotBooks, t)?.imbalance5 ?? null,
    "microprice − mid (fut)": (_, b) => b.micropriceBps,
    "trade flow 10s (fut)": (t) => flow(futuresTrades, t, 10),
    "trade flow 60s (fut)": (t) => flow(futuresTrades, t, 60),
    "trade flow 300s (fut)": (t) => flow(futuresTrades, t, 300),
    "trade flow 60s (spot)": (t) => flow(spotTrades, t, 60),
    "ETH liq. longs−shorts 5m": (t) => {
      const long = windowSum(liquidations, t, 300, (v) => v.ethLong);
      const short = windowSum(liquidations, t, 300, (v) => v.ethShort);
      return Math.sign(short - long) * Math.log1p(Math.abs(short - long));
    },
    "all-market liq. 5m (log $)": (t) => Math.log1p(windowSum(liquidations, t, 300, (v) => v.all)),
    "futures − spot (bps)": (t, b) => {
      const spot = bookAt(spotBooks, t);
      return spot ? ((b.mid - spot.mid) / spot.mid) * 1e4 : null;
    },
    "past 60s return (momentum)": (t, b) => {
      const past = bookAt(futuresBooks, t - 60);
      return past ? Math.log(b.mid / past.mid) * 1e4 : null;
    },
  };

  const seconds = Array.from(futuresBooks.keys()).sort((a, b) => a - b);
  const first = seconds[0];
  const last = seconds[seconds.length - 1];
  const middle = first + (last - first) / 2;
  log(
    `period ${new Date(first * 1000).toISOString()} → ${new Date(last * 1000).toISOString()} ` +
      `(${((last - first) / 86400).toFixed(1)} days), sample every ${SAMPLE_STEP}s`,
    Colors.BLUE
  );

  const names = Object.keys(features);
  const results: Record<string, Record<number, { ic: number; t: number; icFirst: number; icSecond: number; n: number }>> = {};

  for (const horizon of HORIZONS_SECONDS) {
    const xs: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
    const ys: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
    const halves: Record<string, boolean[]> = Object.fromEntries(names.map((n) => [n, []]));

    for (let t = first; t + horizon <= last; t += SAMPLE_STEP) {
      const book = futuresBooks.get(t);
      const future = bookAt(futuresBooks, t + horizon);
      if (!book || !future) continue;
      const target = Math.log(future.mid / book.mid) * 1e4;
      for (const name of names) {
        const value = features[name](t, book);
        if (value === null || !Number.isFinite(value)) continue;
        xs[name].push(value);
        ys[name].push(target);
        halves[name].push(t < middle);
      }
    }

    for (const name of names) {
      const x = xs[name];
      const y = ys[name];
      const ic = correlation(x, y);
      // samples closer than the horizon share part of their future move
      const nEff = x.length / Math.max(1, horizon / SAMPLE_STEP);
      const t = nEff > 3 && Math.abs(ic) < 1 ? (ic * Math.sqrt(nEff - 2)) / Math.sqrt(1 - ic * ic) : 0;
      const part = (inFirst: boolean) => {
        const idx = halves[name].map((h, i) => (h === inFirst ? i : -1)).filter((i) => i >= 0);
        return correlation(
          idx.map((i) => x[i]),
          idx.map((i) => y[i])
        );
      };
      results[name] ??= {};
      results[name][horizon] = { ic, t, icFirst: part(true), icSecond: part(false), n: x.length };
    }
  }

  const label = (s: number) => (s < 60 ? `${s}s` : `${s / 60}m`);
  log(`\nIC of each feature with the futures price move that follows (t-statistic in brackets)`, Colors.WHITE);
  log(`${"feature".padEnd(28)}${HORIZONS_SECONDS.map((h) => label(h).padStart(17)).join("")}`, Colors.WHITE);
  for (const name of names) {
    const cells = HORIZONS_SECONDS.map((h) => {
      const r = results[name][h];
      return `${r.ic >= 0 ? "+" : ""}${r.ic.toFixed(3)} (${r.t.toFixed(1)})`.padStart(17);
    });
    const strong = HORIZONS_SECONDS.some((h) => {
      const r = results[name][h];
      return Math.abs(r.t) >= SIGNIFICANT_T && Math.sign(r.icFirst) === Math.sign(r.icSecond);
    });
    log(`${name.padEnd(28)}${cells.join("")}`, strong ? Colors.GREEN : Colors.WHITE);
  }
  log(
    `green = |t| ≥ ${SIGNIFICANT_T} at some horizon and the same sign in both halves of the data; ` +
      `IC ±0.05 on minutes is already a usable signal for trading`,
    Colors.WHITE
  );

  const file = `${cryptoConfig.paths.storageDir}/orderflow-signal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(file, { symbol: SYMBOL, from: first, to: last, sampleStep: SAMPLE_STEP, results }, { spaces: 2 });
  log(`report saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();
