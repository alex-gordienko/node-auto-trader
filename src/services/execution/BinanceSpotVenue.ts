import { IExecutionVenue, IOrderResult, ISymbolRules } from "./ExecutionVenue";

/**
 * Not implemented yet (TRA-16 P1). Signed Binance spot REST needs a Binance Spot Testnet API key, which has not
 * been requested — nothing in P0 needs it. The boundary (`IExecutionVenue`) exists now so `ExecutionService` can
 * route to this venue later without `Rebalance.service` or the DQN path changing.
 *
 * When implemented: `X-MBX-APIKEY` header, Ed25519-signed canonical query string (never HMAC — see TRA-16 plan
 * §2.3), `BinanceSigner` as the only module touching key material, and `getOrderByClientId` checked before any
 * retry of a timed-out `placeOrder`.
 */
class BinanceSpotVenue implements IExecutionVenue {
  public readonly name = "binance-spot";

  private notImplemented(): never {
    throw new Error(
      "BinanceSpotVenue is not implemented yet (TRA-16 P1). EXECUTION_MODE must stay \"paper\" until it lands."
    );
  }

  public async getBalances(): Promise<Record<string, number>> {
    this.notImplemented();
  }

  public async getSymbolRules(): Promise<ISymbolRules> {
    this.notImplemented();
  }

  public async placeOrder(): Promise<IOrderResult> {
    this.notImplemented();
  }

  public async getOrderByClientId(): Promise<IOrderResult | null> {
    this.notImplemented();
  }

  public async cancelOrder(): Promise<void> {
    this.notImplemented();
  }
}

export default new BinanceSpotVenue();
