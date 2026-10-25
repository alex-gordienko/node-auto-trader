import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import BinanceClient from "./collectors/BinanceClient";
import MarketDataService from "./collectors/MarketData.service";
import StorageService from "./Local.storage.service";
import { Colors, createLogger } from "../utils/colored-console";
import { canOpen, checkMarket, createKillSwitch, IKillSwitchRules, IKillSwitchState, recordClose, recordOpen, resumeKillSwitch } from "../utils/kill-switch";
import {
  entrySide,
  entryThreshold,
  HISTORY_MINUTES,
  horizonFeatures,
  IHorizonModel,
  PER_DAY,
  predictHorizon,
  STEP_MINUTES,
  THRESHOLD_DAYS,
} from "../utils/horizon-model";

const log = createLogger("horizon");

const MIN = 60_000;
const DAY = 86_400_000;
const STEP = STEP_MINUTES * MIN;
const SYMBOL = "ETH-USDT";
const OTHER = "BTC-USDT";

interface IPosition {
  side: number; // 1 long, −1 short (simulated)
  entryAt: number;
  entryPrice: number;
  exitAt: number;
  capital: number; // USDT committed, after the entry costs
}

export interface IHorizonTrade {
  side: number;
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number; // USDT, net of fees and slippage on both sides
  ret: number; // pnl / capital before entry costs
}

interface ILeg {
  equity: number; // USDT while flat
  position: IPosition | null;
  trades: IHorizonTrade[];
}

export interface IHorizonTrack {
  name: string;
  model: string;
  mode: "long" | "ls";
  startedAt: number;
  startPrice: number; // ETH, for buy & hold since the start
  voteStartValue: number | null; // the vote paper portfolio at this track's start, to compare over the same days
  capitalUsd: number;
  lastDecision: number; // decision time (ms) last acted on
  lastSummaryDay: number;
  gated: ILeg; // through the stop-crane
  shadow: ILeg & { day: number; entriesToday: number }; // the same rule without the stop-crane, to judge the model itself
  killSwitch: IKillSwitchState;
}

/**
 * Paper trading of the horizon-search candidates (config `horizon`): no real orders. Every 5 minutes the models score
 * ETH from stored 1m candles; a track enters at the current Binance price when the newest score is beyond its causal
 * threshold (quantile of the previous 30 days' scores), at most 3 entries a UTC day and one position at a time, and
 * exits after the model's horizon. Costs: fee + slippage per side. State: src/Storage/trading/horizon-<track>-paper.json,
 * scores: horizon-scores.json.
 *
 * Each track has its own stop-crane (utils/kill-switch.ts, rules = AI limits with the vote's crash/drawdown levels):
 * a stop closes the position and writes src/Storage/trading/horizon-<track>-STOP — delete it to resume. A track's stop
 * never stops the vote: an experiment must not halt the main strategy. The bot-wide STOP file does stop the tracks.
 */
class HorizonTraderService {
  private readonly dir = path.join(cryptoConfig.paths.storageDir, "trading");
  private readonly scoresFile = path.join(this.dir, "horizon-scores.json");
  private readonly globalStop = path.join(this.dir, "STOP");
  private models = new Map<string, IHorizonModel>();
  private running = false;
  private warned = false;

  private trackFile = (name: string) => path.join(this.dir, `horizon-${name}-paper.json`);
  public stopFile = (name: string) => path.join(this.dir, `horizon-${name}-STOP`);

  private get rules(): IKillSwitchRules {
    return { ...cryptoConfig.killSwitch, ...cryptoConfig.horizon.killSwitch };
  }

  private write(file: string, data: unknown) {
    fs.mkdirSync(this.dir, { recursive: true });
    // write + rename: a process killed mid-write must not leave a cut file
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }

  private read<T>(file: string): T | null {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
  }

  private loadModels(): boolean {
    for (const { model } of cryptoConfig.horizon.tracks) {
      if (this.models.has(model)) continue;
      const file = path.join(cryptoConfig.paths.modelsDir, "horizon", `${model}.json`);
      if (!fs.existsSync(file)) {
        if (!this.warned) log(`no model ${file}: run research/horizon/export.py, horizon paper trading is off until then`, Colors.YELLOW);
        this.warned = true;
        return false;
      }
      const m: IHorizonModel = JSON.parse(fs.readFileSync(file, "utf-8"));
      this.models.set(model, m);
      log(`model ${model}: ${m.kind}, horizon ${m.horizonMinutes / 60} h, trained through ${m.trainedThrough}`, Colors.CYAN);
    }
    return true;
  }

  private async price(symbol: string): Promise<number | null> {
    const ticker = await BinanceClient.getSpot<{ price: string }>("/api/v3/ticker/price", { symbol: symbol.replace("-", "") });
    const price = Number(ticker?.price);
    return price > 0 ? price : null;
  }

  /** Value of the vote paper portfolio (VoteTrader) at these prices; null without it. */
  public voteValue(prices: Record<string, number>): number | null {
    const vote = this.read<{ legs: Record<string, { qty: number; usdt: number }> }>(path.join(this.dir, "vote-paper.json"));
    if (!vote) return null;
    return Object.entries(vote.legs).reduce((s, [coin, leg]) => s + leg.qty * (prices[coin] ?? NaN) + leg.usdt, 0);
  }

  /** Scores every 5-minute decision time from `from` to `to` (ms) from stored candles. */
  private async score(from: number, to: number): Promise<Record<string, { t: number; s: number }[]>> {
    const since = Math.floor((from - (HISTORY_MINUTES + STEP_MINUTES) * MIN) / 1000);
    const toBars = (rows: Awaited<ReturnType<typeof StorageService.getCandles>>) =>
      rows.map((c) => ({ t: c.time * 1000, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volumefrom, tbv: c.takerBuyBase ?? NaN }));
    const minutes = toBars(await StorageService.getCandles(SYMBOL, "minute", since)).filter((b) => b.t < to);
    const other = (await StorageService.getCandles(OTHER, "minute", since)).map((c) => ({ t: c.time * 1000, c: c.close }));
    // daily close = close of the 23:00 hourly candle, known at 00:00 UTC; the trend vote needs 120 of them
    const hours = await StorageService.getCandles(SYMBOL, "hour", Math.floor((from - 160 * DAY) / 1000));
    const dailyCloses = hours.filter((c) => (c.time + 3600) % 86400 === 0).map((c) => ({ t: (c.time + 3600) * 1000, c: c.close }));
    const funding = (await StorageService.getSeries<{ time: number; rate: number }>(SYMBOL, "funding", Math.floor((from - 10 * DAY) / 1000))).map(
      (f) => ({ t: f.time * 1000, rate: f.rate })
    );
    const times: number[] = [];
    for (let t = from; t <= to; t += STEP) times.push(t);
    const X = horizonFeatures({ minutes, other, dailyCloses, funding }, times);
    const out: Record<string, { t: number; s: number }[]> = {};
    for (const [name, model] of this.models) out[name] = times.map((t, i) => ({ t, s: predictHorizon(model, X[i]) })).filter((p) => Number.isFinite(p.s));
    return out;
  }

  private newTrack(cfg: { name: string; model: string; mode: "long" | "ls" }, now: number, price: number, vote: number | null): IHorizonTrack {
    const capital = cryptoConfig.horizon.capitalUsd;
    return {
      ...cfg,
      startedAt: now,
      startPrice: price,
      voteStartValue: vote,
      capitalUsd: capital,
      lastDecision: 0,
      lastSummaryDay: Math.floor(now / DAY),
      gated: { equity: capital, position: null, trades: [] },
      shadow: { equity: capital, position: null, trades: [], day: Math.floor(now / DAY), entriesToday: 0 },
      killSwitch: createKillSwitch(capital, now),
    };
  }

  private cost() {
    return cryptoConfig.horizon.feeRate + cryptoConfig.horizon.slippage;
  }

  /** Equity of a leg at `price`, an open position marked to market net of the exit costs. */
  public legEquity(leg: ILeg, price: number): number {
    const p = leg.position;
    return p ? p.capital * (1 + p.side * (price / p.entryPrice - 1)) * (1 - this.cost()) : leg.equity;
  }

  private open(leg: ILeg, side: number, price: number, now: number, horizonMinutes: number) {
    leg.position = { side, entryAt: now, entryPrice: price, exitAt: now + horizonMinutes * MIN, capital: leg.equity * (1 - this.cost()) };
  }

  private close(leg: ILeg, price: number, now: number): IHorizonTrade {
    const p = leg.position as IPosition;
    const before = leg.equity;
    leg.equity = this.legEquity(leg, price);
    const trade = { side: p.side, entryAt: p.entryAt, exitAt: now, entryPrice: p.entryPrice, exitPrice: price, pnl: leg.equity - before, ret: leg.equity / before - 1 };
    leg.trades.push(trade);
    leg.position = null;
    return trade;
  }

  private stop(track: IHorizonTrack, reason: string, now: number) {
    fs.writeFileSync(this.stopFile(track.name), `${new Date(now).toISOString()} horizon ${track.name}: ${reason}\n`);
    log(`${track.name}: STOP-CRANE: ${reason}. This track is stopped until ${this.stopFile(track.name)} is deleted`, Colors.RED);
  }

  /** One track at decision time `T` with the newest score `score` (NaN: nothing new to decide). */
  private step(track: IHorizonTrack, model: IHorizonModel, scores: { t: number; s: number }[], T: number, score: number, price: number, now: number) {
    const rules = this.rules;
    const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

    // stop-crane: the bot-wide STOP and this track's own stop file
    const byHand = fs.existsSync(this.globalStop);
    if (track.killSwitch.stopped && !fs.existsSync(this.stopFile(track.name)) && !byHand) {
      log(`${track.name}: resumed after the stop "${track.killSwitch.stopped}"`, Colors.GREEN);
      track.killSwitch = resumeKillSwitch(track.killSwitch, this.legEquity(track.gated, price), now);
    }
    const checked = checkMarket(track.killSwitch, { now, price, equity: this.legEquity(track.gated, price) }, rules);
    track.killSwitch = checked.state;
    if (checked.stop) this.stop(track, checked.stop, now);
    const mustExit = !!track.killSwitch.stopped || byHand;

    const threshold = Number.isFinite(score) ? entryThreshold(scores, T, track.mode) : NaN;
    const side = Number.isFinite(score) ? entrySide(score, threshold, track.mode) : 0;

    // gated leg: exits at the horizon or on a stop; entries need the stop-crane's permission (3 a UTC day)
    const g = track.gated;
    if (g.position && (now >= g.position.exitAt || mustExit)) {
      const tr = this.close(g, price, now);
      log(`${track.name}: paper ${tr.side > 0 ? "SELL" : "BUY back"} ETH at ${price.toFixed(2)}, trade ${pct(tr.ret)} (${tr.pnl.toFixed(2)} USDT)${mustExit ? ", stop-crane exit" : ""}`, Colors.GREEN);
      const closed = recordClose(track.killSwitch, { now, pnl: tr.pnl }, rules);
      track.killSwitch = closed.state;
      if (closed.stop) this.stop(track, closed.stop, now);
    }
    if (!g.position && side && !mustExit && !track.killSwitch.stopped) {
      const permit = canOpen(track.killSwitch, now, rules);
      if (!permit.allowed) log(`${track.name}: entry skipped, ${permit.reason}`, Colors.YELLOW);
      else {
        this.open(g, side, price, now, model.horizonMinutes);
        track.killSwitch = recordOpen(track.killSwitch, now);
        log(`${track.name}: paper ${side > 0 ? "BUY" : "SHORT (simulated)"} ETH at ${price.toFixed(2)} for ${model.horizonMinutes / 60} h — score ${(score * 1e4).toFixed(1)} bps vs threshold ${(threshold * 1e4).toFixed(1)}`, Colors.GREEN);
      }
    }

    // shadow leg: the bare rule (research/horizon/study.py), no stop-crane
    const sh = track.shadow;
    const today = Math.floor(now / DAY);
    if (sh.day !== today) [sh.day, sh.entriesToday] = [today, 0];
    if (sh.position && now >= sh.position.exitAt) this.close(sh, price, now);
    if (!sh.position && side && sh.entriesToday < PER_DAY) {
      this.open(sh, side, price, now, model.horizonMinutes);
      sh.entriesToday++;
    }
    if (Number.isFinite(score)) track.lastDecision = T;

    if (track.lastSummaryDay !== today) {
      track.lastSummaryDay = today;
      const value = this.legEquity(g, price);
      const n = g.trades.length;
      const wins = g.trades.filter((t) => t.pnl > 0).length;
      log(
        `${track.name}: ${value.toFixed(2)} USDT (${pct(value / track.capitalUsd - 1)} since ${new Date(track.startedAt).toISOString().slice(0, 10)}, ETH buy & hold ${pct(price / track.startPrice - 1)}), ` +
          `${n} trades, ${n ? ((wins / n) * 100).toFixed(0) : "–"}% won, ${g.position ? `in a ${g.position.side > 0 ? "long" : "short"} until ${new Date(g.position.exitAt).toISOString().slice(0, 16)}` : "flat"}` +
          `${track.killSwitch.stopped ? `, STOPPED: ${track.killSwitch.stopped}` : ""}; without the stop-crane ${pct(this.legEquity(sh, price) / track.capitalUsd - 1)}`,
        Colors.CYAN
      );
    }
  }

  public check = async (): Promise<void> => {
    if (!cryptoConfig.horizon.enabled || this.running || !this.loadModels()) return;
    this.running = true;
    try {
      await MarketDataService.syncCandles(SYMBOL, "minute");
      await MarketDataService.syncCandles(OTHER, "minute");
      await MarketDataService.syncCandles(SYMBOL, "hour");
      await MarketDataService.syncFunding(SYMBOL);
      const [price, btc] = [await this.price(SYMBOL), await this.price(OTHER)];
      // a missing price is a feed hiccup, not a reason to stop: the next check retries
      if (!price || !btc) return log("no current Binance price, check skipped", Colors.YELLOW);
      const now = Date.now();

      // newest decision time whose last minute candle is stored
      const stored = await StorageService.getCandles(SYMBOL, "minute", Math.floor((now - 30 * MIN) / 1000));
      if (!stored.length) return log("no recent ETH minute candles stored, check skipped", Colors.YELLOW);
      const T = Math.floor(((stored[stored.length - 1].time + 60) * 1000) / STEP) * STEP;

      const saved = this.read<{ last: number; scores: Record<string, { t: number; s: number }[]> }>(this.scoresFile);
      const keepFrom = T - (THRESHOLD_DAYS + 1) * DAY;
      const from = saved && saved.last >= keepFrom ? saved.last + STEP : T - THRESHOLD_DAYS * DAY;
      const scores = saved?.scores ?? {};
      if (from <= T) {
        if (!saved) log(`scoring the last ${THRESHOLD_DAYS} days for the entry thresholds`, Colors.CYAN);
        const fresh = await this.score(from, T);
        for (const [name, list] of Object.entries(fresh)) scores[name] = [...(scores[name] ?? []), ...list].filter((p) => p.t >= keepFrom);
        this.write(this.scoresFile, { last: T, scores });
      }

      const vote = this.voteValue({ ETH: price, BTC: btc });
      for (const cfg of cryptoConfig.horizon.tracks) {
        const model = this.models.get(cfg.model) as IHorizonModel;
        const file = this.trackFile(cfg.name);
        const track = this.read<IHorizonTrack>(file) ?? this.newTrack(cfg, now, price, vote);
        const list = scores[cfg.model] ?? [];
        const newest = list[list.length - 1];
        // decide only on a fresh, not yet used decision time: scores backfilled after a pause are not traded late
        const fresh = newest && newest.t === T && T > track.lastDecision && now - T < 2 * STEP;
        this.step(track, model, list, T, fresh ? newest.s : NaN, price, now);
        this.write(file, track);
      }
    } finally {
      this.running = false;
    }
  };

  /** All tracks as stored, for the report. */
  public tracks(): IHorizonTrack[] {
    return cryptoConfig.horizon.tracks.map((c) => this.read<IHorizonTrack>(this.trackFile(c.name))).filter((t): t is IHorizonTrack => !!t);
  }
}

export default new HorizonTraderService();
