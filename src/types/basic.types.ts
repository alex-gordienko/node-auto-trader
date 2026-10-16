export interface IRoutesConfig {
	REST: {
		[key: string]: string
	}
}

export enum CryptoCompareChannels {
  All = "*",
	Trade = 0,
	Ticker = 2,
	Aggregate_Index = 5,
	Order_Book_L2 = 8,
	Full_Volume = 11,
	Full_Top_Tier_Volume = 21,
	OHLC_Candles = 24,
	Top_Order_Book = 30,
}

export enum CryptoCompareExchange {
  All = "*",
	Coinbase = "Coinbase",
	CCCAGG = "CCCAGG",
}

export enum CryptoBase {
	USDT = "USDT",
	ETH = "ETH",
}

export enum CryptoPairs {
	ETH_USDT = "ETH-USDT"
}

export enum CryptoExchangeCoins {
	ETH_USDT = "eth_usdt"
}
