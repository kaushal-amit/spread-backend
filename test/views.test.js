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
const { pool } = require('../src/db');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('\n=== view content ===\n  SKIP  no DATABASE_URL — these need real Postgres\n');
    return;
  }
  let bad = 0;
  console.log('\n=== the views return rows, not just resolve ===');
  try {
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
  } catch (e) {
    console.log(`  FAIL could not read the views — ${e.message.slice(0, 80)}`);
    bad++;
  }
  try { await pool.end(); } catch {}
  console.log(bad ? `\nFAILURES: ${bad}` : '\nALL PASS  (7 checks)');
  process.exit(bad ? 1 : 0);
})();
