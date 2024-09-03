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
	BNB = "BNB",
	TRX = "TRX",
	POLY = "MATIC",
	XMR = "XMR",
	WAVES = "WAVES",
}

export enum CryptoExchangeCoins {
	ETH = "eth",
	XMR = "xmr",
	BNB = "bnb",
	BNB_BSC = "bnbbsc",
	TRX = "trx",
	POLY = "matic",
	WAVES = "waves",
}

export enum CryptoExchangePairs {
	ETH_XMR = "eth_xmr",
	XMR_ETH = "xmr_eth",
	BNB_BSC_ETH = "bnbbsc_eth",
	ETH_BNB_BSC = "eth_bnbbsc",
	ETH_TRX = "eth_trx",
	TRX_ETH = "trx_eth",
	ETH_POLY = "eth_matic",
	POLY_ETH = "matic_eth",
	ETH_WAVES = "eth_waves",
	WAVES_ETH = "waves_eth",
}
