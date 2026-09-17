#!/usr/bin/env python3
"""Backfill Kuru MON-USDC order-flow events from Monad RPC.

Fetches eth_getLogs for the market contract in 100-block chunks (the public RPC
caps responses ~that size), 4 parallel workers, resumable (skips segments whose
output file already exists). Output: one gzipped JSONL per ~1-day block segment
under data/history/raw/, plus a small meta sidecar with segment timestamps.

Usage:
  python3 scripts/backfill-logs.py --days 30          # last ~30 days
  python3 scripts/backfill-logs.py --from-block 100000000 --to-block 100500000
"""
import argparse, gzip, json, os, shutil, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

RPC = "https://rpc.monad.xyz"
MKT = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394"
ROOT = os.path.expanduser("~/Documents/Github/jev-trader")
OUT_DIR = os.path.join(ROOT, "data", "history", "raw")
BLOCKS_PER_SEG = 286_105  # ~1 day at current rate
CHUNK = 100
WORKERS = 4

def rpc(method, params, t=40):
    req = urllib.request.Request(
        RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=t))
    except Exception as e:
        return {"error": {"message": str(e)}}

def fetch_chunk(ch):
    """Fetch logs [a,b]; on 413 split in two, retries with backoff."""
    a, b = ch
    for attempt in range(4):
        r = rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(b), "address": MKT}])
        if "result" in r:
            return a, r["result"]
        msg = str(r.get("error", {}))
        if "413" in msg and b > a:
            mid = (a + b) // 2
            r1 = rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(mid), "address": MKT}])
            r2 = rpc("eth_getLogs", [{"fromBlock": hex(mid + 1), "toBlock": hex(b), "address": MKT}])
            if "result" in r1 and "result" in r2:
                return a, r1["result"] + r2["result"]
        time.sleep(0.6 * (attempt + 1))
    return a, None

def seg_path(s):
    return os.path.join(OUT_DIR, f"seg_{s}.jsonl.gz")

def meta_path(s):
    return os.path.join(OUT_DIR, f"seg_{s}.meta.json")

def do_segment(s, e, workers, keep_cancel_from=None):
    """Fetch [s, e) into seg_s.jsonl.gz. Returns (logs, errors)."""
    path = seg_path(s)
    chunks = [(b, min(b + CHUNK - 1, e - 1)) for b in range(s, e, CHUNK)]
    logs_n = 0; errors = 0
    gz = gzip.open(path, "wb", compresslevel=6)
    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for a, logs in ex.map(fetch_chunk, chunks):
                if logs is None:
                    errors += 1
                    continue
                logs_n += len(logs)
                for l in logs:
                    if (keep_cancel_from is not None
                            and int(l["blockNumber"], 16) < keep_cancel_from
                            and l.get("topics") and l["topics"][0].startswith("0x386974f41b")):
                        continue  # old-era cancellations dropped (re-downloadable)
                    gz.write((json.dumps({
                        "bn": int(l["blockNumber"], 16),
                        "tx": l.get("transactionHash"),
                        "li": l.get("logIndex"),
                        "t": l.get("topics"),
                        "d": l.get("data"),
                    }) + "\n").encode())
    finally:
        gz.close()
    # meta sidecar: segment boundary timestamps (best effort)
    meta = {"seg_start": s, "seg_end": e, "logs": logs_n, "errors": errors, "fetched_at": int(time.time())}
    for key, blk in (("t_start", s), ("t_end", e - 1)):
        r = rpc("eth_getBlockByNumber", [hex(blk), False], t=20)
        if "result" in r:
            meta[key] = int(r["result"]["timestamp"], 16)
    with open(os.path.join(OUT_DIR, f"seg_{s}.meta.json"), "w") as fh:
        json.dump(meta, fh)
    return logs_n, errors

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-block", type=int)
    ap.add_argument("--to-block", type=int)
    ap.add_argument("--days", type=int)
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument("--blocks-per-day", type=int, default=BLOCKS_PER_SEG)
    ap.add_argument("--keep-cancel-from-block", type=int, default=None,
                    help="drop OrdersCanceled events below this block (old eras)")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    r = rpc("eth_blockNumber", [])
    bn = int(r["result"], 16)
    if args.from_block is not None:
        start = args.from_block
    elif args.days:
        start = bn - args.days * args.blocks_per_day
    else:
        start = bn - BLOCKS_PER_SEG
    end = args.to_block if args.to_block is not None else bn
    start = max(1, start)
    print(f"[backfill] blocs {start:,} → {end:,} ({(end-start)/1e6:.1f}M blocs)", flush=True)

    segs = list(range(start, end, BLOCKS_PER_SEG))
    t0 = time.time(); total = 0; done = 0
    for s in segs:
        if shutil.disk_usage(OUT_DIR).free < 1.5e9:
            print("STOP: espace disque faible (<1.5 GB libres) - relancer plus tard, resumable", flush=True)
            break
        e = min(s + BLOCKS_PER_SEG, end)
        if os.path.exists(meta_path(s)) and os.path.exists(seg_path(s)) and os.path.getsize(seg_path(s)) > 0:
            print(f"  seg {s:,}: déjà présent (meta ok), skip", flush=True)
            done += 1
            continue
        n, errs = do_segment(s, e, args.workers, keep_cancel_from=args.keep_cancel_from_block)
        total += n
        done += 1
        el = time.time() - t0
        print(f"  seg {s:,} → {e:,}: {n} logs ({errs} err) | total {total:,} | {el:.0f}s", flush=True)
    print(f"[backfill] terminé : {total:,} logs, {done} segments, {time.time()-t0:.0f}s", flush=True)

if __name__ == "__main__":
    main()
