/**
 * D3 · the depth slots are proxied: the browser asks the backend, the backend
 * asks the scraper with the token from ITS env, and the scraper's answer —
 * status and body — is relayed verbatim. The scraper's INGEST_TOKEN never
 * reaches a browser.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('slotsproxy');
const express = require('express');
const http = require('http');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  // a fake scraper
  const seen = [];
  const scraper = express(); scraper.use(express.json());
  scraper.get('/ingest/depth-symbols', (req, res) => { seen.push(['GET', req.get('x-ingest-token')]); res.json({ symbols: [{ slot: 1, symbol: 'KHOT', code: null }], trading_date: '2026-09-10', slotCount: 5 }); });
  scraper.post('/ingest/slots/:n', (req, res) => {
    seen.push(['POST', req.get('x-ingest-token'), req.params.n, req.body]);
    if (req.body.symbol === 'DUP') return res.status(409).json({ ok: false, error: 'One symbol, one slot — DUP already holds slot 1' });
    res.json({ ok: true, row: { slot_no: Number(req.params.n), symbol: req.body.symbol, reason: req.body.reason } });
  });
  const ss = http.createServer(scraper); await new Promise((r) => ss.listen(0, r));
  process.env.SCRAPER_INGEST_URL = `http://127.0.0.1:${ss.address().port}/ingest`;
  process.env.INGEST_TOKEN = 'scraper-token-never-in-a-browser';
  delete require.cache[require.resolve('../src/services/scraperClient')];

  const app = express(); app.use(express.json());
  app.use('/api', (req, _r, next) => { req.auth = { kind: 'user', uid: 'uid-amit', email: 'amit@x' }; next(); });
  app.use('/api', require('../src/api/routes').build());
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const j = async (r) => ({ status: r.status, body: await r.json() });

  try {
    const g = await fetch(`${base}/slots`).then(j);
    chk('GET /api/slots relays the scraper\'s slot list with slotCount', g.status === 200 && g.body.slotCount === 5 && g.body.symbols[0].symbol === 'KHOT', g);
    chk('  and the scraper saw the backend\'s token, not the browser\'s', seen[0][1] === 'scraper-token-never-in-a-browser', seen[0]);

    const ok = await fetch(`${base}/slots/3`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'abar', reason: 'UI' }) }).then(j);
    chk('POST /api/slots/3 relays a 200 with the scraper\'s row', ok.status === 200 && ok.body.ok && ok.body.row.symbol === 'ABAR' && ok.body.row.slot_no === 3, ok);
    chk('  the symbol is uppercased at the boundary and the token is the backend\'s', seen[1][3].symbol === 'ABAR' && seen[1][1] === 'scraper-token-never-in-a-browser', seen[1]);

    const dup = await fetch(`${base}/slots/2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'DUP' }) }).then(j);
    chk('a 409 from the scraper is relayed VERBATIM — status and sentence', dup.status === 409 && /One symbol, one slot/.test(dup.body.error), dup);

    const bad = await fetch(`${base}/slots/0`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'ABAR' }) }).then(j);
    chk('slot 0 is a 400 before the scraper is asked', bad.status === 400 && seen.length === 3, bad);

    ss.close();
    const down = await fetch(`${base}/slots/1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'ABAR' }) }).then(j);
    chk('scraper unreachable → 503 NOT_READY naming it, never a silent 200', down.status === 503 && down.body.code === 'NOT_READY', down);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  srv.close(); try { ss.close(); } catch { /* closed */ }
  try { await require('../src/db').pool.end(); } catch { /* */ }
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
