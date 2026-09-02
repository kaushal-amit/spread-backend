'use strict';
/**
 * ============================================================================
 *  doctor.js — what is missing, and what to do about it
 * ============================================================================
 * `NO_DATA — the scraper did not run` is the correct answer on a database that
 * has been running for months. It is the WRONG answer on a fresh one, where the
 * truth is "nothing has been loaded yet" and the next step is different.
 *
 * This checks each prerequisite in dependency order and stops at the first
 * thing that is missing, because everything after it will fail for the same
 * reason and reporting all of them is noise.
 * ============================================================================
 */

const { pool } = require('../db');
const { toDay: day } = require('../lib/day');

const K = "AT TIME ZONE 'UTC' + interval '3 hours'";

async function check(db = pool) {
  const out = [];
  const add = (name, ok, detail, fix) => out.push({ name, ok, detail, fix });

  // ---- 1 · schema --------------------------------------------------------
  const { rows: [sch] } = await db.query(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='spread';`);
  const tables = Number(sch.n);
  add('schema', tables > 0, `${tables} tables in spread`,
      tables ? null : 'npm run migrate');
  if (!tables) return finish(out);

  // ---- 2 · which source? -------------------------------------------------
  const { rows: [src] } = await db.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_name IN ('stock_quotes','quote') AND table_schema IN ('public','spread')
      ORDER BY CASE table_schema WHEN 'public' THEN 0 ELSE 1 END LIMIT 1;`);
  const source = src ? `${src.table_schema}.${src.table_name}` : null;
  add('quote source', !!source,
      source ? `${source}${src.table_schema === 'spread' ? ' — this database owns it' : ' — read only'}` : 'none found',
      source ? null : 'npm run migrate');
  if (!source) return finish(out);

  // ---- 3 · quotes --------------------------------------------------------
  const { rows: [q] } = await db.query(
    `SELECT count(*) AS rows,
            count(DISTINCT symbol) AS symbols,
            count(DISTINCT (created_at ${K})::date) AS days,
            min((created_at ${K})::date) AS oldest,
            max((created_at ${K})::date) AS newest
       FROM ${source};`);
  const quoteRows = Number(q.rows);
  add('quotes', quoteRows > 0,
      quoteRows
        ? `${quoteRows.toLocaleString('en-US')} rows · ${q.symbols} symbols · ` +
          `${q.days} days · ${day(q.oldest)} to ${day(q.newest)}`
        : 'empty',
      quoteRows ? null
        : src.table_schema === 'spread'
          ? `${source} is empty. Either repoint the scrapers at it, or copy the existing ` +
            'data across — see RUN_BACKFILL.md. Everything downstream needs this first.'
          : 'the scrapers have not written anything');
  if (!quoteRows) return finish(out);

  // ---- 4 · calendar ------------------------------------------------------
  const { rows: [cal] } = await db.query(
    `SELECT count(*) FILTER (WHERE is_session) AS sessions,
            count(*) FILTER (WHERE is_session AND trading_day BETWEEN $1 AND $2) AS in_range
       FROM spread.trading_day;`, [q.oldest, q.newest]);
  add('calendar', Number(cal.in_range) > 0,
      `${cal.sessions} session days, ${cal.in_range} inside the quote range`,
      Number(cal.in_range) ? null : 'npm run calendar');

  // ---- 5 · symbols -------------------------------------------------------
  const { rows: [sym] } = await db.query('SELECT count(*) AS n FROM spread.symbol;');
  const symbols = Number(sym.n);
  add('symbols', symbols > 0, `${symbols} registered`,
      symbols ? null
        : 'spread.symbol is empty, so the `missing` step writes no rows and a scraper ' +
          'failure stays invisible. Seed it: npm run seed:symbols');

  // ---- 6 · computed days -------------------------------------------------
  const { rows: [sd] } = await db.query(
    `SELECT count(DISTINCT trading_day) AS days, max(trading_day) AS newest
       FROM spread.symbol_day;`);
  const computed = Number(sd.days);
  /*
   * The suggested command must be COPY-PASTEABLE. It previously printed
   *   npm run job:daily Tue Jul 14 2026 00:00:00 GMT+0530 (India Standard Time) ...
   * because a pg DATE arrived as a JS Date. The driver now returns dates as
   * strings; `day()` is belt and braces for anything that still does not.
   */
  add('computed metrics', computed > 0,
      computed ? `${computed} days, latest ${day(sd.newest)}` : 'none',
      computed ? null
        : `npm run job:daily ${day(q.oldest)} ${day(q.newest)}   ` +
          '(oldest first — each day needs the one before it)');

  // ---- 7 · depth, for CR-34 ---------------------------------------------
  //
  // Counting rows is not enough. The signal reads bid_qty and offer_qty, and a
  // column that did not map is a silent NULL rather than an error — the signal
  // then reads WAIT forever without saying why.
  // A row is not a snapshot: ten levels share one capture_id. Reporting rows
  // overstates the CR-34 sample tenfold.
  const { rows: [d] } = await db.query(
    `SELECT count(*) AS rows,
            count(DISTINCT capture_id) AS captures,
            count(DISTINCT symbol) AS symbols,
            count(*) FILTER (WHERE bid_qty IS NOT NULL AND offer_qty IS NOT NULL) AS usable
       FROM spread.depth;`)
    .catch(() => ({ rows: [{ rows: 0, captures: 0, symbols: 0, usable: 0 }] }));

  const depthRows = Number(d.rows);
  const captures = Number(d.captures);
  const usable = Number(d.usable);
  add('depth', depthRows === 0 || usable > 0,
      depthRows === 0
        ? 'none — the depth signal cannot run. It needs 100+ snapshots per symbol per session.'
        : `${captures.toLocaleString('en-US')} captures (${depthRows.toLocaleString('en-US')} rows × ten levels), ` +
          `${d.symbols} symbols, ${usable.toLocaleString('en-US')} rows with quantities`,
      depthRows > 0 && usable === 0
        ? 'rows are present but bid_qty/offer_qty are all NULL — the import did not map onto ' +
          'the columns CR-34 reads. Run scripts/inspect-depth.sql and align the mapping.'
        : null);

  /*
   * V-04 · orphaned open buys.
   *
   * Neither `contracts()` nor `accountSummary()` bounds by trading day, which
   * is correct for a genuinely carried position. But a buy left open by the
   * A-02 bug looks identical to one deliberately carried, and it inflates
   * investedKd and blocks new claims for as long as it sits there.
   *
   * Worth running once before the first live session, and cheap to keep.
   */
  const { rows: orphans } = await db.query(
    `SELECT l.symbol, l.contract_seq, l.trading_day, l.price_fils,
            COALESCE(l.filled_shares, l.shares) AS shares
       FROM spread.order_leg l
      WHERE l.side='BUY' AND l.status IN ('FILLED','CARRIED')
        AND NOT EXISTS (SELECT 1 FROM spread.order_leg s
                         WHERE s.symbol=l.symbol AND s.contract_seq=l.contract_seq
                           AND s.side='SELL' AND s.status='FILLED')
        AND l.trading_day < current_date
      ORDER BY l.trading_day;`).catch(() => ({ rows: [] }));

  add('open positions', orphans.length <= 1,
      orphans.length === 0
        ? 'none carried from a prior session'
        : orphans.map((o) => `${o.symbol} seq ${o.contract_seq} from ${day(o.trading_day)} ` +
            `(${Number(o.shares).toLocaleString('en-US')} @ ${o.price_fils})`).join(' · '),
      orphans.length > 1
        ? 'more than one position is open across sessions. Rule 8 says never carry overnight, ' +
          'so this is either a real carry that needs closing or a leg orphaned by a past bug. ' +
          'Check each against the broker before trading.'
        : null);

  return finish(out);
}

function finish(checks) {
  const firstBlocked = checks.find((c) => !c.ok);
  return {
    ok: !firstBlocked,
    checks,
    // One next step, not a list. Everything after the first failure fails for
    // the same reason and printing all of them is noise.
    next: firstBlocked ? { step: firstBlocked.name, do: firstBlocked.fix } : null,
  };
}

module.exports = { check };

if (require.main === module) {
  check()
    .then((r) => {
      console.log('');
      for (const c of r.checks) {
        console.log(`  ${c.ok ? '✓' : '✗'}  ${c.name.padEnd(18)} ${c.detail}`);
      }
      console.log('');
      if (r.next) {
        console.log(`  Next: ${r.next.do}`);
      } else {
        console.log('  Everything is in place.');
      }
      console.log('');
      process.exit(0);
    })
    .catch((e) => require('../lib/dberror').die(e));
}
