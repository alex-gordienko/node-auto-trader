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
  All = "*",
	USD = "USD",
	BTC = "BTC",
	ETH = "ETH",
	USDT = "USDT",
	XMR = "XMR",
}

export interface IWSconfig {
	connectToCryptoCompare: (manualCall: boolean) => void
	subscribeToCryptoCompare: ({
		subs,
		exchange,
		base,
		quote,
	}: {
		subs: CryptoCompareChannels[]
		exchange: CryptoCompareExchange[]
		base: CryptoBase[]
		quote: CryptoBase[]
	}) => void
}
