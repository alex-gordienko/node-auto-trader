/**
 * Trades the 10–120 day trend vote of a BTC + ETH basket on Binance Demo Trading / Spot Testnet (fake money), through the stop-crane:
 *   yarn testnet          one decision: each coin is held while most lookback windows (10–120 days) are up
 *   yarn testnet --drill  stop-crane drill: quick buy/sell round trips until the losing streak or the day's limit
 *                         stops trading, then a buy that must be refused
 * Keys: BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET in .env; they are only sent to the testnet. The trend
 * is read from public mainnet klines. State and the stop file live in STORAGE_DIR (src/Storage/testnet in the yarn
 * script), apart from the running bot. Meant to be run once a week (weekly decisions).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import axios from "axios";

import cryptoConfig from "../config/crypto.config";
import KillSwitchService from "../services/KillSwitch.service";
import { Colors, createLogger } from "../utils/colored-console";

const log = createLogger("testnet");

// Binance Demo Trading (fake money); old testnet keys need BINANCE_TESTNET_URL=https://testnet.binance.vision
const TESTNET = process.env.BINANCE_TESTNET_URL || "https://demo-api.binance.com";
const MAINNET_DATA = "https://data-api.binance.vision";
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const LEG_USD = Number(process.env.TESTNET_LEG_USD || 1000); // USDT put into each coin; smaller legs lose ~1% to LOT_SIZE rounding dust
const LOOKBACKS = [10, 14, 21, 30, 45, 60, 90, 120]; // days; one 30d window alone was overfit

const key = process.env.BINANCE_TESTNET_API_KEY;
const secret = process.env.BINANCE_TESTNET_API_SECRET;
if (!key || !secret) throw new Error("BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET are not set");

interface ILeg {
  qty: string; // coin bought by this bot and still held, "0" when out
  entryUsd: number; // USDT spent on it
}
const stateFile = path.join(cryptoConfig.paths.storageDir, "trading", "testnet-legs.json");
const readLegs = (): Record<string, ILeg> => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf-8")) : {});
const writeLegs = (legs: Record<string, ILeg>) => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(legs, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
};

const signed = async (method: "GET" | "POST", endpoint: string, params: Record<string, string> = {}) => {
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");
  try {
    const { data } = await axios({ method, url: `${TESTNET}${endpoint}?${query}&signature=${signature}`, headers: { "X-MBX-APIKEY": key } });
    return data;
  } catch (error) {
    const body = axios.isAxiosError(error) ? JSON.stringify(error.response?.data) : String(error);
    throw new Error(`${method} ${endpoint} failed: ${body}`);
  }
};

const price = async (symbol: string): Promise<number> =>
  Number((await axios.get(`${TESTNET}/api/v3/ticker/price`, { params: { symbol } })).data.price);

const stepSizes = new Map<string, string>();
const floorToStep = async (symbol: string, qty: number) => {
  if (!stepSizes.has(symbol)) {
    const info = (await axios.get(`${TESTNET}/api/v3/exchangeInfo`, { params: { symbol } })).data.symbols[0];
    stepSizes.set(symbol, info.filters.find((f: { filterType: string }) => f.filterType === "LOT_SIZE").stepSize);
  }
  const step = stepSizes.get(symbol)!;
  const decimals = step.replace(/0+$/, "").split(".")[1]?.length ?? 0;
  return (Math.floor(qty / Number(step) + 1e-9) * Number(step)).toFixed(decimals);
};

/** Market order; returns the coin received (net of a commission taken in it) and the USDT moved, net of fees in USDT. */
const order = async (symbol: string, side: "BUY" | "SELL", amount: { quoteUsd: number } | { qty: string }) => {
  const params: Record<string, string> = { symbol, side, type: "MARKET", newOrderRespType: "FULL" };
  if ("quoteUsd" in amount) params.quoteOrderQty = amount.quoteUsd.toFixed(2);
  else params.quantity = amount.qty;
  const r = await signed("POST", "/api/v3/order", params);
  const base = symbol.replace("USDT", "");
  // shortcut: a commission in a third asset (BNB) is counted at zero, fine for testnet
  const fee = (asset: string) =>
    (r.fills as { commission: string; commissionAsset: string }[]).filter((f) => f.commissionAsset === asset).reduce((s, f) => s + Number(f.commission), 0);
  const quote = Number(r.cummulativeQuoteQty);
  log(`${side} ${symbol}: order ${r.orderId} ${r.status}, ${r.executedQty} ${base} for ${quote.toFixed(2)} USDT`, Colors.GREEN);
  return { qty: Number(r.executedQty) - fee(base), usd: side === "BUY" ? quote : quote - fee("USDT") };
};

const buyLeg = async (legs: Record<string, ILeg>, symbol: string) => {
  const gate = KillSwitchService.check(symbol, { price: await price(symbol), equity: LEG_USD });
  if (!gate.mayOpen) {
    log(`${symbol}: buy refused by the stop-crane: ${gate.reason}`, Colors.YELLOW);
    return false;
  }
  const r = await order(symbol, "BUY", { quoteUsd: LEG_USD });
  legs[symbol] = { qty: await floorToStep(symbol, r.qty), entryUsd: r.usd };
  writeLegs(legs);
  KillSwitchService.opened(symbol);
  return true;
};

const sellLeg = async (legs: Record<string, ILeg>, symbol: string, why: string) => {
  const leg = legs[symbol];
  const r = await order(symbol, "SELL", { qty: leg.qty });
  const pnl = r.usd - leg.entryUsd;
  log(`${symbol}: position closed (${why}), pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`, pnl > 0 ? Colors.GREEN : Colors.YELLOW);
  legs[symbol] = { qty: "0", entryUsd: 0 };
  writeLegs(legs);
  KillSwitchService.closed(symbol, pnl);
};

/**
 * Lookback vote from mainnet daily closes, as "50/50 vote 10–120d" in scripts/strategy-check.ts: each window votes
 * up when the last closed day is above the close that many days earlier.
 * shortcut: the leg is all in at a majority vote, while the backtest holds the vote's share; split legs if it matters.
 */
const trendUp = async (symbol: string) => {
  const longest = Math.max(...LOOKBACKS);
  const { data } = await axios.get(`${MAINNET_DATA}/api/v3/klines`, { params: { symbol, interval: "1d", limit: longest + 2 } });
  const closes = (data as string[][]).slice(0, -1).map((k) => Number(k[4])); // the last kline is today, still open
  const last = closes.length - 1;
  const ups = LOOKBACKS.filter((days) => closes[last] > closes[last - days]);
  log(`${symbol}: ${ups.length}/${LOOKBACKS.length} windows up (${ups.join(", ") || "none"} days)`, Colors.CYAN);
  return ups.length / LOOKBACKS.length > 0.5;
};

const decide = async () => {
  const legs = readLegs();
  for (const symbol of SYMBOLS) {
    const held = Number(legs[symbol]?.qty ?? 0) > 0;
    const gate = KillSwitchService.check(symbol, { price: await price(symbol), equity: LEG_USD });
    if (gate.mustExit) {
      if (held) await sellLeg(legs, symbol, "stop-crane");
      else log(`${symbol}: stopped, nothing held`, Colors.YELLOW);
      continue;
    }
    const up = await trendUp(symbol);
    if (up && !held) await buyLeg(legs, symbol);
    else if (!up && held) await sellLeg(legs, symbol, "trend down");
    else log(`${symbol}: ${held ? "holding" : "staying in USDT"}, nothing to do`);
  }
};

const drill = async () => {
  const symbol = "BTCUSDT";
  const legs = readLegs();
  for (let round = 1; round <= 4; round++) {
    log(`drill round ${round}`, Colors.CYAN);
    if (!(await buyLeg(legs, symbol))) break;
    await sellLeg(legs, symbol, "drill");
  }
  log(`stop file ${fs.existsSync(KillSwitchService.stopFile) ? "written" : "missing"}: ${KillSwitchService.stopFile}`, Colors.CYAN);
};

const main = async () => {
  log(`storage: ${cryptoConfig.paths.storageDir}`);
  const account = await signed("GET", "/api/v3/account");
  const bal = (a: string) => account.balances.find((b: { asset: string }) => b.asset === a)?.free ?? "0";
  log(`testnet account: canTrade=${account.canTrade}, USDT ${bal("USDT")}, BTC ${bal("BTC")}, ETH ${bal("ETH")}`, Colors.CYAN);
  await (process.argv.includes("--drill") ? drill() : decide());
  const legs = readLegs();
  for (const s of SYMBOLS) {
    const qty = Number(legs[s]?.qty ?? 0);
    if (qty > 0) log(`${s}: holding ${qty} worth ${(qty * (await price(s))).toFixed(2)} USDT (paid ${legs[s].entryUsd.toFixed(2)})`, Colors.CYAN);
  }
};

main().catch((error) => {
  log(String(error), Colors.RED);
  process.exit(1);
});
