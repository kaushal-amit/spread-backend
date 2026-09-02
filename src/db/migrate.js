'use strict';
/**
 * ============================================================================
 *  migrate.js — apply SQL migrations once, in order, safely
 * ============================================================================
 * Runs on every boot. Four properties matter more than cleverness:
 *
 *   IDEMPOTENT   every file is IF NOT EXISTS / CREATE OR REPLACE, and each is
 *                recorded so it is never attempted twice
 *   ORDERED      lexical by filename, so 001 lands before 002
 *   SERIALISED   a Postgres advisory lock, so two instances booting together
 *                cannot both apply the same file
 *   HONEST       a file whose contents changed after being applied is reported
 *                as DRIFT — the database and the repository disagree, and
 *                nobody finds out until something reads a column that was
 *                never added
 *
 * Each file runs in its own transaction. A failure rolls that file back and
 * STOPS the run: a half-applied schema is worse than an unapplied one, because
 * the next thing to read it gets a confident answer from a table that is only
 * partly there.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../db');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 8471023;   // arbitrary, fixed, shared by every instance

const TRACKING = `
CREATE SCHEMA IF NOT EXISTS spread;
CREATE TABLE IF NOT EXISTS spread.schema_migration (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms int
);`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

async function migrate({ dryRun = false, db = pool, log = console } = {}) {
  await db.query(TRACKING);

  const client = await db.connect();
  const out = { applied: [], skipped: [], drift: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint);', [LOCK_KEY]);

    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

    /*
     * TWO FILES SHARING A NUMBER IS AN ORDERING HAZARD, and it is what happens
     * when a new zip is extracted over an old one: the renamed file lands
     * beside the file it replaced and BOTH run.
     *
     * Lexical order then decides which, and the loser fails against a schema
     * the winner already changed — which is exactly the confusing error this
     * check replaces:
     *
     *   applied 002_source_tables_and_views.sql
     *   002_source_views.sql failed: relation "public.stock_quotes" does not exist
     *
     * Refuse rather than guess. Whichever is stale, deleting it is the fix and
     * the runner should say which two are in conflict.
     */
    const byNumber = new Map();
    for (const f of files) {
      const n = (f.match(/^(\d+)/) || [])[1];
      if (!n) continue;
      if (!byNumber.has(n)) byNumber.set(n, []);
      byNumber.get(n).push(f);
    }
    const clashes = [...byNumber.entries()].filter(([, fs_]) => fs_.length > 1);
    if (clashes.length) {
      const detail = clashes
        .map(([n, fs_]) => `  ${n}: ${fs_.join('  and  ')}`).join('\n');
      throw new Error(
        'two migrations share a number, so their order is ambiguous:\n' + detail +
        '\n\nThis usually means a new package was extracted over an old one. ' +
        'Delete whichever file is stale and run again — nothing has been applied.');
    }
    const { rows } = await client.query(
      'SELECT filename, checksum FROM spread.schema_migration;');
    const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      const sum = sha(sql);

      if (seen.has(file)) {
        if (seen.get(file) !== sum) {
          out.drift.push(file);
          log.warn(`[migrate] DRIFT — ${file} has changed since it was applied. ` +
                   'The database does not match this file. Add a new migration ' +
                   'rather than editing an applied one.');
        } else {
          out.skipped.push(file);
        }
        continue;
      }

      if (dryRun) { out.applied.push(file); continue; }

      const t0 = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO spread.schema_migration (filename, checksum, duration_ms)
           VALUES ($1,$2,$3) ON CONFLICT (filename) DO NOTHING;`,
          [file, sum, Date.now() - t0]);
        await client.query('COMMIT');
        out.applied.push(file);
        log.log(`[migrate] applied ${file}  (${Date.now() - t0}ms)`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed and was rolled back: ${e.message}`);
      }
    }
    return out;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint);', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => {
      console.log(`applied ${r.applied.length}, skipped ${r.skipped.length}` +
                  (r.drift.length ? `, DRIFT: ${r.drift.join(', ')}` : ''));
      process.exit(r.drift.length ? 1 : 0);
    })
    .catch((e) => require('../lib/dberror').die(e));
}
