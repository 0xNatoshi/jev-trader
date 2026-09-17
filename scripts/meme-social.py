#!/usr/bin/env python3
"""Social read on a fresh memecoin: does the buzz look real, and what is the odds of a pump?

Two inputs the pool metrics cannot see:
  1. X, via xread (the vendor-agnostic local reader; no API keys, nothing official).
  2. An LLM (DeepSeek through the opencode Go subscription) to read the chatter and
     answer one question with a number, not a story.

The LLM is the right tool for exactly one job here: judging whether the chatter around a
ticker is organic (many distinct accounts, specifics, screenshots of real trades) or a
shill farm (copy-pasted, link-spam, wallet bots). It is NOT asked to predict price, and
its score is logged next to the pool metrics so we can later check whether it adds
anything at all.

Usage: python3 scripts/meme-social.py --top 5 [--minutes 120]
"""
import argparse
import json
import os
import re
import subprocess
import time
import urllib.request

XREAD = "/Users/thibaultsj/.local/bin/xread"
SNAP = "data/meme-snapshots.jsonl"
OUT = "data/meme-social.jsonl"
KEY_ENV = os.path.expanduser("~/.hermes/.env")
MODEL = "deepseek-v4.1-flash"
API = "https://opencode.ai/zen/go/v1/chat/completions"


def api_key():
    with open(KEY_ENV) as f:
        for line in f:
            if line.startswith("OPENCODE_GO_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def fresh_pools(minutes):
    if not os.path.exists(SNAP):
        return []
    latest = {}
    for line in open(SNAP):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if time.time() - r["ts"] > 3600:
            continue
        latest[r["pool"]] = r
    rows = [r for r in latest.values() if r.get("age_min", 1e9) <= minutes]
    rows.sort(key=lambda r: -r.get("score", 0))
    return rows


def symbol(name):
    return (name or "?").split("/")[0].strip()[:20]


def xchatter(sym, limit=15):
    """Recent posts mentioning the ticker, via xread (read-only)."""
    q = f'"{sym}" memecoin OR solana OR pump'
    try:
        p = subprocess.run([XREAD, "search", q, "--limit", str(limit), "--no-cache"],
                           capture_output=True, text=True, timeout=90)
        rows = []
        for line in p.stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            rows.append({
                "likes": d.get("likeCount") or 0,
                "author": d.get("author") or d.get("authorName") or "?",
                "followers": d.get("authorFollowersCount") or 0,
                "text": re.sub(r"\s+", " ", (d.get("text") or ""))[:220],
            })
        rows.sort(key=lambda r: -r["likes"])
        return rows[:limit]
    except Exception as e:
        print(f"  xread failed: {e}")
        return []


PROMPT = """You judge whether a brand-new memecoin's social buzz is real, for a trader deciding whether to buy in the next few minutes.

You get: pool metrics, and recent X posts mentioning the ticker.

Answer with ONE JSON object, nothing else:
{"score": <0-100 chance this is a real, organic launch that can run>, "shill": <0-100 share of the chatter that looks paid/bot>, "why": "<max 20 words>"}

Judge only what you can see: distinct accounts vs copy-paste, specifics vs slogans, link spam, engagement/follower ratio, whether the ticker is being talked about by strangers or by its own creators. Most new tokens are rugs: a high score must be earned."""


def ask_llm(key, pool, posts):
    ctx = (
        f"Token: {pool['name']} | age {pool['age_min']:.0f} min | liquidity ${pool['liquidity']:,.0f} | "
        f"1h volume ${pool['vol1h']:,.0f} | buyers/sellers 1h {pool['buyers1h']:.0f}/{pool['sellers1h']:.0f} | "
        f"1h price change {pool['chg1h']:.1f}%\n\nRecent X posts (likes | author | followers | text):\n"
    )
    for p in posts[:12]:
        ctx += f"- {p['likes']} | @{p['author']} | {p['followers']} | {p['text']}\n"
    body = {"model": MODEL, "max_tokens": 300, "temperature": 0,
            "messages": [{"role": "system", "content": PROMPT}, {"role": "user", "content": ctx}]}
    req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {key}", "content-type": "application/json",
                                          "x-opencode-session": "meme-scan",
                                          "accept": "application/json",
                                          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    txt = d["choices"][0]["message"].get("content") or ""
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--minutes", type=float, default=60)
    # Hard gate: the LLM is never run on the stream, only on the rare candidates that a
    # deterministic filter already liked. Everything else is decided without tokens.
    ap.add_argument("--min-score", type=float, default=65.0)
    ap.add_argument("--min-liquidity", type=float, default=20_000.0)
    args = ap.parse_args()

    key = api_key()
    if not key:
        print("no OPENCODE_GO_API_KEY in ~/.hermes/.env")
        return
    pools = [p for p in fresh_pools(args.minutes)
             if p.get("score", 0) >= args.min_score and p.get("liquidity", 0) >= args.min_liquidity]
    pools = pools[: args.top]
    if not pools:
        # Normal outcome, most of the time: nothing deserves an LLM call.
        return

    os.makedirs("data", exist_ok=True)
    with open(OUT, "a") as out:
        for p in pools:
            sym = symbol(p["name"])
            posts = xchatter(sym)
            verdict = ask_llm(key, p, posts) if posts else None
            rec = {"ts": time.time(), "pool": p["pool"], "sym": sym, "poolScore": p["score"],
                   "posts": len(posts), "social": verdict}
            out.write(json.dumps(rec) + "\n")
            if verdict:
                print(f"  {sym:<10} pool {p['score']:>5.1f} | social {verdict.get('score')} | shill {verdict.get('shill')} | {verdict.get('why')}")
            else:
                print(f"  {sym:<10} pool {p['score']:>5.1f} | no chatter found ({len(posts)} posts)")

    print(f"\nlogged -> {OUT}")


if __name__ == "__main__":
    main()
