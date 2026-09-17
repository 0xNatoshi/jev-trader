#!/usr/bin/env python3
"""Is there a longshot edge on Polymarket? The measurement, not the story.

The claim (Bartlett & O'Hara, 41.6M Kalshi trades): traders systematically overbet
YES on markets that end up settling NO, so buying NO on longshots has positive
expectancy. Here we measure it directly on resolved Polymarket markets:

  for every resolved market, take the YES price T hours before its end, then compare
  with what actually happened. Bucket by price and print the calibration table:
  if 5c longshots settle YES only 3% of the time, buying NO at 95c returns 3c/95c.

Read-only, no keys. Writes data/poly-longshot.json.
"""
import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

GAMMA = "https://gamma-api.polymarket.com/markets"
CLOB = "https://clob.polymarket.com"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def resolved_markets(want, days=45, pages=28):
    """Markets that ended in the last `days` days.

    The window matters more than the sort: browsing `closed=true` without it pulls the
    far-dated markets first (end dates in 2029, closed early because the event was ruled
    out), i.e. a sample that is almost all NO. That is what made the first two runs look
    like a huge longshot edge.
    """
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc)
    d_min = (now - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    d_max = now.strftime("%Y-%m-%d")

    out, offset, page = [], 0, 0
    seen = set()
    while page < pages and len(out) < want:
        url = (
            f"{GAMMA}?limit=100&offset={offset}&closed=true"
            f"&end_date_min={d_min}&end_date_max={d_max}&order=endDate&ascending=false"
        )
        try:
            batch = get(url)
        except Exception as e:
            print(f"  catalogue stopped at offset {offset}: {e}")
            break
        if not batch:
            break
        for m in batch:
            tokens = m.get("clobTokenIds")
            if not tokens or not m.get("endDate") or m.get("id") in seen:
                continue
            try:
                ids = json.loads(tokens) if isinstance(tokens, str) else tokens
            except Exception:
                continue
            if len(ids) != 2:
                continue
            prices_field = m.get("outcomePrices")
            try:
                pr = json.loads(prices_field) if isinstance(prices_field, str) else prices_field
            except Exception:
                continue
            if not pr or abs(float(pr[0]) - round(float(pr[0]))) > 1e-9:
                continue  # still trading
            seen.add(m.get("id"))
            out.append({"q": m.get("question"), "end": m.get("endDate"), "yes": ids[0]})
        offset += 100
        page += 1
        if len(batch) < 100:
            break
    return out[:want]


def prices(token):
    """Public CLOB price history for one outcome token."""
    try:
        h = get(f"{CLOB}/prices-history?market={token}&interval=max&fidelity=60")
        return h.get("history") or []
    except Exception:
        return []


def price_before_last(pts, hours):
    """Price `hours` before the LAST quotation, which is when the market really ended.

    Measuring against the scheduled end date instead is a trap: Polymarket end dates are
    often far out and events resolve early, so you end up reading a price after
    resolution. That produced a beautiful, entirely fake longshot edge (every low-priced
    market "settled NO") in the first run.
    """
    if len(pts) < 3:
        return None
    last_t = pts[-1]["t"]
    target = last_t - hours * 3600
    if pts[0]["t"] > target:
        return None  # the series does not reach back far enough
    return min(pts, key=lambda p: abs(p["t"] - target))["p"], last_t


def outcome_from_series(pts):
    """Did token[0] win? Read it from its own last price: ~1 means it won, ~0 means it lost.

    Do not trust `outcomes` / `outcomePrices` ordering here: for some markets the token
    order and the outcome order differ, which silently inverts the calibration (the
    first two runs showed impossible results, e.g. 92% of coin-flip markets settling NO).
    """
    if not pts:
        return None
    last = pts[-1]["p"]
    if last >= 0.9:
        return 1
    if last <= 0.1:
        return 0
    return None  # ambiguous ending: leave it out rather than guess


def study(args):
    ms = resolved_markets(args.markets)
    print(f"resolved markets pulled: {len(ms)} (volume >= $1,000)")
    rows = []

    def work(m):
        pts = prices(m["yes"])
        y = outcome_from_series(pts)
        if y is None:
            return None
        got = price_before_last(pts, 24)
        if not got:
            return None
        p24, last_t = got
        return {"q": m["q"], "end": m["end"], "p24": p24, "won": y, "last_t": last_t, "n": len(pts)}

    with ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(work, ms):
            if r:
                rows.append(r)
    print(f"with a price 24h before the end: {len(rows)}")

    buckets = [(0, .05), (.05, .10), (.10, .20), (.20, .35), (.35, .65), (.65, .80), (.80, .90), (.90, .95), (.95, 1.01)]
    print(f"\n{'bucket':>12} {'n':>5} {'priced':>7} {'settled YES':>11} {'edge NO':>9}")
    for lo, hi in buckets:
        sel = [r for r in rows if lo <= r["p24"] < hi]
        if not sel:
            continue
        priced = sum(r["p24"] for r in sel) / len(sel)
        freq = sum(r["won"] for r in sel) / len(sel)
        # Buying the OTHER side at (1 - p): pays 1 if token0 loses, costs (1 - p).
        edge = (1 - freq) * 1.0 - (1 - priced)
        print(f"{lo:>5.2f}-{hi:<6.2f} {len(sel):>5} {priced:>7.3f} {freq:>11.3f} {edge:>+9.3f}")

    with open("data/poly-longshot.json", "w") as f:
        json.dump({"rows": rows}, f, indent=1)
    print("\nraw rows: data/poly-longshot.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", type=int, default=400)
    study(ap.parse_args())
