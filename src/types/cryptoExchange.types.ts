import { CryptoBase, CryptoExchangeCoins } from "./basic.types";

export interface ICryptoExchangeResponse {
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

export interface ICryptoExchangeTransactionsHistory {
  exchangeAPItransactionId: string;
  timestamp: number;
  fromCoin: CryptoBase;
  toCoin: CryptoBase;
  amount: number;
  walletFrom: string;
  walletTo: string;
  transactionHash: string;
  networkFee: number | Long | bigint;
}