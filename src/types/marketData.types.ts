export type CandleTimeframe = "minute" | "hour";

/** Binance symbol in the bot's notation, e.g. "ETH-USDT" or "BTC-USDT". */
export type MarketSymbol = string;

/**
 * OHLCV candle from Binance. `volumefrom` / `volumeto` keep their old names, so datasets saved earlier
 * stay readable; order-flow fields are optional because older rows do not have them.
 */
export interface IMarketCandle {
  time: number; // candle open, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volumefrom: number; // base asset volume (ETH)
  volumeto: number; // quote asset volume (USDT)
  trades?: number; // number of trades
  takerBuyBase?: number; // volume bought by market orders (aggressive buyers), base asset
  takerBuyQuote?: number; // same in quote asset
}

/** Binance USDⓈ-M futures market state, 5-minute resolution. */
export interface IFuturesMetrics {
  time: number; // unix seconds
  openInterest: number; // contracts (ETH)
  openInterestValue: number; // USDT
  longShortAccountRatio: number; // all accounts: long / short
  topTraderAccountRatio: number; // top traders by accounts: long / short
  topTraderPositionRatio: number; // top traders by position size: long / short
  takerBuySellRatio: number; // taker buy volume / taker sell volume
}

export interface IFundingRate {
  time: number; // unix seconds
  rate: number; // e.g. 0.0001 = 0.01% per funding interval
}

export interface ICandleSeries {
  minute: IMarketCandle[];
  hour: IMarketCandle[];
}

/** Everything the models need for one traded pair. */
export interface IMarketDataset extends ICandleSeries {
  // reference markets (e.g. BTC-USDT) in the order of config marketData.referencePairs
  references: ICandleSeries[];
  futures: IFuturesMetrics[];
  funding: IFundingRate[];
}
