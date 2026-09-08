'use strict';
/**
 * ============================================================================
 *  slots.js — the per-slot stale rule (A4, Item 5)
 * ============================================================================
 * A depth slot is only as good as its latest capture. When a slot stops being
 * swept — the symbol suspended, the scrape timing out — its ladder freezes and
 * every size and stop read off it is a stale picture. On 7 September four of
 * twelve slots died before 09:30. This finds them: during the session, a slot
 * whose newest awsat_stock_depth capture is older than `slot_stale_min` (kb, 10)
 * is stale, emitted on the feed as `spread:slotStale` and displaced FIRST on the
 * next swap.
 *
 * The window is 09:00–13:30 Kuwait: before the open there is nothing to capture,
 * and after 13:30 the session is closing and a gap is expected. Outside it the
 * rule is silent (no false stale on a quiet evening).
 * ============================================================================
 */
const { pool } = require('../db');

const WINDOW_START_MIN = 9 * 60;        // 09:00 Kuwait
const WINDOW_END_MIN = 13 * 60 + 30;    // 13:30 Kuwait
const kuwaitMins = (d) => { const k = new Date(new Date(d).getTime() + 3 * 3600000); return k.getUTCHours() * 60 + k.getUTCMinutes(); };

async function staleMin(db = pool) {
  const { rows } = await db.query(
    "SELECT value FROM spread.kb_threshold WHERE key = 'slot_stale_min' AND still_true;").catch(() => ({ rows: [] }));
  const v = rows[0] ? Number(rows[0].value) : 10;
  return Number.isFinite(v) ? v : 10;
}

/**
 * G-5 · the slot count, from the scraper's published number — never a literal 5
 * or 12. The scraper's GET /ingest/depth-symbols carries slotCount; until it can
 * be reached, fall back to the count of DISTINCT slots present in
 * awsat_stock_depth today (the real address space the data proves), and only
 * then to 5. `client` is injectable for the test.
 */
async function slotCount(tradingDay, { db = pool, client = require('./scraperClient') } = {}) {
  const published = await (client.depthSymbols ? client.depthSymbols() : Promise.resolve(null)).catch(() => null);
  if (published && Number.isFinite(Number(published.slotCount)) && Number(published.slotCount) > 0) {
    return Number(published.slotCount);
  }
  const { rows } = await db.query(
    `SELECT count(DISTINCT symbol)::int AS n FROM public.awsat_stock_depth WHERE trading_date = $1`,
    [require('../lib/day').toDay(tradingDay)]).catch(() => ({ rows: [{ n: 0 }] }));
  return rows[0] && rows[0].n > 0 ? Number(rows[0].n) : 5;
}

/**
 * The stale slots for the day, as of `now`. Each active slot's newest
 * awsat_stock_depth capture; a slot with no capture for `slot_stale_min`, inside
 * the session window, is stale. Returns [{ slot, symbol, lastCaptureAt, staleSec }].
 * Empty outside 09:00–13:30 — a gap there is expected, not a fault.
 */
async function staleSlots(tradingDay, { db = pool, now = new Date() } = {}) {
  const mins = kuwaitMins(now);
  if (mins < WINDOW_START_MIN || mins > WINDOW_END_MIN) return [];
  const cap = await staleMin(db);
  const { rows } = await db.query(
    `SELECT w.slot_no, w.symbol,
            (SELECT max(d.captured_at) FROM public.awsat_stock_depth d
              WHERE upper(d.symbol) = upper(w.symbol) AND d.trading_date = w.trading_date) AS last_capture
       FROM public.depth_watchlist w
      WHERE w.trading_date = $1 AND w.released_at IS NULL
      ORDER BY w.slot_no;`, [tradingDay]);
  const nowMs = new Date(now).getTime();
  const out = [];
  for (const r of rows) {
    const last = r.last_capture ? new Date(r.last_capture).getTime() : null;
    const staleSec = last == null ? null : Math.round((nowMs - last) / 1000);
    if (last == null || staleSec > cap * 60) {
      out.push({ slot: Number(r.slot_no), symbol: r.symbol,
        lastCaptureAt: r.last_capture ? new Date(r.last_capture).toISOString() : null,
        staleSec });
    }
  }
  return out;
}

module.exports = { staleSlots, staleMin, slotCount, WINDOW_START_MIN, WINDOW_END_MIN, kuwaitMins };
