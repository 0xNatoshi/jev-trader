#!/usr/bin/env python3
"""Memecoin scanner: score every new pool, then test the score against reality.

Two halves in one tool:

  scan      read new pools (GeckoTerminal, no key), compute a deterministic 0-100
            score per pool, append a timestamped snapshot to data/meme-snapshots.jsonl
  verdict   compare snapshots taken hours apart: did the high-score pools actually do
            better than the low-score ones? That is the only question that matters.

The score is deliberately built from things a rug cannot fake at the start: real
liquidity, how much of it is traded, how many distinct wallets are buying, whether the
book is one-way, age, and whether valuation is sane relative to the pool.

Usage:
  python3 scripts/meme-scan.py scan --pages 3 --networks solana,base,bsc
  python3 scripts/meme-scan.py verdict
"""
import argparse
import json
import os
import time
import urllib.request
from collections import Counter

API = "https://api.geckoterminal.com/api/v2"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
SNAP = "data/meme-snapshots.jsonl"


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def score(p):
    """0-100. Higher = more likely to survive the next hours. Deterministic, documented.

    Each term is deliberately crude and observable at scan time. The point is not a
    clever model, it is a filter that can be falsified with data.
    """
    s = 50.0
    liq = num(p.get("liquidity"))
    vol1h = num(p.get("vol1h"))
    age_min = num(p.get("age_min"))
    buyers1h = num(p.get("buyers1h"))
    sell1h = num(p.get("sells1h"))
    buy1h = num(p.get("buys1h"))
    fdv = num(p.get("fdv"))
    chg1h = num(p.get("chg1h"))

    # Liquidity: the only thing that lets you leave.
    s += 25 if liq >= 50_000 else 15 if liq >= 20_000 else 5 if liq >= 5_000 else -30
    # Age: pools that survive their first hour are a different species.
    s += 10 if age_min >= 60 else 0 if age_min >= 15 else -15
    # Distinct buyers vs sellers: one-way flow is a pump, two-way is a market.
    s += 12 if buyers1h >= 100 else 6 if buyers1h >= 30 else -12 if buyers1h < 5 else 0
    if sell1h > 0:
        ratio = buy1h / (buy1h + sell1h)
        s += 8 if 0.35 <= ratio <= 0.65 else -12 if ratio >= 0.9 else -4
    else:
        s -= 12  # nobody sold yet: the price is a claim, not a market
    # Turnover: volume far above liquidity means the pool is being churned.
    if liq > 0:
        r = vol1h / liq
        s += 6 if 0.2 <= r <= 3 else -10 if r > 10 else 0
    # Valuation sanity.
    if liq > 0:
        s += 6 if fdv <= 20 * liq else -12 if fdv > 100 * liq else 0
    # Already parabolic: the easy money is gone.
    s += -10 if chg1h > 200 else 4 if -30 <= chg1h <= 30 else 0
    return max(0.0, min(100.0, s))


def fetch_new(networks, pages):
    """New pools straight from the venue's explorer, newest first, per page.

    GeckoTerminal's free tier rate-limits bursts (~429): pause between calls.
    """
    out = []
    for net in networks:
        for page in range(1, pages + 1):
            try:
                d = get(f"{API}/networks/{net}/new_pools?page={page}")
            except Exception as e:
                print(f"  {net} page {page}: {e}")
                time.sleep(4)
                continue
            time.sleep(2.5)
            for row in d.get("data") or []:
                a = row.get("attributes") or {}
                created = a.get("pool_created_at") or ""
                age_min = 1e9
                if created:
                    try:
                        import datetime as dt
                        t = dt.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
                        age_min = (time.time() - t) / 60
                    except Exception:
                        pass
                vol = a.get("volume_usd") or {}
                tx = a.get("transactions") or {}
                h1 = tx.get("h1") or {}
                ch = a.get("price_change_percentage") or {}
                out.append({
                    "pool": a.get("address"),
                    "net": net,
                    "name": a.get("name"),
                    "created": created,
                    "age_min": round(age_min, 1),
                    "liquidity": num(a.get("reserve_in_usd")),
                    "fdv": num(a.get("fdv_usd")),
                    "vol5m": num(vol.get("m5")),
                    "vol1h": num(vol.get("h1")),
                    "vol24h": num(vol.get("h24")),
                    "buys1h": num(h1.get("buys")),
                    "sells1h": num(h1.get("sells")),
                    "buyers1h": num(h1.get("buyers")),
                    "sellers1h": num(h1.get("sellers")),
                    "chg1h": num(ch.get("h1")),
                    "price": num(a.get("base_token_price_usd")),
                })
    return out


def cmd_scan(args):
    nets = [n.strip() for n in args.networks.split(",") if n.strip()]
    pools = fetch_new(nets, args.pages)
    now = time.time()
    kept = []
    for p in pools:
        p["score"] = round(score(p), 1)
        p["ts"] = now
        kept.append(p)
    os.makedirs("data", exist_ok=True)
    with open(SNAP, "a") as f:
        for p in kept:
            f.write(json.dumps(p) + "\n")

    live = [p for p in kept if p["age_min"] <= 120]
    dead = [p for p in live if p["liquidity"] < 5_000]
    hot = sorted(live, key=lambda p: -p["score"])[: args.top]
    print(f"pools read: {len(kept)} | launched in the last 2h: {len(live)} | under $5k liquidity: {len(dead)}")
    print(f"median liquidity (last 2h): ${sorted(p['liquidity'] for p in live)[len(live)//2]:,.0f}" if live else "no fresh pools")
    print("\ntop by score:")
    for p in hot:
        print(f"  {p['score']:>5.1f} | ${p['liquidity']:>10,.0f} liq | ${p['vol1h']:>9,.0f} 1h vol | {p['buyers1h']:>4.0f} buyers | {p['age_min']:>5.0f} min | {p['name'][:34]}")
    print(Counter(p["net"] for p in kept).most_common())


def load_snaps():
    by_pool = {}
    if not os.path.exists(SNAP):
        return by_pool
    with open(SNAP) as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            by_pool.setdefault(r["pool"], []).append(r)
    for v in by_pool.values():
        v.sort(key=lambda r: r["ts"])
    return by_pool


def cmd_verdict(args):
    snaps = load_snaps()
    pairs = []
    for pool, rows in snaps.items():
        if len(rows) < 2:
            continue
        a, b = rows[0], rows[-1]
        if b["ts"] - a["ts"] < args.min_hours * 3600:
            continue
        if a["price"] <= 0 or b["price"] <= 0:
            continue
        pairs.append({"score": a["score"], "ret": (b["price"] / a["price"] - 1) * 100, "hours": (b["ts"] - a["ts"]) / 3600, "name": a["name"]})
    if not pairs:
        print("not enough history yet: run `scan` now, then again later (cron does it hourly)")
        return
    pairs.sort(key=lambda r: -r["score"])
    n = len(pairs)
    top = pairs[: max(1, n // 2)]
    bot = pairs[max(1, n // 2):]
    def stats(rows):
        rets = sorted(r["ret"] for r in rows)
        med = rets[len(rets) // 2]
        return f"n={len(rows):>4} median {med:>+8.1f}% | mean {sum(rets)/len(rets):>+8.1f}% | best {rets[-1]:>+9.0f}% | worst {rets[0]:>+9.0f}%"
    print(f"pairs with history: {n} (>= {args.min_hours}h apart)")
    print(f"  high score : {stats(top)}")
    print(f"  low score  : {stats(bot)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s1 = sub.add_parser("scan")
    s1.add_argument("--networks", default="solana,base,bsc")
    s1.add_argument("--pages", type=int, default=3)
    s1.add_argument("--top", type=int, default=12)
    s2 = sub.add_parser("verdict")
    s2.add_argument("--min-hours", type=float, default=1.0)
    args = ap.parse_args()
    (cmd_scan if args.cmd == "scan" else cmd_verdict)(args)
