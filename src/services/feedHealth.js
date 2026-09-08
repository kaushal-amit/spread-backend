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
async function roster({ db = pool, maxAgeSec = MAX_AGE_SEC } = {}) {
  const { rows: [reg] } = await db.query("SELECT to_regclass('public.client_heartbeat') AS t;");
  if (!reg.t) return { available: false, maxAgeSec, scripts: [] };

  const { rows } = await db.query(
    `SELECT script, version, rows_seen, problem, last_seen_at,
            EXTRACT(epoch FROM now() - last_seen_at)::int AS silent_sec
       FROM public.client_heartbeat;`);
  const byScript = new Map(rows.map((r) => [r.script, r]));
  const scripts = EXPECTED.map((script) => {
    const r = byScript.get(script);
    if (!r) return { script, status: 'absent', lastSeenAt: null, silentSec: null, rowsSeen: null, problem: null };
    return {
      script,
      status: r.silent_sec > maxAgeSec ? 'silent' : 'ok',
      version: r.version, rowsSeen: r.rows_seen, problem: r.problem,
      lastSeenAt: r.last_seen_at, silentSec: r.silent_sec,
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
        s.status === 'absent' ? 'FEED_ABSENT' : 'FEED_SILENT',
        JSON.stringify({ script: s.script, status: s.status, silentSec: s.silentSec,
          lastSeenAt: s.lastSeenAt, problem: s.problem,
          note: `the ${s.script} feed is ${s.status} — the header must not render zeros as data` })])
      .catch((e) => log.warn('[feedHealth] alarm', e.message));
  }
  if (bad.length) log.warn(`[feedHealth] ${bad.map((s) => `${s.script}:${s.status}`).join(' ')}`);
  return { available: true, raised: bad };
}

module.exports = { roster, check, EXPECTED, MAX_AGE_SEC };
