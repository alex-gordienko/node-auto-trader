export interface IRoutesConfig {
	REST: {
		[key: string]: string
	}
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
