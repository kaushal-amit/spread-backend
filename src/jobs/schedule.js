'use strict';
/**
 * ============================================================================
 *  jobs/schedule.js — SPR-28 · the 13:45 stats slot, actually scheduled
 * ============================================================================
 * DIAGNOSIS (live prod, 2026-09-10, read-only):
 *   spread.symbol_day_stats  — 0 rows, EVER. The bridge table the gate columns
 *                              (6/7/8/9/10) read is empty on every session.
 *   public.symbol_day        — 5,305 rows, today present. The scraper's side is
 *                              fine; the sessions exist.
 *   src/**                   — NO scheduler. The only setInterval outside the
 *                              socket scanners is ratelimit.js. `npm run
 *                              stats:daily` is a MANUAL script and nothing ever
 *                              invoked it.
 *   spread.gate_config       — session-budget = 800, so resolveBudgetKd() does
 *                              NOT throw; the job would have run cleanly.
 *
 * VERDICT: the job (jobs/stats + reconcile-fees, bundled by runDaily) is
 * correct — it was simply never scheduled. Not "the job never writes"; "the
 * cron line was missing". So this module adds exactly that, plus the two things
 * a first deploy of a missing cron needs:
 *
 *   1. THE CRON · every session day at 13:45 Kuwait (after the scraper's 13:30
 *      symbol_day write), runDaily(today) — stats THEN reconcile:fees, in the
 *      one slot (R-31), so a filled leg carries the broker's own charge before
 *      the next open.
 *   2. BOOT CATCH-UP · if the process starts AFTER 13:45 on a session day and
 *      today's stats row is still absent (a restart across the slot), run it
 *      once at boot. Full runDaily, because today's fee reconciliation is due.
 *   3. BACKFILL · the table is empty for every past session. Fill the gap so the
 *      review screen and history read real gate columns instead of NULLs. Past
 *      days are STATS ONLY (computeDay, not runDaily): re-running fee
 *      reconciliation across closed sessions would re-touch old ledger rows, and
 *      the bridge only needs the stats columns. Bounded, background, oldest gap
 *      last so the most-recent sessions land first.
 *
 * Kuwait is UTC+3 year-round (no DST), matching the socket scanners' +3.
 * ============================================================================
 */
const log = require('../lib/log');
const { pool } = require('../db');
const { kuwaitDay } = require('./daily');
const stats = require('./stats');

const KUWAIT_OFFSET_MS = 3 * 3600000;
const STATS_TIME = process.env.STATS_DAILY_HHMM || '13:45';
// A safety cap so a first-ever backfill of a long-empty table can never become
// an unbounded boot job. 90 sessions is ~4 trading months — well past anything
// the review screen reads. Set STATS_BACKFILL=off to skip entirely.
const BACKFILL_MAX = Number(process.env.STATS_BACKFILL_MAX || 90);

const pad = (n) => String(n).padStart(2, '0');
function kuwaitHHMM(now = Date.now()) {
  const k = new Date(now + KUWAIT_OFFSET_MS);
  return `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`;
}
function kuwaitDow(now = Date.now()) {
  return new Date(now + KUWAIT_OFFSET_MS).getUTCDay();   // 5=Fri, 6=Sat weekend
}
const isWeekend = (now = Date.now()) => { const d = kuwaitDow(now); return d === 5 || d === 6; };

/** Has the bridge already been written for this day? */
async function statsExist(day, db = pool) {
  const { rows } = await db.query(
    'SELECT 1 FROM spread.symbol_day_stats WHERE trading_day = $1::date LIMIT 1', [day]);
  return rows.length > 0;
}

/**
 * The gap: session days that HAVE quote data (public.symbol_day) but NO bridge
 * row yet. Most-recent first, capped. public.symbol_day is one row per
 * symbol-day, far smaller than the minute table, so this is cheap.
 */
async function missingDays(db = pool, limit = BACKFILL_MAX) {
  const { rows } = await db.query(
    `SELECT to_char(s.d, 'YYYY-MM-DD') AS day
       FROM (SELECT DISTINCT trading_date AS d FROM public.symbol_day WHERE trading_date <= CURRENT_DATE) s
       LEFT JOIN (SELECT DISTINCT trading_day AS d FROM spread.symbol_day_stats) x ON x.d = s.d
      WHERE x.d IS NULL
      ORDER BY s.d DESC
      LIMIT $1`, [limit]);
  return rows.map((r) => r.day);
}

/**
 * Fill the empty history — STATS ONLY, never fee reconciliation. Background and
 * best-effort: one failing day is logged and the rest continue; the daily cron
 * will retry today regardless. Oldest of the capped window runs last so the
 * most-recent sessions (what the board falls back to) appear first.
 */
async function backfill({ db = pool, limit = BACKFILL_MAX } = {}) {
  if (String(process.env.STATS_BACKFILL || '').toLowerCase() === 'off') {
    log.info('[stats-schedule] backfill disabled (STATS_BACKFILL=off)');
    return { ran: 0, disabled: true };
  }
  let days;
  try { days = await missingDays(db, limit); }
  catch (e) { log.warn('[stats-schedule] backfill scan failed:', e.message); return { ran: 0, error: e.message }; }
  if (!days.length) { log.info('[stats-schedule] backfill: no gap — symbol_day_stats covers every session with data'); return { ran: 0 }; }
  log.warn(`[stats-schedule] backfill: ${days.length} session(s) have quote data but NO bridge row — filling stats (no fee reconcile)`);
  let ran = 0;
  // Oldest first, so a partial run still leaves a contiguous recent tail.
  for (const day of days.slice().reverse()) {
    try {
      const r = await stats.computeDay(day, { db });
      ran += 1;
      log.info(`[stats-schedule] backfill ${day}: ${r.rows} symbols (${r.minMinutes}-${r.maxMinutes} min measured)`);
    } catch (e) {
      log.warn(`[stats-schedule] backfill ${day} failed: ${e.message}`);
    }
  }
  return { ran, total: days.length };
}

/**
 * Today's full daily: stats THEN reconcile:fees, in one slot (R-31). Used by the
 * 13:45 fire and by boot catch-up. Idempotent (ON CONFLICT), so a double-fire is
 * harmless.
 */
async function runToday({ db = pool, day = kuwaitDay() } = {}) {
  const r = await stats.runDaily(day, { db, apply: true });
  const rf = r.reconcileFees;
  const feeNote = rf && !rf.error ? `${rf.broker ?? '?'} broker, ${rf.adjusted ?? 0} adjusted` : `not run — ${rf?.error || 'n/a'}`;
  log.info(`[stats-schedule] ${day}: ${r.rows} symbols, ${r.minMinutes}-${r.maxMinutes} min measured · fees: ${feeNote}`);
  return r;
}

/**
 * Start the scheduler. Returns the interval handle (push it onto the shutdown
 * timers). `guard` is the socket reentrancy wrapper so a slow runDaily cannot
 * overlap its next minute-tick and so /health sees the scheduler's lastSuccessAt
 * alongside the six scanners. Passing `now`/`db` is for the test harness.
 */
function startDailyStatsScheduler({ db = pool, everyMs = 60000, time = STATS_TIME,
  now = Date.now, guard = null, runBackfill = true } = {}) {
  const fired = new Set();

  // Boot: catch up today if the slot already passed with no row, then backfill
  // the historical gap. Both in the background — boot must not block on them.
  (async () => {
    try {
      const day = kuwaitDay(new Date(now()));
      if (!isWeekend(now()) && kuwaitHHMM(now()) >= time && !(await statsExist(day, db))) {
        log.warn(`[stats-schedule] boot catch-up: ${day} is past ${time} with no bridge row — running now`);
        fired.add(`${day} ${time}`);
        await runToday({ db, day });
      }
    } catch (e) { log.warn('[stats-schedule] boot catch-up failed:', e.message); }
    if (runBackfill) { try { await backfill({ db }); } catch (e) { log.warn('[stats-schedule] backfill error:', e.message); } }
  })();

  const body = async () => {
    if (isWeekend(now())) return;
    const day = kuwaitDay(new Date(now()));
    const key = `${day} ${time}`;
    if (kuwaitHHMM(now()) !== time || fired.has(key)) return;
    fired.add(key);
    log.info(`[stats-schedule] ${time} Kuwait — running the daily stats + fee reconcile for ${day}`);
    await runToday({ db, day });
  };
  const wrapped = guard ? guard('statsDaily', body) : body;
  return setInterval(() => { Promise.resolve(wrapped()).catch((e) => log.warn('[stats-schedule]', e.message)); }, everyMs);
}

module.exports = { startDailyStatsScheduler, backfill, missingDays, runToday, statsExist, kuwaitHHMM };
