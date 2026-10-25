"""Which prediction horizon works when the bot may enter at most 3 times a day? Binance spot 1m klines 2020 … now, BTC / ETH.
A model scores every 5 minutes; only the top-3 most confident moments per day are traded (causal threshold = quantile of
the previous 30 days of scores), one position at a time, held for the horizon. Walk-forward: test years 2022 … 2026, each
trained on everything before it. Run: .venv/bin/python -I study.py  → results.parquet, trades.parquet (report.py makes the report)."""
import json, os, sys, time
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import funding as load_funding, load

HERE = os.path.dirname(os.path.abspath(__file__))
MIN = 60_000
STEP = 5  # decision grid, minutes
HORIZONS = {"5m": 5, "15m": 15, "1h": 60, "4h": 240, "12h": 720, "1d": 1440, "3d": 4320}
TEST_YEARS = [2022, 2023, 2024, 2025, 2026]
PER_DAY = 3
WINDOW_DAYS = 30
COSTS = {"gross": 0, "maker 0.02%": 8, "maker 0.05%": 14, "taker 0.1%": 24, "bot 0.7%": 140}  # round trip, bps, incl. 0.02%/side slippage
TREND_LOOKBACKS = [10, 14, 21, 30, 45, 60, 90, 120]


def minute_grid(sym):
    d = load(sym).set_index("t")
    t = np.arange(d.index[0], d.index[-1] + MIN, MIN)
    d = d.reindex(t)
    d["c"] = d["c"].ffill()
    for k in ("o", "h", "l"):
        d[k] = d[k].fillna(d["c"])
    d[["v", "tbv"]] = d[["v", "tbv"]].fillna(0)
    return d


def funding(sym):
    """Mean of the last 9 funding rates (3 days) known at each minute close."""
    f = pd.DataFrame(load_funding(sym))
    s = pd.Series(f["fundingRate"].astype(float).values, f["fundingTime"].astype("int64").values).sort_index()
    return s.rolling(9).mean()


def features(sym, other):
    """Rows = 1m candles indexed by open time; a row's values use only candles that closed by its close (open + 1m)."""
    d, o = minute_grid(sym), minute_grid(other).reindex(minute_grid(sym).index).ffill()
    lr, olr = np.log(d["c"]), np.log(o["c"])
    r1 = lr.diff()
    idx = np.where(((d.index.values + MIN) % (STEP * MIN)) == 0)[0]
    idx = idx[idx >= 4320 + 1440 * 2]  # warm-up for the longest windows
    F = {}
    take = lambda s: s.values[idx].astype(np.float32)
    for k in (1, 5, 15, 60, 240, 720, 1440, 4320):
        F[f"ret_{k}"] = take(lr - lr.shift(k))
    for k in (15, 60, 240):
        F[f"other_ret_{k}"] = take(olr - olr.shift(k))
    F["rv_60"], F["rv_1440"] = take(r1.rolling(60).std()), take(r1.rolling(1440).std())
    F["rv_ratio"] = F["rv_60"] / F["rv_1440"]
    v = d["v"]
    F["vol_ratio_60"] = take(v.rolling(60).sum() / (v.rolling(1440).sum() / 24))
    F["vol_ratio_5"] = take(v.rolling(5).sum() / (v.rolling(1440).sum() / 288))
    for k in (5, 60, 240):
        vv = v.rolling(k).sum()
        F[f"taker_imb_{k}"] = take((2 * d["tbv"].rolling(k).sum() - vv) / vv.replace(0, np.nan))
    F["range_60"] = take((d["h"].rolling(60).max() - d["l"].rolling(60).min()) / d["c"])
    F["range_5"] = take((d["h"].rolling(5).max() - d["l"].rolling(5).min()) / d["c"])
    pv = (d["c"] * v).rolling(1440).sum() / v.rolling(1440).sum()
    F["vwap_dev_1440"] = take(lr - np.log(pv))
    F["hi_dist_1440"] = take(lr - np.log(d["h"].rolling(1440).max()))
    F["lo_dist_1440"] = take(lr - np.log(d["l"].rolling(1440).min()))
    tt = pd.to_datetime(d.index.values[idx] + MIN, unit="ms")  # decision time = candle close
    F["hour_sin"], F["hour_cos"] = np.sin(2 * np.pi * (tt.hour + tt.minute / 60) / 24), np.cos(2 * np.pi * (tt.hour + tt.minute / 60) / 24)
    F["dow"] = tt.dayofweek.values.astype(np.float32)
    # daily context: trend vote on finished daily closes (close of the day before the decision day)
    daily = d["c"][(d.index.values + MIN) % (1440 * MIN) == 0]
    daily.index = pd.to_datetime(daily.index.values + MIN, unit="ms")  # stamped at 00:00 of the next day = when it is known
    vote = sum((daily > daily.shift(k)).astype(float) for k in TREND_LOOKBACKS) / len(TREND_LOOKBACKS)
    vote[daily.shift(120).isna()] = np.nan
    F["trend_vote"] = vote.reindex(tt.normalize()).values.astype(np.float32)
    F["daily_ret_30"] = (np.log(daily) - np.log(daily.shift(30))).reindex(tt.normalize()).values.astype(np.float32)
    fr = funding(sym)
    pos = np.searchsorted(fr.index.values, tt.values.astype("datetime64[ms]").astype("int64"), side="right") - 1
    F["funding_3d"] = np.where(pos >= 0, fr.values[np.clip(pos, 0, None)], np.nan).astype(np.float32)
    X = pd.DataFrame(F, index=tt).replace([np.inf, -np.inf], np.nan)
    Y = pd.DataFrame({h: lr.shift(-m).values[idx] - lr.values[idx] for h, m in HORIZONS.items()}, index=tt)
    return X, Y


# ---------- selection ----------
def select(score, label, horizon_min, mode, rng=None):
    """Walk through decision points in time order; enter when the score is beyond the causal threshold (quantile of the
    previous 30 days of scores), at most PER_DAY entries per UTC day, one position at a time held for the horizon.
    mode 'long': long/flat on high scores; 'ls': long or short by sign of the score. rng → random entries (control)."""
    s = pd.Series(score)
    q = 1 - PER_DAY / (1440 / STEP)
    mag = s if mode == "long" else s.abs()
    thr = mag.rolling(WINDOW_DAYS * 1440 // STEP, min_periods=7 * 1440 // STEP).quantile(q).shift(1).values
    days = score.index.normalize().values if hasattr(score, "index") else None
    t = s.index.values
    out, busy_until, count, cur = [], np.datetime64(0, "ns"), 0, None
    mags, lab = mag.values, label
    p_rand = PER_DAY / (1440 / STEP)
    for i in range(len(t)):
        if days[i] != cur:
            cur, count = days[i], 0
        if t[i] < busy_until or count >= PER_DAY or np.isnan(lab[i]):
            continue
        go = (rng.random() < p_rand) if rng is not None else (not np.isnan(thr[i]) and mags[i] > thr[i])
        if go:
            side = 1.0 if (mode == "long" or rng is not None or s.values[i] > 0) else -1.0
            out.append((t[i], side, side * lab[i]))
            busy_until = t[i] + np.timedelta64(horizon_min, "m")
            count += 1
    return pd.DataFrame(out, columns=["t", "side", "gross"])


def oracle(label, times, horizon_min, mode):
    """Perfect foresight: per day the 3 best non-overlapping entries (within the day) by realized return."""
    df = pd.DataFrame({"t": times, "g": label if mode == "long" else np.abs(label)}).dropna()
    picks = []
    for _, g in df.groupby(df.t.dt.normalize()):
        chosen = []
        for _, r in g.sort_values("g", ascending=False).iterrows():
            if all(abs((r.t - c).total_seconds()) >= horizon_min * 60 for c in chosen):
                chosen.append(r.t); picks.append(r.g)
                if len(chosen) == PER_DAY:
                    break
    return np.array(picks)


def oracle_fast(label, times, horizon_min, mode):
    """Same as oracle, vectorised per day with numpy (the pandas version is too slow for 1,700 days × 7 horizons)."""
    g = label if mode == "long" else np.abs(label)
    ok = ~np.isnan(g)
    t = times.values[ok].astype("datetime64[m]").astype(np.int64)
    g = g[ok]
    day = t // 1440
    res = []
    bounds = np.flatnonzero(np.diff(day)) + 1
    for a, b in zip(np.r_[0, bounds], np.r_[bounds, len(t)]):
        order = np.argsort(-g[a:b])
        chosen = []
        for j in order:
            tj = t[a + j]
            if all(abs(tj - c) >= horizon_min for c in chosen):
                chosen.append(tj); res.append(g[a + j])
                if len(chosen) == PER_DAY:
                    break
    return np.array(res)


def stats(tr, cost_bps, start, end):
    days = (end - start) / np.timedelta64(1, "D")
    if len(tr) == 0:
        return dict(trades_day=0, hit=np.nan, net_bps=np.nan, ann=0.0, sharpe=np.nan, mdd=0.0, t=np.nan, n=0)
    net = tr["gross"].values - cost_bps / 1e4
    daily = pd.Series(net, pd.to_datetime(tr["t"]).dt.normalize()).groupby(level=0).sum()
    daily = daily.reindex(pd.date_range(start, end - np.timedelta64(1, "D")), fill_value=0)
    eq = daily.cumsum()
    return dict(trades_day=len(tr) / days, hit=(net > 0).mean(), net_bps=net.mean() * 1e4,
                ann=np.exp(net.sum() * 365 / days) - 1, sharpe=daily.mean() / daily.std() * np.sqrt(365) if daily.std() > 0 else np.nan,
                mdd=float(np.exp((eq - eq.cummax()).min()) - 1), t=net.mean() / net.std() * np.sqrt(len(net)) if len(net) > 2 else np.nan, n=len(net))


def models():
    return {
        "gbm": lambda: HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=2000,
                                                     l2_regularization=1.0, early_stopping=False, random_state=0),
        "ridge": lambda: Ridge(alpha=10.0),
    }


def fit_predict(kind, Xtr, ytr, Xte):
    lo, hi = np.nanpercentile(ytr, [0.5, 99.5])
    ytr = np.clip(ytr, lo, hi)
    if kind == "ridge":
        mu, sd = np.nanmean(Xtr, 0), np.nanstd(Xtr, 0) + 1e-12
        f = lambda X: np.nan_to_num(np.clip((X - mu) / sd, -5, 5))
        m = models()[kind]().fit(f(Xtr), ytr)
        return m.predict(f(Xte))
    return models()[kind]().fit(Xtr, ytr).predict(Xte)


def selftest():
    # selection: a perfect score on a known label must pick the top moves, respect 3/day and the busy window
    t = pd.date_range("2024-01-01", periods=288 * 40, freq="5min")
    rng = np.random.default_rng(1)
    lab = rng.normal(0, 0.001, len(t))
    tr = select(pd.Series(lab, t), lab, 5, "long")
    assert tr.groupby(tr.t.dt.normalize()).size().max() <= PER_DAY
    assert (tr.gross > 0).mean() > 0.95  # the score is the label itself
    tr2 = select(pd.Series(lab, t), lab, 60, "ls")
    assert (np.diff(tr2.t.values) >= np.timedelta64(60, "m")).all()
    o = oracle_fast(lab, pd.Series(t), 5, "long")
    o2 = oracle(lab, pd.Series(t), 5, "long")
    assert np.allclose(np.sort(o), np.sort(o2))
    s = stats(pd.DataFrame({"t": t[:2], "gross": [0.01, -0.01]}), 0, t[0].normalize().to_datetime64(), (t[0].normalize() + pd.Timedelta(days=2)).to_datetime64())
    assert abs(s["net_bps"]) < 1e-9 and s["n"] == 2


def main():
    selftest()
    rows, trades = [], []
    for sym, other in (("BTCUSDT", "ETHUSDT"), ("ETHUSDT", "BTCUSDT")):
        t0 = time.time()
        X, Y = features(sym, other)
        # alignment check: the 5m label at a decision is exactly the 5m return feature of the next decision (no overlap with the past)
        assert np.allclose(X["ret_5"].shift(-1).values[:-1], Y["5m"].values[:-1], atol=1e-6, equal_nan=True)
        assert np.allclose(X["ret_60"].shift(-12).values[:-12], Y["1h"].values[:-12], atol=1e-6, equal_nan=True)
        print(f"{sym}: {len(X)} decision points, {X.shape[1]} features, built in {time.time() - t0:.0f}s", flush=True)
        end_all = (X.index[-1].normalize() + pd.Timedelta(days=1)).to_datetime64()
        for h, hm in HORIZONS.items():
            preds = {k: pd.Series(np.nan, X.index) for k in models()}
            for y in TEST_YEARS:
                te = (X.index.year == y)
                # train on everything up to the year start minus the horizon (labels must end before the test year)
                tr = (X.index < pd.Timestamp(f"{y}-01-01") - pd.Timedelta(minutes=hm)) & Y[h].notna().values
                tr_idx = np.flatnonzero(tr)[::3]  # every 15 min: neighbouring labels overlap anyway
                for k in models():
                    preds[k][te] = fit_predict(k, X.values[tr_idx], Y[h].values[tr_idx], X.values[te])
            test = X.index >= pd.Timestamp(f"{TEST_YEARS[0]}-01-01")
            tt, lab = X.index[test], Y[h].values[test]
            start = np.datetime64(f"{TEST_YEARS[0]}-01-01")
            for mode in ("long", "ls"):
                ic = {k: pd.Series(preds[k].values[test]).corr(pd.Series(lab), method="spearman") for k in models()}
                for k in models():
                    tr_k = select(pd.Series(preds[k].values[test], tt), lab, hm, mode)
                    tr_k["sym"], tr_k["h"], tr_k["mode"], tr_k["model"] = sym, h, mode, k
                    trades.append(tr_k)
                    for c, bps in COSTS.items():
                        rows.append(dict(sym=sym, h=h, mode=mode, model=k, cost=c, ic=ic[k], **stats(tr_k, bps, start, end_all)))
                rnd = select(pd.Series(np.zeros(len(tt)), tt), lab, hm, "long", rng=np.random.default_rng(7))
                for c, bps in COSTS.items():
                    rows.append(dict(sym=sym, h=h, mode=mode, model="random", cost=c, ic=np.nan, **stats(rnd, bps, start, end_all)))
                orc = oracle_fast(lab, pd.Series(tt), hm, mode)
                for c, bps in COSTS.items():
                    net = orc - bps / 1e4
                    rows.append(dict(sym=sym, h=h, mode=mode, model="oracle", cost=c, ic=np.nan, trades_day=len(orc) / ((end_all - start) / np.timedelta64(1, "D")),
                                     hit=(net > 0).mean(), net_bps=net.mean() * 1e4, ann=np.nan, sharpe=np.nan, mdd=np.nan, t=np.nan, n=len(net)))
            g = pd.DataFrame(rows)
            show = g[(g.sym == sym) & (g.h == h) & (g.cost.isin(["gross", "taker 0.1%"]))][["mode", "model", "cost", "ic", "trades_day", "hit", "net_bps", "sharpe", "t"]]
            print(f"--- {sym} {h} ({time.time() - t0:.0f}s)\n{show.to_string(index=False, float_format=lambda v: f'{v:.3f}')}", flush=True)
        pd.DataFrame(rows).to_parquet(os.path.join(HERE, "results.parquet"))
        pd.concat(trades).to_parquet(os.path.join(HERE, "trades.parquet"))


if __name__ == "__main__":
    main()
