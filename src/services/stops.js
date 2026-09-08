'use strict';
/**
 * ============================================================================
 *  stops.js — the market gate and the session stops (R-19, R-20)
 * ============================================================================
 * FLOW step 3 and "THE SESSION STOPS". Each rule exists because of a session:
 *
 *   breadth under 35                → stop        2 Sep: opened at 24% and never
 *                                                 rose; one loss, six unfilled
 *   falling 7+ points in an hour    → stop        31 Aug: 47 → 40 → 36 in the
 *                                                 first hour; screened to 12:45
 *   flat 35–50                      → careful     one position, take 2 fils
 *   two losing contracts            → stop        30 Aug: five MRC contracts,
 *                                                 four netted +0.69, the fifth
 *                                                 lost 12.59
 *   after any loss                  → 30 minutes  before re-entering
 *   12:45                           → flat        not into the auction
 *
 * Two pure functions (marketGate, sessionStops) over rows, so every rule is
 * tested against the captured 31 Aug and 2 Sep series without a clock or a
 * database; evaluate() reads the rows and the thresholds and applies them.
 *
 * WHAT IS ENFORCED, AND WHERE (api/trading_routes.js):
 *   a claim (/trading/move) and a POSTED BUY (/trading/record) are REFUSED
 *   while canOpen is false — those are decisions. A FILLED BUY is a fact that
 *   happened in Awsat: it is always booked, and when it lands while a stop is
 *   in force the response carries `ruleBreach` and event_log records
 *   STOP_BREACHED — the ledger never lies to make a rule look kept.
 *
 * Breadth = advancing / symbols_traded × 100 (BACKEND_spec §2: broker
 * numerator, our denominator). A capture with symbols_traded = 0 is the
 * pre-open placeholder and is not a reading.
 * ============================================================================
 */
const { pool } = require('../db');
const { toDay } = require('../lib/day');

const KEYS = ['breadth_stop_pct', 'breadth_careful_pct', 'breadth_drop_stop_pts', 'breadth_drop_window_mins',
  'careful_max_target_ticks', 'loss_stop_contracts', 'loss_cooloff_mins', 'flat_by_hhmm', 'time_stop_mins',
  'exit_hold_to_flat'];

async function thresholds(db = pool) {
  const { rows } = await db.query(
    `SELECT key, value FROM spread.kb_threshold WHERE still_true AND key = ANY($1)`, [KEYS]);
  const t = {};
  for (const r of rows) t[r.key] = Number(r.value);
  const missing = KEYS.filter((k) => !Number.isFinite(t[k]));
  if (missing.length) {
    const { notReady } = require('../api/errors');
    throw notReady(`kb_threshold is missing ${missing.join(', ')}`, 'run npm run migrate (020 seeds the session-stop thresholds)');
  }
  return t;
}

/*
 * The clock. Production is the wall clock; a test freezes it with SPREAD_TEST_NOW
 * so a suite that opens positions is deterministic whatever the hour — otherwise
 * "12:45 has passed" refuses every trade between 12:45 and 16:00 Kuwait. The env
 * var is read only when set, so production is unchanged.
 */
const testNow = () => (process.env.SPREAD_TEST_NOW ? new Date(process.env.SPREAD_TEST_NOW) : new Date());

/** Kuwait wall-clock minutes of an instant (UTC+3, no DST). */
const kuwaitMins = (d) => { const k = new Date(new Date(d).getTime() + 3 * 3600000); return k.getUTCHours() * 60 + k.getUTCMinutes(); };
const hhmmToMins = (hhmm) => Math.floor(Number(hhmm) / 100) * 60 + (Number(hhmm) % 100);
const minsToClock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const breadthOf = (r) => (Number(r.symbolsTraded) > 0 ? (100 * Number(r.advancing)) / Number(r.symbolsTraded) : null);

/**
 * The market gate, over the day's summary captures up to `now`.
 * rows: [{ at: Date|string, symbolsTraded, advancing, declining, unchanged }]
 */
function marketGate(rows, now, t) {
  const readings = (rows || [])
    .map((r) => ({ at: new Date(r.at), symbolsTraded: Number(r.symbolsTraded), advancing: Number(r.advancing),
      declining: Number(r.declining), unchanged: Number(r.unchanged) }))
    .filter((r) => !Number.isNaN(r.at.getTime()) && r.at.getTime() <= new Date(now).getTime() && r.symbolsTraded > 0)
    .sort((a, b) => a.at - b.at)
    .map((r) => ({ ...r, breadthPct: Number(breadthOf(r).toFixed(1)), clock: minsToClock(kuwaitMins(r.at)) }));

  const at = (clockMins, toleranceMins = 6) => readings.find((r) => {
    const m = kuwaitMins(r.at); return m >= clockMins && m <= clockMins + toleranceMins;
  }) || null;
  const three = { '0900': at(9 * 60), '0930': at(9 * 60 + 30), '1000': at(10 * 60) };

  if (!readings.length) {
    return { verdict: 'unknown', breadthPct: null, at: null, dropPts: null, hourAgo: null, rising: null,
      readings: three, reason: 'no market summary capture with symbols traded — the gate is NOT COMPUTED' };
  }
  const current = readings[readings.length - 1];
  const windowMs = t.breadth_drop_window_mins * 60000;
  const cutoff = current.at.getTime() - windowMs;
  // The reading one window ago: the latest capture at or before the cutoff,
  // else the first of the day (the first hour compares to the open).
  const before = readings.filter((r) => r.at.getTime() <= cutoff);
  const hourAgo = before.length ? before[before.length - 1] : readings[0];
  const dropPts = hourAgo === current ? 0 : Number((hourAgo.breadthPct - current.breadthPct).toFixed(1));
  const rising = dropPts < 0;

  let verdict, reason;
  if (current.breadthPct < t.breadth_stop_pct) {
    verdict = 'stop';
    reason = `breadth ${current.breadthPct}% is under ${t.breadth_stop_pct} — no trade at all`;
  } else if (dropPts >= t.breadth_drop_stop_pts) {
    verdict = 'stop';
    reason = `breadth fell ${dropPts} points in ${t.breadth_drop_window_mins} minutes (${hourAgo.breadthPct}% at ${hourAgo.clock} → ${current.breadthPct}% at ${current.clock}) — stop, whatever the level`;
  } else if (current.breadthPct <= t.breadth_careful_pct && !rising) {
    verdict = 'careful';
    reason = `breadth ${current.breadthPct}% is flat between ${t.breadth_stop_pct} and ${t.breadth_careful_pct} — one position, take ${t.careful_max_target_ticks} fils`;
  } else {
    verdict = 'trade';
    reason = rising && current.breadthPct <= t.breadth_careful_pct
      ? `breadth ${current.breadthPct}% and rising (${hourAgo.breadthPct}% at ${hourAgo.clock})`
      : `breadth ${current.breadthPct}% above ${t.breadth_careful_pct}`;
  }
  return {
    verdict, reason, breadthPct: current.breadthPct, at: new Date(current.at).toISOString(), clock: current.clock,
    hourAgo: { breadthPct: hourAgo.breadthPct, at: new Date(hourAgo.at).toISOString(), clock: hourAgo.clock },
    dropPts, rising, readings: three, captures: readings.length,
  };
}

/**
 * The session stops, over today's closed contracts.
 * closed: [{ symbol, seq, closedAt: Date|string, netKd }]
 */
function sessionStops(closed, now, t) {
  const losses = (closed || []).filter((c) => Number(c.netKd) < 0)
    .map((c) => ({ ...c, closedAt: new Date(c.closedAt) }))
    .sort((a, b) => a.closedAt - b.closedAt);
  const last = losses.length ? losses[losses.length - 1] : null;
  const nowMs = new Date(now).getTime();
  const cooloffUntil = last ? new Date(last.closedAt.getTime() + t.loss_cooloff_mins * 60000) : null;
  const inCooloff = !!cooloffUntil && nowMs < cooloffUntil.getTime();
  const stopped = losses.length >= t.loss_stop_contracts;
  const reasons = [];
  if (stopped) reasons.push(`${losses.length} losing contract${losses.length === 1 ? '' : 's'} today (${losses.map((l) => `${l.symbol} C${l.seq} ${Number(l.netKd).toFixed(2)}`).join(', ')}) — the day is over`);
  else if (inCooloff) reasons.push(`${last.symbol} C${last.seq} lost ${Number(last.netKd).toFixed(2)} at ${minsToClock(kuwaitMins(last.closedAt))} — no re-entry before ${minsToClock(kuwaitMins(cooloffUntil))}`);
  return {
    count: losses.length, contractsClosed: (closed || []).length,
    losses: losses.map((l) => ({ symbol: l.symbol, seq: l.seq, netKd: Number(l.netKd), closedAt: new Date(l.closedAt).toISOString() })),
    lastLossAt: last ? new Date(last.closedAt).toISOString() : null,
    cooloffUntil: inCooloff ? new Date(cooloffUntil).toISOString() : null, inCooloff, stopped, reasons,
  };
}

/**
 * SPR-37 · 13:30 IS THE END OF THE TRADING DAY. Nothing evaluates after it.
 *
 * The market gate used to run on the wall clock and on
 * awsat_market_summary.session_state, which stays 'LIVE' after the close — so
 * the engine kept computing a fresh breadth-drop STOP every minute on a frozen
 * market (13:09–13:14, six identical lines). The exchange itself tells us the
 * phase: awsat_market_quotes.session carries
 *   09:00–12:59  Trading
 *   13:00–13:09  Close Auction Acceptance
 *   13:10–13:14  Trading at Last
 *   13:15–13:30  Close-Of-Day
 * so the engine reads that column instead of inferring. 'Trading' — or NULL,
 * the July capture defect — means evaluate; any other phase means the day is
 * over. And nothing runs past 13:30 regardless: a capture left running still
 * tagged 'Trading' past the close (as happened at 14:51) is still closed.
 *
 * The reading must be RECENT (within 15 min of `now`) to count — a stale row
 * from earlier or another symbol never decides the current phase; with no
 * recent reading the phase is NULL and the engine evaluates as before.
 */
const TRADING_DAY_END_MINS = 13 * 60 + 30;

async function marketPhase(day, now, db = pool) {
  const { rows: [r] } = await db.query(
    `SELECT session FROM public.awsat_market_quotes
      WHERE trading_date = $1::date AND created_at <= $2
        AND created_at >= $2::timestamptz - interval '15 minutes'
      ORDER BY created_at DESC LIMIT 1;`, [day, now]);
  return r ? (r.session ?? null) : null; // NULL = no recent reading / capture defect → evaluate
}

/** Is the trading day over, per the exchange phase and the 13:30 hard rule? */
function isClosed(phase, nowMins) {
  if (phase != null && phase !== 'Trading') return true;          // Close Auction / Trading at Last / Close-Of-Day
  if (phase === 'Trading' && nowMins >= TRADING_DAY_END_MINS) return true; // a capture left running past the close
  return false;
}

/** Everything the session needs: rows from the database, rules from above. */
async function evaluate(day, { db = pool, now = testNow() } = {}) {
  const t = await thresholds(db);

  // SPR-37 · read the exchange phase first. Once the day is over, do not
  // evaluate breadth at all — return a single CLOSED verdict, no per-minute
  // recomputation, so the feed and the banner stop churning STOP lines.
  const phase = await marketPhase(day, now, db);
  const nowMinsEarly = kuwaitMins(now);
  if (isClosed(phase, nowMinsEarly)) {
    const reason = phase && phase !== 'Trading'
      ? `the market is closed (${phase}) — the trading day is over`
      : 'past 13:30 — the trading day is over';
    return {
      day: toDay(day), now: new Date(now).toISOString(), clock: minsToClock(nowMinsEarly),
      market: { verdict: 'closed', reason, breadthPct: null, at: null, dropPts: null, hourAgo: null,
        rising: null, readings: { '0900': null, '0930': null, '1000': null }, captures: 0 },
      losses: sessionStops([], now, t),
      flatBy: minsToClock(hhmmToMins(t.flat_by_hhmm)), pastFlatBy: true,
      mode: 'closed', canOpen: false, maxTargetTicks: null,
      reasons: [reason], warnings: [],
      marketPhase: phase, closed: true,
      timeStops: [], timeStopMins: Number(t.time_stop_mins ?? 20),
      holdToFlat: [], holdToFlatBy: Number(t.exit_hold_to_flat ?? 1) === 1,
      thresholds: t,
    };
  }

  const { rows: summary } = await db.query(
    `SELECT captured_at AS at, symbols_traded AS "symbolsTraded", advancing, declining, unchanged
       FROM public.awsat_market_summary
      WHERE trading_date = $1::date AND session_state = 'LIVE' AND captured_at <= $2
      ORDER BY captured_at;`, [day, now]);
  const { rows: closed } = await db.query(
    `WITH legs AS (
       SELECT symbol, contract_seq, side, price_fils, resolved_at,
              COALESCE(filled_shares, shares) AS shares, COALESCE(commission_kd, 0) AS commission_kd
         FROM spread.order_leg
        WHERE (side = 'BUY' AND status IN ('FILLED','CARRIED')) OR (side = 'SELL' AND status = 'FILLED')
     ), c AS (
       SELECT symbol, contract_seq AS seq,
              max(resolved_at) FILTER (WHERE side = 'SELL') AS closed_at,
              sum(shares) FILTER (WHERE side = 'BUY') AS bought,
              sum(shares) FILTER (WHERE side = 'SELL') AS sold,
              sum(CASE WHEN side = 'SELL' THEN price_fils * shares / 1000.0 ELSE -price_fils * shares / 1000.0 END)
                - sum(commission_kd) AS net_kd
         FROM legs GROUP BY 1, 2
     )
     SELECT symbol, seq, closed_at AS "closedAt", round(net_kd::numeric, 3) AS "netKd"
       FROM c WHERE bought IS NOT NULL AND sold >= bought
        AND spread.kuwait_day(closed_at) = $1::date AND closed_at <= $2;`, [day, now]);

  const market = marketGate(summary, now, t);
  const losses = sessionStops(closed, now, t);
  const timeStopsList = await timeStops(day, { db, now, t });
  const holdToFlatList = await holdToFlat(day, { db, now, t, timeStops: timeStopsList });
  const nowMins = kuwaitMins(now);
  const flatBy = hhmmToMins(t.flat_by_hhmm);
  const pastFlatBy = nowMins >= flatBy && nowMins < 16 * 60; // after the flat time, until the evening
  const sessionStarted = nowMins >= 9 * 60 + 5;

  const reasons = [];   // BLOCKING — canOpen is false while any of these hold
  const warnings = [];  // loud, but not a block
  if (market.verdict === 'stop') reasons.push(market.reason);
  // R-19 · an UNKNOWN market (no summary capture yet, or the scraper is behind)
  // is announced loudly but does NOT freeze trading — a feed gap must not do
  // what breadth-under-35 does. The operator sees NOT COMPUTED and decides.
  if (market.verdict === 'unknown' && sessionStarted && nowMins < flatBy) warnings.push(market.reason);
  reasons.push(...losses.reasons);
  if (pastFlatBy) reasons.push(`${minsToClock(flatBy)} has passed — flat, not into the auction`);

  const mode = losses.stopped || market.verdict === 'stop' || pastFlatBy ? 'stop'
    : losses.inCooloff ? 'cooloff'
    : market.verdict === 'careful' ? 'careful'
    : market.verdict === 'unknown' ? (sessionStarted ? 'unknown' : 'pre_open') : 'trade';
  return {
    day: toDay(day), now: new Date(now).toISOString(), clock: minsToClock(nowMins),
    market, losses,
    flatBy: minsToClock(flatBy), pastFlatBy,
    mode, canOpen: reasons.length === 0,
    maxTargetTicks: mode === 'careful' ? t.careful_max_target_ticks : null,
    reasons, warnings,
    marketPhase: phase, closed: false,
    // R-21 · the 20-minute time stop, per open position. Informational — hit-bid
    // is the action, there is no auto-sell.
    timeStops: timeStopsList, timeStopMins: Number(t.time_stop_mins ?? 20),
    // A1 · hold-to-flat: an open position that has not hit its target is held to
    // flat_by_hhmm rather than sold on the first profitable tick. The time stop
    // TAKES PRECEDENCE — a position on the time-stop list is never also told to
    // hold, so the two never conflict.
    holdToFlat: holdToFlatList, holdToFlatBy: Number(t.exit_hold_to_flat ?? 1) === 1,
    thresholds: t,
  };
}

/**
 * A1 · the open positions to HOLD to flat_by_hhmm. Every open filled buy that is
 * NOT a time stop (the time stop wins) and is before the flat time. Guidance,
 * not an action — the sell is the operator's, at the target or at the flat time.
 * Empty when hold-to-flat is switched off (kb exit_hold_to_flat = 0).
 */
async function holdToFlat(day, { db = pool, now = testNow(), t, timeStops: timeStopsList = [] } = {}) {
  if (Number((t || {}).exit_hold_to_flat ?? 1) !== 1) return [];
  const nowMins = kuwaitMins(now);
  const flatBy = hhmmToMins((t || {}).flat_by_hhmm);
  if (nowMins >= flatBy) return []; // past the flat time, the rule is flat, not hold
  const dead = new Set(timeStopsList.map((x) => `${x.symbol}:${x.seq}`));
  const { rows } = await db.query(
    `WITH legs AS (
       SELECT symbol, contract_seq, side,
              COALESCE(filled_shares, shares) AS shares,
              COALESCE(resolved_at, posted_at) AS at
         FROM spread.order_leg
        WHERE (side = 'BUY' AND status IN ('FILLED','CARRIED')) OR (side = 'SELL' AND status = 'FILLED')
     ), c AS (
       SELECT symbol, contract_seq AS seq,
              min(at)     FILTER (WHERE side = 'BUY') AS filled_at,
              sum(shares) FILTER (WHERE side = 'BUY') AS bought,
              sum(shares) FILTER (WHERE side = 'SELL') AS sold
         FROM legs GROUP BY 1, 2
     )
     SELECT symbol, seq, filled_at
       FROM c
      WHERE bought IS NOT NULL AND (sold IS NULL OR sold < bought)
        AND spread.kuwait_day(filled_at) = $1::date;`, [day]);
  return rows
    .filter((r) => !dead.has(`${r.symbol}:${Number(r.seq)}`))
    .map((r) => ({ symbol: r.symbol, seq: Number(r.seq), flatBy: minsToClock(flatBy) }));
}

/**
 * R-21 · the 20-minute time stop (FLOW step 6). An open filled buy that has NOT
 * printed above its entry within `time_stop_mins` of the fill is a time stop:
 * close it at the bid. "Printed above entry" is any bid or last since the fill
 * exceeding entry — a position that moved in your favour and came back is not a
 * time stop, one that never moved is. Returns [{symbol, seq, minutesHeld, entry,
 * bid}]; the emit and the banner are the caller's.
 */
async function timeStops(day, { db = pool, now = testNow(), t } = {}) {
  const mins = Number((t || {}).time_stop_mins ?? 20);
  const { rows } = await db.query(
    `WITH legs AS (
       SELECT symbol, contract_seq, side, price_fils,
              COALESCE(filled_shares, shares) AS shares,
              COALESCE(resolved_at, posted_at) AS at
         FROM spread.order_leg
        WHERE (side = 'BUY' AND status IN ('FILLED','CARRIED')) OR (side = 'SELL' AND status = 'FILLED')
     ), c AS (
       SELECT symbol, contract_seq AS seq,
              min(price_fils) FILTER (WHERE side = 'BUY') AS entry,
              min(at)         FILTER (WHERE side = 'BUY') AS filled_at,
              sum(shares)     FILTER (WHERE side = 'BUY') AS bought,
              sum(shares)     FILTER (WHERE side = 'SELL') AS sold
         FROM legs GROUP BY 1, 2
     )
     SELECT symbol, seq, entry, filled_at
       FROM c
      WHERE bought IS NOT NULL AND (sold IS NULL OR sold < bought)
        AND spread.kuwait_day(filled_at) = $1::date;`, [day]);

  const out = [];
  for (const r of rows) {
    const minutesHeld = Math.floor((new Date(now).getTime() - new Date(r.filled_at).getTime()) / 60000);
    if (minutesHeld < mins) continue;
    // Any print since the fill above the entry disqualifies the time stop.
    const { rows: [pk] } = await db.query(
      `SELECT max(GREATEST(COALESCE(bid::numeric, 0), COALESCE(last_price::numeric, 0))) AS peak
         FROM public.awsat_market_quotes
        WHERE upper(symbol) = upper($1) AND created_at >= $2 AND created_at <= $3;`, [r.symbol, r.filled_at, now]);
    const peak = pk && pk.peak != null ? Number(pk.peak) : null;
    if (peak != null && peak > Number(r.entry)) continue;
    const { rows: [q] } = await db.query(
      `SELECT bid::numeric AS bid FROM public.awsat_market_quotes
        WHERE upper(symbol) = upper($1) AND created_at <= $2 ORDER BY created_at DESC LIMIT 1;`, [r.symbol, now]);
    out.push({ symbol: r.symbol, seq: Number(r.seq), minutesHeld, entry: Number(r.entry),
      bid: q && q.bid != null ? Number(q.bid) : null });
  }
  return out;
}

module.exports = { marketGate, sessionStops, evaluate, timeStops, holdToFlat, thresholds, KEYS, kuwaitMins, minsToClock, marketPhase, isClosed, TRADING_DAY_END_MINS };
