import { ICyptoCompareData, IFormattedCurrencyHistory } from "../types/cryptoCompare.types";

export const mergeDatasets = (datasets: ICyptoCompareData[][]): IFormattedCurrencyHistory[] => {
  const trainDataWAVES_ETH = datasets[0];
  const trainDataWAVES_USD = datasets[1];
  const trainDataETH_USD = datasets[2];

  const formattedTrainData: IFormattedCurrencyHistory[] = [];

  for (const trainDataWAVES_ETHItem of trainDataWAVES_ETH) {
    const trainDataWAVES_USDItem = trainDataWAVES_USD.find((item) => item.time === trainDataWAVES_ETHItem.time);
    const trainDataETH_USDItem = trainDataETH_USD.find((item) => item.time === trainDataWAVES_ETHItem.time);

    if (trainDataWAVES_USDItem && trainDataETH_USDItem) {
      formattedTrainData.push({
        time: trainDataWAVES_ETHItem.time,

        waves_usd_open: trainDataWAVES_USDItem.open,
        waves_usd_close: trainDataWAVES_USDItem.close,
        waves_usd_high: trainDataWAVES_USDItem.high,
        waves_usd_low: trainDataWAVES_USDItem.low,

        eth_usd_open: trainDataETH_USDItem.open,
        eth_usd_close: trainDataETH_USDItem.close,
        eth_usd_high: trainDataETH_USDItem.high,
        eth_usd_low: trainDataETH_USDItem.low,

        waves_eth_open: trainDataWAVES_ETHItem.open,
        waves_eth_close: trainDataWAVES_ETHItem.close,
        waves_eth_high: trainDataWAVES_ETHItem.high,
        waves_eth_low: trainDataWAVES_ETHItem.low,
      })
    }
  }

  return formattedTrainData;
};