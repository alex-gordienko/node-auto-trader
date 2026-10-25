# Graph Report - node-auto-trader  (2026-10-25)

## Corpus Check
- 94 files · ~57,885 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: (none) 5, .bin 3, .css 2)

## Summary
- 942 nodes · 2168 edges · 49 communities (37 shown, 12 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a44f84aa`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Colors
- tensorflow.helpers.ts
- Exchange & Storage Services
- TensorflowAI
- Binance REST Market Data
- CryptoPairs
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
- .predictNextPrices
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
- orderflow-signal.ts
- features-report.ts
- tfjs-node-compat.ts
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
- `IOrderFlowMetrics` --references--> `IOutputCalibration`  [EXTRACTED]
  src/services/OrderFlow.service.ts → src/utils/tensorflow.helpers.ts
- `IFuturesContext` --references--> `IFuturesMetrics`  [EXTRACTED]
  src/utils/tensorflow.helpers.ts → src/types/marketData.types.ts
- `runFold()` --calls--> `log()`  [EXTRACTED]
  src/scripts/backtest.ts → src/utils/colored-console.ts

## Import Cycles
- None detected.

## Communities (49 total, 12 thin omitted)

### Community 0 - "Colors"
Cohesion: 0.06
Nodes (64): axios, dotenv, ethers, express, @waves/waves-transactions, cryptoConfig, digitalOceanConfig, routes (+56 more)

### Community 1 - "tensorflow.helpers.ts"
Cohesion: 0.10
Nodes (29): buildForecastSamples(), buildGapChecker(), buildHourlyContext(), CONTEXT_FEATURE_COUNT, evaluateLivePredictions(), EXTERNAL_FEATURE_COUNT, externalFeaturesAt(), featureWindow() (+21 more)

### Community 2 - "Exchange & Storage Services"
Cohesion: 0.06
Nodes (11): initApp(), CryptoExchangeService, DigitalOceanStorageService, EtheriumWallet, LocalStorageService, StatisticAndPredictionService, WavesWalletService, log() (+3 more)

### Community 4 - "Binance REST Market Data"
Cohesion: 0.06
Nodes (18): BinanceClient, log, BinanceMarketDataService, log, CoinbaseCollector, log, sleep(), DvolCollector (+10 more)

### Community 5 - "CryptoPairs"
Cohesion: 0.16
Nodes (6): IOrderFlowBundle, log, OrderFlowService, CryptoPairs, ETH_USDT, correlationT()

### Community 6 - "Root Package Meta"
Cohesion: 0.07
Nodes (26): author, description, aws-sdk, date-fns, license, main, name, private (+18 more)

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

### Community 12 - "RL Trading Environment"
Cohesion: 0.16
Nodes (4): ITransition, ReplayBuffer, TradingEnvironment, ILiveFeedback

### Community 13 - "NPM Scripts"
Cohesion: 0.12
Nodes (16): scripts, backfill:binance, backtest, backtest:orderflow, build, collect:stats, dev, features:report (+8 more)

### Community 14 - "TypeScript Config"
Cohesion: 0.17
Nodes (11): compilerOptions, allowJs, esModuleInterop, forceConsistentCasingInFileNames, module, outDir, rootDir, skipLibCheck (+3 more)

### Community 15 - "Dashboard App & Charts"
Cohesion: 0.39
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
Cohesion: 0.06
Nodes (40): COSTS, dailyBars(), GUARDS, hourly, IStrategy, log, SignalName, signalsOf() (+32 more)

### Community 26 - ".predictNextPrices"
Cohesion: 0.16
Nodes (7): IForecastPath, ITensorflowPrediction, IMarketDataset, argmax(), buildExternalContext(), buildFuturesContext(), toOHLCV()

### Community 27 - "daily-horizon.ts"
Cohesion: 0.10
Nodes (25): backtest(), COIN_FEATURES, coinFeatures(), COSTS, FEATURES, featuresAt(), FUNDING, HORIZONS (+17 more)

### Community 28 - "Tensorflow.service.ts"
Cohesion: 0.15
Nodes (18): buildInferenceState(), DQN_FEATURE_COUNT, EMPTY_FORECAST, IEnvStepResult, RL_ACTION_LABELS, RLAction, RLActionIndex, SIGNAL_COUNT (+10 more)

### Community 29 - "BinanceStreamCollector"
Cohesion: 0.09
Nodes (11): BinanceStreamCollector, DeribitOptionsRecorder, log, LiquidationsCollector, OrderBookCollector, RollingGzipWriter, acquireLock(), ICollectorsHandle (+3 more)

### Community 30 - "OrderFlow.service.ts"
Cohesion: 0.15
Nodes (16): @tensorflow/tfjs-node, flows, handle, IOrderFlowMetrics, DepthRow, IBook, IFlow, ILiquidations (+8 more)

### Community 31 - "testnet-trade.ts"
Cohesion: 0.22
Nodes (19): buyLeg(), decide(), drill(), floorToStep(), ILeg, LEG_USD, log, LOOKBACKS (+11 more)

### Community 32 - "rebalance-backtest.ts"
Cohesion: 0.19
Nodes (17): BANDS, CHECK_HOURS, config, IRun, log, NO_STOPS, run(), selfCheck() (+9 more)

### Community 33 - ".trainForecast"
Cohesion: 0.19
Nodes (12): applyColumnScaler(), computeOutputErrors(), correlation(), fitCalibration(), fitColumnScaler(), fitFeatureScaler(), fitTargetScaler(), IFeatureScaler (+4 more)

### Community 34 - "technical-indicators.ts"
Cohesion: 0.20
Nodes (19): atr(), buildCandleFeatures(), buildMarketFeatures(), buildPremiumFeatures(), buildReferenceFeatures(), coinbasePremium(), computeIndicators(), ema() (+11 more)

### Community 35 - "orderflow-backtest.ts"
Cohesion: 0.14
Nodes (7): AVERAGE_WINDOWS_SECONDS, COSTS_BPS, HORIZONS_SECONDS, ITrade, log, RIDGE_PENALTY, THRESHOLD_QUANTILES

### Community 36 - "Learn More"
Cohesion: 0.14
Nodes (13): Advanced Configuration, Analyzing the Bundle Size, Available Scripts, Code Splitting, Deployment, Getting Started with Create React App, Learn More, Making a Progressive Web App (+5 more)

### Community 37 - "OrderFlowSeconds"
Cohesion: 0.22
Nodes (3): flowImbalance(), OrderFlowSeconds, signedLog()

### Community 38 - "orderflow-signal.ts"
Cohesion: 0.12
Nodes (17): DepthRow, HORIZONS_SECONDS, IBook, imbalance(), Level, LiquidationRow, log, readBooks() (+9 more)

### Community 41 - "features-report.ts"
Cohesion: 0.25
Nodes (6): fs-extra, FeatureGroup, GROUPS, LABELS, log, VARIANTS

## Knowledge Gaps
- **46 isolated node(s):** `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu`, `aws-sdk`, `date-fns` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 348 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `log()` connect `Exchange & Storage Services` to `Colors`, `.trainForecast`, `TensorflowAI`, `CryptoPairs`, `backtest.ts`, `RL Trading Environment`, `Collectors Supervisor`, `.predictNextPrices`, `Tensorflow.service.ts`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **What connects `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu` to the rest of the system?**
  _46 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Colors` be split into smaller, more focused modules?**
  _Cohesion score 0.055984555984555984 - nodes in this community are weakly interconnected._
- **Why does `Colors` connect `Colors` to `rebalance-backtest.ts`, `orderflow-backtest.ts`, `orderflow-signal.ts`, `backtest.ts`, `features-report.ts`, `strategy-check.ts`, `daily-horizon.ts`, `Tensorflow.service.ts`, `OrderFlow.service.ts`, `testnet-trade.ts`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Should `tensorflow.helpers.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1032258064516129 - nodes in this community are weakly interconnected._
- **Why does `fs-extra` connect `features-report.ts` to `rebalance-backtest.ts`, `orderflow-backtest.ts`, `orderflow-signal.ts`, `Root Package Meta`, `backtest.ts`, `strategy-check.ts`, `daily-horizon.ts`, `Tensorflow.service.ts`, `OrderFlow.service.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Should `Exchange & Storage Services` be split into smaller, more focused modules?**
  _Cohesion score 0.06298076923076923 - nodes in this community are weakly interconnected._