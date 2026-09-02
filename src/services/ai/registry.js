'use strict';
/**
 * ============================================================================
 *  registry.js — the AI calls a FIXED set of functions. It does not write SQL.
 * ============================================================================
 * FROZEN. Anything outside this list is refused BY NAME rather than attempted.
 *
 * THE EMPTY-REGISTRY CASE IS A KNOWN FAILURE MODE. A previous agent
 * hallucinated tool calls when its registry loaded empty — it had no data, no
 * way to say so, and produced confident commentary anyway. A commentary layer
 * with no data must FAIL LOUDLY, not invent.
 *
 * That is why call() refuses rather than returning an empty result: an empty
 * array and a broken connection look identical downstream, and one of them is
 * a reason to stop.
 * ============================================================================
 */

const { pool } = require('../../db');
const live = require('../live');
const depth = require('../depth');
const screening = require('../screening');

const TOOLS = {
  getSymbolDay: { args: ['symbol', 'days'], fn: async (db, { symbol, days = 5 }) => {
    const { rows } = await db.query(
      `SELECT * FROM spread.symbol_day
        WHERE upper(symbol) = upper($1) AND capture_quality IN ('OK','PARTIAL')
        ORDER BY trading_day DESC LIMIT $2;`, [symbol, Math.min(Number(days) || 5, 60)]);
    return rows;
  } },

  getProfile: { args: ['symbol'], fn: async (db, { symbol }) => {
    const { rows } = await db.query(
      'SELECT * FROM spread.symbol_profile WHERE upper(symbol) = upper($1);', [symbol]);
    return rows[0] || null;
  } },

  getBook: { args: ['symbol'], fn: async (db, { symbol }) => {
    const { rows } = await db.query(
      `SELECT symbol, bid, bid_qty, offer, offer_qty, last_price, last_qty,
              trades, volume, created_at
         FROM spread.v_quote_screening
        WHERE upper(symbol) = upper($1) ORDER BY created_at DESC LIMIT 1;`, [symbol]);
    return rows[0] || null;
  } },

  getMarketDay: { args: ['date'], fn: async (db, { date }) => {
    const { rows } = await db.query(
      'SELECT * FROM spread.market_day WHERE trading_day = $1;', [date]);
    return rows[0] || null;
  } },

  getEvents: { args: ['symbol', 'days'], fn: async (db, { symbol, days = 30 }) => {
    const { rows } = await db.query(
      `SELECT * FROM spread.symbol_event
        WHERE upper(symbol) = upper($1) AND event_date >= current_date - $2::int
        ORDER BY event_date DESC;`, [symbol, Number(days) || 30]);
    return rows;
  } },

  getWakeups: { args: ['date'], fn: async (db, { date }) => live.wakeUpScan(date, { db }) },

  getDepthSignal: { args: ['symbol', 'date'], fn: async (db, { symbol, date }) => {
    const s = await depth.signalFor(symbol, date, { db });
    // The sample size travels WITH the signal so the boundary can check it.
    return s;
  } },

  getMyOrders: { args: ['days'], fn: async (db, { days = 1 }) => {
    const { rows } = await db.query(
      `SELECT symbol, side, status, price_fils, shares, filled_shares,
              commission_kd, executions, placement, posted_at, resolved_at
         FROM spread.order_leg
        WHERE trading_day >= current_date - $1::int
        ORDER BY posted_at DESC LIMIT 50;`, [Number(days) || 1]);
    return rows;
  } },

  /*
   * The ninth tool, and THE ONLY ONE THAT RETURNS A VERDICT rather than raw
   * data. The other eight give the model numbers to reason from; this gives it
   * the answer.
   *
   * Deliberate: the AI's job is explaining and warning, not second-guessing
   * nine gates. If its commentary disagrees with the funnel, that is a bug in
   * one of them — and cited_values makes it traceable to which.
   *
   * NO PRICES REACH THE MODEL THROUGH THIS. Verdicts and reasons only.
   */
  getScreenResult: { args: ['date', 'budgetKd'], fn: async (db, { date, budgetKd = 790 }) => {
    const r = await screening.screen(date, Number(budgetKd), { db });
    const strip = (x) => ({
      symbol: x.symbol, passed: x.passed, failed: x.failed, reasons: x.reasons,
      score: x.score, targetTicks: x.targetTicks, rising: x.rising,
      behaviour: x.behaviour,
      gates: x.gates.map((g) => ({ label: g.label, ok: g.ok, warn: g.warn, value: g.value })),
    });
    return {
      recommended: r.recommended.map(strip),
      nearMiss: r.nearMiss.map(strip),
      rejected: r.rejected.map(strip),
      counts: r.counts, reach: r.reach,
    };
  } },

  /*
   * The precedent lookup. "You have repositioned twice" is ignorable;
   * "the third reposition cost 44.94" is not. The record is what makes a
   * warning land.
   */
  getPrecedent: { args: ['pattern'], fn: async (_db, { pattern }) =>
    PRECEDENTS.filter((p) => !pattern || p.pattern === pattern) },
};

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

const auditLog = [];

/** The registry must not be empty. Checked BEFORE any commentary is produced. */
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

async function call(name, args = {}, { db = pool, timeoutMs = 10000 } = {}) {
  assertReady();
  const tool = TOOLS[name];
  if (!tool) {
    const e = new Error(`"${name}" is not in the tool registry. The registry is frozen — ` +
      `available: ${Object.keys(TOOLS).join(', ')}`);
    e.code = 'TOOL_NOT_FOUND';
    throw e;
  }

  const t0 = Date.now();
  const timer = new Promise((_, rej) => setTimeout(
    () => rej(Object.assign(new Error(`${name} exceeded ${timeoutMs}ms`), { code: 'TOOL_TIMEOUT' })),
    timeoutMs));

  try {
    const result = await Promise.race([tool.fn(db, args), timer]);
    auditLog.push({ at: new Date(), tool: name, args,
      rows: Array.isArray(result) ? result.length : (result ? 1 : 0), ms: Date.now() - t0 });
    return result;
  } catch (e) {
    auditLog.push({ at: new Date(), tool: name, args, error: e.message, ms: Date.now() - t0 });
    throw e;
  }
}

const recentCalls = (n = 50) => auditLog.slice(-n);
const toolSchemas = () => Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: `SPREAD read-only tool. Arguments: ${t.args.join(', ') || 'none'}`,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(t.args.map((a) => [a, { type: 'string' }])),
  },
}));

module.exports = { TOOLS, PRECEDENTS, call, assertReady, recentCalls, toolSchemas };
