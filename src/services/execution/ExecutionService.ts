import fs from "fs";
import path from "path";

import cryptoConfig from "../../config/crypto.config";
import { Colors, createLogger } from "../../utils/colored-console";
import { CryptoPairs } from "../../types/basic.types";
import { IRebalanceTrade } from "../../utils/rebalance";
import { deterministicClientOrderId, IExecutionVenue } from "./ExecutionVenue";
import PaperVenue from "./PaperVenue";
import BinanceSpotVenue from "./BinanceSpotVenue";

const log = createLogger("execution");

/**
 * Routes a strategy decision to a venue and appends it to the fill ledger. `EXECUTION_MODE` defaults to "paper"
 * (today's behaviour, no credential, no behaviour change); "live" is rejected until `BinanceSpotVenue` is
 * implemented (TRA-16 P1) rather than silently falling back to paper — a misconfigured live flag must fail
 * loudly, not trade on paper while an operator believes it is live.
 *
 * Paper state is the system's *expected* state once a live venue exists; this ledger (append-only, one line per
 * decision) is what a later reconciliation step compares it against.
 */
class ExecutionService {
  private readonly dir = path.join(cryptoConfig.paths.storageDir, "trading");

  private get venue(): IExecutionVenue {
    const mode = cryptoConfig.execution.mode;
    if (mode === "paper") return PaperVenue;
    if (mode === "live") return BinanceSpotVenue;
    throw new Error(`Unknown EXECUTION_MODE "${mode}" — expected "paper" or "live"`);
  }

  private ledgerFile(pair: CryptoPairs): string {
    return path.join(this.dir, `${pair}-fills.jsonl`);
  }

  /**
   * Submits the already-decided `trade` to the active venue and appends the fill to the ledger. The paper
   * portfolio's own math (`rebalanceStep`) is the source of truth for paper mode; this call does not feed back
   * into it — it exists so the ledger, idempotency path and venue boundary are exercised and reviewable before
   * any live order is possible.
   */
  public execute = async (pair: CryptoPairs, trade: IRebalanceTrade, decisionPrice: number): Promise<void> => {
    const clientOrderId = deterministicClientOrderId(pair, trade.side, trade.at);
    try {
      const venue = this.venue;
      const existing = await venue.getOrderByClientId(pair, clientOrderId);
      const result =
        existing ??
        (await venue.placeOrder({
          symbol: pair,
          side: trade.side,
          type: "market",
          quoteQty: trade.usd,
          limitPrice: trade.price,
          clientOrderId,
        }));

      const slippageBps = decisionPrice > 0 ? ((result.avgFillPrice - decisionPrice) / decisionPrice) * 10_000 : 0;
      this.appendLedger(pair, {
        clientOrderId,
        venue: venue.name,
        at: trade.at,
        side: trade.side,
        decisionPrice,
        intendedUsd: trade.usd,
        intendedCost: trade.cost,
        status: result.status,
        avgFillPrice: result.avgFillPrice,
        filledBaseQty: result.filledBaseQty,
        feePaid: result.feePaid,
        slippageBps,
      });
    } catch (error) {
      log(`execution failed for ${clientOrderId}: ${error}`, Colors.RED);
    }
  };

  private appendLedger(pair: CryptoPairs, entry: Record<string, unknown>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.ledgerFile(pair), `${JSON.stringify(entry)}\n`);
  }
}

export default new ExecutionService();
