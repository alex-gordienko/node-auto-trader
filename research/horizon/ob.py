"""Step 6: the bot's recorded futures order books (src/Storage/collectors, since 2026-10-18, one top-20 snapshot a second)
on 10 s / 60 s / 300 s horizons with the same top-3-a-day selection. A week of data — a tiny sample, indicative only.
Run: .venv/bin/python -I ob.py → ob_results.json"""
import glob, gzip, json, os
import numpy as np, pandas as pd
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor

HERE = os.path.dirname(os.path.abspath(__file__))
REC = os.path.expanduser("~/Projects/OwnProjects/node-auto-trader/src/Storage/collectors")
HORIZONS = {"10s": 10, "60s": 60, "300s": 300}
COSTS = {"gross": 0, "maker 0.02%": 8, "maker 0.05%": 14, "taker 0.1%": 24, "bot 0.7%": 140}
PER_DAY = 3


def book(sym):
    cache = os.path.join(HERE, "data", f"ob_{sym}.parquet")
    if os.path.exists(cache):
        return pd.read_parquet(cache)
    rows = []
    for f in sorted(glob.glob(os.path.join(REC, sym, "futures-depth", "*", "*.jsonl.gz"))):
        try:
            with gzip.open(f, "rt") as fh:
                for line in fh:
                    try:
                        recv, ev, bids, asks = json.loads(line)
                    except ValueError:
                        break  # unfinished gzip part / torn line after a kill
                    b, a = np.array(bids, float), np.array(asks, float)
                    if len(b) < 5 or len(a) < 5:
                        continue
                    bq, aq = b[:, 1], a[:, 1]
                    rows.append((ev, b[0, 0], a[0, 0], bq[0], aq[0], bq[:5].sum(), aq[:5].sum(), bq.sum(), aq.sum()))
        except (EOFError, OSError, __import__("zlib").error):
            continue  # truncated file: keep what was read
    df = pd.DataFrame(rows, columns=["t", "bid", "ask", "bq1", "aq1", "bq5", "aq5", "bq20", "aq20"])
    df["t"] = pd.to_datetime(df["t"], unit="ms").dt.floor("s")
    df = df.drop_duplicates("t", keep="last").set_index("t").sort_index()
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    df.to_parquet(cache)
    return df


def features(df):
    g = df.reindex(pd.date_range(df.index[0], df.index[-1], freq="s"))
    fresh = g["bid"].notna()  # seconds with a real snapshot
    g = g.ffill(limit=5)
    mid = (g.bid + g.ask) / 2
    lm = np.log(mid)
    X = pd.DataFrame({
        "imb1": (g.bq1 - g.aq1) / (g.bq1 + g.aq1), "imb5": (g.bq5 - g.aq5) / (g.bq5 + g.aq5), "imb20": (g.bq20 - g.aq20) / (g.bq20 + g.aq20),
        "micro": ((g.ask * g.bq1 + g.bid * g.aq1) / (g.bq1 + g.aq1) - mid) / mid, "spread": (g.ask - g.bid) / mid,
        "r10": lm.diff(10), "r60": lm.diff(60), "r300": lm.diff(300), "rv300": lm.diff().rolling(300).std(),
    })
    X["imb5_mean10"] = X["imb5"].rolling(10).mean()
    Y = pd.DataFrame({h: lm.shift(-s) - lm for h, s in HORIZONS.items()})
    ok = fresh & X.notna().all(axis=1)
    return X[ok], Y[ok]


def select(score, label, horizon_s, thr):
    """Top moments by |score| beyond a fixed threshold from the training days; long or short; ≤3 a day; one position at a time."""
    out, busy, day, count = [], None, None, 0
    t = score.index
    for i in np.flatnonzero(np.abs(score.values) > thr):
        ti = t[i]
        if ti.normalize() != day:
            day, count = ti.normalize(), 0
        if (busy is not None and ti < busy) or count >= PER_DAY or np.isnan(label[i]):
            continue
        side = np.sign(score.values[i])
        out.append((ti, side * label[i]))
        busy, count = ti + pd.Timedelta(seconds=horizon_s), count + 1
    return np.array([g for _, g in out])


def main():
    res = {}
    for sym in ("ETH-USDT", "BTC-USDT"):
        X, Y = features(book(sym))
        days = X.index.normalize().unique()
        split = days[int(len(days) * 0.6)]  # first ~60% of days train, rest test (no shuffling)
        tr, te = X.index < split, X.index >= split
        test_days = (X.index[-1] - split) / pd.Timedelta(days=1)
        res[sym] = {"train": f"{X.index[0]:%m-%d %H:%M} … {split:%m-%d}", "test": f"{split:%m-%d} … {X.index[-1]:%m-%d %H:%M}", "test_days": round(test_days, 2)}
        for h, s in HORIZONS.items():
            ytr = Y[h].values[tr]
            m_ok = ~np.isnan(ytr)
            model = HistGradientBoostingRegressor(max_iter=150, learning_rate=0.05, min_samples_leaf=2000, early_stopping=False, random_state=0)
            idx = np.flatnonzero(m_ok)[::5]
            model.fit(X.values[tr][idx], ytr[idx])
            p_tr, p_te = model.predict(X.values[tr]), pd.Series(model.predict(X.values[te]), X.index[te])
            ic = pd.Series(p_te.values).corr(pd.Series(Y[h].values[te]), method="spearman")
            thr = np.quantile(np.abs(p_tr), 1 - PER_DAY / 86400 * 5)  # a bit looser than 3/day: crossings cluster around spikes
            g = select(p_te, Y[h].values[te], s, thr)
            # perfect foresight: per test day the 3 largest |moves|, spaced by the horizon
            lab = pd.Series(np.abs(Y[h].values[te]), X.index[te]).dropna()
            orc = []
            for _, d in lab.groupby(lab.index.normalize()):
                chosen = []
                for ti, v in d.sort_values(ascending=False).items():
                    if all(abs((ti - c).total_seconds()) >= s for c in chosen):
                        chosen.append(ti); orc.append(v)
                        if len(chosen) == PER_DAY:
                            break
            res[sym][h] = {"ic": round(float(ic), 3), "trades": int(len(g)), "trades_day": round(len(g) / test_days, 2),
                           "gross_bps": round(float(g.mean() * 1e4), 2) if len(g) else None,
                           "hit_gross": round(float((g > 0).mean()), 2) if len(g) else None,
                           "net_bps": {c: round(float(g.mean() * 1e4 - b), 1) if len(g) else None for c, b in COSTS.items()},
                           "oracle_gross_bps": round(float(np.mean(orc) * 1e4), 1),
                           "median_abs_move_bps": round(float(np.nanmedian(np.abs(Y[h].values[te])) * 1e4), 2)}
            print(sym, h, res[sym][h], flush=True)
    json.dump(res, open(os.path.join(HERE, "ob_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
