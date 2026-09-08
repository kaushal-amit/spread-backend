/**
 * R-19 · the market gate, and R-20 · the session stops.
 *
 * The gate is proven against the REAL 31 August and 2 September breadth
 * series, captured read-only from kse (test/fixtures/market_summary.*.txt):
 *
 *   31 Aug  47 → 40 → 36 in the first hour        the drop rule, then the floor
 *   2 Sep   opened at 24% and never rose          the floor rule from 09:00
 *
 * The stops are proven against constructed contracts (two losses, cool-off).
 * Enforcement is proven through the HTTP surface: a POSTED buy is refused
 * under a stop; a FILLED buy is booked and recorded as STOP_BREACHED.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('stops');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const stops = require('../src/services/stops');
const { toResponse } = require('../src/api/errors');
const gateStore = require('../src/services/gateStore');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const T = { breadth_stop_pct: 35, breadth_careful_pct: 50, breadth_drop_stop_pts: 7, breadth_drop_window_mins: 60,
  careful_max_target_ticks: 2, loss_stop_contracts: 2, loss_cooloff_mins: 30, flat_by_hhmm: 1245 };
const load = (f, day) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'))
  .map((l) => { const [t, st, a, d, u] = l.split('|'); return { at: new Date(`${day}T${t}:00+03:00`), symbolsTraded: +st, advancing: +a, declining: +d, unchanged: +u }; });
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+03:00`);

(async () => {
  try {
    const aug31 = load('market_summary.2026-08-31.txt', '2026-08-31');
    const sep02 = load('market_summary.2026-09-02.txt', '2026-09-02');

    console.log('\n=== 31 August · 47 → 40 → 36 in the first hour ===');
    const g0915 = stops.marketGate(aug31, at('2026-08-31', '09:15'), T);
    chk('09:15 · flat 35–50 → careful', g0915.verdict === 'careful', [g0915.verdict, g0915.breadthPct]);
    const g0930 = stops.marketGate(aug31, at('2026-08-31', '09:30'), T);
    chk('09:30 · fell 7+ points from the open → stop', g0930.verdict === 'stop' && g0930.dropPts >= 7, [g0930.dropPts, g0930.reason]);
    chk('  and it names both readings', /47.* → .*39.8/.test(g0930.reason), g0930.reason);
    const g1004 = stops.marketGate(aug31, at('2026-08-31', '10:04'), T);
    chk('10:04 · under 35 → stop on the level', g1004.verdict === 'stop' && g1004.breadthPct < 35, g1004.breadthPct);
    chk('the three readings are captured', g0930.readings['0900'].breadthPct === 47.3 && g0930.readings['0930'] != null, g0930.readings);

    console.log('\n=== 2 September · opened at 24% and never rose ===');
    const s0905 = stops.marketGate(sep02, at('2026-09-02', '09:05'), T);
    chk('09:05 · already under 35 → stop', s0905.verdict === 'stop' && s0905.breadthPct < 35, s0905.breadthPct);
    const s1030 = stops.marketGate(sep02, at('2026-09-02', '10:30'), T);
    chk('10:30 · still stop', s1030.verdict === 'stop', s1030.breadthPct);
    chk('no window in the day flips it to trade', !sep02.some((_, i) => {
      const r = stops.marketGate(sep02, sep02[i].at, T); return r.verdict === 'trade';
    }));

    console.log('\n=== a rising-from-low market is not stopped on the drop rule ===');
    const rising = [
      { at: at('2026-09-03', '09:00'), symbolsTraded: 100, advancing: 40, declining: 40, unchanged: 20 }, // 40
      { at: at('2026-09-03', '10:00'), symbolsTraded: 100, advancing: 48, declining: 32, unchanged: 20 }, // 48
    ];
    const gr = stops.marketGate(rising, at('2026-09-03', '10:00'), T);
    chk('rose 8 points → trade, not stop', gr.verdict === 'trade' && gr.rising, [gr.verdict, gr.dropPts]);

    console.log('\n=== the session stops ===');
    // 30 August: five contracts, the fifth a loss — two losses stop the day.
    const closed = [
      { symbol: 'MRC', seq: 1, closedAt: at('2026-08-30', '09:20'), netKd: 0.2 },
      { symbol: 'MRC', seq: 2, closedAt: at('2026-08-30', '09:45'), netKd: -0.5 },
      { symbol: 'MRC', seq: 3, closedAt: at('2026-08-30', '10:10'), netKd: 0.9 },
      { symbol: 'MRC', seq: 4, closedAt: at('2026-08-30', '10:40'), netKd: 0.09 },
      { symbol: 'MRC', seq: 5, closedAt: at('2026-08-30', '11:00'), netKd: -12.59 },
    ];
    const ss = stops.sessionStops(closed, at('2026-08-30', '11:30'), T);
    chk('two losses → stopped for the day', ss.stopped && ss.count === 2, ss);
    chk('  naming the losers', /MRC C2/.test(ss.reasons[0]) && /MRC C5/.test(ss.reasons[0]), ss.reasons);
    // One loss → 30-minute cool-off, then clear.
    const oneLoss = [{ symbol: 'CATTL', seq: 1, closedAt: at('2026-09-02', '09:40'), netKd: -11.45 }];
    const cool = stops.sessionStops(oneLoss, at('2026-09-02', '09:55'), T);
    chk('one loss, 15 min later → in cool-off', cool.inCooloff && !cool.stopped, cool);
    const clear = stops.sessionStops(oneLoss, at('2026-09-02', '10:15'), T);
    chk('35 min later → clear', !clear.inCooloff && !clear.stopped, clear);

    console.log('\n=== evaluate() enforces the flat-by clock ===');
    const day = kuwaitDay();
    await fx.clearMarketSummary('SZTESTSTOP');
    // Seed a healthy 60% breadth for the last 10 minutes so only the clock bites.
    const now1230 = at(day, '12:20'); // before flat-by
    for (let i = 0; i < 10; i++) {
      await fx.marketSummary(day, new Date(now1230.getTime() - (9 - i) * 60000), { advancing: 60, declining: 25, unchanged: 15, batch: 'SZTESTSTOP' });
    }
    const before = await stops.evaluate(day, { now: at(day, '12:20') });
    chk('healthy breadth before 12:45 → can open', before.canOpen && before.mode === 'trade', [before.mode, before.reasons]);
    const after = await stops.evaluate(day, { now: at(day, '12:50') });
    chk('after 12:45 → flat, no new position', !after.canOpen && after.pastFlatBy && /12:45/.test(after.reasons.join(' ')), after.reasons);
    await fx.clearMarketSummary('SZTESTSTOP');

    console.log('\n=== enforcement through the trading routes ===');
    await gateStore.load().catch(() => {});
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/routes').build());
    // eslint-disable-next-line no-unused-vars
    app.use((err, _q, r, _n) => { const { status, body } = toResponse(err); r.status(status).json(body); });
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}/api`;
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const SYM = 'SZTESTSTOPQ';
    await fx.clearLegs(SYM); await fx.instrument(SYM);
    // Force a stop: breadth 24% now.
    for (let i = 0; i < 10; i++) {
      await fx.marketSummary(day, new Date(Date.now() - (9 - i) * 60000), { advancing: 24, declining: 60, unchanged: 16, batch: 'SZTESTSTOP' });
    }
    const claim = await post('/trading/move', { symbol: SYM, amountKd: 500 });
    chk('a claim is refused under a stop', claim.status === 409 && /no new position/.test(claim.body.error), claim.body);
    const posted = await post('/trading/record', { symbol: SYM, side: 'BUY', status: 'POSTED', priceFils: 200, shares: 1000 });
    chk('a POSTED buy is refused', posted.status === 409 && /breadth 24/.test(posted.body.detail || ''), posted.body);
    const filled = await post('/trading/record', { symbol: SYM, side: 'BUY', status: 'FILLED', priceFils: 200, shares: 1000 });
    chk('a FILLED buy is BOOKED (a fact that happened in Awsat)', filled.status === 200 && filled.body.ok, filled.body);
    chk('  and flagged as a breach', filled.body.ruleBreach && /24/.test(filled.body.warning), filled.body.ruleBreach);
    const { rows: ev } = await pool.query("SELECT * FROM spread.event_log WHERE symbol = $1 AND action = 'STOP_BREACHED'", [SYM]);
    chk('  and recorded in event_log', ev.length === 1, ev.length);

    await fx.clearMarketSummary('SZTESTSTOP');
    await fx.clearLegs(SYM); await pool.query('DELETE FROM spread.event_log WHERE symbol = $1', [SYM]);
    await pool.query('DELETE FROM spread.claim WHERE symbol = $1', [SYM]);
    await fx.clearInstruments(SYM);
    srv.close();
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
