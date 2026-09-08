/**
 * R-26 · the live paint warning (FLOW step 4 check 3). The last price MOVE and
 * the print that carried it; painted = that print is under paint_max_shares.
 *   a 40-share print that moved the price → painted: true
 *   a 5,000-share one                     → painted: false
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('paint');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const depth = require('../src/services/depth');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const PAINT = 'SZTESTPAINT', REAL = 'SZTESTREAL';
const DAY = '2001-01-08';
const at = (hhmm) => `${DAY}T${hhmm}:00+03:00`;

(async () => {
  try {
    for (const s of [PAINT, REAL]) { await fx.clearQuotes(s); await fx.instrument(s); }
    // PAINT: price 150 then moves to 151 on a 40-share print.
    await fx.quote(PAINT, { day: DAY, at: at('09:30'), last: 150, lastQty: 2000, bid: 150, offer: 151 });
    await fx.quote(PAINT, { day: DAY, at: at('09:40'), last: 151, lastQty: 40, bid: 150, offer: 151 });
    // REAL: price 200 then moves to 201 on a 5,000-share print.
    await fx.quote(REAL, { day: DAY, at: at('09:30'), last: 200, lastQty: 3000, bid: 200, offer: 201 });
    await fx.quote(REAL, { day: DAY, at: at('09:40'), last: 201, lastQty: 5000, bid: 200, offer: 201 });

    console.log('\n=== R-26 · painted vs real ===');
    const mp = await depth.lastMove(PAINT, DAY);
    chk('a 40-share move is painted', mp && mp.painted === true && mp.qty === 40 && mp.priceFils === 151, mp);
    const mr = await depth.lastMove(REAL, DAY);
    chk('a 5,000-share move is not painted', mr && mr.painted === false && mr.qty === 5000, mr);
    // No move in the history → null.
    const NONE = 'SZTESTNOMOVE';
    await fx.clearQuotes(NONE); await fx.instrument(NONE);
    await fx.quote(NONE, { day: DAY, at: at('09:30'), last: 100, lastQty: 500, bid: 100, offer: 101 });
    const mn = await depth.lastMove(NONE, DAY);
    chk('no price move yet → null', mn === null, mn);
    await fx.clearQuotes(NONE); await fx.clearInstruments(NONE);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  for (const s of [PAINT, REAL]) { await fx.clearQuotes(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
