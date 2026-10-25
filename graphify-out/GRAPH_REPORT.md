# Graph Report - node-auto-trader  (2026-10-25)

## Corpus Check
- 92 files · ~56,293 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: (none) 5, .bin 3, .css 2)

## Summary
- 929 nodes · 2129 edges · 53 communities (40 shown, 13 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `05497e27`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- MarketData.service.ts
- tensorflow.helpers.ts
- Exchange & Storage Services
- App Bootstrap & Utils
- Binance REST Market Data
- DQN Training (TensorflowAI)
- Root Package Meta
- backtest.ts
- Dashboard Dependencies
- Dashboard Charts Deps
- Runtime Dependencies
- Dev Tooling
- RL Trading Environment
- NPM Scripts
- TypeScript Config
- Dashboard App & Charts
- Dashboard Entry
- PWA Manifest
- Dashboard DO Storage
- Collectors Supervisor
- Dashboard Scripts
- ESLint Config
- Dashboard S3 Config
- Dashboard ESLint
- Browserslist
- strategy-check.ts
- crypto.config.ts
- daily-horizon.ts
- Tensorflow.service.ts
- BinanceStreamCollector
- OrderFlow.service.ts
- testnet-trade.ts
- rebalance-backtest.ts
- .trainForecast
- technical-indicators.ts
- orderflow-backtest.ts
- Learn More
- OrderFlowSeconds
- collector.reader.ts
- orderflow-signal.ts
- restCommands.ts
- features-report.ts
- Colors
- tfjs-node-compat.ts
- binance-backfill.ts
- backlog.md
- status.md

## God Nodes (most connected - your core abstractions)
1. `log()` - 62 edges
2. `TensorflowAI` - 50 edges
3. `CryptoPairs` - 45 edges
4. `Colors` - 42 edges
5. `cryptoConfig` - 38 edges
6. `createLogger()` - 27 edges
7. `BinanceStreamCollector` - 20 edges
8. `MarketDataService` - 20 edges
9. `OrderFlowService` - 17 edges
10. `scripts` - 16 edges

## Surprising Connections (you probably didn't know these)
- `initApp()` --calls--> `log()`  [EXTRACTED]
  index.ts → src/utils/colored-console.ts
- `shutdown()` --calls--> `log()`  [EXTRACTED]
  index.ts → src/utils/colored-console.ts
- `IFuturesContext` --references--> `IFuturesMetrics`  [EXTRACTED]
  src/utils/tensorflow.helpers.ts → src/types/marketData.types.ts
- `runFold()` --calls--> `log()`  [EXTRACTED]
  src/scripts/backtest.ts → src/utils/colored-console.ts
- `readBooks()` --calls--> `readStream()`  [EXTRACTED]
  src/scripts/orderflow-signal.ts → src/services/collectors/collector.reader.ts

## Import Cycles
- None detected.

## Communities (53 total, 13 thin omitted)

### Community 0 - "MarketData.service.ts"
Cohesion: 0.14
Nodes (25): axios, BinanceKline, INTERVAL, METRIC_FIELDS, STEP_SECONDS, STEP_SECONDS, CANDLE_SERIES, COINBASE_SERIES (+17 more)

### Community 1 - "tensorflow.helpers.ts"
Cohesion: 0.11
Nodes (24): MARKET_FEATURE_COUNT, buildExternalContext(), buildFuturesContext(), buildHourlyContext(), EXTERNAL_FEATURE_COUNT, externalFeaturesAt(), featureWindow(), forecastInputAt() (+16 more)

### Community 2 - "Exchange & Storage Services"
Cohesion: 0.06
Nodes (10): CryptoExchangeService, DigitalOceanStorageService, EtheriumWallet, LocalStorageService, StatisticAndPredictionService, WavesWalletService, log(), mapIntevaltoMilliseconds() (+2 more)

### Community 3 - "App Bootstrap & Utils"
Cohesion: 0.12
Nodes (22): dotenv, ethers, @waves/waves-transactions, digitalOceanConfig, ITransactionHistoryETHProps, ITransactionHistoryWAVESProps, TransactionHistoryProps, CANDLE_SERIES (+14 more)

### Community 4 - "Binance REST Market Data"
Cohesion: 0.06
Nodes (18): BinanceClient, log, BinanceMarketDataService, log, CoinbaseCollector, log, sleep(), DvolCollector (+10 more)

### Community 5 - "DQN Training (TensorflowAI)"
Cohesion: 0.08
Nodes (8): log, OrderFlowService, ReplayBuffer, TensorflowAI, CryptoPairs, ETH_USDT, ITensorflowPrediction, argmax()

### Community 6 - "Root Package Meta"
Cohesion: 0.07
Nodes (27): author, description, aws-sdk, date-fns, license, main, name, private (+19 more)

### Community 7 - "backtest.ts"
Cohesion: 0.08
Nodes (41): Action, COSTS, cut(), EVAL_DAYS, fmt(), guardedDqn(), HISTORY_DAYS, ICost (+33 more)

### Community 8 - "Dashboard Dependencies"
Cohesion: 0.09
Nodes (23): dependencies, add, ag-charts-community, ag-charts-enterprise, ag-charts-react, aws-sdk, @aws-sdk/client-s3, date-fns (+15 more)

### Community 9 - "Dashboard Charts Deps"
Cohesion: 0.10
Nodes (18): add, ag-charts-community, ag-charts-enterprise, ag-charts-react, @emotion/cache, @emotion/react, @emotion/styled, http-proxy-middleware (+10 more)

### Community 10 - "Runtime Dependencies"
Cohesion: 0.12
Nodes (16): dependencies, adm-zip, aws-sdk, axios, date-fns, dotenv, ethers, express (+8 more)

### Community 11 - "Dev Tooling"
Cohesion: 0.13
Nodes (15): devDependencies, cross-env, eslint, @eslint/js, globals, nodemon, ts-node, @types/adm-zip (+7 more)

### Community 13 - "NPM Scripts"
Cohesion: 0.12
Nodes (16): scripts, backfill:binance, backtest, backtest:orderflow, build, collect:stats, dev, features:report (+8 more)

### Community 14 - "TypeScript Config"
Cohesion: 0.17
Nodes (11): compilerOptions, allowJs, esModuleInterop, forceConsistentCasingInFileNames, module, outDir, rootDir, skipLibCheck (+3 more)

### Community 15 - "Dashboard App & Charts"
Cohesion: 0.33
Nodes (5): @mui/material, @mui/x-charts, @testing-library/react, App(), PredictionsChart()

### Community 16 - "Dashboard Entry"
Cohesion: 0.29
Nodes (5): react, react-dom, web-vitals, root, reportWebVitals()

### Community 17 - "PWA Manifest"
Cohesion: 0.25
Nodes (7): background_color, display, icons, name, short_name, start_url, theme_color

### Community 19 - "Collectors Supervisor"
Cohesion: 0.38
Nodes (3): shutdown(), CollectorsService, log

### Community 20 - "Dashboard Scripts"
Cohesion: 0.40
Nodes (5): scripts, build, eject, start, test

### Community 21 - "ESLint Config"
Cohesion: 0.50
Nodes (3): @eslint/js, globals, typescript-eslint

### Community 23 - "Dashboard ESLint"
Cohesion: 0.50
Nodes (4): react-app, react-app/jest, eslintConfig, extends

### Community 24 - "Browserslist"
Cohesion: 0.67
Nodes (3): browserslist, development, production

### Community 25 - "strategy-check.ts"
Cohesion: 0.08
Nodes (28): COSTS, dailyBars(), GUARDS, IStrategy, log, SignalName, signalsOf(), IVotePortfolio (+20 more)

### Community 26 - "crypto.config.ts"
Cohesion: 0.14
Nodes (10): cryptoConfig, LiquidationsCollector, Level, OrderBookCollector, acquireLock(), isAlive(), log, startCollectors() (+2 more)

### Community 27 - "daily-horizon.ts"
Cohesion: 0.10
Nodes (28): backtest(), COIN_FEATURES, coinFeatures(), COSTS, FEATURES, featuresAt(), fitRidge(), FUNDING (+20 more)

### Community 28 - "Tensorflow.service.ts"
Cohesion: 0.11
Nodes (23): ITransition, buildInferenceState(), DQN_FEATURE_COUNT, EMPTY_FORECAST, IEnvStepResult, RL_ACTION_LABELS, RLAction, RLActionIndex (+15 more)

### Community 29 - "BinanceStreamCollector"
Cohesion: 0.15
Nodes (5): BinanceStreamCollector, DeribitOptionsRecorder, log, RollingGzipWriter, ICollectorsHandle

### Community 30 - "OrderFlow.service.ts"
Cohesion: 0.14
Nodes (18): flows, handle, IOrderFlowBundle, IOrderFlowMetrics, DepthRow, IBook, IFlow, ILiquidations (+10 more)

### Community 31 - "testnet-trade.ts"
Cohesion: 0.22
Nodes (19): buyLeg(), decide(), drill(), floorToStep(), ILeg, LEG_USD, log, LOOKBACKS (+11 more)

### Community 32 - "rebalance-backtest.ts"
Cohesion: 0.19
Nodes (17): BANDS, CHECK_HOURS, config, IRun, log, NO_STOPS, run(), selfCheck() (+9 more)

### Community 33 - ".trainForecast"
Cohesion: 0.17
Nodes (16): buildForecastSamples(), buildGapChecker(), computeOutputErrors(), correlation(), evaluateLivePredictions(), fitCalibration(), fitColumnScaler(), fitFeatureScaler() (+8 more)

### Community 34 - "technical-indicators.ts"
Cohesion: 0.22
Nodes (18): atr(), buildCandleFeatures(), buildMarketFeatures(), buildPremiumFeatures(), buildReferenceFeatures(), coinbasePremium(), computeIndicators(), ema() (+10 more)

### Community 35 - "orderflow-backtest.ts"
Cohesion: 0.14
Nodes (7): AVERAGE_WINDOWS_SECONDS, COSTS_BPS, HORIZONS_SECONDS, ITrade, log, RIDGE_PENALTY, THRESHOLD_QUANTILES

### Community 36 - "Learn More"
Cohesion: 0.14
Nodes (13): Advanced Configuration, Analyzing the Bundle Size, Available Scripts, Code Splitting, Deployment, Getting Started with Create React App, Learn More, Making a Progressive Web App (+5 more)

### Community 37 - "OrderFlowSeconds"
Cohesion: 0.22
Nodes (3): flowImbalance(), OrderFlowSeconds, signedLog()

### Community 38 - "collector.reader.ts"
Cohesion: 0.24
Nodes (8): readLiquidations(), readTrades(), GZIP_HEADER, ICollectorGap, listStreamFiles(), readGaps(), readHourFile(), readStream()

### Community 39 - "orderflow-signal.ts"
Cohesion: 0.18
Nodes (9): DepthRow, HORIZONS_SECONDS, IBook, imbalance(), Level, LiquidationRow, log, readBooks() (+1 more)

### Community 40 - "restCommands.ts"
Cohesion: 0.33
Nodes (4): initApp(), express, routes, IRoutesConfig

### Community 41 - "features-report.ts"
Cohesion: 0.20
Nodes (8): fs-extra, FeatureGroup, GROUPS, LABELS, log, VARIANTS, IForecastBundle, IForecastMetrics

### Community 42 - "Colors"
Cohesion: 0.22
Nodes (9): Colors, BLUE, CYAN, GREEN, MAGENTA, RED, RESET, WHITE (+1 more)

## Knowledge Gaps
- **46 isolated node(s):** `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu`, `aws-sdk`, `date-fns` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 344 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `log()` connect `Exchange & Storage Services` to `MarketData.service.ts`, `.trainForecast`, `App Bootstrap & Utils`, `DQN Training (TensorflowAI)`, `backtest.ts`, `restCommands.ts`, `RL Trading Environment`, `Collectors Supervisor`, `Tensorflow.service.ts`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **What connects `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu` to the rest of the system?**
  _46 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `MarketData.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13968253968253969 - nodes in this community are weakly interconnected._
- **Why does `Colors` connect `Colors` to `rebalance-backtest.ts`, `MarketData.service.ts`, `orderflow-backtest.ts`, `App Bootstrap & Utils`, `backtest.ts`, `restCommands.ts`, `features-report.ts`, `orderflow-signal.ts`, `strategy-check.ts`, `crypto.config.ts`, `daily-horizon.ts`, `Tensorflow.service.ts`, `OrderFlow.service.ts`, `testnet-trade.ts`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Should `tensorflow.helpers.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Why does `fs-extra` connect `features-report.ts` to `rebalance-backtest.ts`, `orderflow-backtest.ts`, `Root Package Meta`, `orderflow-signal.ts`, `backtest.ts`, `strategy-check.ts`, `daily-horizon.ts`, `Tensorflow.service.ts`, `OrderFlow.service.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Should `Exchange & Storage Services` be split into smaller, more focused modules?**
  _Cohesion score 0.06448412698412699 - nodes in this community are weakly interconnected._