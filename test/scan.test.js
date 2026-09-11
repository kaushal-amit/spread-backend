/**
 * The source scan, as a test.
 *
 * Checks 1 and 4 FAIL: a called-but-undefined function or an orphaned module
 * is unambiguous. Checks 2 and 3 WARN FOREVER — a table with no INSERT is often
 * correct, and failing on it would train someone to add allowlist entries to
 * make the build pass, which converts a signal into paperwork.
 */
const { scan } = require('../scripts/source-scan');
const fs = require('fs');
const path = require('path');

(async () => {
  let query = null;
  // dbguard: read-only — this suite only reads information_schema, so it may
  // look at ANY database. Everything that writes goes behind requireTestDb().
  if (process.env.DATABASE_URL) {
    try {
      const { pool } = require('../src/db');
      await pool.query('SELECT 1');
      query = (sql, params) => pool.query(sql, params);
    } catch { /* the source checks still run */ }
  }

  const r = await scan({ query, entryPoints: ['src/index.js', 'src/mcp/server.js',
    // the npm scripts — each is a process of its own
    'src/jobs/stats/index.js', 'src/jobs/import-fills.js', 'src/jobs/reconcile-fees.js',
    'src/db/migrate.js', 'src/db/doctor.js', 'src/db/seed-calendar.js', 'scripts/import-kb.js'] });
  console.log(r.lines.join('\n'));

  // Every allowlist entry states a reason and an expiry. Missing either is
  // itself a finding — that is what stops an exemption becoming permanent by
  // omission.
  const allow = JSON.parse(fs.readFileSync(path.join(__dirname, '../scan-allow.json'), 'utf8'));
  let bad = r.failed;
  for (const kind of ['columns', 'tables', 'modules', 'functions']) {
    for (const e of allow[kind] || []) {
      if (!e.reason || !e.until) { bad += 1; console.log(`  FAIL ${kind}.${e.name} is missing a reason or an expiry`); }
    }
  }

  /*
   * CR-8 · NOTHING REMOVED FROM THE BOARD — the guard that keeps the three
   * removal paths from coming back:
   *   R1  a join FROM symbol_day (a symbol with no row was absent)
   *   R2  a WHERE on capture_quality (MISSING rows were dropped)
   *   R3  a .filter( on `results` before the buckets (out-of-reach rows vanished)
   * plus HAVING anywhere in the screen or the presenter — a floor on a
   * STATISTIC belongs in the stats job; a floor on a SYMBOL is the bug.
   */
  {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/screening.js'), 'utf8');
    const pres = fs.readFileSync(path.join(__dirname, '../src/api/present.js'), 'utf8');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(--|\/\/).*$/gm, '');
    const code = strip(src), pcode = strip(pres);
    const f = (cond, msg) => { if (!cond) { bad += 1; console.log('  FAIL CR-8 guard: ' + msg); } };
    f(!/\bHAVING\b/i.test(code) && !/\bHAVING\b/i.test(pcode), 'HAVING in screening.js/present.js — a symbol-level floor removes a row');
    f(!/WHERE[^;]*capture_quality/i.test(code), 'WHERE … capture_quality in the screen query — a capture grade is a mark on the row, never a filter');
    f(/FROM\s+public\.instruments\s+s\b/.test(code) && /LEFT JOIN spread\.symbol_day d\b/.test(code), 'the screen must select FROM public.instruments LEFT JOIN spread.symbol_day — the universe is the instrument list');
    const a = code.indexOf('const results = rows.map('), b = code.lastIndexOf('bucketize(results, {');
    f(a > 0 && b > a, 'screening.js must hand `results` to bucketize()');
    f(!/\bresults\s*\.\s*filter\s*\(/.test(code.slice(a, b)), 'a results.filter( before the buckets — that is how out-of-reach rows vanished (R3)');
    f(/UNIVERSE_MISMATCH/.test(code), 'the universe assertion (UNIVERSE_MISMATCH) must stay');
  }

  console.log(bad ? `\nFAILURES: ${bad}` : '\nALL PASS  (source scan)');
  if (query) { const { pool } = require('../src/db'); await pool.end(); }
  process.exit(bad ? 1 : 0);
})();
