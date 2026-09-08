#!/usr/bin/env node
'use strict';
/**
 * halts:backfill — replay the halt transition detection over the captured
 * awsat_market_quotes history and write HALT / RESUME / NO_RESUME rows marked
 * source = 'BACKFILL' (G-2). Idempotent. Run on kse after report-back 2,
 * alongside A1/A5's measurement; the spec's 203 halts is the check.
 *
 *   node scripts/halts-backfill.js <from YYYY-MM-DD> <to YYYY-MM-DD>
 */
const { pool } = require('../src/db');
const halts = require('../src/services/halts');

(async () => {
  const [from, to] = [process.argv[2], process.argv[3]];
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error('usage: node scripts/halts-backfill.js <from YYYY-MM-DD> <to YYYY-MM-DD>');
    process.exit(2);
  }
  const c = await halts.backfill(from, to);
  console.log(`halts:backfill ${from}..${to} — ${c.days} sessions: ` +
    `${c.HALT} HALT, ${c.RESUME} RESUME, ${c.NO_RESUME} NO_RESUME (source=BACKFILL, idempotent)`);
  const skip = await halts.skipListQuery();
  console.log(`skip-list query (halts ≥ 3, reached5 = 0): ` +
    (skip.length ? skip.map((s) => `${s.symbol} (${s.halts})`).join(', ') : 'none') +
    ' — compare to the seeded MUBARRAD / NIH / TIJARA; change nothing without the operator.');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
