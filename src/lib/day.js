'use strict';
/**
 * ============================================================================
 *  day.js — a trading day is a DAY, not an instant
 * ============================================================================
 * The whole schema is keyed on `trading_day`. Every day value that crosses a
 * boundary — SQL to JavaScript, JavaScript to a log line, a log line to a
 * shell command — has to survive as `YYYY-MM-DD` and nothing else.
 *
 * TWO WAYS THAT HAS ALREADY GONE WRONG, in opposite directions:
 *
 *   Before the driver fix, pg returned a DATE as a JS Date at LOCAL midnight,
 *   so 2026-08-12 serialised as 2026-08-11T18:30:00Z on a UTC+0530 machine —
 *   the DAY BEFORE. The same guard printed both forms for one value.
 *
 *   After the fix, dates arrive as strings and every `.toISOString()` on one
 *   threw `r.d.toISOString is not a function`.
 *
 * So the conversion lives in ONE function that accepts either. A helper is the
 * only shape that survives the next person who does not know which form they
 * have — and neither did I, twice.
 * ============================================================================
 */

/**
 * @param {string|Date|null} v
 * @returns {string|null}  YYYY-MM-DD
 */
function toDay(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    /*
     * getUTC*, not getFullYear. A Date built from a bare date string sits at
     * UTC midnight, and reading it with local getters on a machine west of
     * Greenwich returns the previous day.
     */
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** Walk a date range inclusively, as days. */
function* daysBetween(from, to) {
  let t = new Date(`${toDay(from)}T00:00:00Z`);
  const end = new Date(`${toDay(to)}T00:00:00Z`);
  while (t <= end) {
    yield toDay(t);
    t = new Date(t.getTime() + 86400000);
  }
}

/** Boursa Kuwait trades Sunday to Thursday. Friday and Saturday are closed. */
function isWeekday(day) {
  const d = new Date(`${toDay(day)}T00:00:00Z`).getUTCDay();
  return d >= 0 && d <= 4;
}

module.exports = { toDay, daysBetween, isWeekday };
