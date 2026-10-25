# Backlog

Status: todo / doing / done / blocked. Order = expected impact on net profit (product-owner keeps it sorted).
A task is `done` only with a tester verdict PASS linked in "Result".

| id | task | owner → verifier | status | acceptance criteria | result |
|----|------|------------------|--------|---------------------|--------|
| T0 | Lookback robustness of the trend rule | data-analyst | done | Sharpe/CAGR/DD for lookbacks 10–120d, plus a no-picking vote | 30d is a peak; vote 10–120d ≈ B&H return (+43% vs +47%), DD −48% vs −77% (status.md 2026-10-25). Needs tester re-check. |
| T1 | Funding-carry backtest (ETH/BTC perp funding vs spot) | data-analyst → tester | todo | Net of 0.1% and 0.7% fees + slippage; walk-forward; CAGR, max DD, Sharpe vs buy & hold; ≤3 trades/day | |
| T2 | AI vol sizing: use the Forecast model's predicted move size instead of realized vol in src/scripts/strategy-check.ts. Base it on the 10–120d vote, not on trend 30d (T0) | coder-reviewer → tester | todo | Same table as strategy-check; out-of-sample beats the realized-vol rows on Sharpe and DD at 0.1% fee; no look-ahead | |
| T3 | Binance spot execution at 0.1% fee, paper mode first | coder-reviewer | todo | Paper orders logged with fee and slippage; no live orders; tsc passes | |
| T4 | Wire the kill switch (3 trades/day, 3 losses in a row, drawdown 30–35%) into the chosen strategy | coder-reviewer → tester | todo | Each trigger covered by a test/replay that halts trading; backtest shows stop count per year | |
