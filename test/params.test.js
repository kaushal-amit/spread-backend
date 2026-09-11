/**
 * Step 3.3 (B-14) + 3.6 (S-08) · every parameter is validated, every failure
 * is typed. Table-driven: a bad input to any handler is a 400 (or a 409 for a
 * refusal) with a `code`, and NEVER a 500 — because a 500 is what a Postgres
 * 22007 used to look like, and the client's retry policy treated it as an
 * outage.
 *
 * The app is assembled the way src/index.js assembles it: the same routers,
 * the same error middleware, the same 404. No auth: every request here is
 * loopback, which is the development case.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('params');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const { toResponse } = require('../src/api/errors');
const gateStore = require('../src/services/gateStore');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  await gateStore.load().catch(() => {});
  const slot = gateStore.effective().BUDGET.slotKd;

  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/routes').build());
  app.use('/api/review', require('../src/api/review').build());
  app.use('/api', require('../src/api/sizing').build());
  app.use('/api/diag', require('../src/api/diag').build());
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { const { status, body } = toResponse(err); res.status(status).json(body); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'no such endpoint', code: 'NOT_FOUND' }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: j };
  };

  // [method, path, body, expected status, what the reason must mention]
  const TABLE = [
    ['GET', '/orders?from=abc', undefined, 400, /day/],
    ['GET', '/orders?to=2026-13-40', undefined, 400, /day/],
    ['GET', '/orders?limit=9999', undefined, 400, /limit/],
    ['GET', '/orders?limit=0', undefined, 400, /limit/],
    ['GET', '/ledger?from=abc', undefined, 400, /day/],
    ['GET', '/ledger?limit=501', undefined, 400, /limit/],
    ['GET', '/performance/daily?from=yesterday', undefined, 400, /day/],
    ['GET', '/performance/daily?limit=-1', undefined, 400, /limit/],
    ['GET', '/candles/CATTL?minutes=abc', undefined, 400, /minutes/],
    ['GET', '/candles/CATTL?date=abc', undefined, 400, /day/],
    ['GET', '/candles/not%20a%20symbol', undefined, 400, /symbol/],
    ['GET', '/stocks?date=abc', undefined, 400, /day/],
    ['GET', '/stocks?budgetKd=-5', undefined, 400, /budgetKd/],
    ['GET', '/stocks/bad!sym', undefined, 400, /symbol/],
    ['GET', '/stocks/bad!sym/detail', undefined, 400, /symbol/],
    ['GET', '/sizing/bad!sym', undefined, 400, /symbol/],
    ['GET', '/trading/contracts?date=abc', undefined, 400, /day/],
    ['GET', '/ai/history?date=abc', undefined, 400, /day/],
    ['POST', '/trading/move', {}, 400, /symbol/],
    ['POST', '/trading/move', { symbol: 'SZTESTP', amountKd: 'abc' }, 400, /amountKd/],
    ['POST', '/trading/move', { symbol: 'SZTESTP', amountKd: 0 }, 400, /amountKd/],
    ['POST', '/trading/move', { symbol: 'SZTESTP', amountKd: -5 }, 400, /amountKd/],
    ['POST', '/trading/move', { symbol: 'SZTESTP', amountKd: 'Infinity' }, 400, /amountKd/],
    ['POST', '/trading/move', { symbol: 'SZTESTP', amountKd: slot + 1 }, 400, /exceeds the slot/],
    ['POST', '/trading/move', { symbol: 'SZTESTP', placement: 'SOMEWHERE' }, 400, /placement/],
    ['POST', '/trading/untrade', {}, 400, /symbol/],
    ['POST', '/trading/untrade', { symbol: 'bad sym' }, 400, /symbol/],
    ['POST', '/trading/untrade', { symbol: 'SZTESTP', date: 'abc' }, 400, /day/],
    ['POST', '/trading/record', { symbol: 'SZTESTP', side: 'HOLD' }, 400, /side/],
    ['POST', '/trading/record', { symbol: 'SZTESTP', side: 'BUY', status: 'POSTED', priceFils: 0, shares: 10 }, 400, /priceFils/],
    ['POST', '/trading/record', { symbol: 'SZTESTP', side: 'BUY', status: 'POSTED', priceFils: 100, shares: 1.5 }, 400, /shares/],
    ['POST', '/trading/resolve', {}, 400, /./],
    ['POST', '/trading/hit-bid', { symbol: '' }, 400, /symbol/],
    ['POST', '/ledger', { kind: 'BRIBE', amountKd: 1 }, 400, /kind/],
    ['POST', '/ledger', { kind: 'DEPOSIT', amountKd: 'abc' }, 400, /amount/],
    ['POST', '/ledger', { kind: 'DEPOSIT', amountKd: 1, date: 'abc' }, 400, /day/],
    ['PUT', '/gates', {}, 400, /changes/],
    ['PUT', '/gates', { changes: { 'no-such-gate': 1 } }, 400, /not a gate/],
    ['PUT', '/gates', { changes: { 'g1-floor': 999 } }, 409, /structural/],
    ['GET', '/diag/coverage?date=abc', undefined, 400, /day/],
    ['GET', '/diag/depth/bad!sym', undefined, 400, /symbol/],
    ['GET', '/diag/depth/CATTL?date=abc', undefined, 400, /day/],
    ['GET', '/diag/alarms?limit=1000', undefined, 400, /limit/],
    ['GET', '/review/session/not-a-date', undefined, 400, /./],
    ['GET', '/ai/ask', undefined, 404, /endpoint/],
  ];

  console.log('\n=== a bad parameter is a 400 with a reason; a refusal is a 409; never a 500 ===');
  for (const [method, path, body, want, re] of TABLE) {
    const r = await call(method, path, body);
    const text = JSON.stringify(r.body || '');
    chk(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''} → ${want}`,
        r.status === want && r.body && typeof r.body.code === 'string' && re.test(text),
        { status: r.status, body: r.body });
  }

  console.log('\n=== no handler answers 500 to a malformed input ===');
  const all = await Promise.all(TABLE.map(([m, path, body]) => call(m, path, body)));
  chk('zero 500s across the table', all.every((r) => r.status < 500), all.map((r) => r.status));
  chk('every failure carries a code', all.every((r) => r.body && r.body.code), all.filter((r) => !r.body?.code));

  console.log('\n=== body-parser failures are the CLIENT\'s error, not a 500 ===');
  {
    const raw = async (body, headers = {}) => {
      const r = await fetch(`${base}/trading/record`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const bad = await raw('{"symbol": ');
    chk('malformed JSON → 400 BAD_REQUEST', bad.status === 400 && bad.body?.code === 'BAD_REQUEST', bad);
    const huge = await raw(JSON.stringify({ symbol: 'X', pad: 'x'.repeat(200_000) }));
    chk('an oversized body → 413 PAYLOAD_TOO_LARGE', huge.status === 413 && huge.body?.code === 'PAYLOAD_TOO_LARGE', huge);
  }

  console.log('\n=== a concurrency gate releases ONCE per request ===');
  {
    const { concurrency } = require('../src/api/ratelimit');
    const gate = concurrency(2);
    const EventEmitter = require('events');
    const pass = () => new Promise((resolve) => {
      const res = new EventEmitter(); res.status = (c) => ({ json: () => resolve({ code: c }) });
      gate({}, res, () => resolve({ code: 200, res }));
    });
    const a = await pass(), b = await pass();
    const c = await pass();
    chk('the third concurrent request is refused (429)', c.code === 429, c);
    a.res.emit('finish'); a.res.emit('close');          // both events fire on a normal response
    const d = await pass();
    chk('one finished request frees ONE slot', d.code === 200);
    const e = await pass();
    chk('  — not two (the double-decrement let a third through)', e.code === 429, e);
    void b;
  }

  console.log('\n=== 3.3 · typed errors from history and the gate store ===');
  const o = await call('GET', '/orders?from=abc');
  chk('history.orders: 400 BAD_REQUEST, not 503 from pg 22007', o.status === 400 && o.body.code === 'BAD_REQUEST', o.body);
  const g = await call('PUT', '/gates', { changes: { 'g1-floor': 999 } });
  chk('a locked gate: 409 REFUSED, not 500', g.status === 409 && g.body.code === 'REFUSED', g.body);
  const t = await call('GET', '/diag/tools');
  chk('/diag/tools answers with the eleven tools', t.status === 200 && t.body.tools.length === 11, t.status);

  console.log('\n=== R-30 · POST /budget aliases PUT /gates {session-budget} ===');
  const slotBefore = gateStore.effective().BUDGET.slotKd;
  const b1 = await call('POST', '/budget', { budgetKd: 1234 });
  chk('POST /budget changes the slot', b1.status === 200 && gateStore.effective().BUDGET.slotKd === 1234, { status: b1.status, slot: gateStore.effective().BUDGET.slotKd });
  const b2 = await call('PUT', '/gates', { changes: { 'session-budget': 1234 } });
  chk('PUT /gates {session-budget} changes the slot too', b2.status === 200 && gateStore.effective().BUDGET.slotKd === 1234, b2.status);
  const pickBudget = (body) => { const g = (Array.isArray(body) ? body : []).find((x) => x.id === 'session-budget'); return g && JSON.stringify({ id: g.id, gateName: g.gateName, currentValue: g.currentValue, numericValue: g.numericValue, unit: g.unit }); };
  chk('both routes return the same session-budget body', pickBudget(b1.body) === pickBudget(b2.body) && /"numericValue":1234/.test(pickBudget(b1.body) || ''), [pickBudget(b1.body), pickBudget(b2.body)]);
  const bad = await call('POST', '/budget', { budgetKd: 'x' });
  chk('POST /budget with a non-number is a 400', bad.status === 400, bad.body);
  await call('POST', '/budget', { budgetKd: slotBefore }); // restore for later suites

  console.log('\n=== R-11 · the capture interval comes from the server ===');
  const sess = await call('GET', '/session');
  chk('/session carries captureIntervalSecs (the browser reads stale from it)', sess.status === 200 && typeof sess.body.captureIntervalSecs === 'number' && sess.body.captureIntervalSecs > 0, sess.body.captureIntervalSecs);

  console.log('\n=== R-18 · GET /api/sessions is the picker source ===');
  const ss = await call('GET', '/sessions');
  chk('/api/sessions is 200 with a sessions array and the truncation cut', ss.status === 200 && Array.isArray(ss.body.sessions) && typeof ss.body.truncated_before_hhmm === 'number', { status: ss.status });
  chk('every offered date has volume (only days that traded)', (ss.body.sessions || []).every((x) => Number(x.total_volume) > 0), (ss.body.sessions || []).length);

  srv.close();
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
