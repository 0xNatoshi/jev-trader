import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Backfill coverage of the Kuru event history, read from the resumable
 * downloader's segment meta files. This is the "how much data do we actually
 * hold" number the dashboard shows; it is a filesystem read, so it is cached.
 */

export interface Coverage {
  segments: number;
  blocks: number;
  target: number;
  pct: number;
  events: number;
  bytes: number;
  errors: number;
  firstBlock: number | null;
  lastBlock: number | null;
}

const DIR = process.env.HISTORY_DIR ?? "data/history/raw";
const TARGET = Number(process.env.HISTORY_TARGET_BLOCKS ?? "61682320"); // 43,950,000 to 105,632,320
const TTL_MS = 30_000;
let cache: { at: number; value: Coverage } | null = null;

export function backfillCoverage(): Coverage {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let segments = 0, blocks = 0, events = 0, bytes = 0, errors = 0;
  let first: number | null = null, last: number | null = null;
  let names: string[] = [];
  try { names = readdirSync(DIR); } catch { /* not downloaded yet */ }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(DIR, name), "utf8")) as { seg_start: number; seg_end: number; logs?: number; errors?: number };
      segments++;
      blocks += Math.max(0, m.seg_end - m.seg_start);
      events += m.logs ?? 0;
      errors += m.errors ?? 0;
      first = first === null ? m.seg_start : Math.min(first, m.seg_start);
      last = last === null ? m.seg_end : Math.max(last, m.seg_end);
    } catch { /* a half written meta is retried on the next scan */ }
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl.gz")) continue;
    try { bytes += statSync(join(DIR, name)).size; } catch { /* ignore */ }
  }
  const value: Coverage = {
    segments, blocks, target: TARGET, pct: TARGET ? Math.min(100, (blocks / TARGET) * 100) : 0,
    events, bytes, errors, firstBlock: first, lastBlock: last,
  };
  cache = { at: Date.now(), value };
  return value;
}
