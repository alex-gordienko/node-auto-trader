/**
 * `yarn horizon:report`: the horizon-search paper tracks against the vote paper portfolio and ETH buy & hold over the
 * same days (since each track started). Reads src/Storage/trading/*-paper.json; changes nothing.
 */
import BinanceClient from "../services/collectors/BinanceClient";
import HorizonTraderService, { IHorizonTrade } from "../services/HorizonTrader.service";
import { Colors, log } from "../utils/colored-console";

const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);

const stats = (trades: IHorizonTrade[]) => {
  const n = trades.length;
  const rets = trades.map((t) => t.ret);
  const mean = n ? rets.reduce((s, r) => s + r, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : NaN;
  return { n, won: n ? trades.filter((t) => t.pnl > 0).length / n : NaN, bps: mean * 1e4, t: (mean / sd) * Math.sqrt(n) };
};

const main = async () => {
  const price = async (symbol: string) => Number((await BinanceClient.getSpot<{ price: string }>("/api/v3/ticker/price", { symbol }))?.price);
  const prices = { ETH: await price("ETHUSDT"), BTC: await price("BTCUSDT") };
  const tracks = HorizonTraderService.tracks();
  if (!tracks.length) return log("no horizon paper tracks yet: they start with the server (yarn start) once the models exist", Colors.YELLOW);
  const vote = HorizonTraderService.voteValue(prices);
  log(`ETH ${prices.ETH.toFixed(2)}, BTC ${prices.BTC.toFixed(2)}. Returns since each track's start; costs 0.1% fee + 0.02% slippage per side.`, Colors.WHITE);
  for (const tr of tracks) {
    const days = (Date.now() - tr.startedAt) / 86_400_000;
    const g = stats(tr.gated.trades);
    const s = stats(tr.shadow.trades);
    const value = HorizonTraderService.legEquity(tr.gated, prices.ETH);
    const shadow = HorizonTraderService.legEquity(tr.shadow, prices.ETH);
    log(
      [
        `${tr.name} (${tr.mode === "ls" ? "long/short, shorts simulated" : "long/flat"}), started ${new Date(tr.startedAt).toISOString().slice(0, 16)} (${days.toFixed(1)} days)`,
        `  paper: ${value.toFixed(2)} USDT ${pct(value / tr.capitalUsd - 1)} | ${g.n} trades, ${pct(g.won)} won, ${g.n ? g.bps.toFixed(1) : "–"} bps/trade net, t ${Number.isFinite(g.t) ? g.t.toFixed(2) : "–"}` +
          `${tr.killSwitch.stopped ? ` | STOPPED: ${tr.killSwitch.stopped} (delete ${HorizonTraderService.stopFile(tr.name)})` : ""}`,
        `  without the stop-crane: ${pct(shadow / tr.capitalUsd - 1)} | ${s.n} trades, ${s.n ? s.bps.toFixed(1) : "–"} bps/trade`,
        `  same days: ETH buy & hold ${pct(prices.ETH / tr.startPrice - 1)}, vote ${vote !== null && tr.voteStartValue ? pct(vote / tr.voteStartValue - 1) : "– (no vote paper portfolio at the start)"}`,
        `  position: ${tr.gated.position ? `${tr.gated.position.side > 0 ? "long" : "short"} from ${tr.gated.position.entryPrice.toFixed(2)} until ${new Date(tr.gated.position.exitAt).toISOString().slice(0, 16)}` : "flat"}`,
      ].join("\n"),
      Colors.CYAN
    );
  }
  log("Judge only after dozens of trades: the research's best t was ≈ 2 over 4.8 years.", Colors.YELLOW);
};

main().catch((error) => {
  log(`horizon report failed: ${error}`, Colors.RED);
  process.exit(1);
});
