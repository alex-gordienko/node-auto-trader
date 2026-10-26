import type { IOrderRequest } from "../services/BinanceExecution.service";

/**
 * Pure helpers of the Binance order adapter (services/BinanceExecution.service.ts): which base URL may receive
 * orders, exchange-filter rounding, and how a fill compares with the price the paper book assumed.
 */

// Binance Demo Trading and the old Spot Testnet: fake money only
export const TESTNET_HOSTS = ["demo-api.binance.com", "testnet.binance.vision"];
export const DEFAULT_TESTNET_URL = "https://demo-api.binance.com";

/**
 * null when orders may be sent to `url`, otherwise why not. A testnet host is always allowed. Anything else is real
 * money and needs both LIVE_TRADING=true and a confirmation file whose content is exactly that host name — two
 * separate, deliberate steps, so neither a stray env var nor a copied config alone can switch to real orders.
 */
export const refuseBaseUrl = (url: string, liveFlag: string | undefined, confirmation: string | null): string | null => {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return `${url}: orders go over https only`;
    host = u.hostname;
  } catch {
    return `${url} is not a URL`;
  }
  if (TESTNET_HOSTS.includes(host)) return null;
  if (liveFlag !== "true") return `${host} is not a Binance testnet: real-money orders need LIVE_TRADING=true and a confirmation file`;
  if (confirmation?.trim() !== host) return `${host}: LIVE_TRADING=true, but the confirmation file does not name this host`;
  return null;
};

const decimals = (step: string) => step.replace(/0+$/, "").split(".")[1]?.length ?? 0;

/** Quantity floored to the LOT_SIZE step, as the string Binance expects. */
export const floorToStep = (qty: number, step: string): string => {
  const s = Number(step);
  return (Math.floor(qty / s + 1e-9) * s).toFixed(decimals(step));
};

/** Limit price on the PRICE_FILTER tick: a maker buy rounds down, a maker sell rounds up (never crosses the book). */
export const roundToTick = (price: number, tick: string, side: "BUY" | "SELL"): string => {
  const t = Number(tick);
  const n = side === "BUY" ? Math.floor(price / t + 1e-9) : Math.ceil(price / t - 1e-9);
  return (n * t).toFixed(decimals(tick));
};

/** How much worse than `ref` the average fill was, in bps (negative = better). */
export const slippageBps = (side: "BUY" | "SELL", avgPrice: number, ref: number): number =>
  (side === "BUY" ? avgPrice / ref - 1 : ref / avgPrice - 1) * 1e4;

/**
 * Orders that bring a strategy's testnet holdings to its paper position, coin by coin; differences worth less than
 * `minUsd` are left alone (fee dust). A paper leg at zero sells everything the strategy holds there.
 */
export const reconcileOrders = (
  strategy: string,
  paperQty: Record<string, number>, // coin → quantity held on paper
  held: (symbol: string) => number, // the strategy's testnet holdings
  prices: Record<string, number>,
  minUsd: number,
  paperCostBps: number
): IOrderRequest[] =>
  Object.entries(paperQty).flatMap(([coin, qty]) => {
    const symbol = `${coin}USDT`;
    const diff = qty - held(symbol);
    if (Math.abs(diff) * prices[coin] < minUsd) return [];
    return [{ strategy, symbol, side: diff > 0 ? "BUY" : "SELL", usd: Math.abs(diff) * prices[coin], all: qty === 0, refPrice: prices[coin], paperCostBps }];
  });
