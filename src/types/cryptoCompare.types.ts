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
