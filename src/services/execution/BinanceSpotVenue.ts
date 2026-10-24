import axios from "axios";

import cryptoConfig from "../../config/crypto.config";
import { MarketSymbol } from "../../types/marketData.types";
import BinanceClient from "../collectors/BinanceClient";
import BinanceSigner from "./signing/BinanceSigner";
import { IExecutionVenue, IOrderRequest, IOrderResult, ISymbolRules } from "./ExecutionVenue";

type BinanceOrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "PENDING_CANCEL" | "REJECTED" | "EXPIRED";

interface IBinanceFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

interface IBinanceOrderResponse {
  orderId: number;
  clientOrderId: string;
  status: BinanceOrderStatus;
  executedQty: string;
  cummulativeQuoteQty: string;
  // only present on the placeOrder response, not on a later getOrderByClientId lookup
  fills?: IBinanceFill[];
}

interface IBinanceExchangeInfo {
  symbols: { filters: { filterType: string; tickSize?: string; stepSize?: string; minNotional?: string }[] }[];
}

const toOrderStatus = (status: BinanceOrderStatus): IOrderResult["status"] => {
  if (status === "FILLED") return "filled";
  if (status === "PARTIALLY_FILLED") return "partial";
  if (status === "NEW" || status === "PENDING_CANCEL") return "open";
  if (status === "CANCELED" || status === "REJECTED" || status === "EXPIRED") return "rejected";
  return "unknown";
};

const toOrderResult = (res: IBinanceOrderResponse): IOrderResult => {
  const executedQty = Number(res.executedQty);
  const cumulativeQuote = Number(res.cummulativeQuoteQty);
  const fills = res.fills ?? [];
  return {
    clientOrderId: res.clientOrderId,
    venueOrderId: String(res.orderId),
    status: toOrderStatus(res.status),
    filledBaseQty: executedQty,
    avgFillPrice: executedQty > 0 ? cumulativeQuote / executedQty : 0,
    feeAsset: fills[0]?.commissionAsset ?? "",
    feePaid: fills.reduce((sum, f) => sum + Number(f.commission), 0),
    raw: res,
  };
};

/**
 * Signed Binance spot REST (TRA-16 P1). `BinanceSigner` is the only module that touches key material; this class
 * only builds the canonical query string, has it signed, and sends the request. `cryptoConfig.binance.baseUrl`
 * defaults to the public testnet, so this venue cannot reach a mainnet host by accident.
 */
class BinanceSpotVenue implements IExecutionVenue {
  public readonly name = "binance-spot";

  private symbol(pair: string): string {
    return BinanceClient.symbol(pair as MarketSymbol);
  }

  /** Binance's "Order does not exist" error — signals a miss, not a failure, to getOrderByClientId's caller. */
  private isOrderNotFound(error: unknown): boolean {
    return axios.isAxiosError(error) && (error.response?.data as { code?: number } | undefined)?.code === -2013;
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number>
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.append(key, String(value));
    query.append("timestamp", String(Date.now()));
    query.append("recvWindow", String(cryptoConfig.binance.recvWindowMs));

    // signature is computed over the exact string sent, so it is appended only after everything else
    query.append("signature", BinanceSigner.sign(query.toString()));

    const url = `${cryptoConfig.binance.baseUrl}${path}`;
    const headers = { "X-MBX-APIKEY": cryptoConfig.binance.apiKey };
    const config = { params: query, headers, timeout: 15000 };

    const response =
      method === "GET"
        ? await axios.get<T>(url, config)
        : method === "POST"
        ? await axios.post<T>(url, null, config)
        : await axios.delete<T>(url, config);
    return response.data;
  }

  public async getBalances(): Promise<Record<string, number>> {
    const account = await this.signedRequest<{ balances: { asset: string; free: string }[] }>(
      "GET",
      "/api/v3/account",
      {}
    );
    const balances: Record<string, number> = {};
    for (const b of account.balances) balances[b.asset] = Number(b.free);
    return balances;
  }

  public async getSymbolRules(symbol: string): Promise<ISymbolRules> {
    // public endpoint — not signed
    const info = await axios.get<IBinanceExchangeInfo>(`${cryptoConfig.binance.baseUrl}/api/v3/exchangeInfo`, {
      params: { symbol: this.symbol(symbol) },
      timeout: 15000,
    });
    const filters = info.data.symbols[0]?.filters ?? [];
    const priceFilter = filters.find((f) => f.filterType === "PRICE_FILTER");
    const lotSizeFilter = filters.find((f) => f.filterType === "LOT_SIZE");
    const notionalFilter = filters.find((f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL");
    return {
      tickSize: Number(priceFilter?.tickSize ?? 0),
      stepSize: Number(lotSizeFilter?.stepSize ?? 0),
      minNotional: Number(notionalFilter?.minNotional ?? 0),
    };
  }

  public async placeOrder(req: IOrderRequest): Promise<IOrderResult> {
    const params: Record<string, string | number> = {
      symbol: this.symbol(req.symbol),
      side: req.side.toUpperCase(),
      type: req.type.toUpperCase(),
      newClientOrderId: req.clientOrderId,
    };

    if (req.type === "market") {
      if (req.quoteQty !== undefined) params.quoteOrderQty = req.quoteQty;
      else if (req.baseQty !== undefined) params.quantity = req.baseQty;
      else throw new Error(`placeOrder ${req.clientOrderId}: market order needs quoteQty or baseQty`);
    } else {
      if (req.baseQty === undefined || req.limitPrice === undefined) {
        throw new Error(`placeOrder ${req.clientOrderId}: limit order needs baseQty and limitPrice`);
      }
      params.quantity = req.baseQty;
      params.price = req.limitPrice;
      params.timeInForce = req.timeInForce ?? "GTC";
    }

    const res = await this.signedRequest<IBinanceOrderResponse>("POST", "/api/v3/order", params);
    return toOrderResult(res);
  }

  public async getOrderByClientId(symbol: string, clientOrderId: string): Promise<IOrderResult | null> {
    try {
      const res = await this.signedRequest<IBinanceOrderResponse>("GET", "/api/v3/order", {
        symbol: this.symbol(symbol),
        origClientOrderId: clientOrderId,
      });
      return toOrderResult(res);
    } catch (error: unknown) {
      if (this.isOrderNotFound(error)) return null;
      throw error;
    }
  }

  public async cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    await this.signedRequest("DELETE", "/api/v3/order", {
      symbol: this.symbol(symbol),
      origClientOrderId: clientOrderId,
    });
  }
}

export default new BinanceSpotVenue();
