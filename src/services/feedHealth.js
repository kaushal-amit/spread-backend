'use strict';
/**
 * ============================================================================
 *  feedHealth.js — is the data actually arriving? (SPR-27 / SPR-30)
 * ============================================================================
 * The orders userscript posted nothing from 2 September for six sessions and
 * nothing raised it: a userscript leaves a trace only when it POSTs data, so
 * "stopped" and "running but reading nothing" looked identical, and a dead feed
 * cost a live trade on 8 September. The header, meanwhile, rendered zeros — a
 * fabricated FLAT beside a feed that had been silent for days.
 *
 * The scraper now writes public.client_heartbeat every cycle (its C2 work): one
 * row per (script, source), whether or not it had data, so a stale last_seen_at
 * is the signal. This service READS that table — a public.* read, allowed — and
 * turns it into an honest state:
 *
 *   ok      · checked in within maxAgeSec
 *   silent  · checked in, then went quiet longer than maxAgeSec
 *   absent  · never checked in (the case plain silence cannot see)
 *
 * The header shows this instead of zeros (SPR-30); a silent/absent orders feed
 * raises a data_alarm (SPR-27). The table belongs to the scraper, so where it
 * is not present (a schema-only backend test DB) this degrades to `unknown`
 * rather than throwing — loud where it can be, never a crash.
 * ============================================================================
 */
const { pool } = require('../db');
const log = require('../lib/log');

const EXPECTED = (process.env.EXPECTED_SCRIPTS || 'orders,depth,quotes,market-summary')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_AGE_SEC = Number(process.env.FEED_SILENT_SEC || 300);

/**
 * The roster: every EXPECTED script with a status. Mirrors the scraper's own
 * scriptRoster so the two never disagree. Returns { available:false } when the
 * heartbeat table is not present, so a caller can say "unknown" rather than
 * invent an all-ok roster.
 */
/** Is the exchange session open right now (Kuwait, Sun–Thu 09:00–13:30)? */
function inSessionNow(now = new Date()) {
  const k = new Date(now.getTime() + 3 * 3600000);
  const dow = k.getUTCDay(), mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  return dow !== 5 && dow !== 6 && mins >= 9 * 60 && mins < 13 * 60 + 30;
}

/**
 * One feed's status from its heartbeat row. PURE, mirrored line for line from
 * kse-scraper/src/api/ingest.js feedStatus() — the two must agree.
 *
 *   absent    no row: the script never ran
 *   silent    last check-in older than maxAgeSec
 *   degraded  checking in, but (in the session) the panel reports a problem,
 *             or saw 0 rows, or has not had a submission ACCEPTED within
 *             maxAgeSec — a feed that failed every POST used to read ok, and
 *             the header rendered its zeros as data
 *   ok        checked in, delivered, nothing reported
 */
function feedStatus(r, { maxAgeSec = MAX_AGE_SEC, inSession = true } = {}) {
  if (!r) return { status: 'absent', reason: 'never checked in' };
  if (r.silent_sec == null || r.silent_sec > maxAgeSec) {
    return { status: 'silent', reason: `no check-in for ${r.silent_sec ?? '?'}s` };
  }
  if (r.problem) return { status: 'degraded', reason: `panel reports: ${r.problem}` };
  if (inSession) {
    if (r.rows_seen === 0) return { status: 'degraded', reason: 'checking in but sees 0 rows' };
    const sub = r.submission_sec;
    if (r.has_submission_clock && (sub == null || sub > maxAgeSec)) {
      return { status: 'degraded', reason: sub == null ? 'checking in but nothing accepted yet' : `checking in but nothing accepted for ${sub}s` };
    }
  }
  return { status: 'ok', reason: null };
}

// The scraper's migration 040 adds last_submission_at; a database that has not
// run it yet is read on the check-in alone. Probed once per process.
let hasSubmissionClock = null;
async function submissionClock(db) {
  if (hasSubmissionClock != null) return hasSubmissionClock;
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'client_heartbeat' AND column_name = 'last_submission_at';`);
  hasSubmissionClock = rows.length > 0;
  return hasSubmissionClock;
}

async function roster({ db = pool, maxAgeSec = MAX_AGE_SEC, inSession = inSessionNow() } = {}) {
  const { rows: [reg] } = await db.query("SELECT to_regclass('public.client_heartbeat') AS t;");
  if (!reg.t) return { available: false, maxAgeSec, scripts: [] };

  const clock = await submissionClock(db);
  const { rows } = await db.query(
    clock
      ? `SELECT script, version, rows_seen, problem, last_seen_at, last_submission_at, rows_inserted,
                EXTRACT(epoch FROM now() - last_seen_at)::int AS silent_sec,
                EXTRACT(epoch FROM now() - last_submission_at)::int AS submission_sec,
                true AS has_submission_clock
           FROM public.client_heartbeat;`
      : `SELECT script, version, rows_seen, problem, last_seen_at, NULL::timestamptz AS last_submission_at,
                NULL::int AS rows_inserted,
                EXTRACT(epoch FROM now() - last_seen_at)::int AS silent_sec,
                NULL::int AS submission_sec, false AS has_submission_clock
           FROM public.client_heartbeat;`);
  const byScript = new Map(rows.map((r) => [r.script, r]));
  const scripts = EXPECTED.map((script) => {
    const r = byScript.get(script);
    const st = feedStatus(r, { maxAgeSec, inSession });
    if (!r) return { script, status: st.status, reason: st.reason, lastSeenAt: null, silentSec: null, rowsSeen: null, problem: null };
    return {
      script,
      status: st.status, reason: st.reason,
      version: r.version, rowsSeen: r.rows_seen, rowsInserted: r.rows_inserted, problem: r.problem,
      lastSeenAt: r.last_seen_at, silentSec: r.silent_sec,
      lastSubmissionAt: r.last_submission_at, submissionSec: r.submission_sec,
    };
  });
  return { available: true, maxAgeSec, scripts };
}

/**
 * SPR-27 · raise a data_alarm for any EXPECTED feed that is silent or absent,
 * the orders feed above all. Deduped by the data_alarm open-once index (one
 * open row per script per day); a feed that recovers is not auto-resolved here
 * — a returning feed is visible in the roster, and a human resolves the alarm.
 * Returns the raised set so a caller can also emit it live.
 */
async function check(tradingDay, { db = pool, maxAgeSec = MAX_AGE_SEC } = {}) {
  const r = await roster({ db, maxAgeSec });
  if (!r.available) return { available: false, raised: [] };
  const bad = r.scripts.filter((s) => s.status !== 'ok');
  for (const s of bad) {
    await db.query(
      `INSERT INTO spread.data_alarm (trading_day, table_name, column_name, alarm, detail)
       VALUES ($1, 'client_heartbeat', $2, $3, $4)
       ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                    COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
      [tradingDay, s.script,
        s.status === 'absent' ? 'FEED_ABSENT' : s.status === 'degraded' ? 'FEED_DEGRADED' : 'FEED_SILENT',
        JSON.stringify({ script: s.script, status: s.status, silentSec: s.silentSec,
          lastSeenAt: s.lastSeenAt, problem: s.problem,
          note: `the ${s.script} feed is ${s.status} — the header must not render zeros as data` })])
      .catch((e) => log.warn('[feedHealth] alarm', e.message));
  }
  if (bad.length) log.warn(`[feedHealth] ${bad.map((s) => `${s.script}:${s.status}`).join(' ')}`);
  return { available: true, raised: bad };
}

module.exports = { roster, check, EXPECTED, MAX_AGE_SEC, feedStatus, inSessionNow };
