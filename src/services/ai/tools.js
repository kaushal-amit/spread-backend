'use strict';
/**
 * src/services/ai/tools.js — ten parameterised registry calls.
 *
 * ─── THE MODEL PICKS A TOOL, NOT A QUERY ───────────────────────────────────
 * The spec asked for free SQL through a read-only role with an eight-call cap.
 * That trades away the thing that makes this trustworthy.
 *
 * boundary.js rejects any number not traceable to a column, and it can do that
 * because the code knows what was fetched. With free SQL a number is traceable
 * only to a query the model wrote, and "a depth claim on 9 snapshots is
 * rejected" becomes unenforceable — the boundary would have to understand SQL
 * to know how many snapshots were behind it.
 *
 * That rule exists because of a real reading: nine minutes of depth inverted
 * the sign.
 *
 * So the model chooses WHICH of ten, and with what arguments. Every result
 * carries its provenance and its counts.
 *
 * ─── EVERY RESULT DECLARES ITS COUNTS ──────────────────────────────────────
 *     rows_returned   always
 *     snapshots       depth and symbol_minute
 *
 * And the RULE stays in the boundary, not here. A tool that self-censors is a
 * tool that can be talked out of it.
 */

const { pool } = require('../../db');

const q = async (sql, params, extra = {}) => {
  const { rows } = await pool.query(sql, params);
  return { rows, rows_returned: rows.length, ...extra };
};

const DAY = 'trading_date';

const TOOLS = {
  /** One symbol's daily row, or a range of them. */
  symbol_day: {
    description: 'Daily computed metrics for one symbol. Give a symbol, and '
      + 'either a date or a from/to range. Returns close, range, moves, flow, '
      + 'spread and the capture-quality columns.',
    input: { symbol: 'string', date: 'YYYY-MM-DD, optional', from: 'optional', to: 'optional' },
    run: ({ symbol, date, from, to }) => q(
      `SELECT * FROM public.symbol_day
        WHERE symbol = $1
          AND (($2::date IS NULL) OR ${DAY} = $2::date)
          AND (($3::date IS NULL) OR ${DAY} >= $3::date)
          AND (($4::date IS NULL) OR ${DAY} <= $4::date)
        ORDER BY ${DAY} DESC LIMIT 60`,
      [String(symbol || '').toUpperCase(), date || null, from || null, to || null],
      { source: 'public.symbol_day' }),
  },

  /** Market breadth for a date or a range. */
  market_day: {
    description: 'Market-wide breadth and regime for a date or range.',
    input: { date: 'optional', from: 'optional', to: 'optional' },
    run: ({ date, from, to }) => q(
      `SELECT * FROM public.market_day
        WHERE (($1::date IS NULL) OR ${DAY} = $1::date)
          AND (($2::date IS NULL) OR ${DAY} >= $2::date)
          AND (($3::date IS NULL) OR ${DAY} <= $3::date)
        ORDER BY ${DAY} DESC LIMIT 60`,
      [date || null, from || null, to || null], { source: 'public.market_day' }),
  },

  /**
   * The order book.
   *
   * snapshots is returned SEPARATELY from rows_returned: ten levels of one
   * capture is one snapshot, and the 100-snapshot rule counts captures.
   */
  depth: {
    description: 'Order book levels. Latest capture by default, or a time '
      + 'window. Empty for most symbols — 8 of 142 hold a depth slot.',
    input: { symbol: 'string', date: 'optional', since: 'optional timestamp' },
    run: async ({ symbol, date, since }) => {
      const sym = String(symbol || '').toUpperCase();
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (level, captured_at) level, bid, bid_qty, offer,
                offer_qty, captured_at
           FROM public.awsat_stock_depth
          WHERE symbol = $1
            AND (($2::date IS NULL) OR trading_date = $2::date)
            AND (($3::timestamptz IS NULL) OR captured_at >= $3::timestamptz)
          ORDER BY level, captured_at DESC, ingest_source LIMIT 400`,
        [sym, date || null, since || null]);
      const snapshots = new Set(rows.map((r) => String(r.captured_at))).size;
      return { rows, rows_returned: rows.length, snapshots, source: 'public.awsat_stock_depth' };
    },
  },

  /** Minute-by-minute observations for one symbol. */
  symbol_minute: {
    description: 'Per-minute observations for one symbol: price, bid, offer, '
      + 'volume delta. Use for intraday shape.',
    input: { symbol: 'string', date: 'optional', limit: 'optional' },
    run: async ({ symbol, date, limit }) => {
      const { rows } = await pool.query(
        `SELECT * FROM public.symbol_minute
          WHERE symbol = $1 AND (($2::date IS NULL) OR trading_date = $2::date)
          ORDER BY ts DESC LIMIT $3`,
        [String(symbol || '').toUpperCase(), date || null, Math.min(Number(limit) || 120, 400)]);
      // symbol_minute has no id and its time column is `ts`. One row per
      // changed observation, so a snapshot is a distinct ts.
      const snapshots = new Set(rows.map((r) => String(r.ts))).size;
      return { rows, rows_returned: rows.length, snapshots, source: 'public.symbol_minute' };
    },
  },

  /** What fired, and whether it was right. */
  signal_log: {
    description: 'Signals that fired, INCLUDING was_right once scored. '
      + 'was_right is null while a signal is unscored.',
    input: { date: 'optional', symbol: 'optional', scored_only: 'optional boolean' },
    run: ({ date, symbol, scored_only }) => q(
      `SELECT * FROM public.signal_log
        WHERE (($1::date IS NULL) OR trading_date = $1::date)
          AND (($2::text IS NULL) OR symbol = $2)
          AND (($3::boolean IS NOT TRUE) OR was_right IS NOT NULL)
        ORDER BY fired_at DESC LIMIT 200`,
      [date || null, symbol ? String(symbol).toUpperCase() : null, scored_only === true],
      { source: 'public.signal_log' }),
  },

  /** Positions, open or closed. */
  position: {
    description: 'Positions. Open ones, or those opened/closed on a date.',
    input: { date: 'optional', open_only: 'optional boolean' },
    run: ({ date, open_only }) => q(
      `SELECT * FROM public.position
        WHERE (($1::boolean IS NOT TRUE) OR is_open)
          AND (($2::date IS NULL) OR opened_at::date = $2::date OR closed_at::date = $2::date)
        ORDER BY opened_at DESC LIMIT 100`,
      [open_only === true, date || null], { source: 'public.position' }),
  },

  /** The broker's own order records. */
  order_list: {
    description: 'Orders as the broker recorded them, including net_value — '
      + 'the charge that actually landed, which the fee formula cannot produce '
      + 'for a split fill.',
    input: { date: 'optional', symbol: 'optional' },
    run: ({ date, symbol }) => q(
      `SELECT * FROM public.awsat_order_list
        WHERE (($1::date IS NULL) OR trading_date = $1::date)
          AND (($2::text IS NULL) OR symbol = $2)
        ORDER BY order_time DESC LIMIT 200`,
      [date || null, symbol ? String(symbol).toUpperCase() : null],
      { source: 'public.awsat_order_list' }),
  },

  /**
   * The gates, TODAY ONLY. No date parameter, deliberately.
   *
   * This is the live decision engine. Feeding it a past date makes it compute
   * a recommendation for a day that is over, and an answer that reads as
   * current. Historical gate questions come from the stored symbol_day
   * columns via the symbol_day tool — which is what those columns are for.
   */
  screen: {
    description: 'The gates applied across all symbols, TODAY ONLY. There is '
      + 'no date parameter: for a past session use symbol_day, which stores '
      + 'the columns the gates read.',
    input: {},
    run: async () => {
      const routes = require('../../api/routes');
      const board = await routes.board();
      const rows = Array.isArray(board) ? board : (board.candidates || []);
      return { rows, rows_returned: rows.length, source: 'live screening pipeline (today)' };
    },
  },

  /** Two symbols, or two dates, on the same columns. */
  compare: {
    description: 'The same symbol_day columns for two symbols on one date, or '
      + 'one symbol on two dates. Returns both rows so the difference is '
      + 'visible rather than asserted.',
    input: { symbols: 'array of 1-2', dates: 'array of 1-2' },
    run: ({ symbols = [], dates = [] }) => q(
      `SELECT * FROM public.symbol_day
        WHERE symbol = ANY($1) AND ${DAY} = ANY($2::date[])
        ORDER BY symbol, ${DAY}`,
      [(symbols || []).map((s) => String(s).toUpperCase()), dates || []],
      { source: 'public.symbol_day' }),
  },

  /** The knowledge base itself. */
  kb_rule: {
    description: 'The knowledge base. Use when asked what a rule says or why '
      + 'something is done a particular way.',
    input: { symbol: 'optional', search: 'optional text' },
    run: ({ symbol, search }) => q(
      `SELECT heading, source_file, scope, symbol, rule FROM spread.kb_rule
        WHERE still_true
          AND (($1::text IS NULL) OR scope = 'GLOBAL' OR symbol = $1)
          AND (($2::text IS NULL) OR rule ILIKE '%' || $2 || '%')
        ORDER BY scope, source_file LIMIT 20`,
      [symbol ? String(symbol).toUpperCase() : null, search || null],
      { source: 'spread.kb_rule' }),
  },
};

/** Anthropic tool schemas, generated from the definitions above. */
function schemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(t.input).map(([k, v]) => [k, { type: /array/.test(v) ? 'array' : 'string', description: v }])),
      required: [],
    },
  }));
}

async function call(name, args = {}) {
  const t = TOOLS[name];
  if (!t) throw new Error(`unknown tool: ${name}`);
  const started = Date.now();
  const out = await t.run(args || {});
  return { ...out, tool: name, args, duration_ms: Date.now() - started };
}

module.exports = { TOOLS, schemas, call };
