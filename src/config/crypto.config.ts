import dotenv from "dotenv";
import path from "path";
dotenv.config();

/** Sorted unique horizons that always include the main one. */
const parseHorizons = (value: string, main: number): number[] =>
  Array.from(new Set([...value.split(",").map(Number).filter((v) => v > 0), main])).sort((a, b) => a - b);

const cryptoConfig = {
  useGPU: process.env.USE_GPU === "true" || false,
  // api-keys
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

  // DQN looks at this many minutes
  longTermMinuteWindowPrediction: Number(process.env.REQUEST_LIMIT_LONG_TERM_PREDICTION || 15),

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

  // Feature groups the models see. Data is collected either way; a disabled group is fed as zeros, so the
  // model layout stays the same and the contribution of each group can be measured (`yarn features:report`).
  features: {
    // reference markets after the first one (BTC-USDT is always used)
    extraReferences: (process.env.FEATURE_EXTRA_REFERENCES || "true") === "true",
    premiumIndex: (process.env.FEATURE_PREMIUM_INDEX || "true") === "true",
    dvol: (process.env.FEATURE_DVOL || "true") === "true",
    stablecoins: (process.env.FEATURE_STABLECOINS || "true") === "true",
    fearGreed: (process.env.FEATURE_FEAR_GREED || "true") === "true",
    // time of week, trading session, volatility / trend regime, distance to round prices and recent highs / lows
    regime: (process.env.FEATURE_REGIME || "true") === "true",
    // verdict of the order-book model (OrderFlow.service) as a DQN input
    orderFlow: (process.env.FEATURE_ORDER_FLOW || "true") === "true",
  },

  // Order-book model: learns from the recorded order books, trades and liquidations what the price does in the
  // next 10 s / 1 min / 5 min; its verdict is a DQN input. History exists only since recording started.
  orderFlow: {
    windowSeconds: Number(process.env.ORDERFLOW_WINDOW_SECONDS || 60),
    trainingDays: Number(process.env.ORDERFLOW_TRAINING_DAYS || 14),
    sampleStepSeconds: Number(process.env.ORDERFLOW_SAMPLE_STEP || 5),
    maxSamples: Number(process.env.ORDERFLOW_MAX_SAMPLES || 60000),
    epochs: Number(process.env.ORDERFLOW_EPOCHS || 40),
    // below this much recorded data the model is not trained (and its verdict is zeros)
    minHours: Number(process.env.ORDERFLOW_MIN_HOURS || 24),
  },

  forecast: {
    // main horizon: shown as predicted_value and used to judge DQN decisions
    horizonMinutes: Number(process.env.FORECAST_HORIZON_MINUTES || 15),
    // price path: return is forecast for each of these horizons; max/min and their timing within the longest one
    // (short horizons only: the bot relies on the minute price, not on guesses hours ahead)
    horizons: parseHorizons(process.env.FORECAST_HORIZONS || "5,15", Number(process.env.FORECAST_HORIZON_MINUTES || 15)),
    windowSize: Number(process.env.FORECAST_WINDOW_SIZE || 60),
    // hourly candles seen by the forecast (48h = two daily cycles)
    hourWindowSize: Number(process.env.FORECAST_HOUR_WINDOW_SIZE || 48),
    epochs: Number(process.env.FORECAST_EPOCHS || 80),
    // stop when validation has not improved for this many epochs; the best epoch's weights are restored
    patience: Number(process.env.FORECAST_PATIENCE || 8),
    batchSize: Number(process.env.FORECAST_BATCH_SIZE || 256),
    // take every N-th minute as a sample: neighbours are near-duplicates, so this covers more history per sample
    sampleStride: Number(process.env.FORECAST_SAMPLE_STRIDE || 2),
    learningRate: Number(process.env.FORECAST_LEARNING_RATE || 0.001),
    // Network size. Measured on 90 days of ETH-USDT (2026-10-17), evaluation part:
    //   64/1 layer, no LayerNorm  → range IC 0.27–0.29, ~6 min
    //   64/1 layer + LayerNorm    → range IC 0.26–0.27, ~20 min
    //   128/2 layers + LayerNorm  → range IC 0.19–0.24, ~1h48m (overfits)
    // so the small network is the default; change only if the evaluation numbers improve.
    network: {
      minuteUnits: Number(process.env.FORECAST_MINUTE_UNITS || 64),
      minuteLayers: Number(process.env.FORECAST_MINUTE_LAYERS || 1),
      hourUnits: Number(process.env.FORECAST_HOUR_UNITS || 32),
      denseUnits: Number(process.env.FORECAST_DENSE_UNITS || 64),
      dropout: Number(process.env.FORECAST_DROPOUT || 0.2),
      l2: Number(process.env.FORECAST_L2 || 1e-4),
      layerNorm: (process.env.FORECAST_LAYER_NORM || "false") === "true",
    },
    // newest samples used per training, keeps time and memory bounded on long histories
    maxTrainingSamples: Number(process.env.FORECAST_MAX_TRAINING_SAMPLES || 60000),
  },

  // Data and models live in the project folder (paths from the project root, where yarn scripts run), so the
  // compiled server (build/) and ts-node use the same files. Backtests point MODELS_DIR to a separate folder.
  paths: {
    storageDir: process.env.STORAGE_DIR || path.join(process.cwd(), "src/Storage"),
    modelsDir: process.env.MODELS_DIR || path.join(process.cwd(), "src/models"),
  },

  // Real-time market microstructure recorders, started together with the server. Binance keeps no free history of
  // order books / trades streams, so everything a future order-flow model trains on has to be recorded here.
  collectors: {
    // the recorders run in a worker thread of the server process; COLLECTORS_ENABLED=false switches them off
    enabled: (process.env.COLLECTORS_ENABLED || "true") === "true",
    symbols: (process.env.COLLECTOR_SYMBOLS || "ETH-USDT,BTC-USDT").split(",").filter(Boolean),
    // order book: top N levels, one snapshot per interval (the stream itself updates every 100 ms)
    depthLevels: Number(process.env.COLLECTOR_DEPTH_LEVELS || 20),
    depthSnapshotMs: Number(process.env.COLLECTOR_DEPTH_SNAPSHOT_MS || 1000),
    spotStreamUrl: process.env.COLLECTOR_SPOT_WS || "wss://data-stream.binance.vision/ws",
    // Binance serves futures order books on /public and trades / liquidations on /market
    futuresPublicStreamUrl: process.env.COLLECTOR_FUTURES_PUBLIC_WS || "wss://fstream.binance.com/public/ws",
    futuresMarketStreamUrl: process.env.COLLECTOR_FUTURES_MARKET_WS || "wss://fstream.binance.com/market/ws",
    // a stream silent for this long is treated as dead and reconnected
    silenceTimeoutSeconds: Number(process.env.COLLECTOR_SILENCE_TIMEOUT || 60),
    storageDir: process.env.COLLECTOR_STORAGE_DIR || path.join(process.env.STORAGE_DIR || path.join(process.cwd(), "src/Storage"), "collectors"),
  },

  // all market data comes from Binance public endpoints, no API key needed
  marketData: {
    // spot market-data-only mirror first, main API as a fallback
    binanceApiUrls: (process.env.BINANCE_API_URLS || "https://data-api.binance.vision,https://api.binance.com").split(","),
    binanceFuturesApiUrl: process.env.BINANCE_FUTURES_API_URL || "https://fapi.binance.com",
    binanceArchiveUrl: process.env.BINANCE_ARCHIVE_URL || "https://data.binance.vision",
    // markets the traded pair is compared with: BTC leads the market, ETH-BTC shows ETH's own strength,
    // large altcoins show where money rotates
    referencePairs: (process.env.REFERENCE_PAIRS || "BTC-USDT,ETH-BTC,SOL-USDT,BNB-USDT,XRP-USDT").split(",").filter(Boolean),
    // futures open interest, long/short ratios and funding as extra inputs
    useFutures: (process.env.USE_FUTURES_DATA || "true") === "true",
    // initial history loaded from Binance archives when the dataset is empty
    backfillMinuteDays: Number(process.env.BINANCE_BACKFILL_MINUTE_DAYS || 90),
    backfillHourDays: Number(process.env.BINANCE_BACKFILL_HOUR_DAYS || 365),
    // minute history loaded for each retraining (DQN episodes are random segments of it)
    trainingMinuteDays: Number(process.env.TRAINING_MINUTE_DAYS || 90),
    // other free sources with history
    deribitApiUrl: process.env.DERIBIT_API_URL || "https://www.deribit.com/api/v2",
    stablecoinsUrl: process.env.STABLECOINS_URL || "https://stablecoins.llama.fi/stablecoincharts/all",
    fearGreedUrl: process.env.FEAR_GREED_URL || "https://api.alternative.me/fng/",
    // candles kept in memory for inference (indicators need warmup + window)
    inferenceCandles: Number(process.env.INFERENCE_CANDLES || 300),
    priceCacheTtlSeconds: Number(process.env.PRICE_CACHE_TTL || 120),
  },

  rl: {
    learningRate: Number(process.env.RL_LEARNING_RATE || 0.0005),
    network: {
      convFilters: Number(process.env.RL_CONV_FILTERS || 32),
      lstmUnits: Number(process.env.RL_LSTM_UNITS || 32),
      denseUnits: Number(process.env.RL_DENSE_UNITS || 32),
      layerNorm: (process.env.RL_LAYER_NORM || "false") === "true",
    },
    // Reward = position × (return − average market drift of the training data). Without this the DQN learns the
    // trend of its training period ("always buy" after a rising month) instead of timing.
    removeDrift: (process.env.RL_REMOVE_DRIFT || "true") === "true",
    // rewards are price returns (~0.0001); scaling them to percent keeps Q-values in a range the network learns well
    rewardScale: Number(process.env.RL_REWARD_SCALE || 100),
    gamma: Number(process.env.RL_GAMMA || 0.95),
    epsilonStart: Number(process.env.RL_EPSILON_START || 1),
    epsilonMin: Number(process.env.RL_EPSILON_MIN || 0.05),
    // share of training after which exploration reaches epsilonMin (linear decrease);
    // the rest of training the agent mostly follows and corrects its own decisions
    explorationShare: Number(process.env.RL_EXPLORATION_SHARE || 0.6),
    // experience the DQN remembers and learns from (≈ the last 25 episodes of 2000 steps)
    replaySize: Number(process.env.RL_REPLAY_SIZE || 50000),
    batchSize: Number(process.env.RL_BATCH_SIZE || 64),
    episodes: Number(process.env.RL_EPISODES || 40),
    // the DQN decides (and may trade) once per this many minutes — in training and in live trading;
    // keep AUTO_PREDICTION_INTERVAL at most this, or decisions are skipped
    decisionMinutes: Number(process.env.RL_DECISION_MINUTES || 5),
    // each episode is a random segment of this many decisions (500 decisions every 5 min ≈ 1.7 days)
    episodeSteps: Number(process.env.RL_EPISODE_STEPS || 500),
    trainEvery: Number(process.env.RL_TRAIN_EVERY || 4),
    targetUpdateEvery: Number(process.env.RL_TARGET_UPDATE_EVERY || 200),
    // Real cost of one swap: exchange fee + spread (share of the amount) and a fixed network fee for a typical
    // trade size. Unknown until real swaps are made — the defaults match the "typical" backtest level.
    feeRate: Number(process.env.RL_FEE_RATE || 0.005),
    gasUsd: Number(process.env.RL_GAS_USD || 2),
    tradeSizeUsd: Number(process.env.RL_TRADE_SIZE_USD || 1000),
    invalidActionPenalty: Number(process.env.RL_INVALID_ACTION_PENALTY || 0.002),
    // share of every training batch taken from real production decisions (self-correction)
    liveSampleShare: Number(process.env.RL_LIVE_SAMPLE_SHARE || 0.25),
  },
};

export default cryptoConfig;
