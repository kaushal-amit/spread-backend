#!/usr/bin/env node
'use strict';
/**
 * m45 backfill / on-demand compute (A5). Quotes exist back to July, so a past
 * day can be recomputed — but the row is written ONCE and the job refuses to
 * overwrite, so a re-run only fills days that have no row yet.
 *
 *   node scripts/m45.js <YYYY-MM-DD>
 */
const { pool } = require('../src/db');
const { computeM45 } = require('../src/jobs/m45');

(async () => {
  // No arg → today (the 09:45 cron); an explicit YYYY-MM-DD backfills a past day.
  const day = process.argv[2] || require('../src/jobs/daily').kuwaitDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('usage: node scripts/m45.js [YYYY-MM-DD]   (default: today)');
    process.exit(2);
  }
  const r = await computeM45(day);
  console.log(`m45 ${r.day}: ${r.computed} computed (${r.thin} THIN), ${r.skipped} already present ` +
    `(write-once) · commissionPct ${r.commissionPct}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
