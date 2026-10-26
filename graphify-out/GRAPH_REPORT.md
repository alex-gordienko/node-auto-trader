# Graph Report - node-auto-trader  (2026-10-26)

## Corpus Check
- 109 files · ~74,947 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: (none) 5, .bin 3, .css 2)

## Summary
- 1120 nodes · 2637 edges · 60 communities (47 shown, 13 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `65ec27d4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Local.storage.service.ts
- tensorflow.helpers.ts
- Exchange & Storage Services
- TensorflowAI
- Binance REST Market Data
- HorizonTraderService
- Root Package Meta
- BinanceExecution.service.ts
- Dashboard Dependencies
- Dashboard Charts Deps
- Runtime Dependencies
- Dev Tooling
- RL Trading Environment
- NPM Scripts
- TypeScript Config
- predictions.chart.js
- KillSwitch.service.ts
- PWA Manifest
- Dashboard DO Storage
- Collectors Supervisor
- Dashboard Scripts
- ESLint Config
- Dashboard S3 Config
- Dashboard ESLint
- Browserslist
- strategy-check.ts
- MarketData.service.ts
- daily-horizon.ts
- Tensorflow.service.ts
- BinanceStreamCollector
- OrderFlow.service.ts
- testnet-trade.ts
- rebalance-backtest.ts
- features-report.ts
- technical-indicators.ts
- orderflow-backtest.ts
- Learn More
- OrderFlowSeconds
- orderflow-signal.ts
- study.py
- HorizonTrader.service.ts
- backtest.ts
- crypto.config.ts
- tfjs-node-compat.ts
- .applyDqn
- backlog.md
- status.md
- runCollectors.ts
- Best prediction window with at most 3 entries a day — BTC / ETH (Binance spot)
- .closed
- restCommands.ts
- fitCalibration
- Colors
- buildHourlyContext

## God Nodes (most connected - your core abstractions)
1. `log()` - 68 edges
2. `TensorflowAI` - 50 edges
3. `Colors` - 46 edges
4. `CryptoPairs` - 45 edges
5. `cryptoConfig` - 40 edges
6. `createLogger()` - 29 edges
7. `BinanceExecution` - 25 edges
8. `HorizonTraderService` - 20 edges
9. `BinanceStreamCollector` - 20 edges
10. `MarketDataService` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Setup` --references--> `oracle()`  [INFERRED]
  research/horizon/report.md → research/horizon/study.py
- `initApp()` --calls--> `log()`  [EXTRACTED]
  index.ts → src/utils/colored-console.ts
- `shutdown()` --calls--> `log()`  [EXTRACTED]
  index.ts → src/utils/colored-console.ts
- `IHorizonTrack` --references--> `IKillSwitchState`  [EXTRACTED]
  src/services/HorizonTrader.service.ts → src/utils/kill-switch.ts
- `IFuturesContext` --references--> `IFuturesMetrics`  [EXTRACTED]
  src/utils/tensorflow.helpers.ts → src/types/marketData.types.ts

## Import Cycles
- None detected.

## Communities (60 total, 13 thin omitted)

### Community 0 - "Local.storage.service.ts"
Cohesion: 0.11
Nodes (23): dotenv, ethers, @waves/waves-transactions, digitalOceanConfig, ITransactionHistoryETHProps, ITransactionHistoryWAVESProps, TransactionHistoryProps, CANDLE_SERIES (+15 more)

### Community 1 - "tensorflow.helpers.ts"
Cohesion: 0.12
Nodes (26): IPremiumPoint, MARKET_FEATURE_COUNT, buildForecastSamples(), buildGapChecker(), computeOutputErrors(), correlation(), evaluateLivePredictions(), EXTERNAL_FEATURE_COUNT (+18 more)

### Community 2 - "Exchange & Storage Services"
Cohesion: 0.06
Nodes (10): CryptoExchangeService, DigitalOceanStorageService, EtheriumWallet, LocalStorageService, StatisticAndPredictionService, WavesWalletService, log(), mapIntevaltoMilliseconds() (+2 more)

### Community 3 - "TensorflowAI"
Cohesion: 0.07
Nodes (10): log, OrderFlowService, ReplayBuffer, TensorflowAI, CryptoPairs, ETH_USDT, IMarketDataset, argmax() (+2 more)

### Community 4 - "Binance REST Market Data"
Cohesion: 0.07
Nodes (18): BinanceClient, log, BinanceMarketDataService, log, CoinbaseCollector, log, sleep(), DvolCollector (+10 more)

### Community 5 - "HorizonTraderService"
Cohesion: 0.18
Nodes (6): main(), pct(), stats(), HorizonTraderService, IHorizonTrade, log

### Community 6 - "Root Package Meta"
Cohesion: 0.07
Nodes (27): author, description, aws-sdk, date-fns, license, main, name, private (+19 more)

### Community 7 - "BinanceExecution.service.ts"
Cohesion: 0.08
Nodes (19): bps(), main(), mean(), BinanceExecution, BinanceExecutionService, Http, IFilters, ILedgerEntry (+11 more)

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
Cohesion: 0.18
Nodes (5): TradingEnvironment, IBacktestInputs, IOHLCV, IHourlyContext, ILiveFeedback

### Community 13 - "NPM Scripts"
Cohesion: 0.11
Nodes (18): scripts, backfill:binance, backtest, backtest:orderflow, build, collect:stats, dev, execution:report (+10 more)

### Community 14 - "TypeScript Config"
Cohesion: 0.17
Nodes (11): compilerOptions, allowJs, esModuleInterop, forceConsistentCasingInFileNames, module, outDir, rootDir, skipLibCheck (+3 more)

### Community 15 - "predictions.chart.js"
Cohesion: 0.18
Nodes (10): @mui/material, @mui/x-charts, react, react-dom, @testing-library/react, web-vitals, App(), PredictionsChart() (+2 more)

### Community 16 - "KillSwitch.service.ts"
Cohesion: 0.23
Nodes (19): guardedDqn(), IKillSwitchGate, log, canOpen(), checkMarket(), createKillSwitch(), halt(), HARD_MAX_TRADES_PER_DAY (+11 more)

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

### Community 26 - "MarketData.service.ts"
Cohesion: 0.13
Nodes (25): axios, BinanceKline, INTERVAL, METRIC_FIELDS, STEP_SECONDS, STEP_SECONDS, CANDLE_SERIES, COINBASE_SERIES (+17 more)

### Community 27 - "daily-horizon.ts"
Cohesion: 0.10
Nodes (25): backtest(), COIN_FEATURES, coinFeatures(), COSTS, FEATURES, featuresAt(), FUNDING, HORIZONS (+17 more)

### Community 28 - "Tensorflow.service.ts"
Cohesion: 0.09
Nodes (26): ITransition, buildInferenceState(), DQN_FEATURE_COUNT, EMPTY_FORECAST, IEnvStepResult, RL_ACTION_LABELS, RLAction, RLActionIndex (+18 more)

### Community 29 - "BinanceStreamCollector"
Cohesion: 0.21
Nodes (3): DeribitOptionsRecorder, log, RollingGzipWriter

### Community 30 - "OrderFlow.service.ts"
Cohesion: 0.15
Nodes (16): flows, handle, IOrderFlowBundle, IOrderFlowMetrics, DepthRow, IBook, IFlow, ILiquidations (+8 more)

### Community 31 - "testnet-trade.ts"
Cohesion: 0.24
Nodes (19): buyLeg(), decide(), drill(), floorToStep(), ILeg, LEG_USD, log, LOOKBACKS (+11 more)

### Community 32 - "rebalance-backtest.ts"
Cohesion: 0.19
Nodes (17): BANDS, CHECK_HOURS, config, IRun, log, NO_STOPS, run(), selfCheck() (+9 more)

### Community 33 - "features-report.ts"
Cohesion: 0.22
Nodes (6): fs-extra, FeatureGroup, GROUPS, LABELS, log, VARIANTS

### Community 34 - "technical-indicators.ts"
Cohesion: 0.24
Nodes (17): atr(), buildCandleFeatures(), buildMarketFeatures(), buildPremiumFeatures(), buildReferenceFeatures(), coinbasePremium(), computeIndicators(), ema() (+9 more)

### Community 35 - "orderflow-backtest.ts"
Cohesion: 0.14
Nodes (7): AVERAGE_WINDOWS_SECONDS, COSTS_BPS, HORIZONS_SECONDS, ITrade, log, RIDGE_PENALTY, THRESHOLD_QUANTILES

### Community 36 - "Learn More"
Cohesion: 0.14
Nodes (13): Advanced Configuration, Analyzing the Bundle Size, Available Scripts, Code Splitting, Deployment, Getting Started with Create React App, Learn More, Making a Progressive Web App (+5 more)

### Community 37 - "OrderFlowSeconds"
Cohesion: 0.18
Nodes (5): flowImbalance(), imbalance(), OrderFlowSeconds, signedLog(), toBook()

### Community 38 - "orderflow-signal.ts"
Cohesion: 0.12
Nodes (17): DepthRow, HORIZONS_SECONDS, IBook, imbalance(), Level, LiquidationRow, log, readBooks() (+9 more)

### Community 39 - "study.py"
Cohesion: 0.10
Nodes (25): fetch_zip(), funding(), load(), candle_rows(), main(), predict_json(), train(), book() (+17 more)

### Community 40 - "HorizonTrader.service.ts"
Cohesion: 0.11
Nodes (25): IHorizonTrack, ILeg, IPosition, entrySide(), entryThreshold(), FEATURE_NAMES, finite(), HISTORY_MINUTES (+17 more)

### Community 41 - "backtest.ts"
Cohesion: 0.13
Nodes (18): Action, COSTS, cut(), EVAL_DAYS, fmt(), HISTORY_DAYS, ICost, IDecision (+10 more)

### Community 42 - "crypto.config.ts"
Cohesion: 0.25
Nodes (3): initApp(), cryptoConfig, IShadowPortfolio

### Community 53 - "runCollectors.ts"
Cohesion: 0.14
Nodes (9): BinanceStreamCollector, LiquidationsCollector, OrderBookCollector, acquireLock(), ICollectorsHandle, isAlive(), log, startCollectors() (+1 more)

### Community 54 - "Best prediction window with at most 3 entries a day — BTC / ETH (Binance spot)"
Cohesion: 0.15
Nodes (12): After costs (gbm / ridge), After costs (gbm / ridge), Best prediction window with at most 3 entries a day — BTC / ETH (Binance spot), BTCUSDT, Edge before costs, Edge before costs, ETHUSDT, Gross bps per trade by year (gbm) (+4 more)

### Community 56 - "restCommands.ts"
Cohesion: 0.29
Nodes (5): express, routes, hourDays, minuteDays, IRoutesConfig

### Community 57 - "fitCalibration"
Cohesion: 0.47
Nodes (6): fitCalibration(), fitColumnScaler(), fitFeatureScaler(), fitTargetScaler(), mean(), std()

### Community 58 - "Colors"
Cohesion: 0.22
Nodes (9): Colors, BLUE, CYAN, GREEN, MAGENTA, RED, RESET, WHITE (+1 more)

### Community 59 - "buildHourlyContext"
Cohesion: 0.67
Nodes (3): buildHourlyContext(), rolling(), stdOf()

## Knowledge Gaps
- **46 isolated node(s):** `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu`, `aws-sdk`, `date-fns` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 393 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `log()` connect `Exchange & Storage Services` to `Local.storage.service.ts`, `TensorflowAI`, `HorizonTraderService`, `BinanceExecution.service.ts`, `backtest.ts`, `crypto.config.ts`, `RL Trading Environment`, `Collectors Supervisor`, `restCommands.ts`, `MarketData.service.ts`, `Tensorflow.service.ts`?**
  _High betweenness centrality (0.123) - this node is a cross-community bridge._
- **What connects `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu` to the rest of the system?**
  _46 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Local.storage.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11229946524064172 - nodes in this community are weakly interconnected._
- **Why does `Colors` connect `Colors` to `Local.storage.service.ts`, `HorizonTraderService`, `BinanceExecution.service.ts`, `KillSwitch.service.ts`, `strategy-check.ts`, `MarketData.service.ts`, `daily-horizon.ts`, `Tensorflow.service.ts`, `OrderFlow.service.ts`, `testnet-trade.ts`, `rebalance-backtest.ts`, `features-report.ts`, `orderflow-backtest.ts`, `orderflow-signal.ts`, `HorizonTrader.service.ts`, `backtest.ts`, `crypto.config.ts`, `runCollectors.ts`, `restCommands.ts`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Should `tensorflow.helpers.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11904761904761904 - nodes in this community are weakly interconnected._
- **Why does `createLogger()` connect `MarketData.service.ts` to `rebalance-backtest.ts`, `features-report.ts`, `Exchange & Storage Services`, `orderflow-backtest.ts`, `orderflow-signal.ts`, `BinanceExecution.service.ts`, `HorizonTrader.service.ts`, `crypto.config.ts`, `KillSwitch.service.ts`, `runCollectors.ts`, `strategy-check.ts`, `daily-horizon.ts`, `BinanceStreamCollector`, `OrderFlow.service.ts`, `testnet-trade.ts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Should `Exchange & Storage Services` be split into smaller, more focused modules?**
  _Cohesion score 0.06286748077792854 - nodes in this community are weakly interconnected._