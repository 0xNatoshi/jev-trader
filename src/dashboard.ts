/**
 * Operator dashboard, one self contained page served by the bot itself: no build
 * step, no second stack, no new dependency. Three columns, same idea as the
 * YOGORASIGHT style consoles the labs circulate (dense, dark, uppercase labels,
 * monospace numbers) but wired to OUR facts: the deterministic score, the
 * reflexes, the Jev verdict, the position with its TP/SL, the send ledger and
 * the data pipeline.
 *
 * Live data comes from the SSE stream the bot already broadcasts (/events) plus
 * /api/journal for the decision journal.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>jev-trader | lab console</title>
<style>
  :root {
    --bg: #07080a; --panel: #0d0f13; --panel2: #12151b; --line: #1e232c;
    --txt: #d7dee8; --dim: #7c8798; --up: #35d07f; --down: #ff5d6c; --warn: #ffbf47; --accent: #5aa9ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--txt); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 13px; margin: 0; letter-spacing: 0.14em; text-transform: uppercase; }
  .tag { padding: 1px 6px; border: 1px solid var(--line); border-radius: 3px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
  .tag.live { color: var(--up); border-color: #1d3b2b; background: #0d1a14; }
  .tag.dry { color: var(--warn); border-color: #3b331d; background: #1a170d; }
  main { display: grid; grid-template-columns: 300px minmax(420px, 1fr) 360px; gap: 10px; padding: 10px; align-items: start; }
  @media (max-width: 1150px) { main { grid-template-columns: 1fr; } }
  .col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  .card > h2 { margin: 0; padding: 7px 10px; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
  .card > div { padding: 8px 10px; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; }
  .kv span:nth-child(odd) { color: var(--dim); }
  .kv span:nth-child(even) { text-align: right; }
  .big { font-size: 20px; text-align: right; }
  .up { color: var(--up); } .down { color: var(--down); } .warn { color: var(--warn); } .acc { color: var(--accent); } .dim { color: var(--dim); }
  .bar { height: 6px; background: var(--panel2); border-radius: 3px; overflow: hidden; margin-top: 6px; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th { color: var(--dim); font-weight: 400; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
  tr.row { cursor: pointer; }
  tr.row:hover td { background: var(--panel2); }
  tr.sel td { background: #16202b; }
  .feed { max-height: 46vh; overflow: auto; }
  .pill { display: inline-block; padding: 0 5px; border-radius: 3px; border: 1px solid var(--line); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  .pill.reject { color: var(--down); border-color: #3d1f24; background: #180d10; }
  .pill.hold { color: var(--warn); border-color: #3d3320; background: #17130b; }
  .pill.execute { color: var(--up); border-color: #1d3b2b; background: #0d1a14; }
  .pill.unknown { color: var(--accent); border-color: #1d2c3d; background: #0b1219; }
  .trail { color: var(--dim); }
  .facts { display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; }
  .facts span:nth-child(odd) { color: var(--dim); }
  .facts span:nth-child(even) { text-align: right; }
  footer { padding: 8px 14px; color: var(--dim); border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header>
  <h1>jev-trader / lab console</h1>
  <span class="tag" id="mode">mode</span>
  <span class="tag" id="model">model</span>
  <span class="tag" id="market">market</span>
  <span class="tag" id="reflex">reflex</span>
  <span class="tag" id="scoretag">score</span>
  <span class="dim" id="clock" style="margin-left:auto"></span>
</header>
<main>
  <div class="col">
    <div class="card"><h2>System<span class="dim" id="uptime"></span></h2><div>
      <div class="kv" id="sys"></div>
    </div></div>
    <div class="card"><h2>Reflexes<span class="dim">deterministic, before the model</span></h2><div>
      <table><thead><tr><th>reflex</th><th style="text-align:right">hits</th><th>state</th></tr></thead><tbody id="reflexes"></tbody></table>
    </div></div>
    <div class="card"><h2>Data pipeline<span class="dim" id="covpct"></span></h2><div>
      <div class="kv" id="cov"></div>
      <div class="bar"><i id="covbar" style="width:0%"></i></div>
    </div></div>
  </div>

  <div class="col">
    <div class="card"><h2>Decision feed<span class="dim" id="feedcount"></span></h2><div class="feed">
      <table><thead><tr><th>block</th><th>score</th><th>jev</th><th>p(buy)</th><th>outcome</th><th>path</th></tr></thead><tbody id="feed"></tbody></table>
    </div></div>
    <div class="card"><h2>Impulse detail<span class="dim">click a row</span></h2><div>
      <div class="facts" id="detail"><span class="dim">nothing selected</span></div>
    </div></div>
  </div>

  <div class="col">
    <div class="card"><h2>Position<span class="dim" id="posside"></span></h2><div>
      <div class="kv" id="pos"></div>
    </div></div>
    <div class="card"><h2>Maker edge<span class="dim" id="mmn"></span></h2><div>
      <div class="kv" id="mm"></div>
    </div></div>
    <div class="card"><h2>Score<span class="dim">deterministic 0 to 100</span></h2><div>
      <div class="kv" id="scorebody"></div>
    </div></div>
    <div class="card"><h2>Totals</h2><div>
      <div class="kv" id="totals"></div>
    </div></div>
  </div>
</main>
<footer id="foot">waiting for the first block</footer>
<script>
  var J = { impulses: [], counts: {}, reflexHits: {}, unresolved: 0, coverage: null };
  var state = null, selected = null;

  function num(x, d) { if (x === null || x === undefined || isNaN(x)) return '-'; return Number(x).toFixed(d === undefined ? 2 : d); }
  function money(x) { if (x === null || x === undefined) return '-'; return (x >= 0 ? '+' : '') + Number(x).toFixed(4); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }); }
  function kv(pairs) { return pairs.map(function (p) { return '<span>' + p[0] + '</span><span class="' + (p[2] || '') + '">' + p[1] + '</span>'; }).join(''); }
  function dur(ms) { var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h + 'h ' + m + 'm'; }

  function renderHeader() {
    if (!state) return;
    var m = J.model || {};
    document.getElementById('mode').textContent = state.meta.dryRun ? 'dry run' : 'live';
    document.getElementById('mode').className = 'tag ' + (state.meta.dryRun ? 'dry' : 'live');
    document.getElementById('model').textContent = state.meta.model;
    document.getElementById('market').textContent = state.meta.market.slice(0, 10) + '...';
    var r = state.latest && state.latest.reflex ? state.latest.reflex : null;
    document.getElementById('reflex').textContent = r ? 'last reflex: ' + r : 'no reflex fired';
    document.getElementById('scoretag').textContent = 'score ' + (state.latest ? state.latest.score : '-');
    document.getElementById('clock').textContent = new Date().toLocaleTimeString();
    document.getElementById('uptime').textContent = dur(Date.now() - state.meta.startedAt);
  }

  function renderSystem() {
    if (!state) return;
    var t = state.latest ? state.latest.totals : null;
    document.getElementById('sys').innerHTML = kv([
      ['blocks', t ? t.blocks : '-'],
      ['late blocks', t ? t.lateBlocks : '-'],
      ['decisions', t ? t.decisions : '-'],
      ['holds', t ? t.holds : '-'],
      ['reflex rejects', t ? t.reflexRejects : '-', 'warn'],
      ['quotes sent', t ? t.quotes : '-'],
      ['fills', t ? t.fills : '-'],
      ['reverted', t ? t.reverted : '-'],
      ['open sends', J.unresolved, J.unresolved ? 'warn' : ''],
      ['journal rows', J.counts.impulse + ' / ' + J.counts.transitions],
      ['mid', state.latest ? num(state.latest.mid, 6) : '-'],
      ['spread', state.latest ? num(state.latest.spreadBps, 2) + ' bps' : '-'],
      ['read', state.latest ? '-' : '-']
    ]);
  }

  function renderReflexes() {
    var names = ['kill_switch', 'recovery_pending', 'daily_loss', 'gas_cap', 'min_liquidity', 'max_spread', 'low_score', 'duplicate_side', 'max_exposure', 'funds'];
    document.getElementById('reflexes').innerHTML = names.map(function (n) {
      var hits = J.reflexHits[n] || 0;
      var last = state && state.latest && state.latest.reflex === n;
      return '<tr' + (last ? ' class="sel"' : '') + '><td>' + n + '</td><td style="text-align:right" class="' + (hits ? 'warn' : 'dim') + '">' + hits + '</td><td class="dim">' + (last ? 'fired last block' : '') + '</td></tr>';
    }).join('');
  }

  function renderCoverage() {
    var c = J.coverage;
    if (!c) return;
    document.getElementById('covpct').textContent = num(c.pct, 1) + ' pct';
    document.getElementById('cov').innerHTML = kv([
      ['segments', c.segments],
      ['blocks held', c.blocks.toLocaleString()],
      ['events', c.events.toLocaleString()],
      ['size', num(c.bytes / 1e9, 2) + ' GB'],
      ['errors', c.errors, c.errors ? 'down' : ''],
      ['first block', c.firstBlock === null ? '-' : c.firstBlock.toLocaleString()],
      ['last block', c.lastBlock === null ? '-' : c.lastBlock.toLocaleString()]
    ]);
    document.getElementById('covbar').style.width = num(c.pct, 1) + '%';
  }

  function rowClass(i) {
    if (i.reflex) return 'reject';
    if (!i.jev) return 'unknown';
    if (i.intent && i.intent.status === 'placed') return 'execute';
    if (i.status === 'hold') return 'hold';
    return 'hold';
  }

  function renderFeed() {
    var rows = J.impulses.slice(0, 120).map(function (i) {
      var p = i.jev ? num(i.jev.pBuy * 100, 0) + ' pct' : '-';
      var out = i.reflex ? i.reflex : i.intent ? i.intent.status : i.status;
      var path = (i.history || []).map(function (h) { return h.node; }).join('&gt;');
      return '<tr class="row' + (selected === i.id ? ' sel' : '') + '" data-id="' + i.id + '">' +
        '<td>' + i.block + '</td><td class="' + (i.score >= 55 ? 'up' : i.score >= 40 ? '' : 'down') + '">' + i.score + '</td>' +
        '<td>' + (i.jev ? i.jev.action : '-') + '</td><td class="dim">' + p + '</td>' +
        '<td><span class="pill ' + rowClass(i) + '">' + esc(out) + '</span></td><td class="trail">' + path + '</td></tr>';
    }).join('');
    document.getElementById('feed').innerHTML = rows || '<tr><td colspan="6" class="dim">no impulse yet</td></tr>';
    document.getElementById('feedcount').textContent = J.counts.impulse + ' total';
    Array.prototype.forEach.call(document.querySelectorAll('tr.row'), function (tr) {
      tr.onclick = function () { selected = tr.getAttribute('data-id'); renderFeed(); renderDetail(); };
    });
  }

  function renderDetail() {
    var i = null;
    for (var k = 0; k < J.impulses.length; k++) if (J.impulses[k].id === selected) i = J.impulses[k];
    var el = document.getElementById('detail');
    if (!i) { el.innerHTML = '<span class="dim">nothing selected</span>'; return; }
    var facts = Object.keys(i.facts || {}).map(function (key) { return '<span>' + key + '</span><span>' + esc(i.facts[key]) + '</span>'; }).join('');
    var trail = (i.history || []).map(function (h) {
      return '<span>' + h.node + '</span><span class="' + (h.verdict === 'reject' ? 'down' : h.verdict === 'execute' ? 'up' : 'dim') + '">' + esc(h.verdict + ' ' + h.note) + '</span>';
    }).join('');
    el.innerHTML = facts + trail;
  }

  function renderPosition() {
    if (!state || !state.latest) return;
    var p = state.latest.position, r = state.latest.resting, e = state.latest.exit;
    document.getElementById('posside').textContent = p.side;
    document.getElementById('pos').innerHTML = kv([
      ['side / size', p.side + ' ' + num(p.size, 2)],
      ['entry', p.entryPrice === null ? '-' : num(p.entryPrice, 6)],
      ['unrealised usd', money(p.unrealizedUsd), p.unrealizedUsd >= 0 ? 'up' : 'down'],
      ['resting bid', num(r.bidMon, 1) + ' MON'],
      ['resting ask', num(r.askMon, 1) + ' MON'],
      ['tp / sl', 'armed on the entry fill'],
      ['last exit', e ? e.reason + ' ' + num(e.price, 6) : '-']
    ]);
  }

  function renderScore() {
    var s = J.scoreParts || [];
    document.getElementById('scorebody').innerHTML = kv(s.map(function (p) {
      return [p.name + ' (' + p.note + ')', (p.delta > 0 ? '+' : '') + p.delta, p.delta > 0 ? 'up' : 'down'];
    }).concat([['total', J.score, J.score >= 55 ? 'up' : J.score >= 40 ? '' : 'down']]));
  }

  function renderTotals() {
    if (!state || !state.latest) return;
    var t = state.latest.totals;
    var net = t.mm ? (t.mm.captureBps || 0) + (t.mm.markoutBps || 0) : 0;
    document.getElementById('totals').innerHTML = kv([
      ['pnl', money(t.pnlUsd), t.pnlUsd >= 0 ? 'up' : 'down'],
      ['realised', money(t.realizedUsd)],
      ['net edge', num(net, 2) + ' bps', net >= 0 ? 'up' : 'down'],
      ['carry', money(t.mm ? t.mm.carryUsd : 0)],
      ['gas cost', num(t.gasUsd, 4)],
      ['jev cost', num(t.jevUsd, 4)],
      ['pnl pct', num(t.pnlPct, 3) + ' pct']
    ]);
  }

  // The maker's edge, the way the literature splits it: what we quoted (capture),
  // what the flow knew (markout), and what holding the inventory added (carry).
  function renderMaker() {
    if (!state || !state.latest || !state.latest.totals.mm) return;
    var mm = state.latest.totals.mm;
    var net = (mm.captureBps || 0) + (mm.markoutBps || 0);
    document.getElementById('mmn').textContent = (mm.n || 0) + ' fills marked';
    document.getElementById('mm').innerHTML = kv([
      ['quoted', num(mm.captureBps, 2) + ' bps', mm.captureBps >= 0 ? 'up' : 'down'],
      ['markout', num(mm.markoutBps, 2) + ' bps', mm.markoutBps >= 0 ? 'up' : 'down'],
      ['net edge', num(net, 2) + ' bps', net >= 0 ? 'up' : 'down'],
      ['capture', money(mm.captureUsd)],
      ['markout usd', money(mm.markoutUsd)],
      ['carry usd', money(mm.carryUsd), mm.carryUsd >= 0 ? 'up' : 'down']
    ]);
  }

  function renderAll() { renderHeader(); renderSystem(); renderReflexes(); renderCoverage(); renderFeed(); renderDetail(); renderPosition(); renderMaker(); renderScore(); renderTotals(); }

  async function loadJournal() {
    try {
      var r = await fetch('/api/journal');
      var j = await r.json();
      J = j;
      renderAll();
    } catch (e) {}
  }

  function connect() {
    var es = new EventSource('/events');
    es.addEventListener('snapshot', function (ev) {
      var d = JSON.parse(ev.data);
      state = { meta: { model: d.model, dryRun: d.dryRun, market: d.market, startedAt: d.startedAt }, latest: (d.history || []).slice(-1)[0] || null };
      loadJournal();
    });
    es.addEventListener('block', function (ev) {
      var b = JSON.parse(ev.data);
      state = state || { meta: {}, latest: null };
      state.latest = b;
      renderAll();
    });
    es.addEventListener('quote', function () { loadJournal(); });
    es.addEventListener('fill', function () { loadJournal(); });
    es.onerror = function () { setTimeout(connect, 3000); };
  }

  loadJournal();
  setInterval(loadJournal, 5000);
  connect();
</script>
</body>
</html>`;
}
