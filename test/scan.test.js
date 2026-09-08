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

  console.log(bad ? `\nFAILURES: ${bad}` : '\nALL PASS  (source scan)');
  if (query) { const { pool } = require('../src/db'); await pool.end(); }
  process.exit(bad ? 1 : 0);
})();
