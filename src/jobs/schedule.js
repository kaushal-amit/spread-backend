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
/**
 * ONE DAILY SLOT, DONE-WHEN-DONE.
 *
 * The first version fired only on an exact HH:MM match and marked the day
 * fired BEFORE running, so a failed run — or a minute the interval skipped
 * (a slow tick, a restart at 13:45:30) — meant no stats that day and no
 * retry. Now:
 *   - it is due from `time` ONWARD on a session day
 *   - "done" is the TABLE (`exists(day)`), not memory: a restart at 14:00
 *     runs it if the row is missing and skips it if it is there (which is
 *     also the boot catch-up — no separate code path)
 *   - a failure is retried with backoff (1, 2, 4 … up to 30 minutes), logged
 *     each time, never marked done
 * Returns 'idle' when nothing was due, so the guard's health shows work vs
 * idle honestly.
 */
function dailySlot({ name, time, exists, run, db, now }) {
  const done = new Set();          // days proven done (by the table) this process
  let lastAttempt = null, backoffMs = 0;
  return async () => {
    if (isWeekend(now())) return 'idle';
    const day = kuwaitDay(new Date(now()));
    if (done.has(day) || kuwaitHHMM(now()) < time) return 'idle';
    if (lastAttempt != null && now() - lastAttempt < backoffMs) return 'idle';
    // A holiday is not a failure: a day the calendar marks closed is a skip
    // with one log line, never a red. An empty SESSION day still fails loudly
    // inside run() — that is a capture defect.
    const cal = await require('../lib/calendar').sessionDay(day, db);
    if (!cal.session) {
      log.info(`[${name}] ${day} is not a session (${cal.reason}${cal.name ? `: ${cal.name}` : ''}) — skipped`);
      done.add(day);
      return 'idle';
    }
    if (await exists(day, db)) { done.add(day); return 'idle'; }
    lastAttempt = now();
    try {
      log.info(`[${name}] ${time} Kuwait — running for ${day}`);
      await run({ db, day });
      done.add(day); backoffMs = 0;
    } catch (e) {
      backoffMs = Math.min(30 * 60000, backoffMs ? backoffMs * 2 : 60000);
      log.warn(`[${name}] ${day} failed — retry in ${Math.round(backoffMs / 60000)} min: ${e.message}`);
      throw e;
    }
    return 'ran';
  };
}

function startDailyStatsScheduler({ db = pool, everyMs = 60000, time = STATS_TIME,
  now = Date.now, guard = null, runBackfill = true } = {}) {
  // Backfill the historical gap in the background — boot must not block on it.
  // Today's catch-up is the slot itself: due from 13:45, done when the table
  // says so.
  if (runBackfill) {
    (async () => { try { await backfill({ db }); } catch (e) { log.warn('[stats-schedule] backfill error:', e.message); } })();
  }
  const body = dailySlot({ name: 'stats-schedule', time, exists: statsExist, run: runToday, db, now });
  const wrapped = guard ? guard('statsDaily', body) : body;
  // The first tick is immediate, so a boot after the slot catches up now.
  Promise.resolve(wrapped()).catch((e) => log.warn('[stats-schedule]', e.message));
  return setInterval(() => { Promise.resolve(wrapped()).catch((e) => log.warn('[stats-schedule]', e.message)); }, everyMs);
}

/** Has the 09:45 window been written for this day? */
async function m45Exist(day, db = pool) {
  const { rows } = await db.query('SELECT 1 FROM spread.m45 WHERE trading_day = $1::date LIMIT 1', [day]);
  return rows.length > 0;
}

/**
 * The 09:45 job (A5). It existed only as `npm run m45` — never scheduled, so
 * the board's m45 column read "—" every session. Same slot machinery as the
 * stats: due from M45_HHMM (default 09:46, one minute after the window closes),
 * done when spread.m45 has today's rows, retried on failure.
 */
const M45_TIME = process.env.M45_HHMM || '09:46';
function startM45Scheduler({ db = pool, everyMs = 60000, time = M45_TIME, now = Date.now, guard = null } = {}) {
  const run = async ({ db: d, day }) => {
    const r = await require('./m45').computeM45(day, { db: d });
    log.info(`[m45-schedule] ${day}: ${r.computed} computed, ${r.skipped} already present, ${r.thin} thin`);
    return r;
  };
  const body = dailySlot({ name: 'm45-schedule', time, exists: m45Exist, run, db, now });
  const wrapped = guard ? guard('m45', body) : body;
  Promise.resolve(wrapped()).catch((e) => log.warn('[m45-schedule]', e.message));
  return setInterval(() => { Promise.resolve(wrapped()).catch((e) => log.warn('[m45-schedule]', e.message)); }, everyMs);
}

/**
 * The ceiling re-derive nag (services/ceiling.js): once a day from 09:00,
 * and immediately at boot, from 1 Oct 2026 until band-ceiling is saved.
 * Runs on the same slot machinery; "exists" = already re-derived.
 */
function startCeilingCheck({ db = pool, everyMs = 60000, time = '09:00', now = Date.now, guard = null, current = () => null } = {}) {
  const ceiling = require('../services/ceiling');
  const exists = async (day, d) => (day < ceiling.ABOLISHED) || (await ceiling.rederived(d)).yes;
  const run = ({ db: d, day }) => ceiling.check(day, { db: d, current: current() });
  const body = dailySlot({ name: 'ceiling-check', time, exists, run, db, now });
  const wrapped = guard ? guard('ceilingCheck', body) : body;
  Promise.resolve(wrapped()).catch((e) => log.warn('[ceiling-check]', e.message));
  return setInterval(() => { Promise.resolve(wrapped()).catch((e) => log.warn('[ceiling-check]', e.message)); }, everyMs);
}

module.exports = { startDailyStatsScheduler, startM45Scheduler, startCeilingCheck, dailySlot, backfill, missingDays, runToday, statsExist, m45Exist, kuwaitHHMM };
