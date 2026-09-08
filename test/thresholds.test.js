/**
 * R-36 · the ONE threshold store (BACKEND_spec §1.1).
 *   · every gate threshold with a kb_threshold row is sourced from the table,
 *     loaded once, not from spread.config.js
 *   · change 30 → 45 in the table + reload → the 2-tick gap gate moves
 *   · a missing REQUIRED key aborts the load NAMING it (a boot failure, not a
 *     silent default at request time)
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('thresholds');
const { pool } = require('../src/db');
const thresholds = require('../src/config/thresholds');
const gateStore = require('../src/services/gateStore');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    await thresholds.load();
    await gateStore.load();

    console.log('\n=== the gate thresholds come from the table, not the file ===');
    const g0 = gateStore.effective();
    chk('a gate value matches its kb_threshold row', g0.GATES.minPriceMoves === thresholds.get('moves_min'), g0.GATES.minPriceMoves);
    chk('  and the 2-tick gap gate reads gap2_min_pct', g0.TARGETS.minGapPctFor2Tick === thresholds.get('gap2_min_pct'), g0.TARGETS.minGapPctFor2Tick);
    chk('  a kb-only gate (no board control) is sourced too', g0.GATES.minPctExitableForSize === thresholds.get('exitable_size_min_pct'), g0.GATES.minPctExitableForSize);

    console.log('\n=== change 30 → 45 in the table, reload, the gate moves ===');
    const was = thresholds.get('gap2_min_pct');
    await gateStore.writeThreshold('gap2_min_pct', 45, { changedBy: 'test' });
    chk('the store now reads 45', thresholds.get('gap2_min_pct') === 45, thresholds.get('gap2_min_pct'));
    chk('  and the effective 2-tick gap gate is 45', gateStore.effective().TARGETS.minGapPctFor2Tick === 45, gateStore.effective().TARGETS.minGapPctFor2Tick);
    // restore
    await gateStore.writeThreshold('gap2_min_pct', was, { changedBy: 'test' });
    chk('  restored', gateStore.effective().TARGETS.minGapPctFor2Tick === was, gateStore.effective().TARGETS.minGapPctFor2Tick);

    console.log('\n=== a missing REQUIRED key aborts the load naming it ===');
    // A fake pool whose SELECT returns every seeded row EXCEPT one required key.
    const real = await pool.query('SELECT key, value FROM spread.kb_threshold WHERE still_true');
    const dropped = 'moves_min';
    const fakeDb = { query: async () => ({ rows: real.rows.filter((r) => r.key !== dropped) }) };
    let threw = null;
    try { await thresholds.load(fakeDb); } catch (e) { threw = e; }
    chk('load throws when a required key is gone', threw != null);
    chk('  and the message names the missing key', threw != null && new RegExp(dropped).test(threw.message), threw && threw.message);
    // reload the real table so the store is left valid
    await thresholds.load();
    chk('the real store reloads clean', thresholds.get('moves_min') != null, thresholds.get('moves_min'));
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await gateStore.writeThreshold('gap2_min_pct', 30, { changedBy: 'test' }).catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
