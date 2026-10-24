/**
 * The boundary strategy code sees. `PaperVenue` is today's behaviour (default); a live venue is added later
 * (TRA-16 P1+) without the strategy code (Rebalance.service, the DQN path) changing at all.
 *
 * `clientOrderId` is the core safety property, not a convenience: it must be derived deterministically from the
 * decision (pair + side + decision timestamp), so a network timeout on `placeOrder` is never retried blind — the
 * retry path is `getOrderByClientId` first, and only place if the venue has never seen that id. Without this, one
 * dropped response double-trades real money.
 */

export interface IOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quoteQty?: number; // buys: spend N quote units (e.g. USDT)
  baseQty?: number; // sells: sell N base units (e.g. ETH)
  limitPrice?: number;
  timeInForce?: "IOC" | "GTC";
  clientOrderId: string;
}

export interface IOrderResult {
  clientOrderId: string;
  venueOrderId: string | null;
  status: "filled" | "partial" | "rejected" | "open" | "unknown";
  filledBaseQty: number;
  avgFillPrice: number;
  feeAsset: string;
  feePaid: number;
  raw: unknown;
}

export interface ISymbolRules {
  tickSize: number;
  stepSize: number;
  minNotional: number;
}

export interface IExecutionVenue {
  readonly name: string;
  getBalances(): Promise<Record<string, number>>;
  getSymbolRules(symbol: string): Promise<ISymbolRules>;
  placeOrder(req: IOrderRequest): Promise<IOrderResult>;
  getOrderByClientId(symbol: string, clientOrderId: string): Promise<IOrderResult | null>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<void>;
}

/** `${pair}-${side}-${decisionEpochMs}` — unique per decision, stable across retries of the same decision. */
export const deterministicClientOrderId = (symbol: string, side: "buy" | "sell", decisionEpochMs: number): string =>
  `${symbol}-${side}-${decisionEpochMs}`;
