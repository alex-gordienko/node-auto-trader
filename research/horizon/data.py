"""Download Binance spot 1-minute klines (data.binance.vision) for BTCUSDT / ETHUSDT 2020-01 … yesterday into data/<SYM>_1m.parquet.
Run: .venv/bin/python -I data.py"""
import io, os, subprocess, zipfile
from concurrent.futures import ThreadPoolExecutor
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SYMBOLS = ["BTCUSDT", "ETHUSDT"]
COLS = ["t", "o", "h", "l", "c", "v", "ct", "qv", "n", "tbv", "tbq", "x"]


def fetch_zip(url):
    r = subprocess.run(["curl", "-sSf", "--max-time", "120", url], capture_output=True)  # curl: trusts the macOS keychain
    if r.returncode:
        return None
    with zipfile.ZipFile(io.BytesIO(r.stdout)) as z:
        return pd.read_csv(z.open(z.namelist()[0]), header=None, names=COLS)


def load(sym):
    path = os.path.join(HERE, "data", f"{sym}_1m.parquet")
    if os.path.exists(path):
        return pd.read_parquet(path)
    today = pd.Timestamp.now("UTC").tz_localize(None).normalize()
    months = pd.period_range("2020-01", (today - pd.offsets.MonthBegin(1)).strftime("%Y-%m"), freq="M")
    base = f"https://data.binance.vision/data/spot"
    urls = [f"{base}/monthly/klines/{sym}/1m/{sym}-1m-{m}.zip" for m in months]
    # the running month only exists as daily files
    days = pd.date_range(today.replace(day=1), today - pd.Timedelta(days=2))
    urls += [f"{base}/daily/klines/{sym}/1m/{sym}-1m-{d:%Y-%m-%d}.zip" for d in days]
    with ThreadPoolExecutor(8) as ex:
        parts = list(ex.map(fetch_zip, urls))
    missing = [u for u, p in zip(urls, parts) if p is None]
    if missing:
        print(f"{sym}: {len(missing)} files missing, e.g. {missing[:3]}")
    df = pd.concat([p for p in parts if p is not None], ignore_index=True)
    t = df["t"].astype("int64")
    df["t"] = np.where(t > 10 ** 14, t // 1000, t)  # archives switched to microseconds in 2025
    df = df[["t", "o", "h", "l", "c", "v", "tbv"]].drop_duplicates("t").sort_values("t").reset_index(drop=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    df.to_parquet(path)
    return df


def funding(sym):
    """Binance USDⓈ-M funding history (all 8-hour payments since 2019-09) → data/<SYM>_funding.json, list of dicts."""
    import json
    path = os.path.join(HERE, "data", f"{sym}_funding.json")
    if not os.path.exists(path):
        rows, start = [], 1567296000000
        while True:
            r = subprocess.run(["curl", "-sSf", "--max-time", "60", f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={sym}&startTime={start}&limit=1000"], capture_output=True, check=True)
            batch = json.loads(r.stdout)
            rows += batch
            if len(batch) < 1000:
                break
            start = batch[-1]["fundingTime"] + 1
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(rows, f)
    with open(path) as f:
        return json.load(f)


if __name__ == "__main__":
    for s in SYMBOLS:
        d = load(s)
        gaps = np.diff(d["t"].values) // 60000
        print(s, len(d), pd.Timestamp(d.t.iloc[0], unit="ms"), pd.Timestamp(d.t.iloc[-1], unit="ms"), "gaps>1m:", int((gaps > 1).sum()), "max gap min:", int(gaps.max()))
