/**
 * The dated routes. Read-only, and structurally unable to reach the live side.
 *
 * signal_log and position are EMPTY in kse — no writer has run. A passing test
 * on an empty table proves the query parses and nothing else, so both are
 * seeded here.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('review');
const express = require('express');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const http = require('http');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/review', require('../src/api/review').build());
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(8899, r));
  const get = (u) => fetch('http://127.0.0.1:8899/api/review' + u).then(async (r) => ({ status: r.status, body: await r.json() }));

  // The date is taken from /sessions rather than hardcoded: a fixture holds
  // different days from kse, and a test that only passes against one database
  // is testing the fixture.
  // A schema-only kse_test has no session at all, so one is seeded on the
  // fixture day (2001-01-08): a market_day row that traded, one symbol_day
  // row, and quotes 09:00–12:35 Kuwait so capture_ends_hhmm clears 1230.
  const TD = fx.TEST_DAY;
  await fx.clearDay(TD); await fx.clearQuotes('RVTEST');
  await fx.instrument('RVTEST');
  await fx.marketDay(TD, { symbols: 1, advancing: 1, volume: 3600, trades: 12 });
  await fx.symbolDay('RVTEST', TD, { volume: 3600, trades: 12 });
  for (const hhmm of ['06:00', '07:30', '09:35']) { // UTC = Kuwait − 3h
    await fx.quote('RVTEST', { day: TD, at: `${TD}T${hhmm}:00Z`, last: 217, bid: 216, offer: 217, volume: 3600, trades: 12 });
  }
  const cleanup = async () => {
    await fx.clearQuotes('RVTEST'); await fx.clearDay(TD); await fx.clearInstruments('RVTEST');
  };

  let D = null;
  try {
    console.log('\n=== /sessions — only days that TRADED ===');
    const s = await get('/sessions');
    chk('200', s.status === 200, s.status);
    const list = s.body.sessions || [];
    D = list.length ? list[0].date : null;
    chk('sessions are returned', list.length > 0, list.length);
    chk('the seeded session is among them', list.some((x) => x.date === TD), list.map((x) => x.date).slice(-3));
    const seeded = list.find((x) => x.date === TD) || {};
    chk('its capture ends at 12:35 Kuwait, so it is not truncated',
        seeded.capture_ends_hhmm === 1235 && seeded.truncated === false, [seeded.capture_ends_hhmm, seeded.truncated]);
    chk('every one has volume', list.every((x) => Number(x.total_volume) > 0));
    chk('30 July is NOT offered — 134 rows, 10:14 capture, not a session',
        !list.some((x) => x.date === '2026-07-30'), list.filter((x) => x.date === '2026-07-30'));
    chk('each carries capture_ends_hhmm', list.every((x) => 'capture_ends_hhmm' in x));
    chk('and truncated', list.every((x) => 'truncated' in x));
    chk('and data_quality — a different fault from truncation',
        list.every((x) => ['FULL', 'PARTIAL', 'THIN'].includes(x.data_quality)),
        [...new Set(list.map((x) => x.data_quality))]);
    chk('the threshold is stated, so the front end does not invent one',
        s.body.truncated_before_hhmm === 1230, s.body.truncated_before_hhmm);

    // truncated must agree with capture_ends_hhmm and the stated threshold —
    // asserted as the RULE, not against one date, so it holds on any database.
    chk('truncated agrees with capture_ends_hhmm and the threshold',
        list.every((x) => x.capture_ends_hhmm === null
          || x.truncated === (x.capture_ends_hhmm < s.body.truncated_before_hhmm)),
        list.filter((x) => x.capture_ends_hhmm !== null
          && x.truncated !== (x.capture_ends_hhmm < s.body.truncated_before_hhmm))
          .map((x) => [x.date, x.capture_ends_hhmm, x.truncated]));

    console.log('\n=== /session/:date ===');
    if (!D) { chk('at least one session exists to review', false, 'none'); throw new Error('no sessions'); }
    const one = await get(`/session/${D}`);
    chk('200', one.status === 200, one.status);
    chk('it is the market_day row', one.body.symbols_traded > 0, one.body.symbols_traded);
    const missing = await get('/session/1999-01-04');
    chk('a date with no session is 404, not an empty object', missing.status === 404, missing.status);
    const bad = await get('/session/not-a-date');
    chk('a malformed date is 400 and names what was sent', bad.status === 400, bad.status);

    console.log('\n=== /session/:date/symbols — RAW ===');
    const sy = await get(`/session/${D}/symbols`);
    chk('200', sy.status === 200, sy.status);
    chk('rows are returned', sy.body.count > 0, sy.body.count);
    const row = sy.body.symbols[0];
    chk('columns keep OUR names, not the front end\'s',
        'close_px' in row && !('close_fils' in row), Object.keys(row).slice(0, 6));
    chk('the 035 columns travel', 'avg_spread_pct' in row && 'days_active' in row);
    chk('and the 032 flow columns', 'uptick_ratio' in row && 'range_source' in row);

    console.log('\n=== /session/:date/book/:symbol — empty is NORMAL ===');
    const book = await get(`/session/${D}/book/NOSUCH`);
    chk('an absent book is 200, not 404', book.status === 200, book.status);
    chk('b is an empty array', Array.isArray(book.body.b) && book.body.b.length === 0);
    chk('o is an empty array', Array.isArray(book.body.o) && book.body.o.length === 0);
    chk('and it says why', /8 of 142/.test(book.body.note || ''), book.body.note);

    // ── SEEDED: both tables are empty in kse ──
    console.log('\n=== /session/:date/signals — seeded, not empty ===');
    await fx.clearSignals('RVTEST');
    await fx.signal('RVTEST', D, 'NO_PROTECTION', 217, true);
    const sig = await get(`/session/${D}/signals`);
    chk('the seeded signal is returned', sig.body.count >= 1, sig.body.count);
    chk('was_right travels — the POINT of review',
        sig.body.signals.some((x) => x.was_right === true), sig.body.scored);
    chk('and scored counts them', sig.body.scored >= 1, sig.body.scored);
    await fx.clearSignals('RVTEST');

    console.log('\n=== /session/:date/positions — seeded ===');
    await fx.clearPositions('RVTEST');
    await fx.position('RVTEST', D, 3600, 217);
    const pos = await get(`/session/${D}/positions`);
    chk('the seeded position is returned', pos.body.count >= 1, pos.body.count);
    await fx.clearPositions('RVTEST');

    console.log('\n=== the split is structural ===');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/api/review/index.js'), 'utf8');
    chk('review imports NOTHING from the live routes',
        !/require\('\.\.\/routes'\)|require\('\.\.\/\.\.\/services/.test(src));
    // Test the IMPORTS, not the text: the first version matched the comment
    // explaining that board() is not called, and failed on its own explanation.
    const imports = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    chk('review imports only db and errors',
        imports.every((i) => /\/db$|\/errors$|^express$/.test(i)), imports);
    chk('nothing from services, jobs or the live routes',
        !imports.some((i) => /services|jobs|routes|socket/.test(i)), imports);
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }

  try { await cleanup(); } catch (e) { chk('cleanup', false, e.message); }
  srv.close();
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
