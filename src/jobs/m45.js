'use strict';
/**
 * ============================================================================
 *  jobs/m45.js — the 09:00–09:45 range-over-cost, written once (A5, Item 6)
 * ============================================================================
 * How far a symbol ranged in the first 45 minutes against what it costs to trade
 * it. A ranking column on the board, never a gate, never a warning input.
 *
 *   rangePct       = (max(last_price) − min(last_price)) / first last_price
 *   spreadPct      = (offer − bid) / bid    at the last capture ≤ 09:45
 *   commissionPct  = the round-trip rate from commission.js (changes 1 Oct)
 *   rangeOverCost  = rangePct / (spreadPct + commissionPct)
 *
 * HARD RULES:
 *   · SOURCE is public.awsat_market_quotes — the only board-wide feed (~141
 *     symbols at ~60 s). NOT symbol_minute, which covers only the 8–17 depth
 *     slots; a column that is "—" for 133 of 141 is not a ranking column.
 *   · THIN counts ACTIVITY, not captures. Every symbol has ~45 captures whether
 *     it trades or not, so a capture count never fires. activeMinutes = captures
 *     whose volume rose over the previous capture; under m45_min_active_minutes
 *     (kb, 10) the value is NULL with reason THIN. `captures` is stored for
 *     diagnosis but never gates.
 *   · WRITTEN ONCE. The job refuses to overwrite an existing row for the day —
 *     the freeze at 09:45 is the point (+245.8 vs −223.2 between an early and a
 *     late read). This is the ONLY module that writes spread.m45.
 * ============================================================================
 */
const { pool } = require('../db');
const { toDay } = require('../lib/day');
const commission = require('../lib/commission');

const WINDOW_START = '09:00';
const WINDOW_END = '09:45';

async function minActiveMinutes(db) {
  const { rows } = await db.query(
    "SELECT value FROM spread.kb_threshold WHERE key = 'm45_min_active_minutes' AND still_true;").catch(() => ({ rows: [] }));
  const v = rows[0] ? Number(rows[0].value) : 10;
  return Number.isFinite(v) ? v : 10;
}

/**
 * Compute and store the m45 row for every symbol with quotes in the window.
 * Returns { day, computed, skipped, thin }. `skipped` counts symbols whose row
 * already existed (write-once). `now` is only used to guard against running
 * before the window closes when called live.
 */
async function computeM45(day, { db = pool } = {}) {
  const d = toDay(day);
  const minActive = await minActiveMinutes(db);
  const commissionPct = commission.roundTripRate(); // never a literal — moves 1 Oct

  // Every symbol's window captures, ordered, so range and the volume-increase
  // count come from one pass. Trading / CB Auction / NULL sessions, priced.
  const { rows } = await db.query(
    `SELECT symbol,
            (created_at AT TIME ZONE 'Asia/Kuwait')::time AS kt,
            last_price::numeric AS last_price, volume::numeric AS volume,
            bid::numeric AS bid, offer::numeric AS offer, created_at
       FROM public.awsat_market_quotes
      WHERE trading_date = $1::date
        AND (session IN ('Trading','CB Auction') OR session IS NULL)
        AND last_price IS NOT NULL AND last_price > 0
        AND (created_at AT TIME ZONE 'Asia/Kuwait')::time >= time '${WINDOW_START}'
        AND (created_at AT TIME ZONE 'Asia/Kuwait')::time <= time '${WINDOW_END}'
      ORDER BY symbol, created_at;`, [d]);

  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }

  let computed = 0, skipped = 0, thin = 0;
  for (const [symbol, caps] of bySym) {
    const sym = String(symbol).toUpperCase();
    // Write-once: never overwrite a frozen row.
    const { rows: exists } = await db.query(
      'SELECT 1 FROM spread.m45 WHERE symbol = $1 AND trading_day = $2;', [sym, d]);
    if (exists.length) { skipped += 1; continue; }

    const prices = caps.map((c) => Number(c.last_price));
    const first = prices[0];
    const rangePct = first > 0 ? (Math.max(...prices) - Math.min(...prices)) / first : null;
    // activeMinutes = captures whose volume rose over the previous capture.
    let activeMinutes = 0;
    for (let i = 1; i < caps.length; i += 1) {
      if (Number(caps[i].volume) > Number(caps[i - 1].volume)) activeMinutes += 1;
    }
    const captures = caps.length;
    // The spread at the last capture in the window.
    const lastCap = caps[caps.length - 1];
    const spreadPct = lastCap.bid > 0 && lastCap.offer != null
      ? (Number(lastCap.offer) - Number(lastCap.bid)) / Number(lastCap.bid) : null;

    let rangeOverCost = null, reason = null;
    if (activeMinutes < minActive) {
      reason = 'THIN';
    } else if (rangePct == null || spreadPct == null || (spreadPct + commissionPct) <= 0) {
      reason = 'NO_COST'; // no priced spread to divide by — cannot rank
    } else {
      rangeOverCost = Number((rangePct / (spreadPct + commissionPct)).toFixed(3));
    }

    await db.query(
      `INSERT INTO spread.m45 (symbol, trading_day, range_over_cost_ratio, range_pct, spread_pct,
         commission_pct, captures, active_minutes, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (symbol, trading_day) DO NOTHING;`,
      [sym, d,
       rangeOverCost,
       rangePct == null ? null : Number(rangePct.toFixed(6)),
       spreadPct == null ? null : Number(spreadPct.toFixed(6)),
       commissionPct, captures, activeMinutes, reason]);
    if (reason === 'THIN') thin += 1;
    computed += 1;
  }
  return { day: d, computed, skipped, thin, commissionPct };
}

/** The board reads this — by (symbol, trading_day), never a join. */
async function m45For(day, symbols, db = pool) {
  if (!symbols || !symbols.length) return new Map();
  const d = toDay(day);
  const { rows } = await db.query(
    `SELECT symbol, range_over_cost_ratio, reason, captures, active_minutes
       FROM spread.m45 WHERE trading_day = $1::date AND symbol = ANY($2);`,
    [d, symbols.map((s) => String(s).toUpperCase())]);
  const out = new Map();
  for (const r of rows) {
    out.set(r.symbol, { rangeOverCost: r.range_over_cost_ratio == null ? null : Number(r.range_over_cost_ratio),
      reason: r.reason, captures: Number(r.captures), activeMinutes: Number(r.active_minutes) });
  }
  return out;
}

module.exports = { computeM45, m45For, minActiveMinutes, WINDOW_START, WINDOW_END };
