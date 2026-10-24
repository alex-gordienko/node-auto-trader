import { IExecutionVenue, IOrderRequest, IOrderResult, ISymbolRules } from "./ExecutionVenue";

/**
 * Today's behaviour: a fill at the requested price, immediately, with no venue call. `Rebalance.service` already
 * computes the paper portfolio's fee/gas cost in `rebalanceStep`; this venue does not re-derive it — it reports a
 * fill consistent with the order it was handed, so the fill ledger has an entry shaped the same way a real venue's
 * would be.
 *
 * Idempotency is in-memory only: paper trading has no real retry/timeout to guard against, and the process
 * restarting resets paper state anyway (`<pair>-paper.json` on disk is the actual source of truth).
 */
class PaperVenue implements IExecutionVenue {
  public readonly name = "paper";
  private readonly orders = new Map<string, IOrderResult>();

  public async getBalances(): Promise<Record<string, number>> {
    return {};
  }

  public async getSymbolRules(): Promise<ISymbolRules> {
    return { tickSize: 0.01, stepSize: 0.000001, minNotional: 0 };
  }

  public async placeOrder(req: IOrderRequest): Promise<IOrderResult> {
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return existing;

    const avgFillPrice = req.limitPrice ?? 0;
    const filledBaseQty = req.baseQty ?? (req.quoteQty && avgFillPrice ? req.quoteQty / avgFillPrice : 0);
    const result: IOrderResult = {
      clientOrderId: req.clientOrderId,
      venueOrderId: null,
      status: "filled",
      filledBaseQty,
      avgFillPrice,
      feeAsset: "",
      feePaid: 0,
      raw: null,
    };
    this.orders.set(req.clientOrderId, result);
    return result;
  }

  public async getOrderByClientId(_symbol: string, clientOrderId: string): Promise<IOrderResult | null> {
    return this.orders.get(clientOrderId) ?? null;
  }

  public async cancelOrder(): Promise<void> {
    // nothing to cancel on paper: orders fill synchronously
  }
}

export default new PaperVenue();
