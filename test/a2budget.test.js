/**
 * A2 · the daily analysis sizes off the OPERATOR'S budget, and the columns
 * actually populate.
 *
 * The defect this guards is two-layered:
 *   1. `stats.computeDay` defaulted its budget to the 790 file seed, so when the
 *      account moves to 2,000 the nightly analysis would size at a third.
 *   2. WORSE — `spread.symbol_day_stats` has 0 rows in production: the writer's
 *      output has never landed, so a test that only checked "reads the gate, not
 *      the seed" would pass while nothing is produced. So this test runs the
 *      writer for real and asserts the COLUMNS ARE POPULATED off the gate value —
 *      `budget_kd` and `shares_at_budget` specifically — not just that a resolver
 *      was called.
 *
 * And per the loud-failure rule: with NO session budget set, the writer must
 * THROW, never silently seed 790.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('a2budget');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const stats = require('../src/jobs/stats');
const gateStore = require('../src/services/gateStore');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const SYM = 'SZTESTA2';
const DAY = '2011-02-22';                 // a fossil day, isolated from other suites
const at = (hhmm) => `${DAY}T${hhmm}:00+03:00`;

async function seedMinutes() {
  await fx.clearQuotes(SYM);
  await fx.instrument(SYM);
  // Six minutes, bid>0 & offer>0 (v_quote_screening requires both), a moving
  // last_price so the gate percentages have something to measure. bid = 200 fils.
  const mins = ['09:30', '09:31', '09:32', '09:33', '09:34', '09:35'];
  let px = 205;
  for (const m of mins) {
    await fx.quote(SYM, { day: DAY, at: at(m), last: px, lastQty: 40,
      bid: 200, bidQty: 8000, offer: 202, offerQty: 8000, volume: 5000, trades: 10 });
    px += 1;
  }
}

async function statRow(db) {
  const { rows } = await db.query(
    `SELECT budget_kd, shares_at_budget, minutes_measured, pct_postable, source
       FROM spread.symbol_day_stats WHERE symbol = $1 AND trading_day = $2`, [SYM, DAY]);
  return rows[0] || null;
}

(async () => {
  try {
    await pool.query('DELETE FROM spread.symbol_day_stats WHERE symbol = $1', [SYM]);
    await seedMinutes();

    // ── the budget resolves from the gate, and the columns populate ──
    await gateStore.save({ 'session-budget': 2000 }, { db: pool, changedBy: 'a2-guard-test' });
    await stats.computeDay(DAY, { db: pool });          // no explicit budgetKd → gate

    const r2000 = await statRow(pool);
    chk('computeDay WROTE a symbol_day_stats row (the writer produces output)', r2000 != null, r2000);
    chk('  budget_kd is the gate value 2000, not the 790 seed', r2000 && Number(r2000.budget_kd) === 2000, r2000 && r2000.budget_kd);
    chk('  shares_at_budget is POPULATED (not NULL)', r2000 && r2000.shares_at_budget != null, r2000 && r2000.shares_at_budget);
    chk('  minutes_measured is populated', r2000 && Number(r2000.minutes_measured) > 0, r2000 && r2000.minutes_measured);
    chk('  source marks the backend bridge', r2000 && r2000.source === 'BACKEND_BRIDGE', r2000 && r2000.source);

    // ── the sized column actually flows from the budget (not a literal) ──
    const shares2000 = r2000 && Number(r2000.shares_at_budget);
    await stats.computeDay(DAY, { db: pool, budgetKd: 790 });   // explicit smaller budget
    const r790 = await statRow(pool);
    chk('a 790 budget writes budget_kd 790', r790 && Number(r790.budget_kd) === 790, r790 && r790.budget_kd);
    chk('  and shares_at_budget SHRINKS with the smaller budget (it is not a literal)',
      r790 && Number(r790.shares_at_budget) < shares2000, { at790: r790 && r790.shares_at_budget, at2000: shares2000 });

    // ── no budget set → the writer THROWS, it does not seed 790 ──
    // `sessionBudgetKd()` is null for a non-positive value, so a 0 budget is the
    // "operator set nothing usable" state; computeDay reloads it and must refuse.
    await pool.query('DELETE FROM spread.symbol_day_stats WHERE symbol = $1', [SYM]);
    await gateStore.save({ 'session-budget': 0 }, { db: pool, changedBy: 'a2-guard-test' });
    let threw = null;
    try { await stats.computeDay(DAY, { db: pool }); } catch (e) { threw = e; }
    chk('computeDay THROWS with no session budget (loud, not a silent 790)', threw != null, threw && threw.message);
    chk('  and the error names the missing session budget', threw && /session budget/i.test(threw.message), threw && threw.message);
    chk('  and NO row was written off a guessed number', (await statRow(pool)) == null);

    // ── restore the gate so later suites see a real budget ──
    await gateStore.save({ 'session-budget': 2000 }, { db: pool, changedBy: 'a2-guard-test-restore' });

    await pool.query('DELETE FROM spread.symbol_day_stats WHERE symbol = $1', [SYM]);
    await fx.clearQuotes(SYM);
    console.log(`\na2 budget: ${p}/${n}`);
    await pool.end();
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('a2budget suite error:', e);
    process.exit(1);
  }
})();
