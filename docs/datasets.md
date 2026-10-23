# Dataset layout and the leakage boundary

## Layout

`<source>/<symbol-or-MARKET>/<series>/<yyyy-MM>.json` — one file per calendar month, each holding
`[time, row]` pairs sorted and de-duplicated by `time` (`Local.storage.service.ts`: `pushSeries` /
`getSeries`). `<symbol>` is a traded pair (e.g. `ETH-USDT`) for per-pair series, or the literal
`MARKET` for market-wide series (stablecoin supply, fear & greed) that are not specific to one pair.

| source | series | native frequency |
|---|---|---|
| binance | `1m`, `1h` | 1 minute / 1 hour candles |
| binance | `premium-1m`, `premium-1h` | futures premium index, same cadence |
| binance | `futures-metrics` | 5 minutes |
| binance | `funding` | 8 hours (irregular timing) |
| coinbase | `coinbase-1m`, `coinbase-1h` | 1 minute / 1 hour |
| deribit | `dvol-1h` | 1 hour |
| defillama | `stablecoins-1d` (MARKET) | 1 day |
| alternative-me | `fear-greed-1d` (MARKET) | 1 day |

`src/Storage/datasets/ETH-USDT-trading-history.json` (top level, not under a `<source>` folder) is a
legacy file from a retired CryptoCompare-based pipeline. It is not written or read by any current
collector or script — it cannot be reproduced or extended, and should be treated as dead data, not a
dataset.

`_fetches/<symbol>/<interval>/<start>_<end>.json` + `.manifest.json` are explicit, parameterized
snapshots written by `yarn dataset:fetch` (see `src/scripts/dataset-fetch.ts`) — pinned windows for
reproducing a specific result later, separate from the continuously-updated series above.

## The ordering guarantee

**Row *i* of an assembled per-bar feature vector uses only information knowable at or before the
close of candle *i*.** Concretely, as implemented in `src/utils/tensorflow.helpers.ts` and
`src/services/OrderFlow.service.ts`:

- **Same-cadence series** (reference pairs, premium index, Coinbase candles) are joined to candle *i*
  by its own `time` (`technical-indicators.ts: buildReferenceFeatures`, `buildPremiumFeatures`) — never
  a later bar. The Coinbase premium falls back to the *previous* bar, never a future one, when the
  same-time bar is not yet published (`technical-indicators.ts:308`).
- **Slower series** (DVOL, stablecoin supply, fear & greed, futures metrics, funding) are looked up as
  "the last value known at or before `time − availability delay`" via a binary search
  (`lastIndexAtOrBefore`, `tensorflow.helpers.ts:207`), not the value stamped nearest to `time`. The
  delay accounts for publication lag: DVOL is treated as final only 1 hour after its own timestamp,
  daily series (stablecoins, fear & greed) only 2 days after, futures metrics 5 minutes after — the
  last of these was added specifically because a point stamped T was found to still be correlated with
  price moves *after* T on raw archive data (`tensorflow.helpers.ts:35-37`). A gap in a slower series is
  never filled with data published after row *i*'s close.
- **Forecast labels** are computed from candle *t+h* (*h* ≥ 1), strictly after the features built from
  candle *t* (`tensorflow.helpers.ts: forecastInputAt` / `forecastTargets`); candle *t*'s own close is
  only the reference price shared by both, never the outcome itself.
- **The order-flow verdict fed to the DQN** is built from a window ending at the candle's own last
  second (`OrderFlow.service.ts:365`), so it never includes order-book/trade data from after the bar it
  describes.
- **Feature scaling for the forecast model** is fit only on the training partition, before the
  calibration/eval split (`Tensorflow.service.ts:472-508`), so no evaluation-time data leaks into the
  normalization statistics.

### Known violation

The DQN's own feature scaler (`Tensorflow.service.ts: dqnFeatures`) is fit once, over the **entire**
array of features passed in at first training — not a train-only, time-ordered prefix like the
forecast model uses — and then persisted and reused for the life of that scaler. Early rows in that
training run are normalized using mean/std statistics that include later rows. This is a narrower leak
than a label leak (it only affects the scale of inputs, not price or label information), but it is
inconsistent with the rest of the pipeline's ordering guarantee and should be fixed by whoever owns
`Tensorflow.service.ts` (Quant Engineer) — fitting the scaler on a fixed, time-ordered prefix instead.

### Event-stream data is not part of this boundary (yet)

Order book, trade and liquidation events recorded by the streaming collectors
(`src/Storage/collectors/<symbol>/<stream>`, written by `BinanceStreamCollector` and read via
`collector.reader.ts`) are a structurally separate tree from this one. They are consumed live by
`OrderFlowService`, which trains its own small model and exposes a handful of calibrated scalar
"verdicts" per candle — the raw events themselves never become a column of a stored per-bar dataset
here, so they are outside today's reproducibility and quality checks. See the open question below.

## Reproducibility and data-quality tools

- `yarn dataset:inventory` — read-only report of what is on disk per source/symbol/series: row count,
  date range, gaps (missing bars against the series' nominal step), duplicate/out-of-order timestamps,
  zero-volume bars, and price-outlier counts (robust median-absolute-deviation check on bar-to-bar
  returns). It reports; it does not repair anything.
- `yarn dataset:fetch --symbol=<pair> --interval=minute|hour --start=<date> --end=<date>` — fetches one
  explicit, bounded window of Binance spot candles independent of the live incremental sync (which only
  knows "now", not a fixed end, and so cannot be re-run later to reproduce a past result). Writes the
  rows and a manifest (source, exact params, fetch timestamp, row count, content hash, the command that
  produced it). Re-running with the same parameters re-fetches and compares hashes: a match proves
  reproducibility (and repairs the on-disk file if it had been edited or corrupted); a mismatch is
  reported with an added/removed/changed row count and left as a separate conflict file — the existing
  data and manifest are never silently overwritten. Binance spot candles only for now; see below for
  what extending this to the other sources and to multi-source, multi-frequency snapshots would need.

## Extending to multiple sources at different native frequencies (open question from TRA-10)

Two separate mechanisms already exist and should be reused rather than replaced:

1. For a new **slow, delayed-publication** source (comparable to DVOL / stablecoins / fear & greed): add
   a collector under `src/services/collectors/`, a `MarketSeries` entry and `SERIES_SOURCE` mapping in
   `Local.storage.service.ts`, a `syncX`/backfill pair in `MarketData.service.ts`, and a lookup with an
   explicit availability delay in `externalFeaturesAt` (`tensorflow.helpers.ts`). Funding rates and open
   interest already follow this path (`futuresFeaturesAt`) — order book imbalance or liquidation *rates*
   aggregated to a per-bar number would fit the same shape.
2. For **event-level** data (raw order book depth, individual liquidations) the right structural move is
   not to store every event under `src/Storage/datasets` — that would make "the dataset" a join across
   a gigabytes-per-day event log and a small per-bar table. Instead, extend the `OrderFlowService`
   pattern: keep raw events in `src/Storage/collectors`, but have it persist a **per-bar aggregate**
   (e.g. order-book imbalance at candle close, liquidation count/notional within the bar) back into
   `src/Storage/datasets` the same way candles are stored, instead of only emitting a live-only verdict.
   That aggregate then slots into `IMarketDataset` and `externalFeaturesAt` like any other source.

Either way, `dataset:fetch` and `dataset:inventory` would need to become source-aware (today they only
know Binance candles) once a second source joins the explicit-window / quality-check path — tracked
as follow-up, not done in this change.
