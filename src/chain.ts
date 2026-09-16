import { config } from "./config";

/** Raw JSON-RPC call over HTTP. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message} (${json.error.code})`);
  return json.result as T;
}

/**
 * Emits each new block number exactly once.
 * Primary: WebSocket newHeads (fires when a block is Proposed).
 * Backstop: HTTP polling, so the loop keeps running if the socket drops or is unavailable.
 */
export function startBlockFeed(onBlock: (block: number) => void, pollMs = 150) {
  let last = 0;
  const emit = (block: number) => {
    if (block <= last) return;
    last = block;
    onBlock(block);
  };

  const poll = async () => {
    try { emit(parseInt(await rpc<string>("eth_blockNumber"), 16)); } catch {}
  };
  setInterval(poll, pollMs);
  poll();

  if (!config.wsUrl) return;
  const connect = (delay = 0) =>
    setTimeout(() => {
      const ws = new WebSocket(config.wsUrl!);
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.method === "eth_subscription") emit(parseInt(m.params.result.number, 16));
      };
      ws.onclose = () => connect(Math.min(delay + 1000, 10_000));
      ws.onerror = () => ws.close();
    }, delay);
  connect();
}
