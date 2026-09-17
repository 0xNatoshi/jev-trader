#!/usr/bin/env python3
"""Polymarket scan: is there a positive spread?

Two kinds of "positive spread" on a prediction market, both measured from live books:

  1. best ask YES + best ask NO < 1.00  -> buy both sides, guaranteed $1 at
     resolution. The gap is the edge, minus the tick and slippage.
  2. best bid YES + best bid NO > 1.00  -> the mirror (sell both / merge), which
     needs holding the pair before the trade.

Polymarket charges no trading fee, so the whole gap is edge; what limits it is the
size actually resting at those prices, which we report. Read-only, no keys.

Usage: python3 scripts/poly-scan.py [--min-liquidity 5000] [--min-edge 0.5] [--top 20]
"""
import argparse
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor

GAMMA = "https://gamma-api.polymarket.com/markets"
CLOB = "https://clob.polymarket.com"


UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def post(url, payload, timeout=40):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"user-agent": UA, "accept": "application/json", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_markets(min_liquidity, max_pages=16):
    """Active, not closed, liquid enough to bother with.

    Two API limits shape this: a page is capped at 100 rows, and offsets beyond ~2900
    return 422. So filter by liquidity server side (`liquidity_num_min`), page by 100,
    and stop at the first error instead of pretending the catalogue was read fully.
    """
    out, offset, page = [], 0, 0
    while page < max_pages:
        url = (
            f"{GAMMA}?limit=100&offset={offset}&active=true&closed=false"
            f"&liquidity_num_min={min_liquidity:g}&order=liquidity&ascending=false"
        )
        try:
            batch = get(url)
        except Exception as e:
            print(f"  catalogue read stopped at offset {offset}: {e}")
            break
        if not batch:
            break
        for m in batch:
            liq = m.get("liquidityNum") or 0
            if liq < min_liquidity:
                continue
            tokens = m.get("clobTokenIds")
            if not tokens:
                continue
            try:
                ids = json.loads(tokens) if isinstance(tokens, str) else tokens
            except Exception:
                continue
            if len(ids) != 2:
                continue
            out.append({
                "question": m.get("question"),
                "slug": m.get("slug"),
                "end": m.get("endDate"),
                "liquidity": liq,
                "volume": m.get("volumeNum") or 0,
                "tokens": ids,
                "outcomes": m.get("outcomes"),
                "negRisk": bool(m.get("negRisk")),
            })
        offset += 100
        page += 1
        if len(batch) < 100:
            break
    return out


def books(token_ids):
    """Batch order books: [{asset_id, bids:[{price,size}], asks:[...]}]"""
    out = {}
    for i in range(0, len(token_ids), 100):
        chunk = token_ids[i:i + 100]
        try:
            for b in post(f"{CLOB}/books", [{"token_id": t} for t in chunk]):
                out[b["asset_id"]] = b
        except Exception as e:
            print(f"  books chunk failed: {e}")
    return out


def top(side, kind):
    """Best bid (highest) or best ask (lowest) from a raw book."""
    if not side:
        return None
    prices = [(float(l["price"]), float(l["size"])) for l in side]
    return max(prices) if kind == "bid" else min(prices)


def scan(args):
    markets = fetch_markets(args.min_liquidity)
    print(f"markets with liquidity >= ${args.min_liquidity:,.0f}: {len(markets)}")
    ids = [t for m in markets for t in m["tokens"]]
    bk = books(ids)
    print(f"books fetched: {len(bk)} / {len(ids)}")

    rows = []
    for m in markets:
        yes, no = (bk.get(t) for t in m["tokens"])
        if not yes or not no:
            continue
        ask_y, ask_n = top(yes.get("asks"), "ask"), top(no.get("asks"), "ask")
        bid_y, bid_n = top(yes.get("bids"), "bid"), top(no.get("bids"), "bid")
        buy_edge = 1.0 - (ask_y[0] + ask_n[0]) if ask_y and ask_n else None
        sell_edge = (bid_y[0] + bid_n[0]) - 1.0 if bid_y and bid_n else None
        size = min(ask_y[1], ask_n[1]) if ask_y and ask_n else 0
        rows.append({
            "q": m["question"], "slug": m["slug"], "end": m["end"],
            "askY": ask_y[0] if ask_y else None, "askN": ask_n[0] if ask_n else None,
            "buy_edge_bps": round(buy_edge * 1e4, 1) if buy_edge is not None else None,
            "size_usd": round(size, 1),
            "sell_edge_bps": round(sell_edge * 1e4, 1) if sell_edge is not None else None,
            "liquidity": round(m["liquidity"]),
        })

    buys = [r for r in rows if (r["buy_edge_bps"] or -1) >= args.min_edge]
    buys.sort(key=lambda r: -(r["buy_edge_bps"] or 0))
    sells = [r for r in rows if (r["sell_edge_bps"] or -1) >= args.min_edge]
    sells.sort(key=lambda r: -(r["sell_edge_bps"] or 0))

    print(f"\nBUY BOTH SIDES (ask YES + ask NO < 1): {len(buys)} market(s) above {args.min_edge} bps")
    for r in buys[: args.top]:
        print(f"  {r['buy_edge_bps']:>6.1f} bps | ${r['size_usd']:>8,.0f} at touch | liq ${r['liquidity']:>8,} | {r['q'][:70]}")
    print(f"\nSELL BOTH SIDES (bid YES + bid NO > 1): {len(sells)} market(s) above {args.min_edge} bps")
    for r in sells[: args.top]:
        print(f"  {r['sell_edge_bps']:>6.1f} bps | liq ${r['liquidity']:>8,} | {r['q'][:70]}")

    with open("data/poly-scan.json", "w") as f:
        json.dump({"at": __import__("time").time(), "markets": len(markets), "rows": rows}, f)
    print("\nfull result: data/poly-scan.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-liquidity", type=float, default=5000)
    ap.add_argument("--min-edge", type=float, default=0.5, help="bps")
    ap.add_argument("--top", type=int, default=20)
    scan(ap.parse_args())
