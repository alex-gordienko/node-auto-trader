/**
 * 50/50 rebalancing on stored hourly ETH-USDT candles, with the bot's costs and stop-crane rules:
 *   yarn rebalance:backtest
 * src/Storage keeps about two years of hourly candles. For a longer history download it into a folder of its own
 * (the backfill rewrites month files the running bot reads) and point STORAGE_DIR there:
 *   STORAGE_DIR=<folder> REFERENCE_PAIRS=BTC-USDT yarn backfill:binance 1 3400
 *   STORAGE_DIR=<folder> yarn rebalance:backtest
 *
 * Compares band widths and how often the price is checked against buy & hold, then replays the configured setup
 * with the stop-crane on, as if a human resumed trading a week after every stop. Starts with a self-check of the
 * rules on made-up prices. The same code (utils/rebalance.ts) runs in the live bot.
 */
import assert from "assert";
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import StorageService from "../services/Local.storage.service";
import { CryptoPairs } from "../types/basic.types";
import { Colors, createLogger } from "../utils/colored-console";
import { createPortfolio, ethShare, IPaperPortfolio, IRebalanceConfig, portfolioValue, rebalanceStep, resumePortfolio } from "../utils/rebalance";

const log = createLogger("rebalance-backtest");

const PAIR = CryptoPairs.ETH_USDT;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const BANDS = [0.05, 0.075, 0.1, 0.15, 0.2];
const CHECK_HOURS = [1, 8, 24, 168];
const RESUME_AFTER_MS = 7 * DAY;

const config: IRebalanceConfig = {
  target: cryptoConfig.rebalance.target,
  band: cryptoConfig.rebalance.band,
  feeRate: cryptoConfig.rl.feeRate,
  gasUsd: cryptoConfig.rl.gasUsd,
  minTradeUsd: cryptoConfig.rebalance.minTradeUsd,
  stop: cryptoConfig.rebalance.stop,
};
const NO_STOPS: IRebalanceConfig["stop"] = { minShare: 0, maxShare: 1, maxDrawdown: 1, buysInARow: Infinity, maxTradesPerDay: Infinity, maxPriceJump: Infinity };

/** The rules on made-up prices: trades return the share to the target, every stop-crane rule fires when it should. */
const selfCheck = () => {
  const t = Date.UTC(2026, 0, 1);
  const cfg = { ...config, band: 0.1, stop: { ...config.stop, maxDrawdown: 1 } };
  const p = createPortfolio(1000, 100, t, cfg);
  assert(Math.abs(ethShare(p, 100) - 0.5) < 0.01, "starts at 50/50");

  const quiet = rebalanceStep(p, 120, t + 24 * HOUR, cfg);
  assert(!quiet.trade && !quiet.stop, "no trade inside the band");

  const sold = rebalanceStep(p, 160, t + 24 * HOUR, cfg);
  assert(sold.trade?.side === "sell" && !sold.stop, "sells after a rise");
  assert(Math.abs(ethShare(sold.portfolio, 160) - 0.5) < 0.01, "back to 50/50 after selling");

  // the price keeps falling: three purchases, and the third one stops the bot
  let q = sold.portfolio;
  const buys: string[] = [];
  for (const [i, price] of [100, 62, 38].entries()) {
    const step = rebalanceStep(q, price, t + (72 + i * 48) * HOUR, cfg);
    assert(step.trade?.side === "buy", `buys at ${price}`);
    q = step.portfolio;
    if (step.stop) buys.push(step.stop);
  }
  assert(buys.length === 1 && q.stopped, "stops after 3 purchases in a row");
  assert(!rebalanceStep(q, 20, t + 192 * HOUR, cfg).trade, "no trades while stopped");
  const resumed = rebalanceStep(resumePortfolio(q, 38, t + 200 * HOUR), 20, t + 240 * HOUR, cfg);
  assert(resumed.trade?.side === "buy" && !resumed.stop, "a resume starts the purchase count afresh");

  assert(rebalanceStep(p, 120, t + HOUR, cfg).stop?.includes("price changed"), "stops on a price jump between close checks");
  assert(!rebalanceStep(p, 120, t + 13 * HOUR, cfg).stop, "a big move after a long pause is not a jump");
  const skewed: IPaperPortfolio = { ...p, eth: p.eth * 5 };
  assert(rebalanceStep(skewed, 100, t + 24 * HOUR, cfg).stop?.includes("outside"), "stops on an 80/20 skew");
  const fixed = rebalanceStep(resumePortfolio(skewed, 100, t + 30 * HOUR), 100, t + 30 * HOUR, cfg);
  assert(fixed.trade?.side === "sell" && !fixed.stop, "after a resume a skew is traded back, not stopped again");
  assert(rebalanceStep(p, 30, t + 24 * HOUR, { ...cfg, stop: { ...cfg.stop, maxDrawdown: 0.3 } }).stop?.includes("below its peak"), "stops on a drawdown");
  const busy: IPaperPortfolio = { ...p, trades: [1, 2].map((h) => ({ at: t + h * HOUR, side: "sell" as const, price: 100, usd: 50, cost: 2 })) };
  assert(rebalanceStep(busy, 160, t + 13 * HOUR, cfg).stop?.includes("rebalances in the last 24 hours"), "stops on too many trades");
  log("self-check passed: trades return to 50/50, every stop-crane rule fires", Colors.GREEN);
};

interface IRun {
  values: { at: number; value: number }[];
  trades: number;
  costs: number;
  stops: { at: number; reason: string }[];
}

/** Checks the price every `everyHours` (at whole UTC hours); with stops, trading resumes a week after each stop. */
const run = (points: { at: number; price: number }[], cfg: IRebalanceConfig, everyHours: number): IRun => {
  let p = createPortfolio(cryptoConfig.rebalance.capitalUsd, points[0].price, points[0].at, cfg);
  const out: IRun = { values: [], trades: 0, costs: cryptoConfig.rebalance.capitalUsd - p.peakValue, stops: [] };
  for (const { at, price } of points) {
    if (p.stopped && at - p.lastCheckAt >= RESUME_AFTER_MS) p = resumePortfolio(p, price, at);
    if ((at / HOUR) % everyHours === 0) {
      const step = rebalanceStep(p, price, at, cfg);
      p = step.portfolio;
      if (step.trade) {
        out.trades++;
        out.costs += step.trade.cost;
      }
      if (step.stop) out.stops.push({ at, reason: step.stop });
    }
    if (at % DAY === 0) out.values.push({ at, value: portfolioValue(p, price) });
  }
  return out;
};

const summary = (values: { at: number; value: number }[]) => {
  const years = (values[values.length - 1].at - values[0].at) / (365 * DAY);
  let peak = 0;
  let drawdown = 0;
  const returns: number[] = [];
  const byYear = new Map<number, [number, number]>();
  values.forEach(({ at, value }, i) => {
    peak = Math.max(peak, value);
    drawdown = Math.min(drawdown, value / peak - 1);
    if (i) returns.push(Math.log(value / values[i - 1].value));
    const year = new Date(at).getUTCFullYear();
    byYear.set(year, [byYear.get(year)?.[0] ?? value, value]);
  });
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
  const worst = [...byYear].map(([year, [a, b]]) => [year, b / a - 1]).sort((x, y) => x[1] - y[1])[0];
  return {
    perYearPct: +((Math.pow(values[values.length - 1].value / values[0].value, 1 / years) - 1) * 100).toFixed(1),
    maxDrawdownPct: +(drawdown * 100).toFixed(0),
    sharpe: +((mean / sd) * Math.sqrt(365)).toFixed(2),
    worstYear: `${worst[0]} ${(worst[1] * 100).toFixed(0)}%`,
  };
};

(async () => {
  selfCheck();

  const candles = await StorageService.getCandles(PAIR, "hour");
  // a candle's close is the price at its end
  const all = candles.map((c) => ({ at: (c.time + 3600) * 1000, price: c.close })).filter((p) => p.price > 0);
  if (all.length < 24 * 365) {
    log(`only ${all.length} hourly candles in ${cryptoConfig.paths.storageDir}: download a longer history (see the header)`, Colors.RED);
    process.exit(1);
  }
  const periods: [string, typeof all][] = [
    ["all history", all],
    ["since 2019", all.filter((p) => p.at >= Date.UTC(2019, 0, 1))],
  ];
  const report: Record<string, unknown> = { config, from: all[0].at, to: all[all.length - 1].at };

  for (const [name, points] of periods) {
    const capital = cryptoConfig.rebalance.capitalUsd;
    const holdStart = capital - capital * config.feeRate - config.gasUsd;
    const hold = points.filter((p) => p.at % DAY === 0).map((p) => ({ at: p.at, value: (holdStart * p.price) / points[0].price }));
    const rows: Record<string, unknown>[] = [{ setup: "buy & hold", ...summary(hold), trades: 0, costsUsd: capital - holdStart }];
    for (const band of BANDS) {
      for (const everyHours of CHECK_HOURS) {
        const r = run(points, { ...config, band, stop: NO_STOPS }, everyHours);
        rows.push({ setup: `band ±${band * 100}, check every ${everyHours}h`, ...summary(r.values), trades: r.trades, costsUsd: +r.costs.toFixed(0) });
      }
    }
    log(`${name}: ${new Date(points[0].at).toISOString().slice(0, 10)} … ${new Date(points[points.length - 1].at).toISOString().slice(0, 10)}, no stop-crane`, Colors.WHITE);
    console.table(rows);
    report[name] = rows;
  }

  // the configured setup with the stop-crane on
  const everyHours = Math.max(1, Math.round(cryptoConfig.rebalance.checkMinutes / 60));
  const withStops = run(all, config, everyHours);
  const free = run(all, { ...config, stop: NO_STOPS }, everyHours);
  log(
    `configured setup (band ±${config.band * 100}, every ${everyHours}h): without stop-crane ${JSON.stringify(summary(free.values))}, ` +
      `with it (resumed a week after each stop) ${JSON.stringify(summary(withStops.values))}`,
    Colors.WHITE
  );
  withStops.stops.forEach((s) => log(`  stop ${new Date(s.at).toISOString().slice(0, 10)}: ${s.reason}`, Colors.YELLOW));
  report.stops = withStops.stops;

  const file = `${cryptoConfig.paths.storageDir}/rebalance-backtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(file, report, { spaces: 2 });
  log(`report saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();
