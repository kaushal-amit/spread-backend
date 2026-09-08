/**
 * ─── THE ASSERTION THAT WAS MISSING ────────────────────────────────────────
 *
 * All 256 checks passed while every view returned zero rows. The detection in
 * 002 named public.stock_quotes — the PRE-RENAME table — so on kse it took the
 * ELSE arm, created empty spread.quote and spread.depth, and pointed the views
 * at those. No error, no failing check, and every endpoint would have served
 * zeros against a database full of data.
 *
 * A view that RESOLVES is not a view that RETURNS anything, and nothing in the
 * suite knew the difference.
 */
/**
 * Uses the APP'S pool, not a bare Client.
 *
 * A hand-rolled `new Client({ connectionString })` ignores everything else the
 * application configures — and against RDS that means a self-signed
 * certificate chain rejects the connection while every other part of the
 * backend connects fine. A test that connects differently from the app is
 * testing a different thing.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('views');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);

/**
 * A schema-only kse_test (pg_dump -s) holds no captures, so the rows the views
 * must return are SEEDED — one print per session label, one depth level, one
 * daily bar — and removed at the end. On a database that has data as well the
 * assertions still hold; the seed only adds.
 */
const SYM = 'SZTESTVIEW', DAY = fx.TEST_DAY;
async function seed() {
  await fx.instrument(SYM);
  let m = 0;
  for (const session of ['Trading', 'CB Auction', '', 'Close Auction Acceptance']) {
    await fx.quote(SYM, { day: DAY, at: `${DAY}T06:${String(m++).padStart(2, '0')}:00Z`, session,
      last: 200, bid: 199, offer: 200, volume: 1000 * (m + 1), trades: m + 1 });
  }
  await fx.depthLevel(SYM, { level: 1, bid: 199, bidQty: 5000, offer: 200, offerQty: 4000 });
  await fx.daily(SYM, DAY, { open: 199, high: 201, low: 198, close: 200, volume: 4000 });
}
async function clean() {
  await fx.clearQuotes(SYM); await fx.clearDepth(SYM); await fx.clearDaily(SYM);
  await fx.clearInstruments(SYM);
}

(async () => {
  let bad = 0;
  console.log('\n=== the views return rows, not just resolve ===');
  try {
    await seed();
    for (const v of ['v_quote', 'v_quote_screening', 'v_depth', 'v_daily']) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM spread.${v}`);
      if (rows[0].n > 0) console.log(`  OK   spread.${v} returns ${rows[0].n} row(s)`);
      else { bad++; console.log(`  FAIL spread.${v} RESOLVES BUT IS EMPTY`); }
    }

    // v_quote_screening must carry CB Auction and the blank label. Trading-only
    // drops 26.8M shares of circuit-breaker trading and 12,550 July rows whose
    // session field was never captured.
    const { rows: s } = await pool.query(
      `SELECT count(*) FILTER (WHERE session = 'CB Auction')::int AS cb,
              count(*) FILTER (WHERE session = '')::int AS blank
         FROM spread.v_quote_screening`);
    if (s[0].cb > 0) console.log(`  OK   screening keeps CB Auction (${s[0].cb} rows)`);
    else { bad++; console.log('  FAIL screening drops CB Auction — executable trading after a halt'); }
    if (s[0].blank > 0) console.log(`  OK   screening keeps the blank label (${s[0].blank} rows)`);
    else { bad++; console.log('  FAIL screening drops blank-labelled rows — a July capture defect, not a state'); }

    /**
     * v_depth must hold ONE row per (symbol, level, captured_at).
     *
     * Asserting `deduped < raw` was wrong: with only one writer active there
     * are no duplicates and the two counts are equal, which is correct
     * behaviour. The property that matters is that no key appears twice —
     * true whether or not duplicates exist upstream.
     */
    const { rows: d } = await pool.query(
      `SELECT (SELECT count(*)::int FROM awsat_stock_depth) AS raw,
              (SELECT count(*)::int FROM spread.v_depth) AS deduped,
              (SELECT count(*)::int FROM (
                 SELECT symbol, level, captured_at FROM spread.v_depth
                  GROUP BY 1,2,3 HAVING count(*) > 1) x) AS dupes`);
    if (d[0].dupes === 0) {
      console.log(`  OK   v_depth has no duplicate key (${d[0].deduped} of ${d[0].raw} raw row(s))`);
    } else {
      bad++;
      console.log(`  FAIL v_depth has ${d[0].dupes} duplicated key(s) — server and client writes double-count`);
    }
    // The auction band is EXCLUDED from executable prints.
    const { rows: ex } = await pool.query(
      `SELECT count(*)::int AS n FROM spread.v_quote WHERE symbol = $1 AND session = 'Close Auction Acceptance'`, [SYM]);
    if (ex[0].n === 0) console.log('  OK   v_quote excludes Close Auction Acceptance');
    else { bad++; console.log('  FAIL v_quote carries the auction band'); }
  } catch (e) {
    console.log(`  FAIL could not read the views — ${e.message.slice(0, 80)}`);
    bad++;
  }
  try { await clean(); } catch (e) { bad++; console.log(`  FAIL cleanup — ${e.message.slice(0, 80)}`); }
  try { await pool.end(); } catch {}
  console.log(bad ? `\nFAILURES: ${bad}` : '\nALL PASS  (8 checks)');
  process.exit(bad ? 1 : 0);
})();
