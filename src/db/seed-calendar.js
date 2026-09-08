'use strict';
/**
 * ============================================================================
 *  seed-calendar.js — populate spread.trading_day
 * ============================================================================
 * Boursa Kuwait trades SUNDAY TO THURSDAY. Friday and Saturday are the
 * weekend, which is why a `- 1 day` offset for "the previous session" is wrong
 * twice a week before you even reach the missing days.
 *
 * Two sources, in order:
 *   1. Days that carry a trading_date in public.awsat_market_quotes — ground truth
 *   2. Sun-Thu fill-in for the rest of the range, so future days exist
 *
 * Holidays are marked by hand. A day with no quotes and no holiday name is
 * flagged in data_alarm rather than assumed — the difference between a public
 * holiday and a dead scraper is the whole point.
 * ============================================================================
 */

const { pool } = require('../db');
const { toDay, daysBetween, isWeekday } = require('../lib/day');


async function seed({ from = '2026-01-01', to = null, db = pool, log = console } = {}) {
  const end = to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  // ---- 1 · days with real quotes are sessions, whatever the calendar says --
  // 3.9 · the scraper stamps trading_date on every quote. That is the day the
  // session traded, no conversion needed — and it is what 019 seeds from too.
  const { rows: observed } = await db.query(
    `SELECT DISTINCT trading_date AS d
       FROM public.awsat_market_quotes
      WHERE trading_date BETWEEN $1 AND $2
      ORDER BY d;`, [from, end]).catch(() => ({ rows: [] }));

  // toDay, not toISOString. The driver returns DATE as a string and calling a
  // Date method on one threw `r.d.toISOString is not a function`.
  const seen = new Set(observed.map((r) => toDay(r.d)));

  if (seen.size === 0) {
    /*
     * No quotes means the calendar is the Sunday-Thursday rule and nothing
     * else. That is enough for prev_session() to skip weekends, but HOLIDAYS
     * ARE UNKNOWN — and a holiday marked as a session makes "the previous
     * session" wrong by a day for everything after it.
     *
     * Say so rather than reporting a confident 315.
     */
    log.warn('[calendar] no quotes found, so this is the Sunday-Thursday rule only. ' +
             'Holidays are NOT known and will be marked as sessions. Re-run after the ' +
             'quotes are loaded and observed days will correct it.');
  } else {
    log.log(`[calendar] ${seen.size} days observed in the quotes`);
  }

  // ---- 2 · fill the range -------------------------------------------------
  const rows = [];
  for (const day of daysBetween(from, end)) {
    // Observation beats the weekday rule: a holiday that traded is a session.
    rows.push([day, seen.has(day) || isWeekday(day)]);
  }

  let n = 0;
  for (const [day, isSession] of rows) {
    await db.query(
      `INSERT INTO spread.trading_day (trading_day, is_session)
       VALUES ($1, $2)
       ON CONFLICT (trading_day) DO UPDATE
         -- Never downgrade a day we have quotes for. Observation beats the
         -- weekday rule; a holiday that traded is a session.
         SET is_session = spread.trading_day.is_session OR EXCLUDED.is_session;`,
      [day, isSession]);
    n++;
  }

  /*
   * A weekday inside the observed range with no quotes is either a holiday or
   * a scraper failure, and those look identical. Raise it rather than guess.
   */
  const first = [...seen].sort()[0];
  const last = [...seen].sort().slice(-1)[0];
  if (first && last) {
    const { rows: gaps } = await db.query(
      `SELECT trading_day FROM spread.trading_day
        WHERE is_session AND trading_day BETWEEN $1 AND $2
          AND NOT EXISTS (
            SELECT 1 FROM public.awsat_market_quotes q
             WHERE q.trading_date = spread.trading_day.trading_day)
        ORDER BY trading_day;`, [first, last]);

    for (const g of gaps) {
      await db.query(
        `INSERT INTO spread.data_alarm (trading_day, table_name, alarm, detail)
         VALUES ($1, 'awsat_market_quotes', 'NO_ROWS',
                 jsonb_build_object('note',
                   'weekday inside the observed range with no quotes — holiday or scraper failure, and those look identical'))
         ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                      COALESCE(column_name, ''), COALESCE(symbol, ''))
         WHERE resolved_at IS NULL DO NOTHING;`, [g.trading_day]);
    }
    if (gaps.length) {
      log.warn(`[calendar] ${gaps.length} session days with no quotes — raised in data_alarm`);
    }
  }

  return {
    written: n, observed: seen.size, from, to: end,
    // Weekday-rule-only is a different thing from a calendar built on
    // observation, and the caller should be able to tell them apart.
    source: seen.size ? 'observed + weekday rule' : 'weekday rule only — holidays unknown',
    holidaysKnown: seen.size > 0,
  };
}

module.exports = { seed };

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  seed({ from: arg('--from') || '2026-01-01', to: arg('--to') })
    .then((r) => { console.log(JSON.stringify(r, null, 1)); process.exit(0); })
    .catch((e) => require('../lib/dberror').die(e));
}
