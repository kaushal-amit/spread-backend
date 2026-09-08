/**
 * Step 3.9 / D-06 · ONE day-roll rule.
 *
 * kuwaitDay() in JavaScript rolls the session at 04:00 Kuwait. Eleven SQL
 * sites used to roll at midnight. A leg booked at 01:00 Kuwait was dated one
 * day in the ledger and another in every query that derived the day from
 * created_at. spread.kuwait_day() (019) is the SQL twin; this suite walks
 * the boundary minute by minute and asks both.
 *
 * Also: 019 is idempotent (applied twice), the calendar is seeded from
 * trading_date, and a duplicate open data_alarm is refused by the index.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('dayroll');
const { pool } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { kuwaitDay } = require('../src/jobs/daily');
const fx = require('./fixtures').bind(pool);

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    console.log('\n=== 019 applies, and applies again ===');
    const m1 = await migrate();
    const m2 = await migrate();
    chk('a second run applies nothing', m2.applied.length === 0 && !m1.drift.length, m2);
    const { rows: [fn] } = await pool.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'kuwait_day'");
    chk('spread.kuwait_day exists', fn.n === 1);

    console.log('\n=== the 04:00 roll, in JS and SQL, minute by minute ===');
    // Kuwait is UTC+3: 04:00 Kuwait = 01:00 UTC. Walk 20:00 UTC → 06:00 UTC.
    const instants = [];
    for (let m = 20 * 60; m < 30 * 60; m += 7) {
      const d = new Date(Date.UTC(2026, 8, 3, 0, 0, 0) + m * 60000); // from 3 Sep 20:00Z
      instants.push(d.toISOString());
    }
    const { rows } = await pool.query(
      'SELECT t, spread.kuwait_day(t::timestamptz)::text AS d FROM unnest($1::text[]) AS t', [instants]);
    const disagree = rows.filter((r) => r.d !== kuwaitDay(new Date(r.t)));
    chk(`${rows.length} instants across the roll: SQL and JS agree on every one`, disagree.length === 0,
        disagree.slice(0, 5).map((r) => [r.t, r.d, kuwaitDay(new Date(r.t))]));
    const at = (iso) => rows.find((r) => r.t === iso)?.d;
    chk('01:00 Kuwait (22:00Z) is the PREVIOUS session', at('2026-09-03T22:00:00.000Z') === '2026-09-03' || kuwaitDay(new Date('2026-09-03T22:00:00Z')) === '2026-09-03');
    const { rows: [edge] } = await pool.query(
      `SELECT spread.kuwait_day('2026-09-04T00:59:59Z'::timestamptz)::text AS before,
              spread.kuwait_day('2026-09-04T01:00:00Z'::timestamptz)::text AS after`);
    chk('03:59:59 Kuwait → 3 Sep; 04:00:00 Kuwait → 4 Sep (SQL)', edge.before === '2026-09-03' && edge.after === '2026-09-04', edge);
    chk('  and JS says the same', kuwaitDay(new Date('2026-09-04T00:59:59Z')) === '2026-09-03'
        && kuwaitDay(new Date('2026-09-04T01:00:00Z')) === '2026-09-04');

    console.log('\n=== a leg at 01:00 Kuwait is dated the previous session in both ===');
    const SYM = 'SZTESTROLL';
    await fx.clearLegs(SYM); await fx.instrument(SYM);
    const postedAt = new Date('2026-09-03T22:00:00Z'); // 01:00 Kuwait, 4 Sep by the wall clock
    const jsDay = kuwaitDay(postedAt);
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, posted_at)
       VALUES ($1, $2, 1, 'BUY', 'POSTED', 100, 1000, $3)`, [jsDay, SYM, postedAt]);
    const { rows: [leg] } = await pool.query(
      `SELECT trading_day::text AS js, spread.kuwait_day(posted_at)::text AS sql,
              (posted_at AT TIME ZONE 'Asia/Kuwait')::date::text AS midnight_rule
         FROM spread.order_leg WHERE symbol = $1`, [SYM]);
    chk('ledger day (JS) = 2026-09-03', leg.js === '2026-09-03', leg);
    chk('SQL rule = the same day', leg.sql === leg.js, leg);
    chk('the old midnight rule would have said 4 Sep — the bug 019 removes', leg.midnight_rule === '2026-09-04', leg);
    await fx.clearLegs(SYM); await fx.clearInstruments(SYM);

    console.log('\n=== no SQL derives a day its own way any more ===');
    const fs = require('fs'), path = require('path');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const offenders = walk(path.join(__dirname, '../src')).filter((f) =>
      /\+ interval '3 hours'\)::date|AT TIME ZONE 'Asia\/Kuwait'\)::date/.test(fs.readFileSync(f, 'utf8')));
    chk('zero `AT TIME ZONE … ::date` derivations under src/', offenders.length === 0, offenders);

    console.log('\n=== the calendar is seeded from trading_date; a duplicate open alarm is refused ===');
    await fx.clearQuotes('SZTESTCAL'); await fx.instrument('SZTESTCAL');
    await fx.quote('SZTESTCAL', { day: fx.TEST_DAY, at: `${fx.TEST_DAY}T06:00:00Z`, last: 100, bid: 99, offer: 100 });
    await pool.query('DELETE FROM spread.trading_day WHERE trading_day = $1', [fx.TEST_DAY]);
    await migrate(); // 019 is skipped (applied), so seed the same way it does:
    await pool.query(
      `INSERT INTO spread.trading_day (trading_day, is_session)
       SELECT DISTINCT trading_date, true FROM public.awsat_market_quotes WHERE symbol = 'SZTESTCAL'
       ON CONFLICT (trading_day) DO UPDATE SET is_session = spread.trading_day.is_session OR EXCLUDED.is_session`);
    const { rows: [td] } = await pool.query('SELECT is_session FROM spread.trading_day WHERE trading_day = $1', [fx.TEST_DAY]);
    chk('the fixture day is a session because a quote carries its trading_date', td && td.is_session === true, td);
    const seed = require('../src/db/seed-calendar');
    const r = await seed.seed({ from: fx.TEST_DAY, to: fx.TEST_DAY, log: { log() {}, warn() {} } });
    chk('seed-calendar observes it too', r.observed === 1 && r.holidaysKnown, r);
    await pool.query('DELETE FROM spread.trading_day WHERE trading_day = $1', [fx.TEST_DAY]);
    await fx.clearQuotes('SZTESTCAL'); await fx.clearInstruments('SZTESTCAL');

    // R-14 · a weekday gap raises NO_ROWS naming awsat_market_quotes, not stock_quotes.
    console.log('\n=== R-14 · the NO_ROWS alarm names awsat_market_quotes ===');
    const CAL = 'SZTESTCAL14';
    await fx.clearQuotes(CAL); await fx.instrument(CAL);
    await pool.query("DELETE FROM spread.data_alarm WHERE trading_day = '2001-01-09'");
    await pool.query("DELETE FROM spread.trading_day WHERE trading_day IN ('2001-01-08','2001-01-09','2001-01-10')");
    await fx.quote(CAL, { day: '2001-01-08', at: '2001-01-08T06:00:00Z', last: 100, bid: 99, offer: 100 });
    await fx.quote(CAL, { day: '2001-01-10', at: '2001-01-10T06:00:00Z', last: 100, bid: 99, offer: 100 });
    // 2001-01-09 (Tue) is a session weekday with no quote — a gap.
    await pool.query("INSERT INTO spread.trading_day (trading_day, is_session) VALUES ('2001-01-08',true),('2001-01-09',true),('2001-01-10',true) ON CONFLICT (trading_day) DO UPDATE SET is_session = true");
    await require('../src/db/seed-calendar').seed({ from: '2001-01-08', to: '2001-01-10', log: { log() {}, warn() {} } });
    const { rows: [alarm14] } = await pool.query("SELECT table_name FROM spread.data_alarm WHERE trading_day = '2001-01-09' AND alarm = 'NO_ROWS' ORDER BY id DESC LIMIT 1");
    chk('the gap alarm names awsat_market_quotes, not stock_quotes', alarm14 && alarm14.table_name === 'awsat_market_quotes', alarm14);
    await pool.query("DELETE FROM spread.data_alarm WHERE trading_day = '2001-01-09'");
    await pool.query("DELETE FROM spread.trading_day WHERE trading_day IN ('2001-01-08','2001-01-09','2001-01-10')");
    await fx.clearQuotes(CAL); await fx.clearInstruments(CAL);

    await pool.query("DELETE FROM spread.data_alarm WHERE table_name = 'dayroll.test'");
    const ins = () => pool.query(
      `INSERT INTO spread.data_alarm (trading_day, table_name, alarm, detail) VALUES ($1, 'dayroll.test', 'NO_ROWS', '{}')
       ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date), COALESCE(column_name, ''), COALESCE(symbol, ''))
       WHERE resolved_at IS NULL DO NOTHING`, [fx.TEST_DAY]);
    await ins(); await ins();
    const { rows: [al] } = await pool.query("SELECT count(*)::int AS n FROM spread.data_alarm WHERE table_name = 'dayroll.test'");
    chk('the same open alarm raised twice is stored once', al.n === 1, al);
    await pool.query("DELETE FROM spread.data_alarm WHERE table_name = 'dayroll.test'");
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
