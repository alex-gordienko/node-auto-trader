/**
 * `yarn execution:report`: testnet fills (src/Storage/trading/execution-ledger.jsonl) against the prices the paper
 * books used — real slippage and fees per strategy next to the cost the paper assumed. Reads only.
 */
import BinanceExecutionService, { ILedgerEntry } from "../services/BinanceExecution.service";
import { Colors, log } from "../utils/colored-console";

const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN);
const bps = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)} bps` : "–");

const main = () => {
  const ledger = BinanceExecutionService.ledger();
  if (!ledger.length) return log("the execution ledger is empty: set EXECUTION_MODE=testnet and wait for a paper fill", Colors.YELLOW);
  const groups = new Map<string, ILedgerEntry[]>();
  ledger.forEach((e) => groups.set(e.strategy, [...(groups.get(e.strategy) ?? []), e]));
  for (const [strategy, entries] of groups) {
    const done = entries.filter((e) => e.qty > 0);
    const count = (s: ILedgerEntry["status"]) => entries.filter((e) => e.status === s).length;
    // volume-weighted: a big order counts for more than dust
    const w = done.reduce((s, e) => s + e.quote, 0);
    const slip = done.reduce((s, e) => s + e.slippageBps * e.quote, 0) / w;
    const fee = done.reduce((s, e) => s + e.feeBps * e.quote, 0) / w;
    const maker = done.filter((e) => e.orders.every((o) => o.type === "LIMIT_MAKER")).length;
    log(
      [
        `${strategy}: ${entries.length} requests — ${count("filled")} filled, ${count("partial")} partial, ${count("skipped")} skipped, ${count("refused")} refused, ${count("failed")} failed`,
        `  fills: ${done.length}, all-maker ${maker}, with a market part ${done.length - maker}; volume ${w.toFixed(2)} USDT`,
        `  per side: slippage ${bps(slip)} + fee ${bps(fee)} = ${bps(slip + fee)} vs paper ${bps(mean(entries.map((e) => e.paperCostBps)))}`,
        ...entries.filter((e) => e.status === "failed" || e.status === "skipped").slice(-3).map((e) => `  ${new Date(e.at).toISOString().slice(0, 16)} ${e.status}: ${e.note}`),
      ].join("\n"),
      Colors.CYAN
    );
  }
};

main();
