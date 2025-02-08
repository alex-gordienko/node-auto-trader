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

export enum CryptoPairs {
	BTC_USD = "BTC-USD",
	BTC_ETH = "BTC-ETH",
	BTC_USDT = "BTC-USDT",
	BTC_TRX = "BTC-TRX",
	BTC_POLY = "BTC-MATIC",
	BTC_XMR = "BTC-XMR",
	BTC_WAVES = "BTC-WAVES",
	BTC_TON = "BTC-TON",
}

export enum CryptoExchangeCoins {
	ETH = "eth",
	XMR = "xmr",
	BNB = "bnb",
	BNB_BSC = "bnbbsc",
	TRX = "trx",
	POLY = "matic",
	WAVES = "waves",
	BTC = "btc",
}

export enum CryptoExchangePairs {
	BTC_USD = "btc_usd",
	BTC_ETH = "btc_eth",
	BTC_USDT = "btc_usdt",
	BTC_TRX = "btc_trx",
	BTC_POLY = "btc_matic",
	BTC_XMR = "btc_xmr",
	BTC_WAVES = "btc_waves",
	BTC_TON = "btc_ton",
}
