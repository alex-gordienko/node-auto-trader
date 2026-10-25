# Status

**Goal:** the bot is profitable net of fees and costs.

**Constraints**
- Max 3 trades per day.
- Must use its own AI models (several allowed) to learn the market and predict.
- Built-in kill switch for emergencies and N losing trades in a row.
- No live trading without the owner.
- Keep graphify-out/ in git; after major code changes regenerate it with /graphify . (incremental).

**Current stage (2026-10-25):** paper trading. The bot (`yarn start`) paper-trades the BTC+ETH trend vote 10–120d with vol sizing every 3 days (services/VoteTrader.service.ts) through the kill switch; the old 50/50 ETH band rule is no longer run. Real money needs the owner's explicit go-ahead.

**Known results**
- Intraday order flow has no edge after costs.
- Forecast predicts move size (IC 0.34–0.38), not direction.
- Best candidate: 50/50 BTC+ETH, 30d trend per coin, decision every 3 days, vol sizing → +59%/yr vs buy & hold +47%, max DD −45% vs −77% at 0.1% fee.
- **2026-10-25 robustness check: the 30d result is a lucky lookback.** 50/50 trend, 3d, 0.1% fee, by lookback (Sharpe): 10d 0.91, 14d 1.10, 21d 0.95, **30d 1.27**, 45d 1.06, 60d 1.05, 90d 0.84, 120d 1.02 (B&H 0.91). A vote of all lookbacks 10–120d (no picking, row "50/50 vote 10–120d, 3d" in strategy-check): CAGR +43% vs B&H +47%, max DD −48% vs −77%, Sharpe 1.07 vs 0.91, 42 swaps/yr. Honest expectation: about buy & hold's return with ~⅔ of its drawdown — crash insurance, not extra profit.
- The edge is gone at the current 0.7% cost (ChangeNOW + gas) → Binance spot is needed.
- The rules are not AI yet: the AI forecasts 5/15-min moves and cannot be backtested at 3 days (T2 blocked); it runs alongside (forecast + DQN shadow), not in the decision.
- Tester (T0): numbers PASS, drawdown cut robust; Sharpe edge over B&H not significant (t≈1).
- A 20% drawdown stop fires ~5×/yr; use 30–35%.

**Open blockers**
- Cloud sandboxes cannot reach Binance; only the owner's Mac can download data.
