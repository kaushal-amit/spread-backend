/**
 * R-12 · a claim placed for date D is counted by assertPositionRoom on D, not D−1.
 * R-13 · the position-limit message names the slot and the computed fee band —
 *        no KD or fee figure in a string literal.
 *
 * The PLANNING mode (date= in the body) writes a claim for a future session; the
 * position check on that session must see it, or a second claim slips the limit.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('claimday');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const { assertPositionRoom } = require('../src/api/trading_routes');
const rules = require('../src/lib/orderRules');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const A = 'SZTESTCLAIMA', B = 'SZTESTCLAIMB';
const D = '2001-01-08', DPREV = '2001-01-07';

(async () => {
  try {
    await require('../src/services/gateStore').load().catch(() => {});
    for (const s of [A, B]) { await fx.instrument(s); await pool.query('DELETE FROM spread.claim WHERE symbol = $1', [s]); }
    // A claim for the FUTURE session D (the planning mode).
    await pool.query(
      `INSERT INTO spread.claim (trading_day, symbol, amount_kd, is_override, placement)
       VALUES ($1,$2,500,false,null) ON CONFLICT (trading_day, symbol) DO UPDATE SET amount_kd = 500;`, [D, A]);

    console.log('\n=== R-12 · the claim is counted on its own day ===');
    let refusedOnD = false;
    try { await assertPositionRoom(pool, { exceptSymbol: B, day: D }); }
    catch (e) { refusedOnD = e.code === 'REFUSED' && /SZTESTCLAIMA \(claimed\)/.test(e.detail || ''); }
    chk('a second position on D is refused — the D claim is counted', refusedOnD);
    let allowedOnPrev = true;
    try { await assertPositionRoom(pool, { exceptSymbol: B, day: DPREV }); }
    catch { allowedOnPrev = false; }
    chk('the same check on D−1 is allowed — the claim does not count on the day before', allowedOnPrev);

    console.log('\n=== R-13 · the message names the slot and the fee band, no literal ===');
    const msg = rules.checkNewPosition({ openPositions: 1, maxPositions: 1, slotKd: 2000, feeSingleKd: 6.5, feeSplitKd: 9.4 }).message;
    chk('the message names the slot 2,000', /2000 KD/.test(msg), msg);
    chk('  and the computed fee band, not 790/3.40', /6\.50 to 9\.40/.test(msg) && !/790|3\.40/.test(msg), msg);
    const fallback = rules.checkNewPosition({ openPositions: 1, maxPositions: 1 }).message;
    chk('  with no numbers supplied it still refuses and carries no fee literal', /already open/.test(fallback) && !/790|3\.40/.test(fallback), fallback);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  for (const s of [A, B]) { await pool.query('DELETE FROM spread.claim WHERE symbol = $1', [s]).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
