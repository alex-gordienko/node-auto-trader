# Graph Report - node-auto-trader  (2026-10-20)

## Corpus Check
- Corpus is ~32,206 words - fits in a single context window. You may not need a graph.

## Summary
- 640 nodes · 1434 edges · 26 communities (22 shown, 4 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Binance Stream Collectors
- Features & Indicators
- Exchange & Storage Services
- App Bootstrap & Utils
- Binance REST Market Data
- DQN Training (TensorflowAI)
- Root Package Meta
- Backtest & Feature Reports
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
- Dashboard Test Setup

## God Nodes (most connected - your core abstractions)
1. `log()` - 61 edges
2. `TensorflowAI` - 49 edges
3. `CryptoPairs` - 31 edges
4. `Colors` - 30 edges
5. `cryptoConfig` - 26 edges
6. `BinanceStreamCollector` - 19 edges
7. `MarketDataService` - 18 edges
8. `LocalStorageService` - 16 edges
9. `MarketSymbol` - 15 edges
10. `createLogger()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `initApp()` --calls--> `log()`  [EXTRACTED]
  index.ts → src/utils/colored-console.ts
- `shutdown()` --calls--> `log()`  [EXTRACTED]
  index.ts → src/utils/colored-console.ts
- `runFold()` --calls--> `log()`  [EXTRACTED]
  src/scripts/backtest.ts → src/utils/colored-console.ts
- `ITransactionHistoryETHProps` --references--> `CryptoBase`  [EXTRACTED]
  src/services/DigitalOcean.storage.service.ts → src/types/basic.types.ts
- `ITransactionHistoryWAVESProps` --references--> `CryptoBase`  [EXTRACTED]
  src/services/DigitalOcean.storage.service.ts → src/types/basic.types.ts

## Import Cycles
- None detected.

## Communities (26 total, 4 thin omitted)

### Community 0 - "Binance Stream Collectors"
Cohesion: 0.05
Nodes (45): axios, cryptoConfig, hourDays, minuteDays, BinanceKline, INTERVAL, METRIC_FIELDS, STEP_SECONDS (+37 more)

### Community 1 - "Features & Indicators"
Cohesion: 0.05
Nodes (82): ITransition, buildInferenceState(), DQN_FEATURE_COUNT, EMPTY_FORECAST, IEnvStepResult, RL_ACTION_LABELS, RLAction, RLActionIndex (+74 more)

### Community 2 - "Exchange & Storage Services"
Cohesion: 0.06
Nodes (10): CryptoExchangeService, DigitalOceanStorageService, EtheriumWallet, LocalStorageService, StatisticAndPredictionService, WavesWalletService, log(), mapIntevaltoMilliseconds() (+2 more)

### Community 3 - "App Bootstrap & Utils"
Cohesion: 0.07
Nodes (37): initApp(), dotenv, ethers, express, @waves/waves-transactions, digitalOceanConfig, routes, ITransactionHistoryETHProps (+29 more)

### Community 4 - "Binance REST Market Data"
Cohesion: 0.08
Nodes (14): BinanceClient, log, BinanceMarketDataService, log, DvolCollector, log, FearGreedCollector, log (+6 more)

### Community 5 - "DQN Training (TensorflowAI)"
Cohesion: 0.09
Nodes (9): ReplayBuffer, TensorflowAI, CryptoPairs, ETH_USDT, ITensorflowPrediction, IMarketDataset, argmax(), IFeatureScaler (+1 more)

### Community 6 - "Root Package Meta"
Cohesion: 0.07
Nodes (27): author, description, aws-sdk, date-fns, license, main, name, private (+19 more)

### Community 7 - "Backtest & Feature Reports"
Cohesion: 0.09
Nodes (22): fs-extra, Action, COSTS, cut(), EVAL_DAYS, fmt(), HISTORY_DAYS, ICost (+14 more)

### Community 8 - "Dashboard Dependencies"
Cohesion: 0.09
Nodes (23): dependencies, add, ag-charts-community, ag-charts-enterprise, ag-charts-react, aws-sdk, @aws-sdk/client-s3, date-fns (+15 more)

### Community 9 - "Dashboard Charts Deps"
Cohesion: 0.11
Nodes (17): add, ag-charts-community, ag-charts-enterprise, ag-charts-react, @emotion/cache, @emotion/react, @emotion/styled, http-proxy-middleware (+9 more)

### Community 10 - "Runtime Dependencies"
Cohesion: 0.12
Nodes (16): dependencies, adm-zip, aws-sdk, axios, date-fns, dotenv, ethers, express (+8 more)

### Community 11 - "Dev Tooling"
Cohesion: 0.13
Nodes (15): devDependencies, cross-env, eslint, @eslint/js, globals, nodemon, ts-node, @types/adm-zip (+7 more)

### Community 13 - "NPM Scripts"
Cohesion: 0.17
Nodes (12): scripts, backfill:binance, backtest, build, collect:stats, dev, features:report, lint (+4 more)

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
Cohesion: 0.47
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

## Knowledge Gaps
- **46 isolated node(s):** `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu`, `aws-sdk`, `date-fns` (+41 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 229 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `log()` connect `Exchange & Storage Services` to `Binance Stream Collectors`, `Features & Indicators`, `App Bootstrap & Utils`, `DQN Training (TensorflowAI)`, `Backtest & Feature Reports`, `RL Trading Environment`, `Collectors Supervisor`?**
  _High betweenness centrality (0.156) - this node is a cross-community bridge._
- **What connects `@tensorflow/tfjs`, `@tensorflow/tfjs-layers`, `@tensorflow/tfjs-node-gpu` to the rest of the system?**
  _46 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Binance Stream Collectors` be split into smaller, more focused modules?**
  _Cohesion score 0.053763440860215055 - nodes in this community are weakly interconnected._
- **Why does `dependencies` connect `Dashboard Dependencies` to `Dashboard Charts Deps`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **Should `Features & Indicators` be split into smaller, more focused modules?**
  _Cohesion score 0.05041797283176593 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Dashboard Entry` to `Dashboard Charts Deps`, `Dashboard App & Charts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Should `Exchange & Storage Services` be split into smaller, more focused modules?**
  _Cohesion score 0.06448412698412699 - nodes in this community are weakly interconnected._