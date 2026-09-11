'use strict';
/**
 * ============================================================================
 *  live.js — calculations that change minute by minute
 * ============================================================================
 * NOT STORED. Everything here is derived from the last few minutes of tape and
 * is wrong again a minute later — a stored value that decays is worse than no
 * value, because something reads it tomorrow and believes it.
 * ============================================================================
 */

const { pool } = require('../db');
const PRICING = require('../lib/pricing');
const { QUALITY, EXIT, DEPTH } = require('../config/spread.config');


/**
 * 5.1 · estimated fill time.
 *
 * THE WINDOW MUST BE 15 MINUTES. Tested at the same moment against a queue of
 * 410,846:
 *
 *   last 1 min, a dead stretch     250/min      -> "never"    too pessimistic
 *   last 1 min, over a block print 180,050/min  -> 2 min      too optimistic
 *   last 15 min                    ~17,000/min  -> 24 min     usable
 *
 * The middle reading is the trap: one large print makes an unfillable queue
 * look instant.
 */
async function fillTime(symbol, { budgetKd, db = pool, cfg = QUALITY } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const { rows: [r] } = await db.query(
    `WITH w AS (
       SELECT volume::bigint AS vol, bid::numeric AS bid, bid_qty::bigint AS bid_shares,
              created_at
         FROM spread.v_quote_screening
        WHERE symbol = upper($1) AND created_at >= now() - ($2 || ' minutes')::interval
        ORDER BY created_at)
     SELECT (SELECT max(vol) - min(vol) FROM w)                        AS traded,
            (SELECT count(*) FROM w)                                   AS ticks,
            (SELECT bid_shares FROM w ORDER BY created_at DESC LIMIT 1) AS bid_shares,
            (SELECT bid FROM w ORDER BY created_at DESC LIMIT 1)        AS bid,
            (SELECT EXTRACT(EPOCH FROM (max(created_at) - min(created_at)))/60 FROM w) AS span_min;`,
    [sym, cfg.fillPaceWindowMins]);

  if (!r || !Number(r.ticks)) return null;

  // Use the REAL span, not the nominal window — at 09:03 there are three
  // minutes of tape and dividing by 15 understates the pace fivefold.
  const span = Math.max(1, Number(r.span_min) || cfg.fillPaceWindowMins);
  const sharesPerMin = Number(r.traded || 0) / span;

  const bid = Number(r.bid);
  const bidShares = Number(r.bid_shares);
  const shares = budgetKd ? PRICING.sharesFor(budgetKd, bid) : null;
  const mins = PRICING.estFillMins(bidShares, sharesPerMin);

  return {
    symbol: sym, bidFils: bid, bidShares,
    queueAheadShares: bidShares,
    queueSharePct: shares && bidShares ? PRICING.queueSharePct(shares, bidShares) : null,
    sharesPerMin: Math.round(sharesPerMin),
    windowMins: Number(span.toFixed(1)),
    estFillMins: mins,
    // COLOUR BY MINUTES, NOT PERCENTAGE.
    state: PRICING.fillState(mins),
    label: mins == null ? 'never' : mins > 240 ? 'never' : `~${Math.round(mins)} min`,
  };
}

/**
 * 5.2 · wake-up scan.
 *
 * Gate 9 blocks a stock on day one of waking, deliberately — three dead stocks
 * topped the screen after one busy day. The cost is real: a six-day run from
 * 143 to 181 began after five quiet sessions.
 *
 * This is the mitigation. Gate 9 blocks stale one-day history; the scan catches
 * a genuine regime change on hour two, live.
 *
 * COMPARE LIKE WITH LIKE. A count at 11:00 is measured against the median count
 * BY 11:00 — a whole-day median makes every stock look asleep in the morning.
 */
const WAKE = { minRatio: 3.0, minTrades: 20 };

async function wakeUpScan(tradingDay, { db = pool, cfg = WAKE, now = new Date() } = {}) {
  const hour = new Date(now.getTime() + 3 * 3600000).getUTCHours();
  const col = hour <= 9 ? 'median_trades_by_0930'
    : hour === 10 ? 'median_trades_by_1000'
    : hour === 11 ? 'median_trades_by_1100'
    : 'median_trades_by_1200';

  const { rows } = await db.query(
    `WITH today AS (
       SELECT symbol, max(trades::bigint) AS trades_so_far
         FROM spread.v_quote_screening
        WHERE trading_date = $1::date
        GROUP BY symbol)
     SELECT t.symbol, t.trades_so_far, p.${col} AS baseline,
            round(t.trades_so_far::numeric / p.${col}, 2) AS pace_ratio,
            p.peak_hour
       FROM today t JOIN spread.symbol_profile p USING (symbol)
      WHERE p.${col} > 0 AND t.trades_so_far >= $2
        AND t.trades_so_far::numeric / p.${col} >= $3
      ORDER BY pace_ratio DESC;`, [tradingDay, cfg.minTrades, cfg.minRatio]);

  return rows.map((r) => ({
    symbol: r.symbol,
    tradesSoFar: Number(r.trades_so_far),
    baseline: Number(r.baseline),
    paceRatio: Number(r.pace_ratio),
    peakHour: r.peak_hour,
    measuredAt: `${String(hour).padStart(2, '0')}:00`,
    // A 09:30 reading is unstable — most stocks have barely traded.
    lowConfidence: hour <= 9,
    why: `${Number(r.trades_so_far)} trades against a normal ${Number(r.baseline)} by this hour ` +
         `— ${Number(r.pace_ratio)}× its own pace`,
  }));
}

/**
 * 5.3 · is it alive AT ITS OWN PEAK HOUR?
 *
 * The fixed "check at 09:30" rule does not work. One stock does 9% of its
 * trades in the first hour and its morning count is ANTI-predictive: 18 trades
 * by 10:00 gave a 50-trade day, 8 gave 209.
 *
 * This also explains a specific failure: a position was abandoned at 11:30 as
 * "finished" on a stock whose 11:00 hour carries 26% of its trades. The session
 * was not over; the check was mistimed.
 */
async function aliveCheck(symbol, tradingDay, { db = pool, now = new Date() } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const hour = new Date(now.getTime() + 3 * 3600000).getUTCHours();

  const { rows: [p] } = await db.query(
    `SELECT peak_hour, median_trades_by_0930, median_trades_by_1000,
            median_trades_by_1100, median_trades_by_1200
       FROM spread.symbol_profile WHERE upper(symbol) = $1;`, [sym]);
  if (!p) return null;

  const { rows: [t] } = await db.query(
    `SELECT max(trades::bigint) AS n FROM spread.v_quote_screening
      WHERE symbol = upper($1) AND trading_date = $2::date;`, [sym, tradingDay]);

  const baseline = Number(
    hour <= 9 ? p.median_trades_by_0930
      : hour === 10 ? p.median_trades_by_1000
      : hour === 11 ? p.median_trades_by_1100
      : p.median_trades_by_1200) || 0;
  const soFar = Number(t?.n || 0);
  const peakHour = p.peak_hour == null ? null : Number(p.peak_hour);

  return {
    symbol: sym, hour, peakHour, tradesSoFar: soFar, baseline,
    ratio: baseline > 0 ? Number((soFar / baseline).toFixed(2)) : null,
    // Alive at HALF its own normal pace for this point in the session.
    alive: baseline > 0 ? soFar >= 0.5 * baseline : null,
    checkAt: peakHour == null ? null : `${String(peakHour).padStart(2, '0')}:00`,
    tooEarly: peakHour != null && hour < peakHour,
    note: peakHour != null && hour < peakHour
      ? `this stock peaks at ${peakHour}:00 — judging it now is judging it early`
      : baseline > 0 && soFar < 0.5 * baseline
        ? `${soFar} trades against a normal ${Math.round(baseline)} by this hour — it has not shown up`
        : null,
  };
}

/**
 * 5.4 · cost of waiting. DIRECTION, not current values.
 *
 * One exit was −3.48 at 10:50 and −7.18 at 11:15. Waiting 25 minutes cost 3.70
 * KD — more than the day's first trade earned. A trader who can see the queue
 * growing and the bid falling does not need advice.
 */
async function costOfWaiting(symbol, { entryFils, shares, offerFils, sinceMins = 25,
                                       commissionKd = 0, db = pool } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const { rows: [r] } = await db.query(
    `WITH w AS (
       SELECT bid::numeric AS bid, offer_qty::bigint AS offer_shares, created_at
         FROM spread.v_quote_screening
        WHERE symbol = upper($1) AND created_at >= now() - ($2 || ' minutes')::interval
        ORDER BY created_at)
     SELECT (SELECT bid FROM w ORDER BY created_at DESC LIMIT 1) AS bid_now,
            (SELECT bid FROM w ORDER BY created_at ASC  LIMIT 1) AS bid_then,
            (SELECT offer_shares FROM w ORDER BY created_at DESC LIMIT 1) AS queue_now,
            (SELECT offer_shares FROM w ORDER BY created_at ASC  LIMIT 1) AS queue_then
       FROM w LIMIT 1;`, [sym, sinceMins]);
  if (!r) return null;

  const bidNow = Number(r.bid_now), bidThen = Number(r.bid_then);
  const net = (px) => ((px - entryFils) * shares) / 1000 - commissionKd;

  return {
    symbol: sym, sinceMins,
    exitNow: { priceFils: bidNow, netKd: Number(net(bidNow).toFixed(2)) },
    exitThen: { priceFils: bidThen, netKd: Number(net(bidThen).toFixed(2)) },
    costOfWaitingKd: Number((net(bidNow) - net(bidThen)).toFixed(2)),
    bidMoveFils: Number((bidNow - bidThen).toFixed(2)),
    yourOffer: offerFils == null ? null : {
      priceFils: offerFils,
      queueAheadShares: Number(r.queue_now),
      queueGrew: Number(r.queue_now) - Number(r.queue_then),
    },
    // Stated as direction, never as advice.
    direction: bidNow < bidThen ? 'bid falling' : bidNow > bidThen ? 'bid rising' : 'bid flat',
  };
}

/**
 * C5a · tiny prints AT a price, not across the day.
 *
 * THE DAILY AVERAGE HIDES CLUSTERING, and the clustering is at the exit. One
 * stock read 13% tiny for the day and looked clean; the moves TO its intended
 * exit were 100, 1 and 9 shares while 29,000 and 30,000-share blocks pushed it
 * back down. The painting was entirely at the level being aimed at.
 */
async function tinyAtPrice(symbol, priceFils, tradingDay, { db = pool, tinyMax = 100 } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const { rows: [r] } = await db.query(
    `WITH t AS (
       SELECT created_at, last_price::numeric AS px, last_qty::bigint AS one_trade,
              lag(last_price::numeric) OVER (ORDER BY created_at) AS prev_px
         FROM spread.v_quote_screening
        WHERE symbol = upper($1) AND trading_date = $2::date
     ), moves AS (
       SELECT * FROM t WHERE prev_px IS NOT NULL AND px <> prev_px
     )
     SELECT count(*) FILTER (WHERE px = $3)                                AS moves_to,
            count(*) FILTER (WHERE px = $3 AND one_trade BETWEEN 1 AND $4) AS tiny_to,
            sum(one_trade) FILTER (WHERE px = $3 AND one_trade BETWEEN 1 AND $4) AS tiny_shares_to,
            round(avg(one_trade) FILTER (WHERE prev_px = $3 AND px < $3))  AS avg_away_shares,
            count(*)                                                        AS moves_all,
            count(*) FILTER (WHERE one_trade BETWEEN 1 AND $4)              AS tiny_all
       FROM moves;`, [sym, tradingDay, priceFils, tinyMax]);

  if (!r || !Number(r.moves_all)) return null;

  const movesTo = Number(r.moves_to), tinyTo = Number(r.tiny_to);
  const dayPct = Math.round((100 * Number(r.tiny_all)) / Number(r.moves_all));
  const atPct = movesTo > 0 ? Math.round((100 * tinyTo) / movesTo) : null;

  return {
    symbol: sym, priceFils, movesToPrice: movesTo, tinyMovesToPrice: tinyTo,
    tinySharesToPrice: Number(r.tiny_shares_to || 0),
    pctTinyAtPrice: atPct, pctTinyForDay: dayPct,
    avgSharesPushingAway: Number(r.avg_away_shares || 0),
    // THE COMPARISON IS THE FINDING. 13% for the day against 60% at the level
    // is a different stock from 13% against 13%.
    painted: atPct != null && movesTo >= 3 && atPct >= 50,
    why: atPct != null && movesTo >= 3 && atPct >= 50
      ? `${tinyTo} of the last ${movesTo} moves to ${priceFils} came from trades of ${tinyMax} ` +
        `shares or fewer (${Number(r.tiny_shares_to || 0)} shares in total), while an average of ` +
        `${Number(r.avg_away_shares || 0).toLocaleString('en-US')} shares pushed it back off. ` +
        `The day reads ${dayPct}% — the painting is at this level.`
      : null,
  };
}

module.exports = { WAKE, fillTime, wakeUpScan, aliveCheck, costOfWaiting, tinyAtPrice };
