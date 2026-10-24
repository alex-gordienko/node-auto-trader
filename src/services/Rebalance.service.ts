import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import MarketDataService from "./collectors/MarketData.service";
import ExecutionService from "./execution/ExecutionService";
import HealthService from "./HealthService";
import AlertService from "./AlertService";
import { CryptoBase, CryptoPairs } from "../types/basic.types";
import { Colors, createLogger } from "../utils/colored-console";
import {
  bandPrices,
  createPortfolio,
  ethShare,
  IPaperPortfolio,
  IRebalanceConfig,
  portfolioValue,
  rebalanceStep,
  resumePortfolio,
} from "../utils/rebalance";

const log = createLogger("rebalance");

/** What the DQN would hold if it traded: all in ETH after "Buy", all in USDT after "Sell", as in its training. */
interface IShadowPortfolio {
  eth: number;
  usdt: number;
  entryPrice: number;
  startPrice: number;
  startValue: number;
  lastDecisionAt: number;
  swaps: number;
  costs: number;
}

/**
 * Paper trading of the 50/50 strategy (utils/rebalance.ts); no real swaps are made. The portfolio is kept in
 * src/Storage/trading/<pair>-paper.json and survives restarts.
 * Stop-crane: when a rule fires, its reason is written to src/Storage/trading/STOP and the bot stops trading.
 * Delete that file to resume; create it (with any text) to stop the bot by hand.
 * The DQN keeps deciding every few minutes; its decisions move a shadow paper portfolio (<pair>-dqn-paper.json) with
 * the same costs, so live data shows whether the neural networks would beat the 50/50 rule.
 */
class RebalanceService {
  private readonly dir = path.join(cryptoConfig.paths.storageDir, "trading");
  public readonly stopFile = path.join(this.dir, "STOP");

  private get config(): IRebalanceConfig {
    const { target, band, minTradeUsd, stop } = cryptoConfig.rebalance;
    return { target, band, minTradeUsd, stop, feeRate: cryptoConfig.rl.feeRate, gasUsd: cryptoConfig.rl.gasUsd };
  }

  private file(pair: CryptoPairs) {
    return path.join(this.dir, `${pair}-paper.json`);
  }

  private shadowFile(pair: CryptoPairs) {
    return path.join(this.dir, `${pair}-dqn-paper.json`);
  }

  private read<T>(file: string): T | null {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
  }

  private write(file: string, data: unknown) {
    fs.mkdirSync(this.dir, { recursive: true });
    // write + rename: a process killed mid-write must not leave a cut file
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** The shadow portfolio: null before the first decision, undefined if its file cannot be read (it is left alone). */
  private readShadow(pair: CryptoPairs): IShadowPortfolio | null | undefined {
    try {
      return this.read<IShadowPortfolio>(this.shadowFile(pair));
    } catch (error) {
      log(`cannot read ${this.shadowFile(pair)}: ${error}`, Colors.RED);
      return undefined;
    }
  }

  /** The position the DQN decides from comes from its shadow portfolio: it was trained with its own position as input. */
  public dqnPositions(): Map<CryptoPairs, { position: number; entryPrice: number }> {
    const positions = new Map<CryptoPairs, { position: number; entryPrice: number }>();
    for (const pair of Object.values(CryptoPairs)) {
      const shadow = this.readShadow(pair);
      positions.set(pair, { position: shadow && shadow.eth > 0 ? 1 : 0, entryPrice: shadow?.entryPrice ?? 0 });
    }
    return positions;
  }

  /**
   * Applies a DQN decision to its shadow portfolio, at most once per rl.decisionMinutes, with the 50/50 rule's costs.
   * Only a comparison: a failure here is logged and never stops the prediction loop.
   */
  public followDqn = (pair: CryptoPairs, command: string, price: number): void => {
    try {
      this.applyDqn(pair, command, price);
    } catch (error) {
      log(`AI paper (DQN) update failed: ${error}`, Colors.RED);
    }
  };

  private applyDqn(pair: CryptoPairs, command: string, price: number) {
    const now = Date.now();
    const capital = cryptoConfig.rebalance.capitalUsd;
    const { feeRate, gasUsd, decisionMinutes } = cryptoConfig.rl;
    const saved = this.readShadow(pair);
    if (saved === undefined) return;
    const s: IShadowPortfolio = saved ?? {
      eth: 0,
      usdt: capital,
      entryPrice: 0,
      startPrice: price,
      startValue: capital,
      lastDecisionAt: 0,
      swaps: 0,
      costs: 0,
    };
    if (now - s.lastDecisionAt < decisionMinutes * 60_000 - 30_000) return;
    s.lastDecisionAt = now;
    if (command === "Buy" && s.eth === 0 && s.usdt >= cryptoConfig.rebalance.minTradeUsd) {
      const cost = s.usdt * feeRate + gasUsd;
      s.eth = (s.usdt - cost) / price;
      s.usdt = 0;
      s.entryPrice = price;
      s.swaps++;
      s.costs += cost;
      log(`AI paper (DQN): BUY ETH at ${price} (cost ${cost.toFixed(2)} USDT)`, Colors.MAGENTA);
    } else if (command === "Sell" && s.eth > 0) {
      const usd = s.eth * price;
      const cost = usd * feeRate + gasUsd;
      s.usdt = usd - cost;
      s.eth = 0;
      s.entryPrice = 0;
      s.swaps++;
      s.costs += cost;
      log(`AI paper (DQN): SELL ETH at ${price} (cost ${cost.toFixed(2)} USDT)`, Colors.MAGENTA);
    }
    this.write(this.shadowFile(pair), s);
  }

  public check = async (pair: CryptoPairs = CryptoPairs.ETH_USDT): Promise<void> => {
    if (fs.existsSync(this.stopFile)) {
      const reason = fs.readFileSync(this.stopFile, "utf-8").trim() || "by hand";
      log(`STOPPED: ${reason}. Delete ${this.stopFile} to resume`, Colors.RED);
      HealthService.recordStop(reason);
      AlertService.notify("critical", "stop-crane", `Trading stopped: ${reason}`);
      return;
    }
    HealthService.recordStop(null);

    const price = await MarketDataService.getCurrentPrice(CryptoBase.ETH, CryptoBase.USDT);
    if (!price || !(price > 0)) {
      log("no current ETH price, check skipped", Colors.YELLOW);
      AlertService.notify("critical", "no-price", "no current ETH price for the rebalance check");
      return;
    }
    HealthService.recordPrice();
    HealthService.recordRebalanceCheck();
    const now = Date.now();
    const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

    const saved = this.read<IPaperPortfolio>(this.file(pair));
    if (!saved) {
      const portfolio = createPortfolio(cryptoConfig.rebalance.capitalUsd, price, now, this.config);
      this.write(this.file(pair), portfolio);
      log(`paper portfolio started: ${cryptoConfig.rebalance.capitalUsd} USDT, half of it in ETH at ${price}`, Colors.GREEN);
      return;
    }

    // the stop file was deleted by hand: trading resumes, the drawdown and the purchase count start afresh
    const current = saved.stopped ? resumePortfolio(saved, price, now) : saved;
    if (saved.stopped) log(`resumed after the stop "${saved.stopped}"`, Colors.GREEN);

    const { portfolio, trade, stop } = rebalanceStep(current, price, now, this.config);
    // the stop file first: if writing it fails, the old state stays and the same stop fires on the next check
    if (stop) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.stopFile, `${new Date(now).toISOString()} ${stop}\n`);
    }
    this.write(this.file(pair), portfolio);

    if (trade) {
      log(
        `paper ${trade.side === "buy" ? "BUY" : "SELL"} ETH for ${trade.usd.toFixed(2)} USDT at ${price} ` +
          `(cost ${trade.cost.toFixed(2)} USDT), ETH share back to ${(ethShare(portfolio, price) * 100).toFixed(1)}%`,
        Colors.GREEN
      );
      await ExecutionService.execute(pair, trade, price);
      HealthService.recordFill();
    }
    if (stop) {
      log(`STOP-CRANE: ${stop}. Trading is stopped until ${this.stopFile} is deleted`, Colors.RED);
      AlertService.notify("critical", "stop-crane", `Stop-crane fired: ${stop}`);
    }

    const value = portfolioValue(portfolio, price);
    const { buyAt, sellAt } = bandPrices(portfolio, this.config);
    // with the models off the shadow portfolio is frozen: not shown
    const shadow = cryptoConfig.modelsEnabled ? this.readShadow(pair) : null;
    const shadowValue = shadow ? shadow.eth * price + shadow.usdt : null;
    log(
      `${pair} paper 50/50: ${value.toFixed(2)} USDT (${pct(value / portfolio.startValue - 1)} since start, ` +
        `buy & hold ${pct(price / portfolio.startPrice - 1)}), ETH ${(ethShare(portfolio, price) * 100).toFixed(1)}%, ` +
        `${portfolio.trades.length} rebalances; next: sell above ${sellAt.toFixed(2)}, buy below ${buyAt.toFixed(2)}` +
        (shadow && shadowValue !== null ? ` | AI paper (DQN) ${shadowValue.toFixed(2)} USDT (${pct(shadowValue / shadow.startValue - 1)}, ${shadow.swaps} swaps)` : ""),
      Colors.CYAN
    );
  };
}

export default new RebalanceService();
