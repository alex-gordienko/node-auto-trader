/**
 * Backtest of the trading logic on stored Binance data:
 *   yarn backtest
 *
 * Walk-forward over BACKTEST_HISTORY_DAYS of stored history: the part after the first training window is split into
 * periods of BACKTEST_EVAL_DAYS. Before each period the models are trained like the live bot retrains them: on the
 * last `trainingMinuteDays` before the period only, warm-started from the previous period. Then they trade the period. Decisions are made the same way as in the live bot, but orders are
 * simulated: they fill at the next minute's open, and every swap pays exchange fee + spread and a fixed network
 * fee. Models are saved to a separate folder (MODELS_DIR) so the production models are never overwritten.
 * "DQN + stop-crane" trades the same models through utils/kill-switch.ts like the live bot: at most 3 positions a
 * day, a stop closes the position, and a human is assumed to resume trading BACKTEST_RESUME_HOURS after each stop.
 */
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import MarketDataService from "../services/collectors/MarketData.service";
import TensorflowService from "../services/Tensorflow.service";
import { CryptoPairs } from "../types/basic.types";
import { IMarketDataset } from "../types/marketData.types";
import { IOHLCV } from "../utils/technical-indicators";
import { Colors, log } from "../utils/colored-console";
import { canOpen, checkMarket, createKillSwitch, recordClose, recordOpen, resumeKillSwitch } from "../utils/kill-switch";

const PAIR = CryptoPairs.ETH_USDT;
const HISTORY_DAYS = Number(process.env.BACKTEST_HISTORY_DAYS || 365);
const EVAL_DAYS = Number(process.env.BACKTEST_EVAL_DAYS || 30);
// the live bot retrains on this window, so the backtest does the same (rolling, not expanding)
const TRAIN_DAYS = cryptoConfig.marketData.trainingMinuteDays;
// episodes after the first period: the DQN continues from its previous weights, as in live retraining
const WARM_EPISODES = Number(process.env.BACKTEST_WARM_EPISODES || 20);
// candles before a period that are needed only to compute indicators and windows (hourly window ≈ 4 days)
const CONTEXT_DAYS = 7;
// the DQN decides (and the bot may trade) once per this many minutes, as in training and live trading
const DECISION_EVERY = cryptoConfig.rl.decisionMinutes;
const START_USDT = 1000;
// the bot's own minimum swap amount
const MIN_TRADE_USD = 15;
const RANDOM_RUNS = 1000;
const MINUTES_PER_YEAR = 525600;
const KILL_RULES = cryptoConfig.killSwitch;
const RESUME_AFTER_MS = Number(process.env.BACKTEST_RESUME_HOURS || 24) * 3600_000;

// Costs are unknown until real swaps are made, so every result is shown for three levels.
// tradeCostPct: exchange fee + spread as a share of the traded amount.
// gasUsd: fixed Ethereum network fee per swap.
const COSTS: ICost[] = [
  { name: "optimistic", tradeCostPct: 0.001, gasUsd: 0.5 },
  { name: "typical", tradeCostPct: 0.005, gasUsd: 2 },
  { name: "pessimistic", tradeCostPct: 0.01, gasUsd: 5 },
];

type Action = "Hold" | "Buy" | "Sell";

interface ICost {
  name: string;
  tradeCostPct: number;
  gasUsd: number;
}

interface IDecision {
  index: number; // candle the decision was made on; the order fills at index + 1 open
  action: Action;
  expectedMax: number;
  expectedMin: number;
}

interface IResult {
  name: string;
  final: number;
  returnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  costs: number;
  winRatePct: number;
  thirdsReturnPct: number[]; // return of each third of the evaluation period
}

// rows with from <= time < until
const cut = (d: IMarketDataset, until: number, from = 0): IMarketDataset => {
  const keep = <T extends { time: number }>(rows: T[]) => rows.filter((r) => r.time >= from && r.time < until);
  return {
    minute: keep(d.minute),
    hour: keep(d.hour),
    references: d.references.map((r) => ({ minute: keep(r.minute), hour: keep(r.hour) })),
    futures: keep(d.futures),
    funding: keep(d.funding),
    premium: { minute: keep(d.premium.minute), hour: keep(d.premium.hour) },
    coinbase: { minute: keep(d.coinbase.minute), hour: keep(d.coinbase.hour) },
    dvol: keep(d.dvol),
    stablecoins: keep(d.stablecoins),
    fearGreed: keep(d.fearGreed),
  };
};

/** Buy when the range forecast says the upside exceeds the round-trip cost; leave when it no longer does. */
const rangeRuleActions = (decisions: IDecision[], cost: ICost): Map<number, Action> => {
  const threshold = 2 * cost.tradeCostPct + (2 * cost.gasUsd) / START_USDT;
  const actions = new Map<number, Action>();
  let position = 0;
  for (const d of decisions) {
    if (position === 0 && d.expectedMax > threshold) {
      actions.set(d.index + 1, "Buy");
      position = 1;
    } else if (position === 1 && d.expectedMax < threshold) {
      actions.set(d.index + 1, "Sell");
      position = 0;
    }
  }
  return actions;
};

/** Executes orders at the open of the given candles and marks the portfolio to close every minute. */
const simulate = (candles: IOHLCV[], start: number, actions: Map<number, Action>, cost: ICost, name: string): IResult => {
  let usdt = START_USDT;
  let eth = 0;
  let costs = 0;
  let trades = 0;
  let closed = 0;
  let wins = 0;
  let entryUsdt = 0;
  const equity: number[] = [];

  const sell = (price: number) => {
    const proceeds = eth * price;
    const fee = proceeds * cost.tradeCostPct + cost.gasUsd;
    usdt = Math.max(0, proceeds - fee);
    costs += fee;
    eth = 0;
    trades++;
    closed++;
    if (usdt > entryUsdt) wins++;
  };

  for (let m = start; m < candles.length; m++) {
    const action = actions.get(m) ?? "Hold";
    const price = candles[m].open;

    if (action === "Buy" && eth === 0 && usdt >= MIN_TRADE_USD) {
      const fee = usdt * cost.tradeCostPct + cost.gasUsd;
      if (usdt > fee) {
        entryUsdt = usdt;
        eth = (usdt - fee) / price;
        costs += fee;
        usdt = 0;
        trades++;
      }
    } else if (action === "Sell" && eth > 0) {
      sell(price);
    }

    equity.push(usdt + eth * candles[m].close);
  }

  // the final position is converted to USDT, so every strategy pays for exiting too
  if (eth > 0) {
    sell(candles[candles.length - 1].close);
    equity[equity.length - 1] = usdt;
  }

  let peak = equity[0];
  let maxDrawdown = 0;
  const returns: number[] = [];
  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity[i]) / peak);
    if (i > 0 && equity[i - 1] > 0) returns.push(equity[i] / equity[i - 1] - 1);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(returns.length, 1);
  const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(returns.length - 1, 1));

  const thirds = [0, 1, 2].map((k) => {
    const from = Math.floor((equity.length * k) / 3);
    const to = Math.floor((equity.length * (k + 1)) / 3) - 1;
    return equity[from] > 0 ? (equity[to] / equity[from] - 1) * 100 : 0;
  });

  return {
    name,
    final: usdt,
    returnPct: (usdt / START_USDT - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(MINUTES_PER_YEAR) : 0,
    trades,
    costs,
    winRatePct: closed ? (wins / closed) * 100 : 0,
    thirdsReturnPct: thirds,
  };
};

interface IGuarded {
  actions: Map<number, Action>;
  stops: { at: string; reason: string }[];
  skippedBuys: number; // Buy decisions refused by the daily limit or a stop
}

/**
 * DQN decisions through the stop-crane. The DQN decides from the position it really holds, so the decisions are
 * made anew; equity and the pnl of each trade are counted at the `cost` level, like the live bot's own books.
 */
const guardedDqn = (pre: ReturnType<typeof TensorflowService.prepareBacktest>, start: number, cost: ICost): IGuarded => {
  const candles = pre.candles;
  const result: IGuarded = { actions: new Map(), stops: [], skippedBuys: 0 };
  let ks = createKillSwitch(START_USDT, candles[start].time * 1000);
  let usdt = START_USDT;
  let eth = 0;
  let entry = 0;
  let entryUsd = 0;
  for (let i = start; i < candles.length - 1; i += DECISION_EVERY) {
    const now = candles[i].time * 1000;
    const price = candles[i].close;
    if (ks.stopped && now - ks.stoppedAt >= RESUME_AFTER_MS) ks = resumeKillSwitch(ks, usdt + eth * price, now);
    const check = checkMarket(ks, { now, price, equity: usdt + eth * price }, KILL_RULES);
    ks = check.state;
    if (check.stop) result.stops.push({ at: new Date(now).toISOString(), reason: check.stop });

    // while stopped the models are not asked: the position is closed and nothing is opened
    let action: Action = ks.stopped ? "Sell" : TensorflowService.decideAt(pre, i, eth > 0 ? 1 : 0, entry).action;
    if (action === "Buy" && eth === 0 && !canOpen(ks, now, KILL_RULES).allowed) {
      result.skippedBuys++;
      action = "Hold";
    }

    // orders fill at the next minute's open, as in `simulate`
    const fill = candles[i + 1].open;
    if (action === "Buy" && eth === 0 && usdt >= MIN_TRADE_USD) {
      entryUsd = usdt;
      eth = (usdt - usdt * cost.tradeCostPct - cost.gasUsd) / fill;
      usdt = 0;
      entry = price;
      ks = recordOpen(ks, now);
      result.actions.set(i + 1, "Buy");
    } else if (action === "Sell" && eth > 0) {
      usdt = Math.max(0, eth * fill * (1 - cost.tradeCostPct) - cost.gasUsd);
      eth = 0;
      entry = 0;
      const closed = recordClose(ks, { now, pnl: usdt - entryUsd }, KILL_RULES);
      ks = closed.state;
      if (closed.stop) result.stops.push({ at: new Date(now).toISOString(), reason: closed.stop });
      result.actions.set(i + 1, "Sell");
    }
  }
  return result;
};

/** Most positions the strategy opened within one UTC day. */
const maxBuysPerDay = (candles: IOHLCV[], actions: Map<number, Action>): number => {
  const perDay = new Map<number, number>();
  for (const [m, action] of actions) {
    if (action !== "Buy") continue;
    const day = Math.floor(candles[m].time / 86400);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return Math.max(0, ...perDay.values());
};

const fmt = (v: number, digits = 2) => (v >= 0 ? "+" : "") + v.toFixed(digits);

const STRATEGIES = ["DQN", "DQN + stop-crane", "range rule", "buy & hold ETH", "hold USDT"];

interface IFoldCostResult {
  results: IResult[];
  shuffledMedian: number;
  dqnBeatsShuffledPct: number;
}

interface IFold {
  from: string;
  to: string;
  dqnOrders: number;
  dqnMaxBuysPerDay: number;
  guardedOrders: number;
  guardedMaxBuysPerDay: number;
  guardedSkippedBuys: number;
  stops: { at: string; reason: string }[];
  costs: Record<string, IFoldCostResult>;
}

/** Trains on everything before `evalStart` and trades [evalStart, evalEnd). */
const runFold = async (
  full: IMarketDataset,
  evalStart: number,
  evalEnd: number,
  n: number,
  folds: number
): Promise<IFold> => {
  // targets look up to the longest forecast horizon ahead: training stops that long before the period
  const embargo = cryptoConfig.forecast.horizons[cryptoConfig.forecast.horizons.length - 1] * 60;
  log(
    `\n[**] Period ${n}/${folds}: train on ${TRAIN_DAYS} days until ${new Date((evalStart - embargo) * 1000).toISOString()}, ` +
      `trade ${new Date(evalStart * 1000).toISOString()} – ${new Date(evalEnd * 1000).toISOString()}`,
    Colors.BLUE
  );

  const train = cut(full, evalStart - embargo, evalStart - embargo - TRAIN_DAYS * 86400);
  // hourly candles: the same window plus a few days so the first training samples have a full hourly window
  train.hour = full.hour.filter((h) => h.time >= evalStart - (TRAIN_DAYS + CONTEXT_DAYS) * 86400 && h.time < evalStart - embargo);
  train.references.forEach((r, i) => {
    r.hour = full.references[i].hour.filter((h) => h.time >= evalStart - (TRAIN_DAYS + CONTEXT_DAYS) * 86400 && h.time < evalStart - embargo);
  });
  await TensorflowService.trainModel(PAIR, train, []);

  const pre = TensorflowService.prepareBacktest(PAIR, cut(full, evalEnd, evalStart - CONTEXT_DAYS * 86400), evalStart);
  const start = pre.startIndex;

  // Decisions depend on the position, which only follows the actions themselves, so they are the same for every cost level.
  const decisions: IDecision[] = [];
  let position = 0;
  let entry = 0;
  for (let i = start; i < pre.candles.length - 1; i += DECISION_EVERY) {
    const d = TensorflowService.decideAt(pre, i, position, entry);
    decisions.push({ index: i, action: d.action, expectedMax: d.expectedMax, expectedMin: d.expectedMin });
    if (d.action === "Buy" && position === 0) {
      position = 1;
      entry = pre.candles[i].close;
    } else if (d.action === "Sell" && position === 1) {
      position = 0;
      entry = 0;
    }
  }

  const dqnActions = new Map<number, Action>();
  decisions.forEach((d) => d.action !== "Hold" && dqnActions.set(d.index + 1, d.action));

  // the stop-crane's books are kept at the typical cost level; its orders are then simulated at every level
  const guarded = guardedDqn(pre, start, COSTS[1]);

  const fold: IFold = {
    from: new Date(pre.candles[start].time * 1000).toISOString(),
    to: new Date(pre.candles[pre.candles.length - 1].time * 1000).toISOString(),
    dqnOrders: dqnActions.size,
    dqnMaxBuysPerDay: maxBuysPerDay(pre.candles, dqnActions),
    guardedOrders: guarded.actions.size,
    guardedMaxBuysPerDay: maxBuysPerDay(pre.candles, guarded.actions),
    guardedSkippedBuys: guarded.skippedBuys,
    stops: guarded.stops,
    costs: {},
  };

  for (const cost of COSTS) {
    const results = [
      simulate(pre.candles, start, dqnActions, cost, "DQN"),
      simulate(pre.candles, start, guarded.actions, cost, "DQN + stop-crane"),
      simulate(pre.candles, start, rangeRuleActions(decisions, cost), cost, "range rule"),
      simulate(pre.candles, start, new Map<number, Action>([[start, "Buy"]]), cost, "buy & hold ETH"),
      simulate(pre.candles, start, new Map(), cost, "hold USDT"),
    ];

    // same DQN decisions in random order: tests whether the timing of decisions matters at all
    const sequence = decisions.map((d) => d.action);
    const shuffledReturns: number[] = [];
    for (let run = 0; run < RANDOM_RUNS; run++) {
      for (let k = sequence.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [sequence[k], sequence[j]] = [sequence[j], sequence[k]];
      }
      const actions = new Map<number, Action>();
      decisions.forEach((d, k) => sequence[k] !== "Hold" && actions.set(d.index + 1, sequence[k]));
      shuffledReturns.push(simulate(pre.candles, start, actions, cost, "shuffled").returnPct);
    }
    const sorted = [...shuffledReturns].sort((a, b) => a - b);
    fold.costs[cost.name] = {
      results,
      shuffledMedian: sorted[Math.floor(RANDOM_RUNS / 2)],
      dqnBeatsShuffledPct: (shuffledReturns.filter((r) => r < results[0].returnPct).length / RANDOM_RUNS) * 100,
    };
  }

  // short per-period summary at the typical cost level
  const typical = fold.costs[COSTS[1].name];
  const bh = typical.results.find((r) => r.name === "buy & hold ETH")!.returnPct;
  log(
    `[**] Period ${n} (typical costs): ` +
      typical.results.map((r) => `${r.name} ${fmt(r.returnPct)}%`).join(", ") +
      ` | DQN orders ${fold.dqnOrders} (up to ${fold.dqnMaxBuysPerDay} buys a day), beats ${typical.dqnBeatsShuffledPct.toFixed(0)}% of random timings` +
      ` | with stop-crane ${fold.guardedOrders} orders (up to ${fold.guardedMaxBuysPerDay} buys a day, ${fold.guardedSkippedBuys} buys refused), ` +
      `stops: ${fold.stops.length ? fold.stops.map((x) => `${x.at.slice(0, 16)} ${x.reason}`).join("; ") : "none"}`,
    typical.results[0].returnPct > bh ? Colors.GREEN : Colors.YELLOW
  );
  return fold;
};

(async () => {
  if (!process.env.MODELS_DIR) {
    throw new Error("Run the backtest with `yarn backtest`: it sets MODELS_DIR to a separate model folder");
  }
  // models load asynchronously in the service constructor
  await new Promise((r) => setTimeout(r, 3000));

  const full = await MarketDataService.getTrainingDataset(PAIR, HISTORY_DAYS);
  const firstTime = full.minute[0].time;
  const lastTime = full.minute[full.minute.length - 1].time + 60;
  // first period starts once a full training window is available
  const availableDays = (lastTime - firstTime) / 86400 - TRAIN_DAYS - 1;
  const folds = Number(process.env.BACKTEST_FOLDS || Math.floor(availableDays / EVAL_DAYS));
  const firstEval = lastTime - folds * EVAL_DAYS * 86400;

  log(
    `[**] Walk-forward backtest ${PAIR}: ${folds} periods × ${EVAL_DAYS} days ` +
      `(${new Date(firstEval * 1000).toISOString().slice(0, 10)} – ${new Date(lastTime * 1000).toISOString().slice(0, 10)}), ` +
      `training window ${TRAIN_DAYS} days, decisions every ${DECISION_EVERY} min, models in ${process.env.MODELS_DIR}`,
    Colors.BLUE
  );

  const periods: IFold[] = [];
  for (let k = 0; k < folds; k++) {
    const from = firstEval + k * EVAL_DAYS * 86400;
    periods.push(await runFold(full, from, from + EVAL_DAYS * 86400, k + 1, folds));
    if (k === 0) cryptoConfig.rl.episodes = WARM_EPISODES;
  }

  // summary: all periods chained, as if the bot had traded them one after another
  const summary: Record<string, unknown> = {};
  for (const cost of COSTS) {
    log(
      `\n[**] All ${folds} periods, costs: ${cost.name} (${(cost.tradeCostPct * 100).toFixed(2)}% per swap + $${cost.gasUsd} network fee)`,
      Colors.WHITE
    );
    log(
      `${"strategy".padEnd(18)}${"total".padStart(9)}${"vs B&H".padStart(9)}${"worst DD".padStart(10)}` +
        `${"orders".padStart(8)}${"fees $".padStart(9)}${"beats B&H".padStart(11)}   per period (%)`,
      Colors.WHITE
    );

    const chained = (name: string) => {
      const perFold = periods.map((f) => f.costs[cost.name].results.find((r) => r.name === name)!);
      return {
        name,
        totalPct: (perFold.reduce((acc, r) => acc * (1 + r.returnPct / 100), 1) - 1) * 100,
        worstDrawdownPct: Math.max(...perFold.map((r) => r.maxDrawdownPct)),
        orders: perFold.reduce((acc, r) => acc + r.trades, 0),
        fees: perFold.reduce((acc, r) => acc + r.costs, 0),
        perPeriodPct: perFold.map((r) => r.returnPct),
      };
    };
    const rows = STRATEGIES.map(chained);
    const bh = rows.find((r) => r.name === "buy & hold ETH")!;
    for (const r of rows) {
      const beats = r.perPeriodPct.filter((v, k) => v > bh.perPeriodPct[k]).length;
      log(
        `${r.name.padEnd(18)}${fmt(r.totalPct).padStart(9)}${fmt(r.totalPct - bh.totalPct).padStart(9)}` +
          `${r.worstDrawdownPct.toFixed(2).padStart(10)}${String(r.orders).padStart(8)}${r.fees.toFixed(2).padStart(9)}` +
          `${`${beats}/${folds}`.padStart(11)}   ` +
          r.perPeriodPct.map((v) => fmt(v, 1)).join(" / "),
        r.name.startsWith("DQN") ? (r.totalPct > bh.totalPct ? Colors.GREEN : Colors.YELLOW) : Colors.WHITE
      );
    }
    const beatsRandom = periods.map((f) => f.costs[cost.name].dqnBeatsShuffledPct);
    log(`DQN vs random timing of the same actions, per period: ${beatsRandom.map((v) => `${v.toFixed(0)}%`).join(" / ")}`, Colors.WHITE);

    // rising vs falling markets: a useful strategy should keep most of the rise and avoid most of the fall
    const dqn = rows[0];
    for (const [label, rising] of [["rising", true], ["falling", false]] as [string, boolean][]) {
      const idx = bh.perPeriodPct.map((v, k) => ((v > 0) === rising ? k : -1)).filter((k) => k >= 0);
      if (!idx.length) continue;
      const avg = (values: number[]) => idx.reduce((acc, k) => acc + values[k], 0) / idx.length;
      log(
        `${label} market (${idx.length} periods): DQN avg ${fmt(avg(dqn.perPeriodPct))}% vs buy & hold ${fmt(avg(bh.perPeriodPct))}%, ` +
          `DQN better in ${idx.filter((k) => dqn.perPeriodPct[k] > bh.perPeriodPct[k]).length}/${idx.length}`,
        Colors.WHITE
      );
    }
    summary[cost.name] = { ...cost, strategies: rows, dqnBeatsShuffledPct: beatsRandom };
  }

  const allStops = periods.flatMap((f) => f.stops);
  log(
    `\n[**] Stop-crane: ${allStops.length} stops, ${periods.reduce((a, f) => a + f.guardedSkippedBuys, 0)} buys refused, ` +
      `most buys in a day ${Math.max(...periods.map((f) => f.guardedMaxBuysPerDay))} (without it ${Math.max(...periods.map((f) => f.dqnMaxBuysPerDay))}); ` +
      `resume ${RESUME_AFTER_MS / 3600_000} h after a stop, rules ${JSON.stringify(KILL_RULES)}`,
    Colors.WHITE
  );
  for (const x of allStops) log(`  ${x.at.slice(0, 16)} ${x.reason}`, Colors.WHITE);

  const dir = `${cryptoConfig.paths.storageDir}/backtest`;
  fse.ensureDirSync(dir);
  const file = `${dir}/${PAIR}-walkforward-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(
    file,
    { pair: PAIR, folds, evalDays: EVAL_DAYS, trainDays: TRAIN_DAYS, decisionMinutes: DECISION_EVERY, killSwitch: KILL_RULES, periods, summary },
    { spaces: 2 }
  );
  log(`\n[**] Report saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();
