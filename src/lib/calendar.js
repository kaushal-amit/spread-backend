'use strict';
/**
 * ============================================================================
 *  lib/calendar.js — is this day a session? (one answer for every job)
 * ============================================================================
 * Three reasons a day is not a session, in the order they are checked:
 *   weekend    Friday / Saturday — the rule, no table needed
 *   holiday    spread.trading_day.is_session = false (seeded by migration 039
 *              and `npm run calendar`; the Council of Ministers adds closures
 *              by hand)
 *   unknown    no row — treated as a session (Sun–Thu), so a calendar that is
 *              not seeded that far ahead never silences a job
 *
 * A job asks this BEFORE deciding that "no quotes" is a failure: a holiday is
 * a skip with a log line, an empty session day is a loud red.
 * ============================================================================
 */
const { pool } = require('../db');
const { toDay } = require('./day');

const dow = (day) => new Date(`${toDay(day)}T00:00:00Z`).getUTCDay();
const isWeekend = (day) => { const d = dow(day); return d === 5 || d === 6; };

/** { session: boolean, reason: 'weekend'|'holiday'|'unknown'|'session', name } */
async function sessionDay(day, db = pool) {
  const d = toDay(day);
  if (isWeekend(d)) return { session: false, reason: 'weekend', name: null };
  // A read that fails is a failure, not "unknown → session": the caller would
  // then blame the capture for a day the calendar could not be asked about.
  const { rows: [r] } = await db.query(
    'SELECT is_session, holiday_name FROM spread.trading_day WHERE trading_day = $1::date;', [d]);
  if (!r) return { session: true, reason: 'unknown', name: null };
  if (r.is_session === false) return { session: false, reason: 'holiday', name: r.holiday_name || null };
  return { session: true, reason: 'session', name: null };
}

module.exports = { sessionDay, isWeekend };
