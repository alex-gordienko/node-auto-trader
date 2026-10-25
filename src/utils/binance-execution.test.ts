import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { test } from "node:test";

import { floorToStep, refuseBaseUrl, roundToTick, slippageBps } from "./binance-execution";
import { BinanceExecution } from "../services/BinanceExecution.service";

test("only testnet hosts receive orders unless live trading is enabled twice", () => {
  assert.strictEqual(refuseBaseUrl("https://demo-api.binance.com", undefined, null), null);
  assert.strictEqual(refuseBaseUrl("https://testnet.binance.vision", undefined, null), null);
  assert.ok(refuseBaseUrl("https://api.binance.com", undefined, null));
  assert.ok(refuseBaseUrl("https://api.binance.com", "true", null), "the flag alone is not enough");
  assert.ok(refuseBaseUrl("https://api.binance.com", "true", "api.binance.us"), "the confirmation must name this host");
  assert.ok(refuseBaseUrl("https://api.binance.com", "false", "api.binance.com"), "the file alone is not enough");
  assert.strictEqual(refuseBaseUrl("https://api.binance.com", "true", "api.binance.com\n"), null);
  assert.ok(refuseBaseUrl("http://testnet.binance.vision", undefined, null), "no plain http");
  assert.ok(refuseBaseUrl("not a url", undefined, null));
});

test("exchange-filter rounding and slippage", () => {
  assert.strictEqual(floorToStep(0.123456, "0.00010000"), "0.1234");
  assert.strictEqual(floorToStep(1.99999999999, "0.01"), "1.99");
  assert.strictEqual(roundToTick(2000.019, "0.01", "BUY"), "2000.01");
  assert.strictEqual(roundToTick(2000.011, "0.01", "SELL"), "2000.02");
  assert.ok(Math.abs(slippageBps("BUY", 2002, 2000) - 10) < 1e-9);
  assert.ok(Math.abs(slippageBps("SELL", 1998, 2000) - 10.01) < 0.01);
  assert.ok(slippageBps("BUY", 1999, 2000) < 0, "a better fill is negative slippage");
});

/** A fake exchange: a maker order fills 0.2 of 0.5 ETH before the timeout, the rest goes at market. */
const fakeExchange = () => {
  const calls: string[] = [];
  const http = async ({ method, url }: { method: string; url: string }) => {
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams);
    calls.push(`${method} ${u.pathname} ${q.type ?? ""}`.trim());
    if (u.pathname === "/api/v3/exchangeInfo")
      return { symbols: [{ filters: [{ filterType: "LOT_SIZE", stepSize: "0.00010000" }, { filterType: "PRICE_FILTER", tickSize: "0.01000000" }, { filterType: "NOTIONAL", minNotional: "5" }] }] };
    if (u.pathname === "/api/v3/ticker/bookTicker") return { bidPrice: "2000.00", askPrice: "2000.01" };
    if (u.pathname === "/api/v3/order" && method === "POST" && q.type === "LIMIT_MAKER") return { orderId: 1 };
    if (u.pathname === "/api/v3/order" && method === "POST" && q.type === "MARKET") return { orderId: 2, executedQty: q.quantity, cummulativeQuoteQty: String(Number(q.quantity) * 2001) };
    if (u.pathname === "/api/v3/order" && method === "GET") return { status: "PARTIALLY_FILLED", executedQty: "0.1", cummulativeQuoteQty: "200" };
    if (u.pathname === "/api/v3/order" && method === "DELETE") return { status: "CANCELED", executedQty: "0.2", cummulativeQuoteQty: "400" };
    if (u.pathname === "/api/v3/myTrades") return [{ commission: q.orderId === "1" ? "0.0002" : "0.0003", commissionAsset: "ETH" }];
    throw new Error(`unexpected ${method} ${u.pathname}`);
  };
  return { calls, http };
};

const adapter = (baseUrl: string, http: ReturnType<typeof fakeExchange>["http"]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-"));
  const ex = new BinanceExecution({ baseUrl, key: "k", secret: "s", dir, orderType: "limit-maker", makerTimeoutMs: 6000, pollMs: 2000, http, sleep: async () => undefined });
  return { ex, dir };
};

test("a maker order that times out is cancelled and the rest goes at market; the ledger and holdings follow", async () => {
  const { calls, http } = fakeExchange();
  const { ex, dir } = adapter("https://demo-api.binance.com", http);
  await ex.submit({ strategy: "horizon-x", symbol: "ETHUSDT", side: "BUY", usd: 1000, refPrice: 2000, paperCostBps: 12 });
  const [buy] = ex.ledger();
  assert.strictEqual(buy.status, "filled");
  assert.deepStrictEqual(buy.orders.map((o) => o.type), ["LIMIT_MAKER", "MARKET"]);
  assert.ok(Math.abs(buy.qty - 0.5) < 1e-9 && Math.abs(buy.quote - (400 + 0.3 * 2001)) < 1e-6);
  assert.strictEqual(calls.filter((c) => c === "GET /api/v3/order").length, 3, "polled until the timeout");
  assert.ok(calls.includes("DELETE /api/v3/order"));
  // holdings exclude the commission taken in ETH, so a later "sell everything" never asks for coins that are not there
  const held = JSON.parse(fs.readFileSync(path.join(dir, "execution-holdings.json"), "utf-8"))["horizon-x"].ETHUSDT;
  assert.ok(Math.abs(held - (0.5 - 0.0005)) < 1e-9);

  await ex.submit({ strategy: "horizon-x", symbol: "ETHUSDT", side: "SELL", usd: 0, all: true, refPrice: 2000, paperCostBps: 12 });
  const sell = ex.ledger()[1];
  assert.ok(Math.abs(sell.qty - 0.4995) < 1e-9, `sold what the strategy holds: ${sell.qty}`);
  assert.ok(sell.feeUsd > 0 && sell.feeBps > 0);
});

test("a stop file blocks a buy here too, and a non-testnet URL never reaches the exchange", async () => {
  const { calls, http } = fakeExchange();
  const { ex, dir } = adapter("https://demo-api.binance.com", http);
  fs.writeFileSync(path.join(dir, "STOP"), "test");
  await ex.submit({ strategy: "vote", symbol: "ETHUSDT", side: "BUY", usd: 100, refPrice: 2000, paperCostBps: 15 });
  assert.strictEqual(ex.ledger()[0].status, "refused");
  assert.strictEqual(calls.length, 0);

  const live = adapter("https://api.binance.com", http);
  await live.ex.submit({ strategy: "vote", symbol: "ETHUSDT", side: "BUY", usd: 100, refPrice: 2000, paperCostBps: 15 });
  const [entry] = live.ex.ledger();
  assert.strictEqual(entry.status, "refused");
  assert.match(entry.note ?? "", /not a Binance testnet/);
  assert.strictEqual(calls.length, 0, "the refused host was never contacted");
});
