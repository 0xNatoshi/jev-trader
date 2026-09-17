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


def resolved_markets(want, pages=28, min_volume=0.0):
    """Closed markets, newest resolutions first.

    Note: `volumeNum` is ~0 on closed markets (it is a current figure), so filtering on
    it throws away almost everything -- an earlier run kept 39 markets out of 1000 that
    way. Take every market with two tokens and an end date, and let the price history
    decide what is usable.
    """
    out, offset, page = [], 0, 0
    seen = set()
    while page < pages and len(out) < want:
        url = f"{GAMMA}?limit=100&offset={offset}&closed=true&order=endDate&ascending=false"
        try:
            batch = get(url)
        except Exception as e:
            print(f"  catalogue stopped at offset {offset}: {e}")
            break
        if not batch:
            break
        for m in batch:
            tokens = m.get("clobTokenIds")
            if not tokens or not m.get("endDate"):
                continue
            if m.get("id") in seen:
                continue
            try:
                ids = json.loads(tokens) if isinstance(tokens, str) else tokens
            except Exception:
                continue
            if len(ids) != 2:
                continue
            vol = m.get("volumeNum") or 0
            if vol < min_volume:
                continue
            prices = m.get("outcomePrices")
            try:
                pr = json.loads(prices) if isinstance(prices, str) else prices
            except Exception:
                continue
            if not pr or abs(float(pr[0]) - round(float(pr[0]))) > 1e-9:
                continue  # not resolved yet: still trading
            seen.add(m.get("id"))
            out.append({
                "q": m.get("question"), "end": m.get("endDate"), "yes": ids[0],
                "volume": vol, "outcomes": m.get("outcomes"), "outcomePrices": prices,
            })
        offset += 100
        page += 1
        if len(batch) < 100:
            break
    return out[:want]


def price_before(token, end_iso, hours):
    """YES price closest to (end - hours). CLOB prices-history is public."""
    try:
        h = get(f"{CLOB}/prices-history?market={token}&interval=max&fidelity=60")
        pts = h.get("history") or []
    except Exception:
        return None
    if not pts:
        return None
    end = datetime.fromisoformat(end_iso.replace("Z", "+00:00")).timestamp()
    target = end - hours * 3600
    return min(pts, key=lambda p: abs(p["t"] - target))["p"]


def won(outcomes, outcomePrices):
    """Did YES win? Polymarket leaves outcomePrices at resolution, e.g. [1, 0]."""
    try:
        prices = json.loads(outcomePrices) if isinstance(outcomePrices, str) else outcomePrices
        outs = json.loads(outcomes) if isinstance(outcomes, str) else outcomes
    except Exception:
        return None
    if not prices or not outs:
        return None
    return 1 if float(prices[0]) > 0.5 else 0


def study(args):
    ms = resolved_markets(args.markets)
    print(f"resolved markets pulled: {len(ms)} (volume >= $1,000)")
    rows = []

    def work(m):
        y = won(m["outcomes"], m["outcomePrices"])
        if y is None:
            return None
        p24 = price_before(m["yes"], m["end"], 24)
        if p24 is None:
            return None
        return {"q": m["q"], "end": m["end"], "vol": m["volume"], "p24": p24, "yes_won": y}

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
        freq = sum(r["yes_won"] for r in sel) / len(sel)
        # Buying NO at (1 - p): pays 1 if YES loses, costs (1 - p).
        edge = (1 - freq) * 1.0 - (1 - priced)
        print(f"{lo:>5.2f}-{hi:<6.2f} {len(sel):>5} {priced:>7.3f} {freq:>11.3f} {edge:>+9.3f}")

    with open("data/poly-longshot.json", "w") as f:
        json.dump({"rows": rows}, f, indent=1)
    print("\nraw rows: data/poly-longshot.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", type=int, default=400)
    study(ap.parse_args())
