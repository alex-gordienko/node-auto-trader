import dotenv from "dotenv";
dotenv.config();

const cryptoConfig = {
  useGPU: process.env.USE_GPU === "true" || false,
  // api-keys
  cryptoCompareApiKey: process.env.CRYPTO_COMPARE_API_KEY || "YOUR_API_KEY", // get currency rates
  changeNowApiKey: process.env.CHANGE_NOW_API || "YOUR_API_KEY", // exchange currencies

  // providers api-keys
  infuraApiKey: process.env.INFURA_API_KEY || "YOUR_API_KEY", // provider for Atomic wallet API
  blockCypherApiKey: process.env.BLOCK_CYPHER_API || "YOUR_API",
  zeroXApiKey: process.env.ZEROX_API_KEY || "YOUR_API_KEY", // provider for DEX-aggregator API

  // wallet addresses
  etheriumWallet: process.env.ETHERIUM_WALLET_ADDRESS || "YOUR_WALLET", // wallet for Etherium from Atomic
  wavesWallet: process.env.WAVES_WALLET_ADDRESS || "YOUR_WALLET", // wallet for Waves from Atomic

  // wallet keys
  etheriumPrivateKey: process.env.ETHERIUM_PRIVATE_KEY || "YOUR_PRIVATE", // wallet for Etherium from Atomic
  wavesPrivateKey: process.env.WAVES_PRIVATE_KEY || "YOUR_PRIVATE", // wallet for Waves from Atomic

  shortTermMinuteWindowPrediction: Number(process.env.REQUEST_LIMIT_SHORT_TERM_PREDICTION || 5),
  longTermMinuteWindowPrediction: Number(process.env.REQUEST_LIMIT_LONG_TERM_PREDICTION || 15),
  requestLimitMinutePairModelTraining: Number(process.env.REQUEST_LIMIT_TRAINING || 2000),

  autoPredictionInterval: {
    units: (process.env.AUTO_PREDICTION_INTERVAL_UNITS || "minutes") as "minutes" | "hours",
    interval: Number(process.env.AUTO_PREDICTION_INTERVAL || 10),
  },

  autoDatasetForMinuteModelUpdateInterval: {
    units: (process.env.AUTO_DATASET_UPDATE_INTERVAL_UNITS || "hours") as "hours" | "minutes",
    interval: Number(process.env.AUTO_DATASET_UPDATE_INTERVAL || 11),
  },

  autoRetrainingMinuteModelInterval: {
    units: (process.env.AUTO_RETRAINING_MINUTE_INTERVAL_UNITS || "hours") as "hours" | "days",
    interval: Number(process.env.AUTO_RETRAINING_MINUTE_INTERVAL || 12),
  },

  autoUpdateWalletBalanceInterval: {
    units: (process.env.AUTO_UPDATE_WALLET_BALANCE_INTERVAL_UNITS || "minutes") as "minutes" | "hours",
    interval: Number(process.env.AUTO_UPDATE_WALLET_BALANCE_INTERVAL || 10),
  },

  environment: process.env.ENVIRONMENT || "development",

  forecast: {
    horizonMinutes: Number(process.env.FORECAST_HORIZON_MINUTES || 15),
    windowSize: Number(process.env.FORECAST_WINDOW_SIZE || 30),
    epochs: Number(process.env.FORECAST_EPOCHS || 30),
    learningRate: Number(process.env.FORECAST_LEARNING_RATE || 0.001),
  },

  cryptoCompare: {
    // candles kept for inference (indicators need warmup + window)
    inferenceCandles: Number(process.env.CRYPTO_COMPARE_INFERENCE_CANDLES || 200),
    priceCacheTtlSeconds: Number(process.env.CRYPTO_COMPARE_PRICE_CACHE_TTL || 120),
    // pause after a rate-limit response
    rateLimitCooldownMinutes: Number(process.env.CRYPTO_COMPARE_RATE_LIMIT_COOLDOWN || 60),
  },

  rl: {
    learningRate: Number(process.env.RL_LEARNING_RATE || 0.0005),
    gamma: Number(process.env.RL_GAMMA || 0.95),
    epsilonStart: Number(process.env.RL_EPSILON_START || 1),
    epsilonMin: Number(process.env.RL_EPSILON_MIN || 0.05),
    epsilonDecay: Number(process.env.RL_EPSILON_DECAY || 0.97),
    replaySize: Number(process.env.RL_REPLAY_SIZE || 5000),
    batchSize: Number(process.env.RL_BATCH_SIZE || 64),
    episodes: Number(process.env.RL_EPISODES || 15),
    trainEvery: Number(process.env.RL_TRAIN_EVERY || 4),
    targetUpdateEvery: Number(process.env.RL_TARGET_UPDATE_EVERY || 200),
    feeRate: Number(process.env.RL_FEE_RATE || 0.0005),
    invalidActionPenalty: Number(process.env.RL_INVALID_ACTION_PENALTY || 0.002),
    // share of every training batch taken from real production decisions (self-correction)
    liveSampleShare: Number(process.env.RL_LIVE_SAMPLE_SHARE || 0.25),
  },
};

export default cryptoConfig;
