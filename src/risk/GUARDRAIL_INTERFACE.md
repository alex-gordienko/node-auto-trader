# Guardrail layer: single chokepoint for trade cap + kill-switch

Status: interface is implemented and backtest-tested (`src/risk/guardrails.ts`, TRA-18, commit `962c2fb`).
This note is the TRA-20 deliverable: the contract TRA-17 (entry/exit strategy) and TRA-16 (live execution)
should both code against, so neither builds its own cap/kill-switch.

## What exists today, and what doesn't

- `src/scripts/backtest.ts` has **no** kill-switch or trade cap of its own. The only pre-existing
  halt-like logic in the repo is the 50/50-rebalance strategy's "stop-crane" in `src/utils/rebalance.ts`
  (`maxTradesPerDay`, `buysInARow`, `maxDrawdown`), used by `rebalance-backtest.ts` — a different strategy,
  not wired to `backtest.ts` or to the net-return strategy TRA-17 is designing.
- `src/risk/limits.ts` is a **design-only, unwired** day-level risk scorer (drawdown / daily-loss / exposure
  / consecutive-losing-*days*), explicitly marked "nothing in the repo calls this on a live path." It answers
  a different question (how exposed should the book be right now) than the guardrails below (may a new entry
  happen at all). Don't extend it to also do trade-cap/kill-switch duty — that would recreate a second,
  competing implementation of this issue's #1/#2. If TRA-16 needs day-level exposure scoring later, that's
  a separate integration against `limits.ts`, not a reason to duplicate `guardrails.ts`.
- `src/risk/guardrails.ts` (TRA-18) is the pre-trade gate: a hard cap of `maxTradesPerDay` new entries per
  UTC day (exits/flattening are never capped) and a kill-switch that trips on 4 consecutive losing trades or
  on an emergency condition (drawdown breach, extreme volatility, data feed gap). It is already wired into
  `src/risk/backtester.ts` behind an opt-in `guardrails` option.

## The chokepoint

`src/risk/guardrails.ts` is the single chokepoint. It is pure functions over a plain `IGuardrailState` value —
no I/O, no knowledge of how many models or signals fed the decision. That's what makes it safe to share: the
state lives in exactly one place (one object, persisted by whatever process owns the trading loop), and every
candidate entry — regardless of how many models voted for it — passes through the same `canEnter` check before
an order is even considered. Models vote on *direction*; this module is the only thing that gets a vote on
*whether a trade happens at all*.

Required call sequence, per bar/tick, in this order:

1. `rollGuardrailDay(state, barTime, config)` — roll the UTC day bucket, resetting the daily entry count and
   applying the consecutive-loss auto-reset rule if the prior day cleared it.
2. `recordBarReturn(state, netBarReturn)` — accumulate today's running net return (needed for the auto-reset
   judgement; call even on bars with no trade).
3. `checkEmergencyConditions(state, input, config)` — evaluate drawdown / extreme-volatility / data-gap halts.
4. Before acting on **any** candidate entry (open from flat, or flip direction), regardless of which model(s)
   proposed it: `if (!canEnter(state, config)) { do not enter; }`
5. On an entry actually taken: `recordEntry(state)`.
6. On a position actually closed: `recordClosedTrade(state, netReturn, config)`.

`state.halted` must force the position toward flat immediately, not just block new entries — an existing
position must not keep riding through a halt.

Clearing a halt:
- Consecutive-loss halts auto-clear after `consecutiveLossAutoResetProfitableDays` fully profitable UTC days
  (handled inside `rollGuardrailDay`; no caller action needed).
- Emergency halts (`max_drawdown`, `extreme_volatility`, `data_gap`) never auto-clear. Only an explicit
  operator action calling `manualReArm(state)` clears them. Live wiring (TRA-16) must surface this as a
  deliberate human step (e.g. an ops command or dashboard action) — never an automatic retry.

## What TRA-17 should do

Nothing extra. The entry/exit model's job is to decide *direction and sizing*; it hands a candidate entry to
whatever owns the trading loop, which gates it through `canEnter` before acting. TRA-17 does not need its own
trade counter or loss-streak tracker — that would be the "per-model cap" this issue's #2 explicitly rules out.

## What TRA-16 should do

Own one `IGuardrailState` instance for the live book (not one per model/signal), call the sequence above in
the live tick/order loop, and build the human re-arm action (`manualReArm`) as an explicit, audited operator
step — not a config flag the bot can flip itself. `DEFAULT_GUARDRAILS` (3 trades/day, 4-loss kill-switch) is
the proposed starting config; confirm with Risk Engineer before changing thresholds for live money.

## Scope note

This repo's two risk modules (`guardrails.ts` pre-trade gate vs. `limits.ts` day-level exposure scorer) are
not yet reconciled into one live risk-management story. That reconciliation is out of scope for TRA-20 — flag
it separately if TRA-16's integration needs both.
