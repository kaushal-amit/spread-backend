'use strict';
/**
 * ============================================================================
 *  jobs/stats — spread.symbol_day_stats, the BRIDGE for the gate columns
 * ============================================================================
 * public.symbol_day declares pct_postable, pct_exitable, vol_ratio_5d, bid_p25
 * and exitable_best_hour and leaves every one NULL (4,465 rows, 33 sessions,
 * verified 2 September). Gates 6, 7 and 8 read them; Gate 2 at a 2-tick target
 * needs a gap frequency nothing computes; Gates 9 and 10 need 5-SESSION
 * figures in FILS where the scraper offers 20 sessions and percent.
 *
 * This job computes exactly those, from spread.v_quote_screening (one row per
 * symbol per minute: bid, bid_qty, offer, offer_qty, last_price, volume), and
 * writes ONLY spread.symbol_day_stats. spread.symbol_day (the view) prefers
 * the scraper's value where it exists, so when the scraper ships the compute
 * this job's output stops being read and the table can be dropped.
 *
 * The SQL is the 003-era daily job's gate step, cut down to the columns the
 * scraper does not fill, and pointed at the tables that exist. The identical
 * SQL is in scripts/scraper-symbol-day-stats.sql for the scraper to adopt.
 *
 * It is SAFE TO RUN INTRADAY: a partial session produces a partial percentage
 * and minutes_measured says how partial. It is idempotent (ON CONFLICT).
 *
 *   npm run stats:daily                 today (Kuwait), all symbols
 *   npm run stats:daily 2026-09-01      one session
 *   npm run stats:daily 2026-08-01 2026-09-01   a range, oldest first
 * ============================================================================
 */
require('dotenv').config();
const { pool } = require('../../db');
const { GATES, BUDGET } = require('../../config/spread.config');
const gateStore = require('../../services/gateStore');
const { toDay, daysBetween } = require('../../lib/day');
const { kuwaitDay } = require('../daily');

/**
 * A2 · the ONE budget the daily analysis sizes against — the operator's set
 * value from spread.gate_config, the SAME source the live /sizing and /stocks
 * read, never the file seed. A batch process may not have loaded the store at
 * boot, so load it here. Its ABSENCE is a loud throw, not a silent fall back to
 * the 790 seed: computing shares_at_budget off a number nobody set is the C-15
 * failure, and on a 2,000 account the seed would size every row at a third.
 */
async function resolveBudgetKd(db) {
  await gateStore.load(db).catch(() => {});
  const b = gateStore.sessionBudgetKd();
  if (b == null) {
    throw new Error(
      'stats: no session budget is set (spread.gate_config session-budget) — '
      + 'refusing to compute shares_at_budget off the file seed. '
      + 'Set it with PUT /gates {"session-budget": 2000}.');
  }
  return b;
}

/**
 * The size gates depend on the slot. They are stored WITH the slot they were
 * computed at (budget_kd), and the reader can see it. Percentiles are
 * budget-independent and survive a change of slot size.
 */
function bandKd(budgetKd, cfg = GATES) {
  const [qLo, qHi] = cfg.queueBandPct;         // your order is qLo..qHi % of the level
  return { minLevelKd: budgetKd / (qHi / 100), maxLevelKd: budgetKd / (qLo / 100) };
}

/**
 * One session, every symbol that has quotes.
 *
 * @returns {{ day, rows, minutes }}
 */
async function computeDay(day, { db = pool, budgetKd, cfg = GATES } = {}) {
  // A2 · an explicit budgetKd still wins (a backfill or a what-if); otherwise the
  // gate store's session-budget, never the file seed. Unset is a loud throw.
  if (budgetKd == null) budgetKd = await resolveBudgetKd(db);
  const { minLevelKd, maxLevelKd } = bandKd(budgetKd, cfg);

  const { rows: [r] } = await db.query(
    `WITH t AS (
       SELECT symbol, created_at,
              last_price::numeric AS px, volume::bigint AS vol, last_qty::bigint AS lq,
              bid::numeric AS bid, bid_qty::bigint AS bid_shares,
              offer::numeric AS ofr, offer_qty::bigint AS offer_shares,
              lag(last_price::numeric) OVER (PARTITION BY symbol ORDER BY created_at) AS prev_px,
              -- shares an order of budget_kd buys at THIS minute's bid, lot-rounded
              CASE WHEN bid > 0
                   THEN (floor(($2::numeric * 1000) / bid::numeric / $5) * $5)::bigint END AS my_shares
         FROM spread.v_quote_screening
        WHERE trading_date = $1::date
          AND bid > 0 AND offer > 0
     ), m AS (
       SELECT symbol,
              count(*)                                                             AS minutes,
              -- Gate 5 (018). EITHER direction, print size = last_qty: the 003
              -- definition the 20% threshold was calibrated on. The scraper's
              -- tiny_pct_up is up-only and runs about twice this.
              round(100.0 * count(*) FILTER (WHERE px <> prev_px AND lq BETWEEN 1 AND 100)
                    / NULLIF(count(*) FILTER (WHERE px <> prev_px), 0), 1)         AS pct_moves_sub100,
              -- Gate 6. A PERCENTAGE OF THE SESSION, never the median: KFIC's
              -- median said 2.0% postable on the day it filled four times.
              round(100.0 * count(*) FILTER (WHERE bid_shares * bid / 1000 BETWEEN $3 AND $4)
                    / NULLIF(count(*), 0), 1)                                      AS pct_postable,
              -- Gate 7. The ratio catches the offer-wall shape that cost 24 KD.
              round(100.0 * count(*) FILTER (WHERE offer_shares * ofr <= 2 * bid_shares * bid)
                    / NULLIF(count(*), 0), 1)                                      AS pct_exitable_ratio,
              -- Size-relative: is the offer big relative to ME.
              round(100.0 * count(*) FILTER (WHERE my_shares > 0 AND offer_shares <= 3 * my_shares)
                    / NULLIF(count(*), 0), 1)                                      AS pct_exitable_size,
              round(percentile_cont(0.25) WITHIN GROUP (ORDER BY bid_shares * bid / 1000)::numeric, 2)
                                                                                   AS bid_kd_p25,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY bid_shares * bid / 1000)::numeric, 2)
                                                                                   AS bid_kd_p50,
              -- Gate 2 at 2 ticks: how often a queue-zero entry exists.
              round(100.0 * count(*) FILTER (WHERE ofr - bid >= 2)
                    / NULLIF(count(*), 0), 1)                                      AS gap_pct,
              max(vol)                                                             AS day_volume,
              -- shares_at_budget at the session's median bid, for the record
              (floor(($2::numeric * 1000)
                     / NULLIF(percentile_cont(0.5) WITHIN GROUP (ORDER BY bid), 0) / $5) * $5)::bigint
                                                                                   AS shares_at_budget
         FROM t GROUP BY symbol
     ), best_hour AS (
       SELECT symbol,
              max(pct) AS exitable_best_hour_pct
         FROM (SELECT symbol,
                      EXTRACT(hour FROM created_at AT TIME ZONE 'Asia/Kuwait') AS hr,
                      100.0 * count(*) FILTER (WHERE offer_shares * ofr <= 2 * bid_shares * bid)
                            / NULLIF(count(*), 0) AS pct
                 FROM t GROUP BY symbol, hr HAVING count(*) >= 10) h
        GROUP BY symbol
     ), sessions AS (
       -- The previous N SESSIONS, not days. Today excluded: the question is
       -- whether the stock was ALREADY active, or a one-day flash counts itself.
       SELECT trading_date FROM public.symbol_day
        WHERE trading_date < $1::date
        GROUP BY trading_date ORDER BY trading_date DESC LIMIT $6
     ), hist AS (
       SELECT d.symbol,
              avg(d.total_volume)                                        AS base_volume,
              count(*) FILTER (WHERE d.moves >= $7)                      AS days_active,
              count(*) FILTER (WHERE d.close_px < d.prev_close)          AS down_days,
              -- close N sessions ago = the oldest close in the window
              (array_agg(d.close_px ORDER BY d.trading_date ASC))[1]      AS close_n_ago,
              count(*)                                                   AS n
         FROM public.symbol_day d
         JOIN sessions s ON s.trading_date = d.trading_date
        GROUP BY d.symbol
     ), today AS (
       SELECT symbol, close_px FROM public.symbol_day WHERE trading_date = $1::date
     ), ins AS (
       INSERT INTO spread.symbol_day_stats
         (symbol, trading_day, pct_postable, pct_exitable_ratio, pct_exitable_size,
          exitable_best_hour_pct, bid_kd_p25, bid_kd_p50, gap_pct, volume_ratio_5d,
          days_active_5d, down_days_5d, change_5d_fils, minutes_measured, budget_kd,
          shares_at_budget, source, computed_at, pct_moves_sub100)
       SELECT m.symbol, $1::date, m.pct_postable, m.pct_exitable_ratio, m.pct_exitable_size,
              round(b.exitable_best_hour_pct::numeric, 1), m.bid_kd_p25, m.bid_kd_p50, m.gap_pct,
              CASE WHEN h.base_volume > 0 THEN round(m.day_volume / h.base_volume, 3) END,
              h.days_active, h.down_days,
              CASE WHEN h.n = $6 AND td.close_px IS NOT NULL THEN td.close_px - h.close_n_ago END,
              m.minutes, $2::numeric, m.shares_at_budget, 'BACKEND_BRIDGE', now(), m.pct_moves_sub100
         FROM m
         LEFT JOIN best_hour b USING (symbol)
         LEFT JOIN hist h USING (symbol)
         LEFT JOIN today td USING (symbol)
       ON CONFLICT (symbol, trading_day) DO UPDATE SET
         pct_postable = EXCLUDED.pct_postable,
         pct_exitable_ratio = EXCLUDED.pct_exitable_ratio,
         pct_exitable_size = EXCLUDED.pct_exitable_size,
         exitable_best_hour_pct = EXCLUDED.exitable_best_hour_pct,
         bid_kd_p25 = EXCLUDED.bid_kd_p25, bid_kd_p50 = EXCLUDED.bid_kd_p50,
         gap_pct = EXCLUDED.gap_pct, volume_ratio_5d = EXCLUDED.volume_ratio_5d,
         days_active_5d = EXCLUDED.days_active_5d, down_days_5d = EXCLUDED.down_days_5d,
         change_5d_fils = EXCLUDED.change_5d_fils, minutes_measured = EXCLUDED.minutes_measured,
         budget_kd = EXCLUDED.budget_kd, shares_at_budget = EXCLUDED.shares_at_budget,
         source = EXCLUDED.source, computed_at = EXCLUDED.computed_at,
         pct_moves_sub100 = EXCLUDED.pct_moves_sub100
       RETURNING minutes_measured
     )
     SELECT count(*)::int AS rows, COALESCE(min(minutes_measured), 0)::int AS min_minutes,
            COALESCE(max(minutes_measured), 0)::int AS max_minutes
       FROM ins;`,
    [day, budgetKd, minLevelKd, maxLevelKd, BUDGET.lotSize,
     cfg.consistencyWindow, cfg.minPriceMoves]);

  return { day, rows: r.rows, minMinutes: r.min_minutes, maxMinutes: r.max_minutes };
}

async function computeRange(from, to, opts) {
  const out = [];
  for (const day of daysBetween(from, to)) out.push(await computeDay(day, opts));
  return out;
}

/**
 * R-31 · the 13:45 job is stats:daily; the broker-fee reconciliation runs AFTER
 * it, in the same slot, so a filled leg carries the broker's own charge
 * (fee_source = BROKER) rather than the formula's estimate before the next
 * session opens. Best-effort: a reconcile failure must not fail the stats.
 */
async function runDaily(day, { db = pool, apply = true, budgetKd, cfg } = {}) {
  // An empty SESSION day is a capture defect and fails loudly; a holiday is
  // the scheduler's skip (lib/calendar), never reached here. Without this a
  // day with no quotes wrote a green 0-row run and the board screened on it.
  const { rows: [q] } = await db.query(
    'SELECT count(*)::int AS n FROM public.awsat_market_quotes WHERE trading_date = $1::date;', [day]);
  if (!q.n) {
    const cal = await require('../../lib/calendar').sessionDay(day, db);
    if (!cal.session) return { day, rows: 0, minMinutes: 0, maxMinutes: 0, skipped: cal.reason, reconcileFees: null };
    throw new Error(`stats: ${day} has no quotes but the calendar says it was a session — a capture defect, not an empty day; refusing a 0-row run`);
  }
  const stats = await computeDay(day, { db, budgetKd, cfg });
  let reconcileFees = null;
  try { reconcileFees = await require('../reconcile-fees').reconcile(day, { apply, db }); }
  catch (e) { reconcileFees = { error: e.message }; }
  // R-17 / 6.6 · symbol_profile SHOULD be refreshed here. The existing `profile`
  // step depends on trades_hour_09..12 columns that the retired daily job's
  // `hours` step wrote into public.symbol_day; the scraper's rows do not carry
  // them, so the step cannot run standalone. Porting it needs the profile
  // aggregation rewritten to compute the hour-of-day trade counts from the
  // minute quotes (like computeDay) — deferred, tracked as the R-17 remainder.
  return { ...stats, reconcileFees };
}

module.exports = { computeDay, computeRange, bandKd, runDaily, resolveBudgetKd };

if (require.main === module) {
  const dates = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const from = dates[0] || kuwaitDay();
  const to = dates[1] || from;
  (async () => {
    const days = [];
    for (const day of daysBetween(toDay(from), toDay(to))) days.push(day);
    for (const day of days) {
      // stats:daily then reconcile:fees --apply, in one slot (R-31).
      const x = await runDaily(day, { apply: true });
      const rf = x.reconcileFees;
      const feeNote = rf && !rf.error ? `${rf.broker} broker, ${rf.adjusted} adjusted` : `not run — ${rf?.error || 'n/a'}`;
      console.log(`${x.day}  ${String(x.rows).padStart(4)} symbols  ${x.minMinutes}-${x.maxMinutes} minutes measured  · fees: ${feeNote}`);
    }
    return pool.end();
  })().catch((e) => require('../../lib/dberror').die(e));
}
