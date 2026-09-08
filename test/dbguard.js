'use strict';
/**
 * ============================================================================
 *  test/dbguard.js — a DB-backed suite runs ONLY against a *_test database
 * ============================================================================
 * The suites under test/ insert, update and delete rows — in spread.* and, for
 * fixtures the code under test reads, in public.*. Run against the trading
 * database they erase the session: sizing.test.js once deleted every
 * order_leg and cash_movement row for the day. Nothing in the harness knew.
 *
 * Two outcomes, neither of them "carry on and hope":
 *
 *   no DATABASE_URL            → SKIP, exit 0. The suite needs Postgres and
 *                                 says so. `npm test` stays green on a clean
 *                                 checkout instead of failing with
 *                                 ECONNREFUSED.
 *   a database not named *_test → REFUSED, exit 1. Not a warning. A warning
 *                                 is read once and then scrolls past.
 *
 * Every DB suite calls requireTestDb() BEFORE requiring src/db, so a refusal
 * never opens a connection to the database it is refusing.
 * ============================================================================
 */

function dbName(url) {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); }
  catch { return ''; }
}

function requireTestDb(suite) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log(`\n=== ${suite} ===\n  SKIP  no DATABASE_URL — this suite needs a Postgres database named *_test\n`);
    process.exit(0);
  }
  const name = dbName(url);
  if (!/_test$/i.test(name)) {
    console.error(
      `\n=== ${suite} ===\n` +
      `  REFUSED  DATABASE_URL points at "${name || url}".\n` +
      '           DB suites write and delete rows. They run only against a database\n' +
      '           whose name ends in _test. Create one (createdb kse_test, then\n' +
      '           npm run migrate against it) and point DATABASE_URL there.\n');
    process.exit(1);
  }
  return name;
}

module.exports = { requireTestDb, dbName };
