'use strict';
/**
 * ============================================================================
 *  halts.js — the halt-resume detector (FLOW 6.7, HALT_RESUME_study items 1 & 2)
 * ============================================================================
 * A down-halt that resumes pays a measured +5.43 average over the fillable
 * band, and the window is ~2 minutes — each minute costs roughly half the edge
 * (+5.43 at the resume, +3.00 sixty seconds later). So the DECISION cannot be
 * worked out while the window is open: the direction is fixed at the halt, and
 * the verdict is computed the moment the symbol resumes.
 *
 * WHAT RUNS WHERE:
 *   detect   every `halt_poll_secs`, the latest capture of awsat_market_quotes,
 *            each symbol's `session` compared to the last poll
 *   on HALT  record the price five minutes prior and at the halt -> direction;
 *            request a depth slot (the ladder is needed for size and stop)
 *   on RESUME compute the verdict (§8/§9) and push spread:halt
 *
 * THE BOUNDARY: the transition log is spread.halt_event, not public.signal_log
 * — the backend may not write public.* (lint-enforced). The auto-swap is a
 * REQUEST for the same reason: public.depth_watchlist is the scraper's, so the
 * backend decides which slot to displace and emits/records it; the scraper
 * applies it (POST /ingest/slots/:n) — a named seam, not a silent gap.
 *
 * §8 CAVEATS — read before trusting a TRADEABLE (HALT_DETECTOR_spec §8):
 *   · REACTION TIME eats the edge. +5.43 at the resume, +3.00 sixty seconds
 *     later — the window is ~2 minutes and a human is slow. A live figure under
 *     +2.00 over twenty firings means reaction time, not the signal, is the cost.
 *   · QUEUE POSITION is not modelled. "you = 91% of the bid" is size, not a fill:
 *     you still join the queue, and the bid can rebuild before you are served.
 *   · A STOP INSIDE A HALT does not execute — if it re-halts through your stop,
 *     the −5 is not a floor. Two stops gapping through −5 in a month kills this.
 *   · THE UNFILTERABLE 17% — nine of 62 resumes were unfillable and were the best
 *     payers; the gates REJECT them (shown, never removed) but cannot rescue them.
 * ============================================================================
 */
const { pool } = require('../db');
const { toDay } = require('../lib/day');
const pricing = require('../lib/pricing');

const KEYS = ['halt_min_price', 'halt_max_price', 'halt_book_too_deep_qty', 'halt_exit_multiple_min',
  'halt_target_fils', 'halt_stop_fils', 'halt_direction_window_mins', 'halt_poll_secs',
  'halt_offer_over_bid_max', 'my_pct_max'];

const DEFAULTS = { halt_min_price: 100, halt_max_price: 333, halt_book_too_deep_qty: 50000,
  halt_exit_multiple_min: 5, halt_target_fils: 5, halt_stop_fils: 5, halt_direction_window_mins: 5, halt_poll_secs: 20,
  halt_offer_over_bid_max: 3, my_pct_max: 30 };

async function thresholds(db = pool) {
  const t = { ...DEFAULTS };
  try {
    const { rows } = await db.query(
      'SELECT key, value FROM spread.kb_threshold WHERE still_true AND key = ANY($1)', [KEYS]);
    for (const r of rows) t[r.key] = Number(r.value);
  } catch { /* the table may be pre-023 in a bare DB — defaults hold */ }
  return t;
}

const LOT = 100; // shares round to a lot, like the rest of the sizing

/**
 * G-6 · a session string reduced to the state that matters. Beyond the two the
 * spec names:
 *   TRADING  Trading, Trading at Last, Continuous, Open, and NULL/empty
 *            (a null session row is ordinary trading — spec §2)
 *   HALT     CB Auction, Halt, Suspend, Circuit
 *   CLOSE    Close-Of-Day, Closing, Close Auction Acceptance — the session ended
 * CLOSE is tested BEFORE HALT because "Close Auction Acceptance" contains the
 * word Auction; it is an ending, not a halt.
 */
function sessionClass(s) {
  const v = String(s == null ? '' : s).trim();
  if (v === '') return 'TRADING';
  if (/close|closing|acceptance/i.test(v)) return 'CLOSE';
  if (/auction|halt|suspend|circuit|\bcb\b/i.test(v)) return 'HALT';
  if (/trading|continuous|open/i.test(v)) return 'TRADING';
  return 'OTHER';
}

/**
 * The transitions between two session snapshots, each a Map(symbol -> session
 * string). Only the two that matter are reported.
 *   TRADING -> HALT     a halt
 *   HALT    -> TRADING  a resume
 * A symbol absent from `prev` is being seen for the first time and yields no
 * transition (a restart must not replay the whole session as halts).
 */
function transitions(prev, now) {
  const out = [];
  for (const [symbol, sess] of now) {
    if (!prev.has(symbol)) continue;
    const from = sessionClass(prev.get(symbol));
    const to = sessionClass(sess);
    if (from === 'TRADING' && to === 'HALT') out.push({ symbol, kind: 'HALT', sessionFrom: prev.get(symbol), sessionTo: sess });
    else if (from === 'HALT' && to === 'TRADING') out.push({ symbol, kind: 'RESUME', sessionFrom: prev.get(symbol), sessionTo: sess });
    // G-6 · a halt that goes straight to a CLOSE state never resumed.
    else if (from === 'HALT' && to === 'CLOSE') out.push({ symbol, kind: 'NO_RESUME', sessionFrom: prev.get(symbol), sessionTo: sess });
  }
  return out;
}

/** shares a `budgetKd` buys at `priceFils` — through pricing.js, the ONE place
 *  that rounds to a lot (lint-enforced). */
function sharesAt(budgetKd, priceFils) {
  return pricing.sharesFor(Number(budgetKd), Number(priceFils));
}

/**
 * A3 · the resume BAND reference = ceil(prev_close × 0.95). The exchange reopens
 * a halted symbol against this, but it is NOT a floor — on 7 September FUTUREKID
 * reopened 7 fils under it — so the UI shows it as a reference, never a floor.
 */
function haltBandFloor(prevCloseFils) {
  const p = Number(prevCloseFils);
  return p > 0 ? Math.ceil(p * 0.95) : null;
}

/**
 * The verdict — computed, never left to be worked out while the window is open.
 * Pure over the resume book, the sizing, the skip flag and the thresholds.
 *
 * §9 gate order (1–8): direction, band, SECOND HALT (repeat), skip (WARN),
 * book-too-deep, SELLERS STILL QUEUED (ratio — gate 7, before the exit gate),
 * EXIT BLOCKED (gate 8). Then the size check: your % of the bid over my_pct_max
 * is halved once through pricing.js, and if it is STILL over, BOOK TOO DEEP.
 */
function verdict({ direction, resumePrice, bidQty, offerQty, budgetKd, skipReason = null,
                   haltCountToday = 0 }, t = DEFAULTS) {
  const price = Number(resumePrice);
  const myPctMax = Number(t.my_pct_max ?? 30);
  const ratioMax = Number(t.halt_offer_over_bid_max ?? 3);
  // G-4 · gates 1–7 do not need the budget; only sizing and the exit gate do.
  // With no session budget set, the size is NULL — never a fallback number — and
  // the verdict is NO BUDGET SET rather than TRADEABLE or a silent skip.
  const noBudget = budgetKd == null;

  // Sizing, through pricing.js. If your % of the touch bid is over my_pct_max,
  // halve the budget and recompute ONCE; a size still over the cap is BOOK TOO
  // DEEP below. yourPctBid/exitMultiple reflect the (possibly halved) size.
  let shares = noBudget ? null : sharesAt(budgetKd, price);
  let halved = false;
  const pctOf = (s) => (s != null && bidQty > 0 ? Number(((100 * s) / Number(bidQty)).toFixed(1)) : null);
  let yourPctBid = pctOf(shares);
  if (!noBudget && yourPctBid != null && yourPctBid > myPctMax) {
    shares = sharesAt(Number(budgetKd) / 2, price);
    yourPctBid = pctOf(shares);
    halved = true;
  }
  const exitMultiple = shares > 0 ? Number((Number(offerQty) / shares).toFixed(2)) : null;
  const offerOverBid = bidQty > 0 ? Number((Number(offerQty) / Number(bidQty)).toFixed(2)) : null;
  const target = price + Number(t.halt_target_fils);
  const stop = price - Number(t.halt_stop_fils);
  const num = (x) => Number(x).toLocaleString('en-US');

  let v, detail;
  if (direction !== 'DOWN') {
    v = 'UP HALT — SKIP'; detail = 'an upward halt leans negative (−2.5 fils average) — only the down halt is traded';
  } else if (price < Number(t.halt_min_price) || price > Number(t.halt_max_price)) {
    v = 'PRICE OUT OF BAND'; detail = `resume ${price} is outside ${t.halt_min_price}–${t.halt_max_price} fils`;
  } else if (Number(haltCountToday) >= 1) {
    // Gate 5 · this is not the symbol's first halt today — the down-up-down
    // pattern is a cascade, not a bounce. Do not trade it.
    v = 'SECOND HALT — CASCADE'; detail = `halt #${Number(haltCountToday) + 1} for this symbol today — a re-halt is a cascade, not a bounce`;
  } else if (skipReason) {
    v = 'WARN'; detail = `skip list — ${skipReason}`;
  } else if (Number(bidQty) >= Number(t.halt_book_too_deep_qty)) {
    v = 'BOOK TOO DEEP'; detail = `touch bid ${num(bidQty)} is at/over ${num(t.halt_book_too_deep_qty)} — you cannot get filled ahead of it`;
  } else if (offerOverBid != null && Number(offerQty) > ratioMax * Number(bidQty)) {
    // Gate 7 · the offer overhangs the bid — sellers are still queued and the
    // bounce will be sold into. Sits BEFORE the exit gate.
    v = 'SELLERS STILL QUEUED'; detail = `offer ${num(offerQty)} is ${offerOverBid}× the bid ${num(bidQty)} — over ${ratioMax}×, the sellers are still there`;
  } else if (noBudget) {
    // Gate 8 needs a size, and there is no budget to compute one. Not TRADEABLE,
    // not a silent skip — the operator is told to set a budget, and the alert
    // still goes out so the window is not missed.
    v = 'NO BUDGET SET'; detail = 'gates 1–7 passed, but no session budget is set — set one (PUT /gates {"session-budget": …}) to size it';
  } else if (exitMultiple != null && Number(offerQty) >= Number(t.halt_exit_multiple_min) * shares) {
    v = 'EXIT BLOCKED'; detail = `offer ${num(offerQty)} is ${exitMultiple}× your ${num(shares)} — the exit will not clear`;
  } else if (yourPctBid != null && yourPctBid > myPctMax) {
    // The size is still over the cap after halving once.
    v = 'BOOK TOO DEEP'; detail = `your ${num(shares)} is ${yourPctBid}% of the bid ${num(bidQty)} — over ${myPctMax}% even halved`;
  } else {
    v = 'TRADEABLE'; detail = `bid ${num(bidQty)} · you ${num(shares)} = ${yourPctBid}%${halved ? ' (halved)' : ''} · offer ${exitMultiple}×`;
  }
  return { verdict: v, verdictDetail: detail, direction, resumePrice: price, yourShares: shares,
    yourPctBid, exitMultiple, offerOverBid, halved, targetFils: target, stopFils: stop, tradeable: v === 'TRADEABLE' };
}

/** The price `windowMins` before `at`, from the executable prints (the latest at or before). */
async function priceBefore(symbol, tradingDay, at, windowMins, db = pool) {
  const cutoff = new Date(new Date(at).getTime() - windowMins * 60000);
  const { rows: [r] } = await db.query(
    `SELECT last_price FROM public.awsat_market_quotes
      WHERE upper(symbol) = upper($1) AND trading_date = $2 AND created_at <= $3 AND last_price IS NOT NULL
      ORDER BY created_at DESC LIMIT 1;`, [symbol, tradingDay, cutoff]);
  return r ? Number(r.last_price) : null;
}

/** The prior session's close for this symbol, for the resume band reference. */
async function priorClose(symbol, tradingDay, db = pool) {
  const { rows: [r] } = await db.query(
    `SELECT close_px FROM public.symbol_day
      WHERE upper(symbol) = upper($1) AND trading_date < $2 AND close_px IS NOT NULL
      ORDER BY trading_date DESC LIMIT 1;`, [symbol, tradingDay]);
  return r ? Number(r.close_px) : null;
}

/**
 * The alert payload — HALT_DETECTOR_spec §5 / study §8, one stable shape for the
 * push, the feed row and the test. Rejects carry it too (the same shape, a
 * non-TRADEABLE verdict): a screen ranks, it never removes.
 */
function payload({ id, symbol, at, vd, bidQty, offerQty, bandRefFils, history: hist }) {
  return {
    id, symbol, at: new Date(at).toISOString(),
    direction: vd.direction,
    resumePriceFils: vd.resumePrice,
    touchBidQty: Number(bidQty), touchOfferQty: Number(offerQty),
    bandRefFils,                       // ceil(prev_close × 0.95) — a reference, NOT a floor
    yourShares: vd.yourShares, yourPctBid: vd.yourPctBid,
    exitMultiple: vd.exitMultiple, offerOverBid: vd.offerOverBid, halved: vd.halved,
    targetFils: vd.targetFils, stopFils: vd.stopFils,
    verdict: vd.verdict, verdictDetail: vd.verdictDetail, tradeable: vd.tradeable,
    symbolHistory: { halts: hist.halts, reached5Fils: hist.reached5Fils ?? hist.gave5,
      avgFils: hist.avgFils ?? hist.avgGain, gave5: hist.gave5, avgGain: hist.avgGain },
    // legacy field names some callers/tests read
    resumePrice: vd.resumePrice, history: hist,
  };
}

/**
 * G-3 · this symbol's halt history from prior sessions (study §10), from the ONE
 * scoring home. Each RESUME in spread.halt_event is LEFT JOINed to its scored
 * public.signal_log HALT_RESUME row by (symbol, fired_at = detected_at):
 *   halts        every RESUME (scored or not)
 *   reached5Fils RESUMEs whose 15-minute score cleared the halt target (+5 fils)
 *   avgFils      the average 15-minute move over the scored ones
 * A RESUME with no score yet is counted in `halts`, not in `reached5Fils` — the
 * 15-minute horizon is the closest signal_log carries to the study's 20 minutes.
 */
async function history(symbol, tradingDay, db = pool) {
  const target = Number(DEFAULTS.halt_target_fils);
  const { rows: [r] } = await db.query(
    `WITH r AS (
       SELECT h.symbol, h.resume_price_fils AS px, s.px_15min, s.was_right
         FROM spread.halt_event h
         LEFT JOIN public.signal_log s
           ON s.signal = 'HALT_RESUME' AND upper(s.symbol) = upper(h.symbol) AND s.fired_at = h.detected_at
        WHERE upper(h.symbol) = upper($1) AND h.kind = 'RESUME' AND h.trading_day < $2::date
     )
     SELECT count(*)::int AS halts,
            count(*) FILTER (WHERE px_15min IS NOT NULL AND (px_15min - px) >= $3)::int AS reached5,
            round(avg(px_15min - px) FILTER (WHERE px_15min IS NOT NULL), 1) AS avg_fils
       FROM r;`, [symbol, tradingDay, target]);
  const reached = Number(r?.reached5 || 0);
  const avg = r?.avg_fils != null ? Number(r.avg_fils) : null;
  // Keep the legacy field names (gave5 / avgGain) as aliases so existing callers
  // and the payload do not break.
  return { halts: Number(r?.halts || 0), reached5Fils: reached, avgFils: avg, gave5: reached, avgGain: avg };
}

/**
 * Which depth slot to displace for a halted symbol (FLOW step 2): the deadest
 * active slot that is NOT holding an open position or a queued order. Returns a
 * REQUEST — public.depth_watchlist is the scraper's, so the backend never writes
 * it. null when the symbol already holds a slot or none can be freed.
 */
async function slotSwapDecision(symbol, tradingDay, db = pool) {
  const { rows: slots } = await db.query(
    `SELECT slot_no, symbol FROM public.depth_watchlist
      WHERE trading_date = $1 AND released_at IS NULL ORDER BY slot_no;`, [tradingDay]);
  if (slots.some((s) => String(s.symbol).toUpperCase() === String(symbol).toUpperCase())) {
    return { swapIn: symbol, displace: null, reason: 'already in the sweep' };
  }
  // A slot is protected if its symbol holds an open position (a filled buy not
  // yet fully sold) or a live claim/queued order.
  const held = new Set();
  const { rows: pos } = await db.query(
    `SELECT DISTINCT symbol FROM spread.order_leg
      WHERE trading_day = $1 AND status IN ('FILLED','CARRIED','POSTED');`, [tradingDay]);
  for (const p of pos) held.add(String(p.symbol).toUpperCase());
  const { rows: claims } = await db.query('SELECT symbol FROM spread.claim;').catch(() => ({ rows: [] }));
  for (const c of claims) held.add(String(c.symbol).toUpperCase());

  const displaceable = slots.filter((s) => !held.has(String(s.symbol).toUpperCase()));
  if (!displaceable.length) {
    return { swapIn: symbol, displace: null, reason: slots.length ? 'every slot holds a position or an order — not displaced' : 'no slots configured' };
  }
  // A4 · a STALE slot goes first (no depth capture for slot_stale_min); then the
  // deadest by CAPTURE AGE (oldest last capture). Trades are the final tiebreak
  // when depth capture ages tie (e.g. a fresh DB with no depth rows).
  const syms = displaceable.map((s) => s.symbol);
  const cap = await require('./slots').staleMin(db);
  const { rows: capRows } = await db.query(
    `SELECT upper(symbol) AS sym, max(captured_at) AS last_capture
       FROM public.awsat_stock_depth
      WHERE trading_date = $1 AND upper(symbol) = ANY($2)
      GROUP BY upper(symbol);`, [tradingDay, syms.map((s) => String(s).toUpperCase())]);
  const captureBy = new Map(capRows.map((c) => [c.sym, c.last_capture ? new Date(c.last_capture).getTime() : null]));
  const { rows: activity } = await db.query(
    `SELECT DISTINCT ON (symbol) symbol, COALESCE(trades, 0) AS trades
       FROM public.awsat_market_quotes
      WHERE trading_date = $1 AND symbol = ANY($2)
      ORDER BY symbol, created_at DESC;`, [tradingDay, syms]);
  const tradesBy = new Map(activity.map((a) => [String(a.symbol).toUpperCase(), Number(a.trades)]));
  const capOf = (s) => captureBy.get(String(s.symbol).toUpperCase()) ?? null; // null = never captured = most stale
  const ageKey = (s) => { const c = capOf(s); return c == null ? Infinity : (Date.now() - c) / 1000; };
  displaceable.sort((a, b) => {
    const da = ageKey(a), dbb = ageKey(b);
    if (da !== dbb) return dbb - da; // oldest capture (largest age) first
    return (tradesBy.get(String(a.symbol).toUpperCase()) ?? 0) - (tradesBy.get(String(b.symbol).toUpperCase()) ?? 0);
  });
  const pick = displaceable[0];
  const pickCap = capOf(pick);
  const stale = pickCap == null || (Date.now() - pickCap) / 1000 > cap * 60;
  const reason = stale
    ? `stale slot (${pickCap == null ? 'no depth capture today' : Math.round((Date.now() - pickCap) / 60000) + ' min since last capture'}), no position or order`
    : `deadest by capture age (${tradesBy.get(String(pick.symbol).toUpperCase()) ?? 0} trades today), no position or order`;
  // G-1 · the ranked candidates, so a 409 on the first can try the next once.
  const candidates = displaceable.map((s) => ({
    slot: s.slot_no, symbol: s.symbol,
    stale: capOf(s) == null || (Date.now() - capOf(s)) / 1000 > cap * 60 }));
  return { swapIn: symbol, displace: pick.slot_no, displaceSymbol: pick.symbol, stale, reason, candidates };
}

/** The latest capture of the day: symbol -> the quote row. */
async function latestCapture(tradingDay, db = pool) {
  const { rows } = await db.query(
    `SELECT symbol, session, last_price, bid, bid_qty, offer, offer_qty, trades, created_at
       FROM public.awsat_market_quotes
      WHERE trading_date = $1
        AND created_at = (SELECT max(created_at) FROM public.awsat_market_quotes WHERE trading_date = $1);`,
    [tradingDay]);
  return rows;
}

/**
 * One poll. `sessions` is the caller's Map(symbol -> last session string),
 * carried across polls and mutated here. Returns the halts and resumes detected,
 * each already recorded in spread.halt_event, with the resume carrying its
 * computed verdict — ready to emit.
 */
/**
 * G-1 · apply the swap through the scraper, blocking, and record every outcome
 * on the HALT row. 200 → slot_applied; 409 → try the next ranked candidate once,
 * else slot_refused_reason; a network error/timeout → SCRAPER_UNREACHABLE. The
 * halt still alerts whatever happens. Returns { applied, slot, replaced, reason }.
 */
async function applyHaltSlot(client, decision, symbol, haltId, db) {
  if (!decision || decision.displace == null) {
    const reason = decision ? decision.reason : 'no slot decision';
    await db.query('UPDATE spread.halt_event SET slot_refused_reason = $1 WHERE id = $2', [reason, haltId]);
    return { applied: false, slot: null, replaced: null, reason };
  }
  const cands = decision.candidates && decision.candidates.length
    ? decision.candidates
    : [{ slot: decision.displace, symbol: decision.displaceSymbol }];
  let lastReason = null;
  for (let i = 0; i < Math.min(2, cands.length); i += 1) { // the pick, then one more on 409
    const c = cands[i];
    const res = await client.applySlot(c.slot, { symbol, reason: 'HALT', replacedSymbol: c.symbol });
    if (res.ok) {
      const replaced = res.row && res.row.replaced_symbol != null ? res.row.replaced_symbol : c.symbol;
      await db.query(
        `UPDATE spread.halt_event SET slot_applied = $1, slot_applied_at = now(), replaced_symbol = $2,
                slot_refused_reason = NULL WHERE id = $3`, [c.slot, replaced, haltId]);
      return { applied: true, slot: c.slot, replaced, reason: null };
    }
    if (res.networkError) {
      await db.query('UPDATE spread.halt_event SET slot_refused_reason = $1 WHERE id = $2', [res.reason, haltId]);
      return { applied: false, slot: null, replaced: null, reason: res.reason };
    }
    lastReason = (res.body && (res.body.error || res.body.detail)) || `HTTP ${res.status}`;
    // a 409 falls through to the next candidate once
  }
  const reason = `SLOT_REFUSED: ${lastReason || 'no eligible slot'}`;
  await db.query('UPDATE spread.halt_event SET slot_refused_reason = $1 WHERE id = $2', [reason, haltId]);
  return { applied: false, slot: null, replaced: null, reason };
}

/**
 * G-7 · rebuild the detector's per-symbol state from today's halt_event rows, so
 * memory is a CACHE of the table, not the source. After a restart:
 *   · a symbol whose latest event is an OPEN halt (no RESUME/NO_RESUME child) is
 *     seeded HALTED — the same CB Auction capture does not re-fire, and a resume
 *     that happened during the downtime is detected on the next poll.
 *   · a symbol whose latest event is a RESUME / NO_RESUME is seeded TRADING.
 * The gate-5 count reads the table directly, so it is already correct after a
 * deploy; this makes the SESSION map correct too. Populates `sessions` and
 * returns it, so the poll's blind first-tick seed is not used.
 */
async function recoverState(tradingDay, sessions = new Map(), db = pool) {
  const day = toDay(tradingDay);
  const { rows } = await db.query(
    `SELECT DISTINCT ON (symbol) symbol, kind FROM spread.halt_event
      WHERE trading_day = $1 ORDER BY symbol, detected_at DESC, id DESC;`, [day]);
  for (const r of rows) {
    sessions.set(String(r.symbol).toUpperCase(), r.kind === 'HALT' ? 'CB Auction' : 'Trading');
  }
  return sessions;
}

async function poll(tradingDay, { db = pool, budgetKd = require('../config/spread.config').BUDGET.slotKd, seed = false,
                                  scraperClient = require('./scraperClient') } = {}, sessions = new Map()) {
  const day = toDay(tradingDay);
  const t = await thresholds(db);
  const rows = await latestCapture(day, db);
  if (!rows.length) return { seeded: seed, halts: [], resumes: [], captureAt: null };

  const now = new Map(rows.map((r) => [String(r.symbol).toUpperCase(), r.session]));
  const byId = new Map(rows.map((r) => [String(r.symbol).toUpperCase(), r]));
  const captureAt = rows[0].created_at;

  // On the first poll after a (re)start, adopt the state without firing.
  if (seed || sessions.size === 0) {
    for (const [s, sess] of now) sessions.set(s, sess);
    return { seeded: true, halts: [], resumes: [], captureAt: new Date(captureAt).toISOString() };
  }

  const events = transitions(sessions, now);
  const halts = [];
  const resumes = [];
  const noResumes = [];
  for (const ev of events) {
    const q = byId.get(ev.symbol);
    if (ev.kind === 'NO_RESUME') {
      // G-6 · the session closed on a still-halted symbol. Log it, paired to the
      // open halt, and DO NOT alert — the window is gone. This clears the open
      // halt so it does not carry into the next day (G-7 rebuilds from the table).
      const { rows: [open] } = await db.query(
        `SELECT h.id FROM spread.halt_event h
          WHERE h.symbol = $1 AND h.trading_day = $2 AND h.kind = 'HALT'
            AND NOT EXISTS (SELECT 1 FROM spread.halt_event r WHERE r.halt_ref = h.id)
          ORDER BY h.detected_at DESC LIMIT 1;`, [ev.symbol, day]);
      const { rows: [ins] } = await db.query(
        `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, session_from, session_to, halt_ref)
         VALUES ($1,$2,'NO_RESUME',$3,$4,$5,$6) RETURNING id;`,
        [day, ev.symbol, captureAt, ev.sessionFrom, ev.sessionTo, open ? open.id : null]);
      noResumes.push({ id: ins.id, symbol: ev.symbol, at: new Date(captureAt).toISOString(), haltRef: open ? open.id : null });
      continue;
    }
    if (ev.kind === 'HALT') {
      const haltPrice = q.last_price != null ? Number(q.last_price) : null;
      const px5 = await priceBefore(ev.symbol, day, captureAt, t.halt_direction_window_mins, db);
      const direction = haltPrice != null && px5 != null ? (haltPrice < px5 ? 'DOWN' : 'UP') : null;
      const { rows: [ins] } = await db.query(
        `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, session_from, session_to,
           halt_price_fils, px_5min_prior_fils, direction)
         VALUES ($1,$2,'HALT',$3,$4,$5,$6,$7,$8) RETURNING id;`,
        [day, ev.symbol, captureAt, ev.sessionFrom, ev.sessionTo, haltPrice, px5, direction]);
      const slot = await slotSwapDecision(ev.symbol, day, db).catch(() => null);
      // G-1 · apply it now, blocking, and record the outcome on the HALT row.
      const applied = await applyHaltSlot(scraperClient, slot, ev.symbol, ins.id, db);
      halts.push({ id: ins.id, symbol: ev.symbol, direction, haltPrice, px5minPrior: px5,
        at: new Date(captureAt).toISOString(), slotRequest: slot, slotOutcome: applied });
    } else { // RESUME
      // Pair to the open halt (the latest HALT for this symbol/day with no resume yet).
      const { rows: [open] } = await db.query(
        `SELECT h.id, h.direction FROM spread.halt_event h
          WHERE h.symbol = $1 AND h.trading_day = $2 AND h.kind = 'HALT'
            AND NOT EXISTS (SELECT 1 FROM spread.halt_event r WHERE r.halt_ref = h.id)
          ORDER BY h.detected_at DESC LIMIT 1;`, [ev.symbol, day]);
      const direction = open ? open.direction : null;
      const skip = await db.query(
        'SELECT reason FROM spread.halt_skip WHERE upper(symbol) = upper($1) AND still_true;', [ev.symbol]).then((r) => r.rows[0]?.reason || null).catch(() => null);
      // Gate 5 · how many times has THIS symbol halted today already? A resume
      // from the second-or-later halt is a cascade.
      const { rows: [hc] } = await db.query(
        `SELECT count(*)::int AS n FROM spread.halt_event
          WHERE upper(symbol) = upper($1) AND trading_day = $2 AND kind = 'HALT';`, [ev.symbol, day]);
      const haltCountToday = Math.max(0, Number(hc?.n || 1) - 1); // prior halts before this one
      const vd = verdict({ direction, resumePrice: q.last_price, bidQty: q.bid_qty, offerQty: q.offer_qty,
        budgetKd, skipReason: skip, haltCountToday }, t);
      const prevClose = await priorClose(ev.symbol, day, db).catch(() => null);
      const bandRefFils = haltBandFloor(prevClose);
      const hist = await history(ev.symbol, day, db).catch(() => ({ halts: 0, gave5: 0, avgGain: null }));
      const { rows: [ins] } = await db.query(
        `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, session_from, session_to,
           halt_ref, resume_price_fils, touch_bid_shares, touch_offer_shares, your_shares, your_bid_pct, exit_ratio,
           target_fils, stop_fils, verdict, verdict_detail, direction)
         VALUES ($1,$2,'RESUME',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id;`,
        [day, ev.symbol, captureAt, ev.sessionFrom, ev.sessionTo, open ? open.id : null,
         vd.resumePrice, q.bid_qty, q.offer_qty, vd.yourShares, vd.yourPctBid, vd.exitMultiple,
         vd.targetFils, vd.stopFils, vd.verdict, vd.verdictDetail, direction]);
      resumes.push(payload({ id: ins.id, symbol: ev.symbol, at: captureAt, vd,
        bidQty: q.bid_qty, offerQty: q.offer_qty, bandRefFils, history: hist }));
    }
  }
  for (const [s, sess] of now) sessions.set(s, sess);
  return { seeded: false, halts, resumes, noResumes, captureAt: new Date(captureAt).toISOString() };
}

/**
 * G-2 · replay the transition detection (the same G-6 rules) over the captured
 * awsat_market_quotes history and write the halts that already happened, marked
 * source = 'BACKFILL'. Idempotent — the (symbol, day, kind, instant) unique
 * index means a second run writes nothing. Returns per-kind counts.
 *
 * The verdict is NOT recomputed (it is historical, never alerted); the mirror +
 * signals.score fill the scores, so symbolHistory is real on day one.
 */
async function backfill(from, to, { db = pool } = {}) {
  const t = await thresholds(db).catch(() => DEFAULTS);
  const { rows: days } = await db.query(
    `SELECT DISTINCT trading_date FROM public.awsat_market_quotes
      WHERE trading_date >= $1::date AND trading_date <= $2::date ORDER BY trading_date`,
    [from, to]);
  const counts = { HALT: 0, RESUME: 0, NO_RESUME: 0, days: days.length };
  for (const d of days) {
    const day = toDay(d.trading_date);
    const { rows } = await db.query(
      `SELECT symbol, session, last_price, created_at FROM public.awsat_market_quotes
        WHERE trading_date = $1 AND last_price IS NOT NULL
        ORDER BY symbol, created_at`, [day]);
    const bySym = new Map();
    for (const r of rows) { if (!bySym.has(r.symbol)) bySym.set(r.symbol, []); bySym.get(r.symbol).push(r); }

    for (const [symbol, caps] of bySym) {
      let prevClass = null;
      let openHaltId = null;
      let priceAtHalt = null;
      for (const c of caps) {
        const cls = sessionClass(c.session);
        if (prevClass === null) { prevClass = cls; continue; }
        if (cls === prevClass) continue;
        if (prevClass === 'TRADING' && cls === 'HALT') {
          const haltPrice = c.last_price != null ? Number(c.last_price) : null;
          const px5 = await priceBefore(symbol, day, c.created_at, t.halt_direction_window_mins, db).catch(() => null);
          const direction = haltPrice != null && px5 != null ? (haltPrice < px5 ? 'DOWN' : 'UP') : null;
          const { rows: [ins] } = await db.query(
            `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, halt_price_fils, px_5min_prior_fils, direction, source)
             VALUES ($1,$2,'HALT',$3,$4,$5,$6,'BACKFILL')
             ON CONFLICT (symbol, trading_day, kind, detected_at) DO NOTHING RETURNING id`,
            [day, symbol, c.created_at, haltPrice, px5, direction]);
          if (ins) { counts.HALT += 1; openHaltId = ins.id; priceAtHalt = haltPrice; }
        } else if (prevClass === 'HALT' && cls === 'TRADING') {
          const { rows: [ins] } = await db.query(
            `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, resume_price_fils, halt_ref, source)
             VALUES ($1,$2,'RESUME',$3,$4,$5,'BACKFILL')
             ON CONFLICT (symbol, trading_day, kind, detected_at) DO NOTHING RETURNING id`,
            [day, symbol, c.created_at, c.last_price != null ? Number(c.last_price) : null, openHaltId]);
          if (ins) counts.RESUME += 1;
          openHaltId = null; priceAtHalt = null;
        } else if (prevClass === 'HALT' && cls === 'CLOSE') {
          const { rows: [ins] } = await db.query(
            `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, halt_ref, source)
             VALUES ($1,$2,'NO_RESUME',$3,$4,'BACKFILL')
             ON CONFLICT (symbol, trading_day, kind, detected_at) DO NOTHING RETURNING id`,
            [day, symbol, c.created_at, openHaltId]);
          if (ins) counts.NO_RESUME += 1;
          openHaltId = null; priceAtHalt = null;
        }
        prevClass = cls;
      }
    }
  }
  return counts;
}

/**
 * G-2 · the skip list as a QUERY over the backfilled sample: symbols with ≥ 3
 * resumes that never reached +5 fils. Compared to the seeded three
 * (MUBARRAD / NIH / TIJARA) — reported, never changed without the operator.
 */
async function skipListQuery(db = pool) {
  const target = Number(DEFAULTS.halt_target_fils);
  const { rows } = await db.query(
    `WITH r AS (
       SELECT h.symbol, count(*)::int AS halts,
              count(*) FILTER (WHERE s.px_15min IS NOT NULL AND (s.px_15min - h.resume_price_fils) >= $1)::int AS reached5
         FROM spread.halt_event h
         LEFT JOIN public.signal_log s
           ON s.signal = 'HALT_RESUME' AND upper(s.symbol) = upper(h.symbol) AND s.fired_at = h.detected_at
        WHERE h.kind = 'RESUME'
        GROUP BY h.symbol
     )
     SELECT symbol, halts, reached5 FROM r WHERE halts >= 3 AND reached5 = 0 ORDER BY halts DESC;`, [target]);
  return rows.map((r) => ({ symbol: r.symbol, halts: Number(r.halts), reached5: Number(r.reached5) }));
}

module.exports = { sessionClass, transitions, sharesAt, verdict, haltBandFloor, payload,
  priceBefore, priorClose, history, slotSwapDecision, applyHaltSlot, recoverState, backfill, skipListQuery,
  latestCapture, poll, thresholds, KEYS, DEFAULTS };
