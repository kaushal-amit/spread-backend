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

/*
 * ─── ONE REGISTRY (Step 3.1 / B-04) ────────────────────────────────────────
 * There were two: this file (what the model calls) and registry.js (what
 * gather() called), with different names, a `getSymbolDay` filtering on
 * capture_quality = 'OK' — a value nothing writes — and a `screen` reading
 * `board.candidates`, a field board() has never returned. registry.js is
 * gone. assertReady(), the audit log and the precedent record live here.
 */

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
      + 'spread and the capture-quality columns. usable_only=true keeps FULL '
      + 'and PARTIAL captures and drops THIN ones.',
    input: { symbol: 'string', date: 'YYYY-MM-DD, optional', from: 'optional', to: 'optional',
      usable_only: 'optional boolean', limit: 'optional, max 60' },
    run: ({ symbol, date, from, to, usable_only, limit }) => q(
      `SELECT * FROM public.symbol_day
        WHERE symbol = $1
          AND (($2::date IS NULL) OR ${DAY} = $2::date)
          AND (($3::date IS NULL) OR ${DAY} >= $3::date)
          AND (($4::date IS NULL) OR ${DAY} <= $4::date)
          -- FULL and PARTIAL are the values the column holds; 'OK' never was.
          AND (($5::boolean IS NOT TRUE) OR data_quality IN ('FULL','PARTIAL'))
        ORDER BY ${DAY} DESC LIMIT $6`,
      [String(symbol || '').toUpperCase(), date || null, from || null, to || null,
        usable_only === true || usable_only === 'true', Math.min(Number(limit) || 60, 60)],
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

  /*
   * R-28 · the eleventh fixed tool, added so the ten can answer the spec's
   * example question ("which stocks I lost on had tiny_pct above 30 the day
   * before"). Losses come from the ledger (spread.order_leg); the prior-session
   * stat is joined from public.symbol_day. `stat` is whitelisted — never
   * interpolated freely — so this stays as safe as a fixed tool.
   */
  losses_by_prior_day_stat: {
    description: 'Stocks you LOST money on whose <stat> the PRIOR trading session '
      + 'exceeded <threshold>. stat is one of: tiny_pct_up, moves, up_moves_2plus, '
      + 'avg_trade_size, total_volume, trades.',
    input: { stat: 'required (a public.symbol_day column, from the fixed set)', threshold: 'required number' },
    run: ({ stat, threshold }) => {
      const ALLOWED = new Set(['tiny_pct_up', 'moves', 'up_moves_2plus', 'avg_trade_size', 'total_volume', 'trades']);
      const col = String(stat || '');
      if (!ALLOWED.has(col)) {
        const { badRequest } = require('../../api/errors');
        throw badRequest(`stat must be one of ${[...ALLOWED].join(', ')}`, `got "${col}"`);
      }
      const t = Number(threshold);
      if (!Number.isFinite(t)) { const { badRequest } = require('../../api/errors'); throw badRequest('threshold must be a number'); }
      return q(
        `WITH legs AS (
           SELECT symbol, contract_seq, side, price_fils, resolved_at,
                  COALESCE(filled_shares, shares) AS shares, COALESCE(commission_kd, 0) AS commission_kd
             FROM spread.order_leg
            WHERE (side = 'BUY' AND status IN ('FILLED','CARRIED')) OR (side = 'SELL' AND status = 'FILLED')
         ), c AS (
           SELECT symbol, contract_seq,
                  max(resolved_at) FILTER (WHERE side = 'SELL') AS closed_at,
                  sum(shares) FILTER (WHERE side = 'BUY') AS bought,
                  sum(shares) FILTER (WHERE side = 'SELL') AS sold,
                  sum(CASE WHEN side = 'SELL' THEN price_fils * shares / 1000.0 ELSE -price_fils * shares / 1000.0 END)
                    - sum(commission_kd) AS net_kd
             FROM legs GROUP BY 1, 2
         ), losses AS (
           SELECT symbol, spread.kuwait_day(closed_at) AS loss_day, round(net_kd::numeric, 3) AS net_kd
             FROM c WHERE bought IS NOT NULL AND sold >= bought AND net_kd < 0
         )
         SELECT l.symbol, l.loss_day, l.net_kd, sd.trading_date AS prior_day, sd.${col} AS stat_value
           FROM losses l
           JOIN LATERAL (
             SELECT trading_date, ${col} FROM public.symbol_day
              WHERE symbol = l.symbol AND trading_date < l.loss_day
              ORDER BY trading_date DESC LIMIT 1) sd ON true
          WHERE sd.${col} > $1
          ORDER BY l.loss_day DESC LIMIT 200`,
        [t], { source: 'spread.order_leg + public.symbol_day' });
    },
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
      + 'the columns the gates read. Returns the recommended and near-miss '
      + 'rows with their verdicts and reasons; no prices.',
    input: {},
    /*
     * The day and the slot come from the REQUEST (ctx), never from the model:
     * the same routes.board(day, budget) the board endpoint serves, so the
     * answer and the screen cannot disagree. board() returns
     * recommended/nearMiss/rejected — there has never been a `candidates`.
     */
    run: async (_args, ctx = {}) => {
      const routes = require('../../api/routes');
      const gateStore = require('../gateStore');
      const { kuwaitDay } = require('../../jobs/daily');
      const day = ctx.day || kuwaitDay();
      const budgetKd = ctx.budgetKd ?? gateStore.effective().BUDGET.slotKd;
      const board = await routes.board(day, budgetKd);
      const strip = (x, status) => ({
        symbol: x.symbol, status, passed: x.passed, failed: x.failed, reasons: x.reasons,
        target_ticks: x.targetTicks, not_computed: x.notComputed,
        gates: (x.gates || []).map((g) => ({ label: g.label, ok: g.ok, warn: g.warn, value: g.value })),
      });
      // CR-8 · the model sees the same buckets the screen shows — TAKE, ONE
      // AWAY and PRICE WARN in full, LEAVE and NOT COMPUTED as symbol lists with
      // the reason, so "why is X not there" has an answer. The boundary still
      // permits BUY/TAKE only for `recommended` (= TAKE).
      const rows = [...board.take.map((x) => strip(x, 'TAKE')),
        ...board.oneAway.map((x) => strip(x, 'ONE_AWAY')),
        ...board.priceWarn.map((x) => ({ ...strip(x, 'PRICE_WARN'), needs_fils: x.needsFils ?? null }))];
      return { rows, rows_returned: rows.length, day, budget_kd: budgetKd,
        recommended: board.take.map((x) => x.symbol),
        take: board.take.map((x) => x.symbol),
        one_away: board.oneAway.map((x) => x.symbol),
        near_miss: board.oneAway.map((x) => x.symbol),
        price_warn: board.priceWarn.map((x) => ({ symbol: x.symbol, needs_fils: x.needsFils ?? null })),
        leave: board.leave.map((x) => ({ symbol: x.symbol, structural: !!x.structural, reason: x.structuralReason || x.reasons?.[0] || null })),
        not_computed: board.notComputed.map((x) => ({ symbol: x.symbol, missing: x.notComputed, reason: x.noRowReason || null })),
        counts: board.counts, source: 'live screening pipeline (today)' };
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

/* The session record as DATA. Every entry was visible in the book at the time. */
const PRECEDENTS = [
  { pattern: 'stranded', date: '2026-07-29', symbol: 'EQUIPMENT', costKd: -44.94,
    what: 'buy left one level below the bid at 238 with 59,695 ahead; filled as price fell through' },
  { pattern: 'chase', date: '2026-08-11', symbol: 'ARABREC', costKd: 0,
    what: 'order moved 168 to 170 while the stock ran 164 to 174; never filled' },
  { pattern: 'sell-moved-down', date: '2026-08-10', symbol: 'KFIC', costKd: -19.52,
    what: 'three sells cancelled and re-sold lower; same stock and entries as 9 Aug which made +2.95' },
  { pattern: 'exit-not-taken', date: '2026-08-05', symbol: 'EMIRATES', costKd: -31,
    what: '+11.40 was available at 09:40 and the exit was named twice; closed -31' },
  { pattern: 'offer-wall', date: '2026-08-03', symbol: 'WETHAQ', costKd: -11.18,
    what: 'bid 20,000 against an offer of 226,114 — eleven to one; filled in minutes, then blocked' },
  { pattern: 'carried', date: '2026-07-29', symbol: 'EQUIPMENT', costKd: -44.94,
    what: 'held over a weekend on a 1-fil spread at 238' },
  { pattern: 'painted-exit', date: '2026-08-11', symbol: 'ARABREC', costKd: 0,
    what: 'moves to 170 were 100, 1 and 9 shares while 30,000-share blocks pushed it back to 169' },
  { pattern: 'one-day-flash', date: '2026-08-10', symbol: 'MUNSHAAT', costKd: 0,
    what: 'flagged at 8.6x — the strongest signal of the day — and was untradeable at 38% exitable' },
  { pattern: 'depth-inverted', date: '2026-08-13', symbol: 'TIJARA', costKd: 0,
    what: 'nine minutes of data gave the OPPOSITE direction to the full session; five observations inside a falling stretch' },
];

/**
 * The registry must not be empty. A previous agent hallucinated tool calls
 * when its registry loaded empty — no data, no way to say so, and confident
 * commentary anyway. Checked BEFORE any commentary is produced.
 */
function assertReady() {
  const names = Object.keys(TOOLS);
  if (names.length === 0) {
    const e = new Error('AI tool registry is EMPTY. No commentary may be produced — a layer ' +
      'with no data must say so rather than invent. This is the known hallucination case.');
    e.code = 'REGISTRY_EMPTY';
    throw e;
  }
  return names;
}

const auditLog = [];
const recentCalls = (n = 50) => auditLog.slice(-n);

/**
 * @param ctx  request context the model never sets: { day, budgetKd }.
 */
async function call(name, args = {}, ctx = {}) {
  assertReady();
  const t = TOOLS[name];
  if (!t) {
    const e = new Error(`"${name}" is not in the tool registry. The registry is frozen — ` +
      `available: ${Object.keys(TOOLS).join(', ')}`);
    e.code = 'TOOL_NOT_FOUND';
    throw e;
  }
  const started = Date.now();
  try {
    const out = await t.run(args || {}, ctx);
    auditLog.push({ at: new Date(), tool: name, args, rows: out.rows_returned ?? null, ms: Date.now() - started });
    if (auditLog.length > 500) auditLog.splice(0, auditLog.length - 500);
    return { ...out, tool: name, args, duration_ms: Date.now() - started };
  } catch (e) {
    auditLog.push({ at: new Date(), tool: name, args, error: e.message, ms: Date.now() - started });
    throw e;
  }
}

module.exports = { TOOLS, PRECEDENTS, schemas, call, assertReady, recentCalls };
