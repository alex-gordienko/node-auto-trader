import { CryptoBase, CryptoExchangeCoins, CryptoPairs } from "./basic.types";

export interface ICryptoExchangeAvailableCurrenciesResponse {
    "ticker": string,
    "name": string,
    "image": string,
    "hasExternalId": boolean,
    "isExtraIdSupported": boolean,
    "isFiat": boolean,
    "featured": boolean,
    "isStable": boolean,
    "supportsFixedRate": boolean,
    "network": string,
    "tokenContract": unknown,
    "buy": boolean,
    "sell": boolean,
    "legacyTicker": string
  }

export interface ICryptoExchangePossiblePairsResponse {
  fromCurrency: string,
  fromNetwork: string,
  toCurrency: string,
  toNetwork: string,
  flow: {
    standard: boolean,
    "fixed-rate": boolean
  }
}

export interface ICryptoExchangeSwapResponse {
  id: string;
  fromAmount: number;
  toAmount: number;
  flow: "standard" | "fixed-rate";
  type: "direct" | "reverse";
  payinAddress: string;
  payoutAddress: string;
  payinExtraId: string;
  payoutExtraId: string;
  fromCurrency: CryptoExchangeCoins;
  fromNetwork: string;
  toCurrency: CryptoExchangeCoins;
  toNetwork: string;
  refundAddress: string;
  refundExtraId: string;
  payoutExtraIdName: string;
  rateId: string;
}

export interface ICryproExchangeWalletHistory {
  timestamp: number;
  amount: number;
}

export interface ITensorflowPrediction {
  pair: CryptoPairs;
  timestamp: number;
  current_value: number;

  lstm_timestamp: number;
  predicted_value: number;
  predicted_command: string;
  predicted_return?: number;
  // raw forecast outputs (see FORECAST_LAYOUT) — kept even when unreliable, so self-correction can judge them
  forecast_raw?: number[];
  forecast_path?: IForecastPath;
  forecast_reliable?: boolean;
  // order-book model's verdict at the decision, one value per ORDERFLOW_HORIZONS_SECONDS (0 where not reliable)
  orderflow_verdict?: number[];
  // position the DQN decided from: 1 = holding ETH, 0 = holding USDT
  position?: number;
  q_values?: {
    hold: number;
    buy: number;
    sell: number;
  };
}

export interface ICryptoExchangeTransactionsHistory {
  exchangeAPItransactionId: string;
  timestamp: number;
  fromCoin: CryptoBase;
  toCoin: CryptoBase;
  amount: number;
  walletFrom: string;
  walletTo: string;
  transactionHash: string;
  networkFee: number | bigint;
}
export interface IForecastPath {
  horizons: { minutes: number; return: number; reliable: boolean }[];
  // best price to sell (max) / buy (min) within the longest horizon, and when it is expected
  // `reliable` refers to the size of the move, `timeReliable` to when it happens: they are checked separately
  max: { return: number; inMinutes: number; reliable: boolean; timeReliable: boolean };
  min: { return: number; inMinutes: number; reliable: boolean; timeReliable: boolean };
}
