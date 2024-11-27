import { CryptoBase } from './basic.types';
export interface ICyptoCompareHistoryMinutePair {
  Response: string;
  Message: string;
  HasWarning: boolean;
  Type: number;
  Data: {
    Aggregated: boolean;
    TimeTo: number;
    TimeFrom: number;
    Data: ICyptoCompareData[];
  };
}

export type ICryptoCompareCurrency = {
  [key in CryptoBase]: number;
}

export interface ICyptoCompareData {
  time: number;
  high: number;
  low: number;
  open: number;
  volumefrom: number;
  volumeto: number;
  close: number;
  conversionType: string;
  conversionSymbol: string;
}

export interface IFormattedCurrencyHistory {
  time: number;
  waves_usd_open: number;
  waves_usd_close: number;
  waves_usd_high: number;
  waves_usd_low: number;

  eth_usd_open: number;
  eth_usd_close: number;
  eth_usd_high: number;
  eth_usd_low: number;

  waves_eth_open: number;
  waves_eth_close: number;
  waves_eth_high: number;
  waves_eth_low: number;
}