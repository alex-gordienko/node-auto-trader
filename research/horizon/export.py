"""Trains the two paper-trading candidates of the horizon search on all history and exports them as JSON for the bot
(src/utils/horizon-model.ts evaluates them), plus a parity fixture for src/utils/horizon-model.test.ts.

  ETH 3-day long/flat, gradient-boosted trees    → src/models/horizon/eth-3d-gbm.json
  ETH 12-hour long/short, ridge                  → src/models/horizon/eth-12h-ridge.json

Same features, target clipping, model settings and training rows (every 15 min) as the walk-forward in study.py; the
only difference is that the training data runs up to the newest candle whose label has ended. Refit about once a year
(the walk-forward refitted yearly): .venv/bin/python -I research/horizon/export.py — then restart the bot.
Needs pandas, numpy, scikit-learn, pyarrow; data.py downloads Binance 1m klines into research/horizon/data/."""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from study import HORIZONS, features, models, MIN

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "src", "models", "horizon")
FIXTURE = os.path.join(REPO, "src", "utils", "horizon-model.fixture.json")
CANDIDATES = [
    dict(name="eth-3d-gbm", symbol="ETHUSDT", other="BTCUSDT", horizon="3d", kind="gbm", modes=["long"]),
    dict(name="eth-12h-ridge", symbol="ETHUSDT", other="BTCUSDT", horizon="12h", kind="ridge", modes=["ls", "long"]),
]


# sklearn splits "everything not missing" with an infinite threshold; JSON has no Infinity, the largest double splits the same
MAX = np.finfo(np.float64).max


def train(kind, X, y):
    lo, hi = np.nanpercentile(y, [0.5, 99.5])
    y = np.clip(y, lo, hi)
    if kind == "ridge":
        mu, sd = np.nanmean(X, 0), np.nanstd(X, 0) + 1e-12
        m = models()["ridge"]().fit(np.nan_to_num(np.clip((X - mu) / sd, -5, 5)), y)
        return m, {"mu": mu.tolist(), "sd": sd.tolist(), "coef": m.coef_.tolist(), "intercept": float(m.intercept_)}
    m = models()["gbm"]().fit(X, y)
    trees = []
    for (p,) in m._predictors:
        n = p.nodes
        trees.append({"feature": n["feature_idx"].tolist(), "threshold": np.clip(n["num_threshold"], -MAX, MAX).tolist(), "left": n["left"].tolist(),
                      "right": n["right"].tolist(), "missingLeft": n["missing_go_to_left"].astype(int).tolist(),
                      "leaf": n["is_leaf"].astype(int).tolist(), "value": n["value"].tolist()})
    return m, {"baseline": float(np.ravel(m._baseline_prediction)[0]), "trees": trees}


def predict_json(spec, X):
    """The bot's evaluation, in numpy: must equal sklearn's predict."""
    if "coef" in spec:
        Z = np.nan_to_num(np.clip((X - np.array(spec["mu"])) / np.array(spec["sd"]), -5, 5))
        return Z @ np.array(spec["coef"]) + spec["intercept"]
    out = np.full(len(X), spec["baseline"])
    for t in spec["trees"]:
        for r in range(len(X)):
            i = 0
            while not t["leaf"][i]:
                x = X[r, t["feature"][i]]
                go_left = t["missingLeft"][i] if np.isnan(x) else x <= t["threshold"][i]
                i = t["left"][i] if go_left else t["right"][i]
            out[r] += t["value"][i]
    return out


def candle_rows(sym, t_from, t_to):
    from data import load
    d = load(sym)
    d = d[(d.t >= t_from) & (d.t <= t_to)]
    return [[int(r.t), r.o, r.h, r.l, r.c, r.v, r.tbv] for r in d.itertuples()]


def main():
    os.makedirs(OUT, exist_ok=True)
    built = {}
    fixture = {"candidates": {}}
    for c in CANDIDATES:
        key = (c["symbol"], c["other"])
        if key not in built:
            built[key] = features(*key)
        X, Y = built[key]
        hm = HORIZONS[c["horizon"]]
        ok = np.flatnonzero(Y[c["horizon"]].notna().values)[::3]
        m, spec = train(c["kind"], X.values[ok], Y[c["horizon"]].values[ok])
        # the JSON evaluation must reproduce the trained model
        sample = X.values[-2000:]
        ref = m.predict(np.nan_to_num(np.clip((sample - np.array(spec["mu"])) / np.array(spec["sd"]), -5, 5))) if c["kind"] == "ridge" else m.predict(sample)
        assert np.allclose(predict_json(spec, sample), ref, atol=1e-12), "JSON model does not match sklearn"
        model = {"name": c["name"], "symbol": c["symbol"], "other": c["other"], "horizonMinutes": hm, "kind": c["kind"], "modes": c["modes"],
                 "features": list(X.columns), "trainedFrom": f"{X.index[ok[0]]:%Y-%m-%d}", "trainedThrough": f"{X.index[ok[-1]]:%Y-%m-%d %H:%M}",
                 "rows": int(len(ok)), **spec}
        with open(os.path.join(OUT, f"{c['name']}.json"), "w") as f:
            json.dump(model, f, allow_nan=False)
        print(f"{c['name']}: trained on {len(ok)} rows {model['trainedFrom']} … {model['trainedThrough']}")
        # parity fixture: last 6 decision points, with a cut-down model (gbm: first 8 trees) so the test needs no model file
        small = dict(spec) if c["kind"] == "ridge" else {"baseline": spec["baseline"], "trees": spec["trees"][:8]}
        fx = X.iloc[-6:]
        fixture["candidates"][c["name"]] = {"model": {**{k: model[k] for k in ("name", "kind", "features", "horizonMinutes")}, **small},
                                            "times": [int(t.value // 10 ** 6) for t in fx.index],
                                            "features": np.where(np.isnan(fx.values), None, fx.values).tolist(),
                                            "predictions": predict_json(small, fx.values).tolist()}
    # inputs for the parity test: the minutes the last decision points need, daily closes, funding
    t_last = fixture["candidates"]["eth-3d-gbm"]["times"][-1]
    t_from = t_last - (4320 + 1440 + 40) * MIN
    fixture["candles"] = {s: candle_rows(s, t_from, t_last - MIN) for s in ("ETHUSDT", "BTCUSDT")}
    from data import load, funding
    d = load("ETHUSDT")
    daily = d[((d.t + MIN) % (1440 * MIN)) == 0]
    daily = daily[daily.t < t_last][-160:]
    fixture["dailyCloses"] = [[int(r.t + MIN), r.c] for r in daily.itertuples()]  # stamped when known: 00:00 of the next day
    fr = [f for f in funding("ETHUSDT") if f["fundingTime"] <= t_last][-20:]
    fixture["funding"] = [[int(f["fundingTime"]), float(f["fundingRate"])] for f in fr]
    with open(FIXTURE, "w") as f:
        json.dump(fixture, f, separators=(",", ":"))
    print(f"fixture: {os.path.getsize(FIXTURE) / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
