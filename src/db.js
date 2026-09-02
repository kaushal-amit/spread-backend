'use strict';
require('dotenv').config();
const { Pool, types } = require('pg');

/*
 * A DATE IS A DAY, NOT AN INSTANT.
 *
 * By default `pg` turns a DATE column into a JS Date at LOCAL midnight. On a
 * machine at UTC+0530 the date 2026-08-12 becomes 2026-08-11T18:30:00Z — the
 * DAY BEFORE — and every downstream comparison, log line and JSON payload is
 * off by one.
 *
 * The observed symptom was a guard reporting
 *
 *   "prev": "2026-08-11T18:30:00.000Z"
 *   "Wed Aug 12 2026 00:00:00 GMT+0530 (India Standard Time) has no rows"
 *
 * for the same value. Both were 12 August; neither said so.
 *
 * This matters more here than in most systems: the whole schema is keyed on
 * trading_day, spread.prev_session() returns a date, and a day-boundary error
 * is exactly the class of bug that function exists to prevent.
 *
 * OID 1082 is DATE. Returned as the string it already is in the database.
 */
types.setTypeParser(1082, (v) => v);

/*
 * OID 1700 is NUMERIC, which pg returns as a string to avoid losing precision.
 * That is right for money — commission is verified to three decimals — so it
 * is left alone deliberately. Callers use Number() where they mean a float.
 */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  // A screening query that hangs blocks the tick loop. Fail instead.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20000)
});

pool.on('error', (e) => console.error('[db] idle client error:', e.message));

const ping = async () => (await pool.query('SELECT now() AS t')).rows[0].t;

module.exports = { pool, ping };
