import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Typed decision journal. One row per impulse (one block we considered acting on)
 * plus one row per transition, so a decision carries its whole path: scan ->
 * reflex -> jev -> risk -> exec -> fill/exit.
 *
 * Why SQLite and not another jsonl: the intent table is the idempotency ledger.
 * A send is recorded BEFORE the chain is asked, keyed by impulse id, and
 * reconciled afterwards by nonce. A process that restarts can therefore tell a
 * transaction it never confirmed from one it never sent. `events.jsonl` stays
 * the human-readable stream; this is the audit trail the recovery path reads.
 */

export type Node = "scan" | "reflex" | "jev" | "risk" | "exec" | "fill" | "exit";
export type Verdict = "pass" | "reject" | "hold" | "execute" | "fill" | "reverted" | "unknown";

export interface Transition {
  node: Node;
  verdict: Verdict;
  note: string;
  ts: number;
}

export interface Intent {
  side: "buy" | "sell";
  sizeMon: number;
  price: number;
  txHash: string | null;
  nonce: number | null;
  /** The Kuru order id once the receipt landed: what the recovery path compares against the chain. */
  orderId?: number | null;
  /**
   * sent = handed to the RPC, placed = order id on the book, partial/filled = a taker
   * took it (partially or fully), closed = it left the book while we were down,
   * reverted = gas spent, unknown = no receipt, sim = dry run.
   */
  status: "sent" | "placed" | "partial" | "filled" | "closed" | "reverted" | "unknown" | "sim" | "lost";
}

export interface Impulse {
  id: string;
  block: number;
  ts: number;
  /** Deterministic facts the score and the reflexes read. No model output here. */
  facts: Record<string, number | string | boolean | null>;
  score: number;
  jev?: { action: string; pBuy: number; pSell: number; latencyMs: number; usd: number; late?: boolean } | null;
  /** Name of the reflex that stopped this impulse, null when none fired. */
  reflex?: string | null;
  intent?: Intent | null;
  status: Verdict;
  history: Transition[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS impulse (
  id TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  score INTEGER NOT NULL,
  reflex TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS impulse_block ON impulse(block DESC);
CREATE TABLE IF NOT EXISTS transition (
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  node TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (id, seq)
);
CREATE TABLE IF NOT EXISTS intent (
  id TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  side TEXT NOT NULL,
  size_mon REAL NOT NULL,
  price REAL NOT NULL,
  tx_hash TEXT,
  nonce INTEGER,
  order_id INTEGER,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS intent_open ON intent(status);
`;

export class Store {
  private db: Database;

  constructor(path = process.env.DECISIONS_DB ?? "data/decisions.db") {
    mkdirSync(dirname(path) || ".", { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(SCHEMA);
    // Additive migration: a journal opened before order_id existed keeps working.
    try { this.db.exec("ALTER TABLE intent ADD COLUMN order_id INTEGER"); } catch {}
  }

  /** Full row write. Idempotent by impulse id: a replay lands on the same row. */
  save(i: Impulse) {
    this.db.run(
      "INSERT OR REPLACE INTO impulse(id, block, ts, status, score, reflex, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [i.id, i.block, i.ts, i.status, i.score, i.reflex ?? null, JSON.stringify(i)],
    );
  }

  /** Append one transition to the impulse and persist both rows. */
  advance(i: Impulse, node: Node, verdict: Verdict, note = ""): Impulse {
    const t: Transition = { node, verdict, note, ts: Date.now() };
    i.history.push(t);
    i.status = verdict;
    this.db.run("INSERT OR REPLACE INTO transition(id, seq, node, verdict, note, ts) VALUES (?, ?, ?, ?, ?, ?)", [
      i.id, i.history.length - 1, node, verdict, note, t.ts,
    ]);
    this.save(i);
    return i;
  }

  /** Record the send BEFORE the RPC call: a crash in between leaves a row we can reconcile. */
  openIntent(i: Impulse, intent: Intent) {
    i.intent = intent;
    this.db.run(
      "INSERT OR REPLACE INTO intent(id, block, side, size_mon, price, tx_hash, nonce, order_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [i.id, i.block, intent.side, intent.sizeMon, intent.price, intent.txHash, intent.nonce, intent.orderId ?? null, intent.status, Date.now()],
    );
    this.save(i);
  }

  updateIntent(id: string, patch: Partial<Intent>) {
    const row = this.db.query<{ side: string; size_mon: number; price: number; tx_hash: string | null; nonce: number | null; order_id: number | null; status: string }, [string]>(
      "SELECT side, size_mon, price, tx_hash, nonce, order_id, status FROM intent WHERE id = ?",
    ).get(id);
    if (!row) return;
    const next = {
      side: (patch.side ?? row.side) as Intent["side"],
      sizeMon: patch.sizeMon ?? row.size_mon,
      price: patch.price ?? row.price,
      txHash: patch.txHash ?? row.tx_hash,
      nonce: patch.nonce ?? row.nonce,
      orderId: patch.orderId ?? row.order_id,
      status: (patch.status ?? row.status) as Intent["status"],
    };
    this.db.run("UPDATE intent SET side = ?, size_mon = ?, price = ?, tx_hash = ?, nonce = ?, order_id = ?, status = ?, updated_at = ? WHERE id = ?", [
      next.side, next.sizeMon, next.price, next.txHash, next.nonce, next.orderId, next.status, Date.now(), id,
    ]);
    const i = this.impulse(id);
    if (i) { i.intent = next; this.save(i); }
  }

  /** Orders we believe are resting on the book: what the boot recovery compares against the chain. */
  placedIntents() {
    return this.db.query<{ id: string; block: number; side: string; size_mon: number; price: number; order_id: number | null; status: string }, []>(
      "SELECT id, block, side, size_mon, price, order_id, status FROM intent WHERE status IN ('placed', 'partial') AND order_id IS NOT NULL ORDER BY block DESC",
    ).all();
  }

  intent(id: string) {
    return this.db.query<{ id: string; block: number; side: string; size_mon: number; price: number; tx_hash: string | null; nonce: number | null; status: string; updated_at: number }, [string]>(
      "SELECT * FROM intent WHERE id = ?",
    ).get(id) ?? null;
  }

  /** Sends whose fate is still unresolved: the recovery path reconciles exactly these. */
  openIntents() {
    return this.db.query<{ id: string; block: number; side: string; size_mon: number; price: number; tx_hash: string | null; nonce: number | null; status: string; updated_at: number }, []>(
      "SELECT * FROM intent WHERE status IN ('sent', 'unknown') ORDER BY block DESC",
    ).all();
  }

  impulse(id: string): Impulse | null {
    const row = this.db.query<{ payload: string }, [string]>("SELECT payload FROM impulse WHERE id = ?").get(id);
    return row ? (JSON.parse(row.payload) as Impulse) : null;
  }

  recent(limit = 50): Impulse[] {
    return this.db.query<{ payload: string }, [number]>("SELECT payload FROM impulse ORDER BY block DESC LIMIT ?").all(limit)
      .map((r) => JSON.parse(r.payload) as Impulse);
  }

  /** Counter map of the reflex that stopped each impulse, newest window first. */
  reflexCounts(limit = 2000): Record<string, number> {
    const rows = this.db.query<{ reflex: string | null; n: number }, [number]>(
      "SELECT reflex, COUNT(*) AS n FROM (SELECT reflex FROM impulse ORDER BY block DESC LIMIT ?) WHERE reflex IS NOT NULL GROUP BY reflex",
    ).all(limit);
    return Object.fromEntries(rows.map((r) => [r.reflex!, r.n]));
  }

  counts() {
    const impulse = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM impulse").get()?.n ?? 0;
    const transitions = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM transition").get()?.n ?? 0;
    const open = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM intent WHERE status IN ('sent', 'unknown')").get()?.n ?? 0;
    return { impulse, transitions, openIntents: open };
  }

  close() { this.db.close(); }
}
