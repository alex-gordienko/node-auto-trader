import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import KillSwitchService from "./KillSwitch.service";
import { CryptoPairs } from "../types/basic.types";
import { Colors, createLogger } from "../utils/colored-console";

const log = createLogger("rebalance");

/** What the DQN would hold if it traded: all in ETH after "Buy", all in USDT after "Sell", as in its training. */
interface IShadowPortfolio {
  eth: number;
  usdt: number;
  entryPrice: number;
  entryUsd?: number; // USDT spent on the open position, for its pnl (missing in files written before the stop-crane)
  startPrice: number;
  startValue: number;
  lastDecisionAt: number;
  swaps: number;
  costs: number;
}

/**
 * The DQN's shadow paper portfolio (the strategy itself is VoteTrader.service; the old 50/50 band rule of
 * utils/rebalance.ts is now only backtested). The DQN keeps deciding every few minutes; its decisions move a shadow
 * paper portfolio (<pair>-dqn-paper.json), so live data shows whether the neural networks would beat the rules. The DQN trades through
 * the stop-crane (KillSwitch.service): at most 3 positions a day, and a stop closes its position.
 */
class RebalanceService {
  private readonly dir = path.join(cryptoConfig.paths.storageDir, "trading");

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
    const name = `${pair}-dqn`;
    const gate = KillSwitchService.check(name, { price, equity: s.eth * price + s.usdt });
    // a stop closes the position at once, without waiting for the next decision
    const exit = gate.mustExit && s.eth > 0;
    if (!exit && now - s.lastDecisionAt < decisionMinutes * 60_000 - 30_000) return;
    s.lastDecisionAt = now;
    if (command === "Buy" && s.eth === 0 && s.usdt >= cryptoConfig.rebalance.minTradeUsd) {
      if (!gate.mayOpen) {
        log(`AI paper (DQN): Buy skipped, ${gate.reason}`, Colors.YELLOW);
      } else {
        const cost = s.usdt * feeRate + gasUsd;
        s.entryUsd = s.usdt;
        s.eth = (s.usdt - cost) / price;
        s.usdt = 0;
        s.entryPrice = price;
        s.swaps++;
        s.costs += cost;
        KillSwitchService.opened(name);
        log(`AI paper (DQN): BUY ETH at ${price} (cost ${cost.toFixed(2)} USDT)`, Colors.MAGENTA);
      }
    } else if ((command === "Sell" || exit) && s.eth > 0) {
      const usd = s.eth * price;
      const cost = usd * feeRate + gasUsd;
      s.usdt = usd - cost;
      s.eth = 0;
      s.entryPrice = 0;
      s.swaps++;
      s.costs += cost;
      if (s.entryUsd !== undefined) KillSwitchService.closed(name, s.usdt - s.entryUsd);
      s.entryUsd = undefined;
      log(`AI paper (DQN): SELL ETH at ${price} (cost ${cost.toFixed(2)} USDT)${exit ? ", closed by the stop-crane" : ""}`, Colors.MAGENTA);
    }
    this.write(this.shadowFile(pair), s);
  }
}

export default new RebalanceService();
