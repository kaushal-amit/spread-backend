/**
 * Step 3.8 · the trading routes against the real ledger.
 *
 *   claim A → filled buy in B          REFUSED (a claim holds the slot)
 *   claim A → filled buy in A          allowed (filling the claim you hold)
 *   untrade                            the claim goes, event_log keeps it
 *   resting sell that fills            exit_venue = LIMIT
 *   hit-bid                            exit_venue = MARKET
 *   D3 on THIS contract                the prior sell on this contract sets
 *                                      "moved down", not another contract's
 *   no quote today                     bid / unrealised / peak are null,
 *                                      never the entry wearing the bid's name
 *
 * test/lifecycle.test.js is the pure ledger model; this is the HTTP surface
 * over Postgres. SZTESTLC* symbols on a schema-only kse_test.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('lifecycle-db');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const { toResponse } = require('../src/api/errors');
const gateStore = require('../src/services/gateStore');
const thresholds = require('../src/config/thresholds');
const socket = require('../src/socket');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const A = 'SZTESTLCA', B = 'SZTESTLCB', DAY = kuwaitDay();
// Freeze the stops clock to 10:00 Kuwait on the trading day so the flat-by
// refusal (12:45–16:00 Kuwait) can't make this open-a-position suite flaky by
// wall-clock hour. Only the gate reads this; the legs and quotes stay real-time.
process.env.SPREAD_TEST_NOW = `${DAY}T07:00:00Z`;

(async () => {
  await gateStore.load().catch(() => {});
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/routes').build());
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { const { status, body } = toResponse(err); res.status(status).json(body); });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (path) => (await fetch(base + path)).json();
  const legs = (sym) => pool.query('SELECT * FROM spread.order_leg WHERE symbol = $1 ORDER BY id', [sym]).then((r) => r.rows);

  const clean = async () => {
    for (const s of [A, B]) {
      await fx.clearLegs(s); await fx.clearQuotes(s);
      await pool.query('DELETE FROM spread.claim WHERE symbol = $1', [s]);
      await pool.query('DELETE FROM spread.event_log WHERE symbol = $1', [s]);
    }
  };

  try {
    await clean();
    await fx.instrument(A); await fx.instrument(B);
    const now = new Date().toISOString();
    await fx.quote(A, { day: DAY, at: now, last: 200, bid: 200, offer: 201 });

    console.log('\n=== a claim holds the slot ===');
    const c1 = await post('/trading/move', { symbol: A, amountKd: 500 });
    chk('claim A is accepted', c1.status === 200 && c1.body.ok, c1.body);
    const { rows: ev1 } = await pool.query("SELECT * FROM spread.event_log WHERE symbol = $1 AND action = 'CLAIM_PLACED'", [A]);
    chk('  and logged as CLAIM_PLACED', ev1.length === 1 && Number(ev1[0].detail.amount_kd) === 500, ev1);
    const b1 = await post('/trading/record', { symbol: B, side: 'BUY', status: 'FILLED', priceFils: 100, shares: 1000 });
    chk('a filled buy in B is REFUSED while A is claimed', b1.status === 409 && b1.body.code === 'REFUSED', b1);
    chk('  naming the claim', /SZTESTLCA \(claimed\)/.test(b1.body.detail || ''), b1.body.detail);
    const c2 = await post('/trading/move', { symbol: B, amountKd: 500 });
    chk('a second claim is refused too', c2.status === 409, c2.status);
    const a1 = await post('/trading/record', { symbol: A, side: 'BUY', status: 'FILLED', priceFils: 200, shares: 1000 });
    chk('a filled buy in A — the claimed symbol — is allowed', a1.status === 200 && a1.body.ok, a1.body);

    console.log('\n=== one open position per symbol — at the POST, not only at the fill ===');
    // Holding A (filled above). A POSTED BUY in A used to be accepted, and
    // resolving it FILLED opened a SECOND contract in the same stock.
    // (the clock is frozen at 10:00 Kuwait for the whole suite — inside the session,
    // so the refusal below is the position rule, not the flat-by clock)
    const dbl = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 199, shares: 1000 });
    chk('a POSTED BUY while holding the symbol is REFUSED', dbl.status === 409 && /already has an open position/.test(dbl.body.error || ''), dbl.body);
    chk('  naming the contract held', /contract 1/.test(dbl.body.error || ''), dbl.body.error);
    const openA = (await legs(A)).filter((l) => l.side === 'BUY' && ['FILLED', 'CARRIED', 'POSTED'].includes(l.status));
    chk('  and only ONE buy leg exists in A', openA.length === 1, openA.map((l) => [l.status, l.contract_seq]));

    console.log('\n=== untrade is a soft delete ===');
    const u = await post('/trading/untrade', { symbol: A });
    chk('the claim is released', u.status === 200 && u.body.released === true && u.body.releasedKd === 500, u.body);
    const { rows: cl } = await pool.query('SELECT * FROM spread.claim WHERE symbol = $1', [A]);
    chk('  the claim row is gone', cl.length === 0);
    const { rows: ev2 } = await pool.query("SELECT * FROM spread.event_log WHERE symbol = $1 AND action = 'CLAIM_RELEASED'", [A]);
    chk('  and lives on in event_log with its amount', ev2.length === 1 && Number(ev2[0].detail.amount_kd) === 500, ev2);
    const u2 = await post('/trading/untrade', { symbol: A });
    chk('releasing nothing says so', u2.status === 200 && u2.body.released === false, u2.body);

    console.log('\n=== a resting sell that fills is a LIMIT exit ===');
    const s1 = await post('/trading/record', { symbol: A, side: 'SELL', status: 'POSTED', priceFils: 203, shares: 1000 });
    chk('sell posted at 203', s1.status === 200, s1.body);
    const posted = (await legs(A)).find((l) => l.side === 'SELL' && l.status === 'POSTED');
    const r1 = await post('/trading/resolve', { legId: posted.id, status: 'CANCELLED' });
    chk('cancelled', r1.status === 200, r1.body);
    // D3 on THIS contract: the prior sell on this contract was 203; 202 is
    // moving down (above cost, so allowed with a warning that names 203).
    const s2 = await post('/trading/record', { symbol: A, side: 'SELL', status: 'POSTED', priceFils: 202, shares: 1000 });
    chk('a lower sell above cost is allowed with the D5 warning', s2.status === 200 && /from 203 to 202/.test(s2.body.warning || ''), s2.body.warning);
    const s3 = await post('/trading/record', { symbol: A, side: 'SELL', status: 'POSTED', priceFils: 199, shares: 1000 });
    chk('below cost is warned as BELOW_COST (never silently)', s3.status === 200 && /below cost/i.test(s3.body.warning || ''), s3.body.warning);
    const restingSells = (await legs(A)).filter((l) => l.side === 'SELL' && l.status === 'POSTED');
    for (const l of restingSells.slice(1)) await post('/trading/resolve', { legId: l.id, status: 'CANCELLED' });
    const r2 = await post('/trading/resolve', { legId: restingSells[0].id, status: 'FILLED' });
    chk('the resting sell fills', r2.status === 200, r2.body);
    const filledSell = (await legs(A)).find((l) => l.side === 'SELL' && l.status === 'FILLED');
    chk('exit_venue = LIMIT', filledSell && filledSell.exit_venue === 'LIMIT', filledSell?.exit_venue);
    chk('the buy carries no exit_venue', (await legs(A)).find((l) => l.side === 'BUY').exit_venue === null);

    console.log('\n=== hit-bid is a MARKET exit ===');
    const a2 = await post('/trading/record', { symbol: A, side: 'BUY', status: 'FILLED', priceFils: 200, shares: 500 });
    chk('a new contract opens once the first is closed', a2.status === 200, a2.body);
    const realPhase = socket.sessionPhase;
    socket.sessionPhase = () => ({ open: true, phase: 'live' });
    const h = await post('/trading/hit-bid', { symbol: A });
    socket.sessionPhase = realPhase;
    chk('hit the bid', h.status === 200, h.body);
    const market = (await legs(A)).filter((l) => l.side === 'SELL' && l.status === 'FILLED').pop();
    chk('exit_venue = MARKET', market && market.exit_venue === 'MARKET', market?.exit_venue);
    chk('at the bid of the day', Number(market.price_fils) === 200);
    const { rows: [venues] } = await pool.query(
      `SELECT count(*) FILTER (WHERE exit_venue = 'LIMIT')::int AS lim, count(*) FILTER (WHERE exit_venue = 'MARKET')::int AS mkt
         FROM spread.order_leg WHERE symbol = $1 AND status = 'FILLED' AND side = 'SELL'`, [A]);
    chk('both exit paths recorded their venue', venues.lim === 1 && venues.mkt === 1, venues);

    console.log('\n=== a filled sell recorded directly is LIMIT too ===');
    const a3 = await post('/trading/record', { symbol: A, side: 'BUY', status: 'FILLED', priceFils: 200, shares: 400 });
    const s4 = await post('/trading/record', { symbol: A, side: 'SELL', status: 'FILLED', priceFils: 202, shares: 400 });
    chk('recorded', a3.status === 200 && s4.status === 200, [a3.status, s4.status]);
    const direct = (await legs(A)).filter((l) => l.side === 'SELL' && l.status === 'FILLED').pop();
    chk('exit_venue = LIMIT', direct.exit_venue === 'LIMIT', direct.exit_venue);

    console.log('\n=== no quote today → null, not the entry ===');
    const b2 = await post('/trading/record', { symbol: B, side: 'BUY', status: 'FILLED', priceFils: 100, shares: 1000 });
    chk('B opens (A is flat, no claim)', b2.status === 200, b2.body);
    const cs = await get(`/trading/contracts?date=${DAY}`);
    const cb = cs.find((c) => c.symbol === B);
    chk('markedAt = entry', cb && cb.markedAt === 'entry', cb);
    chk('bid is null, not 100', cb.bid === null, cb.bid);
    chk('unrealised is null, not 0.00', cb.unrealisedKd === null, cb.unrealisedKd);
    chk('peak is null (nothing has printed)', cb.peakSinceFill === null, cb.peakSinceFill);
    chk('break-even and the +2/+6 targets are computed', cb.breakEvenPrice > 100 && cb.targetNormal >= cb.breakEvenPrice && cb.targetTrending >= cb.targetNormal, [cb.breakEvenPrice, cb.targetNormal, cb.targetTrending]);
    await fx.quote(B, { day: DAY, at: new Date().toISOString(), last: 104, bid: 104, offer: 105 });
    const cs2 = await get(`/trading/contracts?date=${DAY}`);
    const cb2 = cs2.find((c) => c.symbol === B);
    // A1 · the target reads the SEEDED kb value (exit_target_normal_fils /
    // _trending_fils), not a literal — change the row and both move together.
    const tn = Number(thresholds.get('exit_target_normal_fils'));
    const tt = Number(thresholds.get('exit_target_trending_fils'));
    const expNormal = Math.max(cb2.breakEvenPrice, 100 + tn);
    const expTrending = Math.max(cb2.breakEvenPrice, 100 + tt);
    chk('with a print: bid 104, peak 104, target = entry + the seeded ticks',
        cb2.bid === 104 && cb2.peakSinceFill === 104 && cb2.targetNormal === expNormal && cb2.targetTrending === expTrending,
        { cb2Normal: cb2.targetNormal, expNormal, cb2Trending: cb2.targetTrending, expTrending, tn, tt });
    chk('unrealised = (104 − 100) × 1000 / 1000', cb2.unrealisedKd === 4, cb2.unrealisedKd);

    console.log('\n=== R-42 · cancel-and-hit is one transaction — a refused hit leaves the offer POSTED ===');
    // B holds an open buy; post a resting SELL, then hit past the flat-by clock.
    const restB = await post('/trading/record', { symbol: B, side: 'SELL', status: 'POSTED', priceFils: 106, shares: 1000 });
    chk('a resting sell is posted on B at 106', restB.status === 200, restB.body);
    const realPhase2 = socket.sessionPhase;
    socket.sessionPhase = () => ({ open: true, phase: 'live' });
    const stopsSvc = require('../src/services/stops');
    const realEval = stopsSvc.evaluate;
    stopsSvc.evaluate = async () => ({ pastFlatBy: true, flatBy: '12:45', canOpen: true, reasons: [], mode: 'stop' });
    const chB = await post('/trading/cancel-and-hit', { symbol: B });
    stopsSvc.evaluate = realEval;
    socket.sessionPhase = realPhase2;
    chk('cancel-and-hit is refused past 12:45', chB.status === 409 && /past 12:45/.test(chB.body.error || ''), chB.body);
    const stillPosted = (await legs(B)).find((l) => l.side === 'SELL' && l.status === 'POSTED' && Number(l.price_fils) === 106);
    chk('  the resting offer is STILL POSTED — the cancel rolled back with the refused hit', !!stillPosted, (await legs(B)).map((l) => `${l.side}/${l.status}@${l.price_fils}`));

    console.log('\n=== 6.4 · /ledger pages with a next header ===');
    const lr1 = await fetch(`${base}/ledger?limit=1`);
    const next1 = lr1.headers.get('next');
    const lrows1 = await lr1.json();
    chk('a full ledger page carries a next header', lrows1.length === 1 && !!next1 && /\|\d+$/.test(next1), { len: lrows1.length, next: next1 });
    if (next1) {
      const lr2 = await fetch(`${base}/ledger?limit=1&cursor=${encodeURIComponent(next1)}`);
      const lrows2 = await lr2.json();
      chk('the cursor pages to an older, different movement', lrows2.length >= 1 && JSON.stringify(lrows2[0]) !== JSON.stringify(lrows1[0]), { a: lrows1[0], b: lrows2[0] });
    }
    const badCur = await fetch(`${base}/ledger?cursor=not-a-cursor`);
    chk('a malformed cursor is a 400, not a 500', badCur.status === 400, badCur.status);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await clean().catch(() => {});
  await fx.clearInstruments(A).catch(() => {}); await fx.clearInstruments(B).catch(() => {});
  srv.close();
  delete process.env.SPREAD_TEST_NOW;
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
