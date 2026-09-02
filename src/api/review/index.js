'use strict';
/**
 * src/api/review/index.js — the DATED routes. Mounted at /api/review.
 *
 * ─── WHY THESE ARE SEPARATE FROM THE LIVE ROUTES ───────────────────────────
 * Everything in src/api/routes.js answers "what is true NOW": /session returns
 * the live phase, /stocks runs the screening pipeline with gates and headroom,
 * /orderbook reads the current book. None takes a date.
 *
 * Feeding a past date into that pipeline makes it compute a RECOMMENDATION for
 * a day that is over — and a review screen that can trigger a live action is
 * the failure this separation exists to prevent.
 *
 * So these routes import NOTHING from the live side. Not board(), not build(),
 * not the gate config. They read tables and return rows. The split is visible
 * in the URL as well as the directory: a front-end developer reading
 * /api/review/session/2026-08-25 knows it is read-only; /session/2026-08-25
 * would tell them nothing.
 *
 * `/stocks` and `/review/session/:date/symbols` both return stock rows and are
 * NOT duplicates:
 *     /stocks                     what should I trade — a decision engine
 *     /review/.../symbols         what symbol_day recorded — raw rows
 * They share a table and nothing else.
 */

const express = require('express');
const { pool } = require('../../db');
const { wrap, notFound, badRequest } = require('../errors');

/**
 * A short day is one whose capture stopped before close_capture_min_hhmm.
 *
 * The SAME threshold the close-precedence rule uses, deliberately: the review
 * flag and the close rule must agree about what a short day is, or a session
 * shown as complete supplies a close the compute refused to use.
 *
 * 12:30 Kuwait. End times cluster at 12:59 — ten July days missing only the
 * closing auction — while 30 July ends at 10:14 and 26 August at 12:23. The cut
 * falls in the empty gap between the two groups.
 */
const CLOSE_CAPTURE_MIN_HHMM = Number(process.env.CLOSE_CAPTURE_MIN_HHMM || 1230);

/** YYYY-MM-DD, or a 400 naming what was sent. */
function day(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw || ''))) {
    throw badRequest(`"${raw}" is not a date. Expected YYYY-MM-DD.`);
  }
  return raw;
}

function build() {
  const r = express.Router();

  /**
   * GET /review/sessions — the dates that may be selected.
   *
   * From market_day WHERE total_volume > 0, not from symbol_day existing.
   * 30 July has 134 symbol_day rows and a 10:14 capture: it is in the table and
   * it is not a session anyone can review.
   *
   * truncated and data_quality are BOTH returned because they are different
   * faults. 26 August is truncated (capture stopped at 12:23); a day can be
   * THIN for other reasons entirely. The front end may want to grey one and
   * warn on the other.
   */
  r.get('/sessions', wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      WITH ends AS (
        SELECT trading_date,
               max(extract(hour FROM (created_at AT TIME ZONE 'Asia/Kuwait')) * 100
                 + extract(minute FROM (created_at AT TIME ZONE 'Asia/Kuwait')))::int AS last_hhmm
          FROM public.awsat_market_quotes GROUP BY trading_date
      ),
      quality AS (
        SELECT trading_date,
               count(*) FILTER (WHERE data_quality = 'THIN')::int AS thin_symbols,
               count(*)::int AS symbols
          FROM public.symbol_day GROUP BY trading_date
      )
      SELECT m.trading_date::text            AS date,
             m.symbols_traded,
             m.advancing, m.declining, m.unchanged,
             m.pct_advancing, m.regime,
             m.total_volume, m.total_trades,
             m.broker_seen_at IS NOT NULL    AS broker_confirmed,
             e.last_hhmm                     AS capture_ends_hhmm,
             (e.last_hhmm < $1)              AS truncated,
             q.thin_symbols,
             q.symbols,
             CASE WHEN q.symbols > 0 AND q.thin_symbols = q.symbols THEN 'THIN'
                  WHEN q.thin_symbols > 0 THEN 'PARTIAL'
                  ELSE 'FULL' END            AS data_quality
        FROM public.market_day m
        LEFT JOIN ends e    ON e.trading_date = m.trading_date
        LEFT JOIN quality q ON q.trading_date = m.trading_date
       WHERE COALESCE(m.total_volume, 0) > 0
       ORDER BY m.trading_date DESC`, [CLOSE_CAPTURE_MIN_HHMM]);

    res.json({
      sessions: rows,
      // Stated so the front end does not invent its own cut.
      truncated_before_hhmm: CLOSE_CAPTURE_MIN_HHMM,
      note: 'A date absent from this list has no data — it is not a holiday list.',
    });
  }));

  /** GET /review/session/:date — the market_day row for one session. */
  r.get('/session/:date', wrap(async (req, res) => {
    const d = day(req.params.date);
    const { rows } = await pool.query(
      'SELECT * FROM public.market_day WHERE trading_date = $1', [d]);
    if (!rows.length) throw notFound(`no session was computed for ${d}`);
    res.json(rows[0]);
  }));

  /**
   * GET /review/session/:date/symbols — symbol_day rows, RAW.
   *
   * Not reshaped into the front end's StockData: the mapping lives there, so
   * backend naming can change without breaking it, and there is one place to
   * look when a field is wrong.
   */
  r.get('/session/:date/symbols', wrap(async (req, res) => {
    const d = day(req.params.date);
    const { rows } = await pool.query(
      `SELECT * FROM public.symbol_day WHERE trading_date = $1 ORDER BY symbol`, [d]);
    res.json({ date: d, count: rows.length, symbols: rows });
  }));

  /**
   * GET /review/session/:date/book/:symbol — the last depth capture of that day.
   *
   * MAY BE EMPTY, and that is the normal case: depth covers 8 symbols a day out
   * of 142. An empty book renders as an empty ladder, never a spinner and never
   * an error.
   */
  r.get('/session/:date/book/:symbol', wrap(async (req, res) => {
    const d = day(req.params.date);
    const symbol = String(req.params.symbol || '').toUpperCase();

    const { rows } = await pool.query(`
      WITH last_capture AS (
        SELECT max(captured_at) AS at FROM public.awsat_stock_depth
         WHERE symbol = $1 AND trading_date = $2
      )
      SELECT DISTINCT ON (level) level, bid, bid_qty, offer, offer_qty, captured_at
        FROM public.awsat_stock_depth d, last_capture l
       WHERE d.symbol = $1 AND d.trading_date = $2 AND d.captured_at = l.at
       ORDER BY level, ingest_source`, [symbol, d]);

    // BookLevel = [price, qty, orders|null]. The third is the order COUNT,
    // which is not in the broker feed: 100,000 in 1 order is a wall, in 47 it
    // is demand. Returned as null so the front end renders without it.
    res.json({
      date: d,
      symbol,
      captured_at: rows.length ? rows[0].captured_at : null,
      b: rows.filter((x) => x.bid !== null).map((x) => [Number(x.bid), Number(x.bid_qty), null]),
      o: rows.filter((x) => x.offer !== null).map((x) => [Number(x.offer), Number(x.offer_qty), null]),
      levels: rows.length,
      note: rows.length ? undefined
        : 'no depth was captured for this symbol on this date — 8 of 142 symbols hold a slot',
    });
  }));

  /**
   * GET /review/session/:date/signals — what fired, INCLUDING was_right.
   *
   * was_right is the point of review: live it is unknown, and the next morning
   * it is known. That is how a rule gets validated rather than believed.
   */
  r.get('/session/:date/signals', wrap(async (req, res) => {
    const d = day(req.params.date);
    const { rows } = await pool.query(
      `SELECT * FROM public.signal_log WHERE trading_date = $1
        ORDER BY fired_at, symbol`, [d]);
    res.json({
      date: d,
      count: rows.length,
      scored: rows.filter((x) => x.was_right !== null).length,
      signals: rows,
    });
  }));

  /** GET /review/session/:date/positions — positions closed that day. */
  r.get('/session/:date/positions', wrap(async (req, res) => {
    const d = day(req.params.date);
    const { rows } = await pool.query(
      `SELECT * FROM public.position
        WHERE closed_at::date = $1 OR opened_at::date = $1
        ORDER BY opened_at`, [d]);
    res.json({ date: d, count: rows.length, positions: rows });
  }));

  return r;
}

module.exports = { build };
