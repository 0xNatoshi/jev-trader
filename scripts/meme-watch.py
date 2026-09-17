#!/usr/bin/env python3
"""Real-time memecoin watcher: catch a launch in the seconds after it opens.

Deterministic only -- no LLM, no tokens burned. It polls the explorer's new-pool feed
every few seconds, scores each pool with the same rules as `meme-scan.py`, and writes an
alert the moment one clears the bar. A one-minute Hermes cron reads the alerts and pushes
them to Telegram, so the notification is decoupled from the polling loop.

Why polling and not an on-chain subscription: GeckoTerminal's public feed needs no key and
no node, and a new pool shows up within seconds. If we need faster than that later, the
next step is a Solana log subscription on the pool program, not a bigger poll rate.

Alerts land in data/meme-alerts.jsonl (one line each, deduplicated by pool).
"""
import json
import os
import time
import urllib.request

API = "https://api.geckoterminal.com/api/v2"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
ALERTS = "data/meme-alerts.jsonl"
SEEN = "data/meme-seen.json"

NETWORKS = [n.strip() for n in os.environ.get("MEME_NETWORKS", "solana,base").split(",") if n.strip()]
POLL_SECONDS = float(os.environ.get("MEME_POLL_SECONDS", "20"))
MIN_SCORE = float(os.environ.get("MEME_MIN_SCORE", "70"))
MIN_LIQUIDITY = float(os.environ.get("MEME_MIN_LIQUIDITY", "10000"))
MAX_AGE_MIN = float(os.environ.get("MEME_MAX_AGE_MIN", "20"))


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def score(p):
    """Same deterministic rules as meme-scan.py (kept in sync by hand: one place only)."""
    s = 50.0
    liq, vol1h, age = num(p["liquidity"]), num(p["vol1h"]), num(p["age_min"])
    buyers, buys, sells = num(p["buyers1h"]), num(p["buys1h"]), num(p["sells1h"])
    fdv, chg = num(p["fdv"]), num(p["chg1h"])
    s += 25 if liq >= 50_000 else 15 if liq >= 20_000 else 5 if liq >= 5_000 else -30
    s += 10 if age >= 60 else 0 if age >= 15 else -15
    s += 12 if buyers >= 100 else 6 if buyers >= 30 else -12 if buyers < 5 else 0
    if sells > 0:
        r = buys / (buys + sells)
        s += 8 if 0.35 <= r <= 0.65 else -12 if r >= 0.9 else -4
    else:
        s -= 12
    if liq > 0:
        r = vol1h / liq
        s += 6 if 0.2 <= r <= 3 else -10 if r > 10 else 0
        s += 6 if fdv <= 20 * liq else -12 if fdv > 100 * liq else 0
    s += -10 if chg > 200 else 4 if -30 <= chg <= 30 else 0
    return max(0.0, min(100.0, s))


def fetch(net):
    """First page of new pools for one network."""
    d = get(f"{API}/networks/{net}/new_pools?page=1")
    out = []
    for row in d.get("data") or []:
        a = row.get("attributes") or {}
        created = a.get("pool_created_at") or ""
        age = 1e9
        if created:
            try:
                import datetime as dt
                age = (time.time() - dt.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()) / 60
            except Exception:
                pass
        vol, tx, ch = a.get("volume_usd") or {}, a.get("transactions") or {}, a.get("price_change_percentage") or {}
        h1 = tx.get("h1") or {}
        out.append({
            "pool": a.get("address"), "net": net, "name": a.get("name"), "created": created,
            "age_min": round(age, 1), "liquidity": num(a.get("reserve_in_usd")), "fdv": num(a.get("fdv_usd")),
            "vol5m": num(vol.get("m5")), "vol1h": num(vol.get("h1")),
            "buys1h": num(h1.get("buys")), "sells1h": num(h1.get("sells")),
            "buyers1h": num(h1.get("buyers")), "sellers1h": num(h1.get("sellers")),
            "chg1h": num(ch.get("h1")), "price": num(a.get("base_token_price_usd")),
        })
    return out


def load_seen():
    if os.path.exists(SEEN):
        try:
            return json.load(open(SEEN))
        except Exception:
            return {}
    return {}


def main():
    os.makedirs("data", exist_ok=True)
    seen = load_seen()
    backoff: dict[str, float] = {}
    print(f"watching {','.join(NETWORKS)} every {POLL_SECONDS:.0f}s | bar: score >= {MIN_SCORE:.0f}, "
          f"liq >= ${MIN_LIQUIDITY:,.0f}, age <= {MAX_AGE_MIN:.0f} min", flush=True)
    while True:
        started = time.time()
        for net in NETWORKS:
            if backoff.get(net, 0) > time.time():
                continue
            try:
                pools = fetch(net)
            except Exception as e:
                # The public tier is ~30 req/min and shared with whatever else is running:
                # on a 429, stand down for a minute instead of hammering it.
                if "429" in str(e):
                    backoff[net] = time.time() + 60
                print(f"  {net}: {e}", flush=True)
                time.sleep(5)
                continue
            for p in pools:
                if not p["pool"] or p["pool"] in seen:
                    continue
                seen[p["pool"]] = time.time()
                p["score"] = round(score(p), 1)
                if p["score"] >= MIN_SCORE and p["liquidity"] >= MIN_LIQUIDITY and p["age_min"] <= MAX_AGE_MIN:
                    line = (f"PEPITE {p['name']} | score {p['score']:.0f} | ${p['liquidity']:,.0f} liq | "
                            f"{p['buyers1h']:.0f} acheteurs / {p['age_min']:.0f} min | {p['chg1h']:+.0f}% 1h | "
                            f"{p['net']} {p['pool']}")
                    with open(ALERTS, "a") as f:
                        f.write(line + "\n")
                    print("  ALERT " + line, flush=True)
            time.sleep(2)  # courtesy delay: the public tier is ~30 req/min
        # keep the seen file from growing forever (a week of pools)
        cut = time.time() - 7 * 86400
        seen = {k: v for k, v in seen.items() if v >= cut}
        json.dump(seen, open(SEEN, "w"))
        time.sleep(max(0.0, POLL_SECONDS - (time.time() - started)))


if __name__ == "__main__":
    main()
