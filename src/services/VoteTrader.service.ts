import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import BinanceClient from "./collectors/BinanceClient";
import MarketDataService from "./collectors/MarketData.service";
import StorageService from "./Local.storage.service";
import KillSwitchService from "./KillSwitch.service";
import { Colors, createLogger } from "../utils/colored-console";
import { IPaperFill, IPaperLeg, rebalanceLeg, toDailyBars, voteTarget } from "../utils/daily-strategy";

const log = createLogger("vote");

const NAME = "vote";
const DAY_MS = 86_400_000;

interface IVotePortfolio {
  legs: Record<string, IPaperLeg>; // per coin: half of the capital
  startedAt: number;
  startValue: number;
  startPrices: Record<string, number>;
  lastDecisionDay: number; // UTC day number
  fills: (IPaperFill & { at: number; coin: string })[];
}

/**
 * Paper trading of the trend vote (config `vote`): no real orders, fills at Binance spot prices with the configured
 * fee and slippage. The portfolio is kept in src/Storage/trading/vote-paper.json and survives restarts.
 * Every check goes through the stop-crane (KillSwitch.service, state "vote"): a stop sells everything at once and
 * holds until src/Storage/trading/STOP is deleted; every purchase uses one of the 3 trades a UTC day; 3 losing
 * positions in a row stop.
 */
class VoteTraderService {
  private readonly file = path.join(cryptoConfig.paths.storageDir, "trading", `${NAME}-paper.json`);

  private get rules() {
    return { ...cryptoConfig.killSwitch, ...cryptoConfig.vote.killSwitch };
  }

  private write(p: IVotePortfolio) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // write + rename: a process killed mid-write must not leave a cut file
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(p, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  private async prices(): Promise<Record<string, number> | null> {
    const prices: Record<string, number> = {};
    for (const coin of cryptoConfig.vote.coins) {
      const ticker = await BinanceClient.getSpot<{ price: string }>("/api/v3/ticker/price", { symbol: `${coin}USDT` });
      const price = Number(ticker?.price);
      if (!(price > 0)) return null;
      prices[coin] = price;
    }
    return prices;
  }

  /** Wanted coin shares from the daily closes up to today 00:00 UTC; null while today's close is not stored yet. */
  private async targets(today: number): Promise<Record<string, number> | null> {
    const targets: Record<string, number> = {};
    for (const coin of cryptoConfig.vote.coins) {
      const symbol = `${coin}-USDT`;
      await MarketDataService.syncCandles(symbol, "hour");
      const candles = await StorageService.getCandles(symbol, "hour");
      const bars = candles.length ? toDailyBars(candles) : [];
      if (!bars.length || bars[bars.length - 1].t * 1000 !== today * DAY_MS) return null;
      targets[coin] = voteTarget(bars.map((b) => b.price), cryptoConfig.vote.targetVolatility);
      if (!Number.isFinite(targets[coin])) throw new Error(`${symbol}: fewer than 121 daily closes stored`);
    }
    return targets;
  }

  private share(p: IVotePortfolio, coin: string, price: number) {
    const leg = p.legs[coin];
    return (leg.qty * price) / (leg.qty * price + leg.usdt);
  }

  private trade(p: IVotePortfolio, coin: string, price: number, target: number, now: number) {
    const { feeRate, slippage, minChange, minTradeUsd } = cryptoConfig.vote;
    const { leg, fill } = rebalanceLeg(p.legs[coin], price, target, { feeRate, slippage, minChange, minTradeUsd });
    if (!fill) return;
    p.legs[coin] = leg;
    p.fills.push({ ...fill, at: now, coin });
    log(`paper ${fill.side.toUpperCase()} ${coin} for ${fill.usd.toFixed(2)} USDT at ${fill.price.toFixed(2)} (fee ${fill.fee.toFixed(2)})`, Colors.GREEN);
    if (fill.side === "buy") KillSwitchService.opened(NAME);
    if (fill.closedPnl !== null) KillSwitchService.closed(NAME, fill.closedPnl, this.rules);
  }

  public check = async (): Promise<void> => {
    const prices = await this.prices();
    // a missing price is a feed hiccup, not a reason to stop: the next check retries
    if (!prices) return log("no current Binance price, check skipped", Colors.YELLOW);
    const now = Date.now();
    const { coins, capitalUsd, stepDays } = cryptoConfig.vote;
    const p: IVotePortfolio = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf-8"))
      : {
          legs: Object.fromEntries(coins.map((c) => [c, { qty: 0, usdt: capitalUsd / coins.length, flow: 0 }])),
          startedAt: now,
          startValue: capitalUsd,
          startPrices: prices,
          lastDecisionDay: -1,
          fills: [],
        };
    const equity = () => coins.reduce((s, c) => s + p.legs[c].qty * prices[c] + p.legs[c].usdt, 0);
    // the basket's value is its "price" for the abnormal-move rule: it moves only with what is held
    const gate = () => KillSwitchService.check(NAME, { price: equity(), equity: equity() }, this.rules);

    const today = Math.floor(now / DAY_MS);
    if (gate().mustExit) {
      coins.forEach((c) => this.trade(p, c, prices[c], 0, now));
    } else if (today % stepDays === 0 && p.lastDecisionDay !== today) {
      const targets = await this.targets(today);
      if (!targets) log("today's 00:00 close is not stored yet, the decision waits for the next check", Colors.YELLOW);
      else {
        for (const c of coins) {
          // every purchase asks the stop-crane again: it holds the 3-a-day limit
          const blocked = targets[c] > this.share(p, c, prices[c]) ? gate().reason : null;
          if (blocked) log(`${c}: buy skipped, ${blocked}`, Colors.YELLOW);
          else this.trade(p, c, prices[c], targets[c], now);
        }
        p.lastDecisionDay = today;
        log(`decision: wanted ${coins.map((c) => `${c} ${(targets[c] * 100).toFixed(0)}%`).join(", ")} of its half`, Colors.CYAN);
      }
    }
    this.write(p);

    const value = equity();
    const hold = coins.reduce((s, c) => s + prices[c] / p.startPrices[c], 0) / coins.length - 1;
    const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
    log(
      `paper BTC+ETH vote: ${value.toFixed(2)} USDT (${pct(value / p.startValue - 1)} since start, buy & hold ${pct(hold)}), ` +
        `${coins.map((c) => `${c} ${(this.share(p, c, prices[c]) * 100).toFixed(0)}%`).join(", ")}, ${p.fills.length} fills`,
      Colors.CYAN
    );
  };
}

export default new VoteTraderService();
