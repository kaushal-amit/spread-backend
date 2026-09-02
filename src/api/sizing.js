'use strict';
/**
 * src/api/sizing.js — /budget and /sizing/:symbol
 *
 * ─── THE BUG THIS FIXES ────────────────────────────────────────────────────
 * YOUR % sized from the WHOLE budget. With one position open it was wrong on
 * every other symbol — and YOUR % is a gate, so a wrong figure changed a
 * decision.
 *
 * Every derived figure here sizes from the ALLOCATION (budget - reserve -
 * committed), never from the total.
 *
 * ─── RECOMPUTE, NEVER RESET ────────────────────────────────────────────────
 * Changing the budget recomputes what is available. It does not touch open
 * positions, contract history or the day's P&L. A filled position keeps its
 * actual size forever: the money was spent at that size and no later number
 * changes what happened.
 */

const express = require('express');
const { pool } = require('../db');
const { wrap, notFound, badRequest } = require('./errors');
const { toDay } = require('../lib/day');
const { SESSION } = require('../config/spread.config');

/**
 * The session these figures belong to.
 *
 * Through lib/day.js and the configured offset — a bare toISOString() gives the
 * UTC day, and after 21:00 UTC that is tomorrow in Kuwait.
 */
function today() {
  return toDay(new Date(Date.now() + SESSION.timezoneOffsetHours * 3600000));
}

/**
 * The thresholds, from the table.
 *
 * NOT hardcoded: the commission schedule changes on 1 October and both derived
 * constants move with it. A number in a source file cannot follow.
 *
 * Currently public.kb_threshold — built in the scraper by mistake. It moves to
 * spread.kb_threshold, and this resolver prefers that when it exists so the
 * move needs no change here.
 *
 * A missing key THROWS. A gate running on a default nobody chose is a gate
 * nobody decided, and it looks exactly like a gate that is working.
 */
async function thresholds() {
  const { rows: where } = await pool.query(
    `SELECT to_regclass('spread.kb_threshold') IS NOT NULL AS in_spread`);
  const table = where[0].in_spread ? 'spread.kb_threshold' : 'public.kb_threshold';

  const { rows } = await pool.query(`SELECT key, value FROM ${table} WHERE still_true`);
  const t = {};
  for (const r of rows) t[r.key] = Number(r.value);

  const need = ['commission_rate', 'commission_min_kd', 'my_pct_min', 'my_pct_max',
    'exit_depth_max_x', 'reserve_pct', 'reserve_release_hhmm', 'tick_min_price'];
  const missing = need.filter((k) => !Number.isFinite(t[k]));
  if (missing.length) {
    throw badRequest(
      `kb_threshold is missing ${missing.join(', ')} in ${table}. `
      + 'Sizing cannot be computed from defaults — run sql/kb_seed.sql.');
  }

  // DERIVED, not stored, so they follow the schedule.
  //
  // MIN_POSITION_KD: below this the 0.5 KD minimum bites and the flat fee
  //   exceeds the percentage: commission_min_kd divided by commission_rate.
  //   (The arithmetic is not spelled out here — only lib/commission.js may
  //   carry fee literals, and a worked example in a comment trips that rule
  //   for good reason: two places holding the same number drift.)
  //
  // MAX_PRICE_FILS: above this ONE FIL never clears a round trip at any size.
  //   A fil on a stock at P is worth 1/P; the trip costs 2 x rate. One fil
  //   clears while 1/P > 2 x rate, so P < 1 / (2 x rate) = 333.
  //   The two is the two SIDES of the trip.
  t.min_position_kd = Math.round(t.commission_min_kd / t.commission_rate);
  t.max_price_fils = Math.round(1 / (2 * t.commission_rate));
  return t;
}

/** What the trader set, or the default until they set one. */
async function budgetKd() {
  const { rows } = await pool.query(
    `SELECT value FROM public.app_config WHERE key = 'budget_kd'`).catch(() => ({ rows: [] }));
  return rows.length ? Number(rows[0].value) : Number(process.env.BUDGET_KD || 720);
}

/**
 * Capital in open positions — from spread.order_leg, via accountSummary().
 *
 * ─── IT READ THE WRONG TABLE ───────────────────────────────────────────────
 * The first version read public.position. Nothing writes that table and nothing
 * will: it is the SCRAPER's, and the lint forbids this codebase from writing to
 * public.*. So committed_kd would have read 0 forever while the real model held
 * an open position — no error, a plausible number, and wrong.
 *
 * The same class as the empty views: a query that resolves is not a query that
 * answers.
 *
 * accountSummary() is the one place that knows what is open. It counts
 * order_leg where the buy is filled and unsold, which is what the lifecycle
 * suite tests: 780.8 KD with a position open, zero after it closes.
 */
async function committedKd(day) {
  const { accountSummary } = require('./routes');
  const a = await accountSummary(day);
  return { kd: Number(a.investedKd || 0), positions: Number(a.openPositions || 0) };
}

function build() {
  const r = express.Router();

  /**
   * GET /budget
   *
   * free is what a NEW position may use. Every size on screen comes from here
   * or from /sizing — never from the budget directly.
   */
  r.get('/budget', wrap(async (_req, res) => {
    const t = await thresholds();
    const budget = await budgetKd();
    const c = await committedKd(today());

    // Held back until reserve_release_hhmm, then available.
    const k = new Date(Date.now() + 3 * 3600_000);
    const nowHHMM = k.getUTCHours() * 100 + k.getUTCMinutes();
    const reserveHeld = nowHHMM < t.reserve_release_hhmm;
    const reserve = reserveHeld ? Number((budget * t.reserve_pct / 100).toFixed(3)) : 0;

    res.json({
      budget_kd: budget,
      reserve_kd: reserve,
      reserve_held: reserveHeld,
      reserve_releases_at_hhmm: t.reserve_release_hhmm,
      committed_kd: Number(c.kd.toFixed(3)),
      open_positions: c.positions,
      free_kd: Number(Math.max(0, budget - reserve - c.kd).toFixed(3)),
      min_position_kd: t.min_position_kd,
      max_price_fils: t.max_price_fils,
      note: 'free_kd is what a NEW position may use. Sizing NEVER divides the '
        + 'total: with one position open that is wrong on every other symbol.',
    });
  }));

  /**
   * GET /sizing/:symbol
   *
   * floor    the smallest position worth taking — below min_position_kd the
   *          flat commission bites, and below my_pct_min you are invisible in
   *          the queue.
   * ceiling  the largest that can still get out: above my_pct_max you ARE the
   *          level, and the offer must be exit_depth_max_x times your size.
   */
  r.get('/sizing/:symbol', wrap(async (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const t = await thresholds();
    const budget = await budgetKd();
    const c = await committedKd(today());

    const k = new Date(Date.now() + 3 * 3600_000);
    const nowHHMM = k.getUTCHours() * 100 + k.getUTCMinutes();
    const reserve = nowHHMM < t.reserve_release_hhmm
      ? budget * t.reserve_pct / 100 : 0;
    // THE ALLOCATION, not the budget. This is the bug.
    const free = Math.max(0, budget - reserve - c.kd);

    // The touch, from the newest depth capture.
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (level) level, bid, bid_qty, offer, offer_qty, captured_at
        FROM public.awsat_stock_depth
       WHERE symbol = $1 AND level = 1
       ORDER BY level, captured_at DESC, ingest_source`, [symbol]);

    const { rows: last } = await pool.query(
      `SELECT close_px FROM public.symbol_day WHERE symbol = $1
        ORDER BY trading_date DESC LIMIT 1`, [symbol]);
    if (!last.length && !rows.length) throw notFound(`nothing is known about ${symbol}`);

    const price = rows.length && rows[0].bid ? Number(rows[0].bid)
      : (last.length ? Number(last[0].close_px) : null);
    const bidQty = rows.length ? Number(rows[0].bid_qty) : null;
    const offerQty = rows.length ? Number(rows[0].offer_qty) : null;

    // Structural, and it cannot be overridden: below tick_min_price the tick is
    // 0.1 fils, and above max_price_fils one fil never clears the round trip.
    const reasons = [];
    if (price !== null && price < t.tick_min_price) {
      reasons.push(`${price} fils is below the ${t.tick_min_price}-fil tick band — the tick is 0.1`);
    }
    if (price !== null && price > t.max_price_fils) {
      reasons.push(`${price} fils is above ${t.max_price_fils} — one fil does not clear a round trip at any size`);
    }

    const kdOf = (shares) => (shares === null || price === null) ? null : (shares * price) / 1000;
    const floorKd = bidQty === null ? t.min_position_kd
      : Math.max(t.min_position_kd, kdOf(bidQty * t.my_pct_min / 100));
    const byQueue = kdOf(bidQty === null ? null : bidQty * t.my_pct_max / 100);
    const byExit = kdOf(offerQty === null ? null : offerQty / t.exit_depth_max_x);
    const ceilingRaw = [byQueue, byExit, free].filter((v) => v !== null && Number.isFinite(v));
    const ceilingKd = ceilingRaw.length ? Math.min(...ceilingRaw) : free;

    const reachable = reasons.length === 0 && ceilingKd >= floorKd && free >= t.min_position_kd;
    const suggested = reachable ? Math.min(ceilingKd, free) : null;
    const shares = (suggested !== null && price)
      ? Math.floor((suggested * 1000) / price) : null;

    res.json({
      symbol,
      price_fils: price,
      floor_kd: Number(floorKd.toFixed(3)),
      ceiling_kd: Number(ceilingKd.toFixed(3)),
      suggested_kd: suggested === null ? null : Number(suggested.toFixed(3)),
      suggested_shares: shares,
      // FROM THE ALLOCATION. Dividing by the budget is the bug being fixed.
      your_pct: (shares !== null && bidQty) ? Number(((100 * shares) / bidQty).toFixed(2)) : null,
      net_per_fil_kd: (shares !== null) ? Number((shares / 1000).toFixed(3)) : null,
      reachable,
      reasons,
      // Shown so a wrong figure is traceable to its inputs.
      basis: {
        free_kd: Number(free.toFixed(3)),
        committed_kd: Number(c.kd.toFixed(3)),
        budget_kd: budget,
        bid_qty: bidQty,
        offer_qty: offerQty,
        sized_from: 'free_kd',
      },
    });
  }));

  return r;
}

module.exports = { build };
