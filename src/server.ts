import { config } from "./config";
import { backfillCoverage } from "./coverage";
import { dashboardHtml } from "./dashboard";
import type { Fill, Quote } from "./market";
import type { ScorePart } from "./score";
import type { Impulse } from "./store";
import type { BlockEvent } from "./trader";

interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number }

/**
 * What the console and the journal endpoint read from the trader, passed as
 * closures so the server never keeps its own copy of the bot's state.
 */
export interface JournalView {
  recent: (n: number) => Impulse[];
  counts: () => { impulse: number; transitions: number; openIntents: number };
  reflexHits: () => Record<string, number>;
  score: () => number;
  scoreParts: () => ScorePart[];
  unresolved: () => number;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * GET / snapshot (JSON, unchanged so existing consumers keep working)
 * GET /history recent blocks
 * GET /events SSE stream (`snapshot`, `block`, `quote`, `fill`, `ping`)
 * GET /dashboard operator console
 * GET /api/journal decision journal, reflex counters, score breakdown, data coverage
 */
export function startServer(meta: Meta, history: () => BlockEvent[], journal: JournalView) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  Bun.serve({
    port: config.port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/") return json({ ...meta, latest: history().at(-1) ?? null });
      if (pathname === "/history") return json(history());
      if (pathname === "/dashboard" || pathname === "/dashboard/") return html(dashboardHtml());
      if (pathname === "/api/journal") {
        return json({
          model: meta.model,
          dryRun: meta.dryRun,
          openIntents: journal.counts().openIntents,
          impulses: journal.recent(200),
          counts: journal.counts(),
          reflexHits: journal.reflexHits(),
          score: journal.score(),
          scoreParts: journal.scoreParts(),
          unresolved: journal.unresolved(),
          coverage: backfillCoverage(),
        });
      }
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, history: history() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcast: (e: BlockEvent) => broadcast("block", e),
    /** A quote's receipt landed: placed (with order id) or reverted, and the real gas. */
    broadcastQuote: (block: number, quote: Quote) => broadcast("quote", { block, quote }),
    /** A taker hit one of our resting orders in `block`. */
    broadcastFill: (block: number, fill: Fill) => broadcast("fill", { block, fill }),
  };
}
