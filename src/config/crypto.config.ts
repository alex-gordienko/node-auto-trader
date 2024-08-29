import dotenv from "dotenv";
dotenv.config();

const cryptoConfig = {
  // api-keys
  cryptoCompareApiKey: process.env.CRYPTO_COMPARE_API_KEY || "YOUR_API_KEY", // get currency rates
  changeNowApiKey: process.env.CHANGE_NOW_API || "YOUR_API_KEY", // exchange currencies

  // providers api-keys
  infuraApiKey: process.env.INFURA_API_KEY || "YOUR_API_KEY", // provider for Atomic wallet API
  blockCypherApiKey: process.env.BLOCK_CYPHER_API || "YOUR_API",

  // wallet addresses
  etheriumWallet: process.env.ETHERIUM_WALLET_ADDRESS || "YOUR_WALLET", // wallet for Etherium from Atomic
  polygonWallet: process.env.POLYGON_WALLET_ADDRESS || "YOUR_WALLET", // wallet for Binance from Atomic

  // wallet keys
  etheriumPrivateKey: process.env.ETHERIUM_PRIVATE_KEY || "YOUR_PRIVATE", // wallet for Etherium from Atomic
  polyPrivateKey: process.env.POLYGON_PRIVATE_KEY || "YOUR_PRIVATE", // wallet for Binance from Atomic

  requestLimitMinutePairPrediction: Number(process.env.REQUEST_LIMIT_PREDICTION || 10),
  requestLimitMinutePairModelTraining: Number(process.env.REQUEST_LIMIT_TRAINING || 2000),

  autoPredictionInterval: {
    units: (process.env.AUTO_PREDICTION_INTERVAL_UNITS || "minutes") as "minutes" | "hours",
    interval: Number(process.env.AUTO_PREDICTION_INTERVAL || 10),
  },

  autoDatasetForMinuteModelUpdateInterval: {
    units: (process.env.AUTO_DATASET_UPDATE_INTERVAL_UNITS || "minutes") as "hours" | "minutes",
    interval: Number(process.env.AUTO_DATASET_UPDATE_INTERVAL || 10),
  },

  autoDatasetForHourModelUpdateInterval: {
    units: (process.env.AUTO_DATASET_UPDATE_HOUR_INTERVAL_UNITS || "hours") as "hours" | "days",
    interval: Number(process.env.AUTO_DATASET_UPDATE_HOUR_INTERVAL || 2),
  },

  autoRetrainingMinuteModelInterval: {
    units: (process.env.AUTO_RETRAINING_MINUTE_INTERVAL_UNITS || "hours") as "hours" | "days",
    interval: Number(process.env.AUTO_RETRAINING_MINUTE_INTERVAL || 12),
  },

  autoRetrainingHourModelInterval: {
    units: (process.env.AUTO_RETRAINING_HOUR_INTERVAL_UNITS || "days") as "hours" | "days",
    interval: Number(process.env.AUTO_RETRAINING_HOUR_INTERVAL || 1),
  },

  autoUpdateWalletBalanceInterval: {
    units: (process.env.AUTO_UPDATE_WALLET_BALANCE_INTERVAL_UNITS || "minutes") as "minutes" | "hours",
    interval: Number(process.env.AUTO_UPDATE_WALLET_BALANCE_INTERVAL || 10),
  },

  environment: process.env.ENVIRONMENT || "development",
};

export default cryptoConfig;
