/**
 * R-40 · the stale-leg lister names POSTED legs from an earlier session so they
 * can be resolved CANCELLED before the first live session. Today's POSTED leg is
 * not stale; a July one is.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('stalelegs');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const { staleLegs } = require('../src/db/legs-stale');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const OLD = 'SZTESTSTALEA', TODAY = 'SZTESTSTALEB';
const TODAY_DAY = kuwaitDay();

(async () => {
  try {
    for (const s of [OLD, TODAY]) { await fx.clearLegs(s); await fx.instrument(s); }
    // A POSTED leg dated in July, and a POSTED leg dated today.
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, posted_at)
       VALUES ('2026-07-15',$1,1,'BUY','POSTED',238,1000,'2026-07-15T09:51:00Z')`, [OLD]);
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, posted_at)
       VALUES ($1,$2,1,'BUY','POSTED',200,1000,now())`, [TODAY_DAY, TODAY]);

    const rows = await staleLegs(pool, TODAY_DAY);
    const syms = rows.map((r) => r.symbol);
    console.log('\n=== R-40 · stale POSTED legs ===');
    chk('the July POSTED leg is listed', syms.includes(OLD), syms);
    chk("today's POSTED leg is not listed", !syms.includes(TODAY), syms);
    // A resolved (CANCELLED) old leg is not stale — only POSTED ones.
    await pool.query("UPDATE spread.order_leg SET status = 'CANCELLED' WHERE symbol = $1", [OLD]);
    const after = (await staleLegs(pool, TODAY_DAY)).map((r) => r.symbol);
    chk('once cancelled it drops off the list', !after.includes(OLD), after);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  for (const s of [OLD, TODAY]) { await fx.clearLegs(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
