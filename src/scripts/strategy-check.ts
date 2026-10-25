/**
 * Checks daily ETH-USDT and BTC-USDT strategies against buy & hold after costs, with and without the guard (losing streak,
 * drawdown and crash-day rules from utils/daily-strategy.ts):
 *   STORAGE_DIR=<own folder> REFERENCE_PAIRS=BTC-USDT yarn backfill:binance 1 3400
 *   STORAGE_DIR=<same folder> npx ts-node --transpile-only src/scripts/strategy-check.ts
 * One decision a day at 00:00 UTC from hourly closes known by then (at most one trade a day, below the limit of 3).
 * Rules only, nothing is fitted, so the whole history is out of sample; results are averaged over the possible
 * first decision days and shown for the first and second half of the test period too.
 */
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import StorageService from "../services/Local.storage.service";
import { IMarketCandle } from "../types/marketData.types";
import { lastIndexAtOrBefore } from "../utils/tensorflow.helpers";
import { createLogger, Colors } from "../utils/colored-console";
import { IDailyBar, IGuardConfig, simulate, stats } from "../utils/daily-strategy";

const log = createLogger("strategy-check");

const DAY = 86400;
const HOUR = 3600;
const FIRST_TEST_DAY = Date.UTC(2019, 0, 1) / 1000;
const SPLIT_DAY = Date.UTC(2023, 0, 1) / 1000;
// Binance spot fee + spread, and the current bot (ChangeNow + Ethereum gas)
const COSTS = [0.001, 0.007];
// ETH's own volatility is ~80% a year: sizing to 60% keeps about three quarters of the position on calm days
const TARGET_VOLATILITY = 0.6;
const GUARDS: Record<string, IGuardConfig | null> = {
  "no guard": null,
  "guard DD 35%": { lossesInARow: 3, maxDrawdown: 0.35, maxDayMove: 0.15, pauseDays: 14 },
  "guard DD 20%": { lossesInARow: 3, maxDrawdown: 0.2, maxDayMove: 0.15, pauseDays: 14 },
};

interface IStrategy {
  name: string;
  coins: ("ETH" | "BTC")[];
  signal: SignalName; // wanted coin share per bar
  step: number; // days between decisions
  minChange: number;
}

const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

const dailyBars = async (symbol: "ETH-USDT" | "BTC-USDT"): Promise<IDailyBar[]> => {
  const candles = await StorageService.getCandles(symbol, "hour");
  if (!candles.length || candles[0].time > FIRST_TEST_DAY - 200 * DAY) {
    throw new Error(`Needs hourly ${symbol} since mid-2018 in ${cryptoConfig.paths.storageDir}: run the backfill from the header`);
  }
  // a close is known when its candle ends
  const times = candles.map((c: IMarketCandle) => c.time + HOUR);
  const closes = candles.map((c) => c.close);
  const bars: IDailyBar[] = [];
  for (let t = Math.ceil(times[0] / DAY) * DAY; t <= times[times.length - 1]; t += DAY) bars.push({ t, price: closes[lastIndexAtOrBefore(times, t)] });
  return bars;
};

/** The signals of one coin, from prices known at each decision. */
const signalsOf = (bars: IDailyBar[]) => {
  const trend = (days: number) => bars.map((b, k) => (k >= days ? Number(b.price > bars[k - days].price) : NaN));
  const volatility = bars.map((_, k) => {
    if (k < 30) return NaN;
    let sum = 0;
    for (let j = k - 29; j <= k; j++) sum += Math.log(bars[j].price / bars[j - 1].price) ** 2;
    return Math.sqrt((sum / 30) * 365);
  });
  const t21 = trend(21);
  const t30 = trend(30);
  const t45 = trend(45);
  const vote = bars.map((_, k) => (t21[k] + t30[k] + t45[k]) / 3);
  // every lookback votes: 30d alone is a peak among its neighbours (14–120d), the vote does not depend on picking it
  const lookbacks = [10, 14, 21, 30, 45, 60, 90, 120].map(trend);
  const voteAll = bars.map((_, k) => (k >= 120 ? mean(lookbacks.map((t) => t[k])) : NaN));
  const volSized = (signal: number[]) => signal.map((s, k) => s * Math.min(1, TARGET_VOLATILITY / volatility[k]));
  return { hold: bars.map(() => 1), t30, vote, voteAll, t30Vol: volSized(t30), voteVol: volSized(vote) };
};
type SignalName = keyof ReturnType<typeof signalsOf>;

(async () => {
  const eth = await dailyBars("ETH-USDT");
  const btc = await dailyBars("BTC-USDT");
  // both coins on the same days
  const from = Math.max(eth[0].t, btc[0].t);
  const to = Math.min(eth[eth.length - 1].t, btc[btc.length - 1].t);
  const coins = { ETH: eth.filter((b) => b.t >= from && b.t <= to), BTC: btc.filter((b) => b.t >= from && b.t <= to) };
  const all = coins.ETH;
  const signals = { ETH: signalsOf(coins.ETH), BTC: signalsOf(coins.BTC) };
  const first = all.findIndex((b) => b.t >= FIRST_TEST_DAY);

  // a 50/50 portfolio is two halves, each traded on its own coin's signal (up to 2 swaps a day)
  const strategies: IStrategy[] = [
    { name: "ETH buy & hold", coins: ["ETH"], signal: "hold", step: 1, minChange: 0 },
    { name: "ETH trend 30d, 3d", coins: ["ETH"], signal: "t30", step: 3, minChange: 0 },
    { name: "ETH trend 30d, 1d", coins: ["ETH"], signal: "t30", step: 1, minChange: 0 },
    { name: "ETH vote 21/30/45, 3d", coins: ["ETH"], signal: "vote", step: 3, minChange: 0.3 },
    { name: "ETH trend 30d + vol, 3d", coins: ["ETH"], signal: "t30Vol", step: 3, minChange: 0.2 },
    { name: "BTC buy & hold", coins: ["BTC"], signal: "hold", step: 1, minChange: 0 },
    { name: "BTC trend 30d, 3d", coins: ["BTC"], signal: "t30", step: 3, minChange: 0 },
    { name: "50/50 buy & hold", coins: ["ETH", "BTC"], signal: "hold", step: 1, minChange: 0 },
    { name: "50/50 trend 30d, 3d", coins: ["ETH", "BTC"], signal: "t30", step: 3, minChange: 0 },
    { name: "50/50 trend 30d, 1d", coins: ["ETH", "BTC"], signal: "t30", step: 1, minChange: 0 },
    { name: "50/50 vote 10–120d, 3d", coins: ["ETH", "BTC"], signal: "voteAll", step: 3, minChange: 0.25 },
    { name: "50/50 trend + vol, 3d", coins: ["ETH", "BTC"], signal: "t30Vol", step: 3, minChange: 0.2 },
    { name: "50/50 vote + vol, 3d", coins: ["ETH", "BTC"], signal: "voteVol", step: 3, minChange: 0.2 },
  ];

  const periods = [
    { name: "2019+", from: first, to: all.length },
    { name: "2019–2022", from: first, to: all.findIndex((b) => b.t >= SPLIT_DAY) },
    { name: "2023+", from: all.findIndex((b) => b.t >= SPLIT_DAY), to: all.length },
  ];

  const results = strategies.flatMap((strategy) =>
    COSTS.flatMap((cost) =>
      Object.entries(GUARDS).map(([guardName, guard]) => {
        const byPeriod = periods.map((period) => {
          const bars = all.slice(period.from, period.to);
          const runs = Array.from({ length: strategy.step }, (_, offset) => {
            const sims = strategy.coins.map((coin) =>
              simulate(coins[coin].slice(period.from, period.to), signals[coin][strategy.signal].slice(period.from, period.to), {
                cost,
                minChange: strategy.minChange,
                step: strategy.step,
                offset,
                guard,
              })
            );
            const equity = bars.map((_, k) => mean(sims.map((sim) => sim.equity[k])));
            const swaps = sims.reduce((s, sim) => s + sim.swaps, 0);
            const positions = sims.reduce((s, sim) => s + sim.positions, 0);
            return {
              stats: stats(bars, equity, swaps),
              inMarket: mean(sims.map((sim) => sim.inMarket)),
              losingShare: positions ? sims.reduce((s, sim) => s + sim.losingPositions, 0) / positions : 0,
              stops: sims.flatMap((sim) => sim.stops),
            };
          });
          const avg = (pick: (r: (typeof runs)[number]) => number) => mean(runs.map(pick));
          return {
            period: period.name,
            cagr: avg((r) => r.stats.cagr),
            total: avg((r) => r.stats.total),
            worstStart: Math.min(...runs.map((r) => r.stats.total)),
            maxDrawdown: avg((r) => r.stats.maxDrawdown),
            sharpe: avg((r) => r.stats.sharpe),
            swapsPerYear: avg((r) => r.stats.swapsPerYear),
            inMarket: avg((r) => r.inMarket),
            losingShare: avg((r) => r.losingShare),
            stops: avg((r) => r.stops.length),
            stopReasons: runs[0].stops.map((s) => `${date(s.t)} ${s.reason}`),
            years: runs[0].stats.years,
          };
        });
        return { strategy: strategy.name, cost, guard: guardName, periods: byPeriod };
      })
    )
  );

  log(`ETH-USDT and BTC-USDT daily bars ${date(all[first].t)} … ${date(all[all.length - 1].t)} (${all.length - first} days)`, Colors.WHITE);
  for (const cost of COSTS) {
    log(`\ncost ${(cost * 100).toFixed(1)}% per swap; per year, max drawdown, Sharpe; halves 2019–2022 / 2023+`, Colors.CYAN);
    log(
      `${"strategy".padEnd(22)}${"guard".padEnd(14)}${"CAGR".padStart(7)}${"max DD".padStart(8)}${"Sharpe".padStart(8)}` +
        `${"swaps/y".padStart(9)}${"in ETH".padStart(8)}${"stops".padStart(7)}${"halves CAGR".padStart(16)}`,
      Colors.WHITE
    );
    const hold = (name: string) => results.find((r) => r.strategy === `${name.split(" ")[0]} buy & hold` && r.cost === cost)!.periods[0];
    results
      .filter((r) => r.cost === cost && (!r.strategy.endsWith("buy & hold") || r.guard === "no guard"))
      .forEach((r) => {
        const [whole, a, b] = r.periods;
        const bh = hold(r.strategy);
        log(
          `${r.strategy.padEnd(22)}${r.guard.padEnd(14)}${pct(whole.cagr).padStart(7)}${pct(-whole.maxDrawdown).padStart(8)}` +
            `${whole.sharpe.toFixed(2).padStart(8)}${whole.swapsPerYear.toFixed(0).padStart(9)}${pct(whole.inMarket).padStart(8)}` +
            `${whole.stops.toFixed(1).padStart(7)}${`${pct(a.cagr)} / ${pct(b.cagr)}`.padStart(16)}`,
          whole.sharpe > bh.sharpe && whole.maxDrawdown < bh.maxDrawdown ? Colors.GREEN : Colors.WHITE
        );
      });
  }
  log(`green = better Sharpe and smaller drawdown than buy & hold of the same coins at the same cost`, Colors.WHITE);

  const file = `${cryptoConfig.paths.storageDir}/strategy-check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(
    file,
    { from: date(all[first].t), to: date(all[all.length - 1].t), costs: COSTS, guards: GUARDS, targetVolatility: TARGET_VOLATILITY, results },
    { spaces: 2 }
  );
  log(`report saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();
