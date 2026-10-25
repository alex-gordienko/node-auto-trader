import fs from "fs";
import path from "path";

import cryptoConfig from "../config/crypto.config";
import { Colors, createLogger } from "../utils/colored-console";
import {
  canOpen,
  checkMarket,
  createKillSwitch,
  IKillSwitchState,
  recordClose,
  recordOpen,
  resumeKillSwitch,
} from "../utils/kill-switch";

const log = createLogger("stop-crane");

export interface IKillSwitchGate {
  mayOpen: boolean; // a new position may be opened now
  mustExit: boolean; // stopped: an open position is closed now
  reason: string | null; // why a position may not be opened
}

/**
 * Stop-crane and the 3-trades-a-day limit of a live strategy (utils/kill-switch.ts). The state of each strategy is
 * kept in src/Storage/trading/<name>-kill-switch.json and survives restarts.
 * The bot has one stop file, src/Storage/trading/STOP, shared with the 50/50 rule: a stop of any strategy writes its
 * reason there and stops them all. Create the file (with any text) to stop the bot by hand; delete it to resume — the
 * losing streak, the peak and the day's loss then start afresh, the trades already made today still count.
 */
class KillSwitchService {
  private readonly dir = path.join(cryptoConfig.paths.storageDir, "trading");
  public readonly stopFile = path.join(this.dir, "STOP");

  private file(name: string) {
    return path.join(this.dir, `${name}-kill-switch.json`);
  }

  private read(name: string): IKillSwitchState | null {
    const file = this.file(name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
  }

  private write(name: string, state: IKillSwitchState) {
    fs.mkdirSync(this.dir, { recursive: true });
    // write + rename: a process killed mid-write must not leave a cut file
    fs.writeFileSync(`${this.file(name)}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${this.file(name)}.tmp`, this.file(name));
  }

  /** Every check of the strategy, with or without a trade: applies the stop file and the market rules. */
  public check = (name: string, { price, equity }: { price: number; equity: number }): IKillSwitchGate => {
    const now = Date.now();
    const rules = cryptoConfig.killSwitch;
    let state = this.read(name) ?? createKillSwitch(equity, now);

    if (fs.existsSync(this.stopFile)) {
      if (!state.stopped) {
        const reason = fs.readFileSync(this.stopFile, "utf-8").trim() || "stopped by hand";
        state = { ...state, stopped: reason, stoppedAt: now };
        log(`${name}: STOPPED (${reason}), open positions are closed. Delete ${this.stopFile} to resume`, Colors.RED);
      }
    } else if (state.stopped) {
      log(`${name}: resumed after the stop "${state.stopped}"`, Colors.GREEN);
      state = resumeKillSwitch(state, equity, now);
    }

    const { state: next, stop } = checkMarket(state, { now, price, equity }, rules);
    // the stop file first: if writing the state fails, the stop still holds
    if (stop) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.stopFile, `${new Date(now).toISOString()} ${name}: ${stop}\n`);
      log(`${name}: STOP-CRANE: ${stop}. Trading is stopped until ${this.stopFile} is deleted`, Colors.RED);
    }
    this.write(name, next);

    const open = canOpen(next, now, rules);
    return { mayOpen: open.allowed, mustExit: !!next.stopped, reason: open.reason };
  };

  /** A position was opened: uses one of the day's trades. */
  public opened = (name: string): void => {
    const state = this.read(name);
    if (state) this.write(name, recordOpen(state, Date.now()));
  };

  /** A position was closed with `pnl` USDT net of costs; a losing streak stops the bot. */
  public closed = (name: string, pnl: number): void => {
    const state = this.read(name);
    if (!state) return;
    const now = Date.now();
    const { state: next, stop } = recordClose(state, { now, pnl }, cryptoConfig.killSwitch);
    if (stop) {
      fs.writeFileSync(this.stopFile, `${new Date(now).toISOString()} ${name}: ${stop}\n`);
      log(`${name}: STOP-CRANE: ${stop}. Trading is stopped until ${this.stopFile} is deleted`, Colors.RED);
    }
    this.write(name, next);
  };
}

export default new KillSwitchService();
