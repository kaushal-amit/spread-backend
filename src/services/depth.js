'use strict';
/**
 * ============================================================================
 *  depth.js — CR-34 · bid-depth direction signal
 * ============================================================================
 * INFORMS THE ALERT AND THE AI. GATES NOTHING.
 *
 * One stock, one session, 418 snapshots:
 *
 *   bid over 300,000   305 snapshots   10 of 11 upward ticks    91% up
 *   bid 50k-150k        34             1 up, 3 down             25%
 *   bid under 50,000    57             0 up, 10 down             0%
 *
 * WHY IT WORKS: a deep bid is buyers who CANNOT GET FILLED. They are queued;
 * the only way in is to raise the price. A thin bid is a level that has just
 * been consumed — nothing is left beneath and the next seller pushes through.
 *
 * "Buyers are piled up" is a BUY signal, not a warning. A 400,000-share bid is
 * 400,000 shares of unsatisfied demand, not resistance to a fall.
 *
 * THE CORRECTION THAT BELONGS IN THE RECORD: an earlier reading of NINE
 * MINUTES of the same session concluded the OPPOSITE. Five observations inside
 * a falling stretch, and the sign inverted. Hence minSnapshots — a
 * depth-direction claim below that sample is REFUSED, here and in the AI layer.
 * ============================================================================
 */

const { pool } = require('../db');
const { DEPTH } = require('../config/spread.config');

const K = "AT TIME ZONE 'UTC' + interval '3 hours'";

/**
 * Classify one book snapshot.
 *
 * BLOCKED IS CHECKED FIRST. Deep on both sides is a standoff, not a signal —
 * a 1,030,681-share offer rejected the advance four times in one session.
 */
function classify(book, thresholds = DEPTH) {
  const bid = Number(book.bidShares);
  const offer = Number(book.offerShares);
  const t = {
    deepBid: Number(book.deepBidShares ?? thresholds.deepBidShares),
    thinBid: Number(book.thinBidShares ?? thresholds.thinBidShares),
    thinOffer: Number(book.thinOfferShares ?? thresholds.thinOfferShares),
    wallOffer: Number(book.wallOfferShares ?? thresholds.wallOfferShares),
  };

  if (!Number.isFinite(bid) || !Number.isFinite(offer)) {
    return { signal: 'WAIT', reason: 'no depth' };
  }
  if (offer > t.wallOffer) {
    return { signal: 'BLOCKED',
      reason: `offer ${offer.toLocaleString('en-US')} is a wall overhead — deep on both sides is a ` +
              'standoff, not a signal' };
  }
  if (bid > t.deepBid && offer < t.thinOffer) {
    return { signal: 'BUY',
      reason: `bid ${bid.toLocaleString('en-US')} against an offer of ${offer.toLocaleString('en-US')} — ` +
              'queued buyers who cannot get filled, and little above them' };
  }
  if (bid < t.thinBid) {
    return { signal: 'SELL',
      reason: `bid ${bid.toLocaleString('en-US')} — the level has been consumed and nothing is beneath it` };
  }
  return { signal: 'WAIT', reason: null };
}

/**
 * The live signal for one symbol, with its sample size attached.
 *
 * `sampleSufficient` is FALSE below the threshold and the caller must not act
 * on the direction. It is not a soft warning: five observations produced the
 * opposite conclusion on the same stock.
 */
async function signalFor(symbol, tradingDay, { db = pool, cfg = DEPTH } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();

  // Level 1 is the touch — what the signal reads. captured_at is when the book
  // looked like this; created_at is when the row was written, ~0.3s later.
  const { rows: [snap] } = await db.query(
    `SELECT bid::numeric AS bid_fils, bid_qty::bigint AS bid_shares,
            offer::numeric AS offer_fils, offer_qty::bigint AS offer_shares,
            COALESCE(captured_at, created_at) AS at
       FROM spread.depth
      WHERE upper(symbol) = $1
        AND COALESCE(trading_day, (COALESCE(captured_at, created_at) ${K})::date) = $2
        AND level = 1
      ORDER BY COALESCE(captured_at, created_at) DESC LIMIT 1;`, [sym, tradingDay]);

  /*
   * COUNT CAPTURES, NOT ROWS.
   *
   * The scraper writes TEN LEVELS per capture, sharing one capture_id. Counting
   * rows overstates the sample TENFOLD — a symbol with 100 rows has 10 real
   * captures, and would pass a check that exists precisely because five
   * observations once inverted the sign.
   *
   * Falls back to counting level-1 rows when capture_id is absent, which is
   * still per-capture rather than per-row.
   */
  const { rows: [n] } = await db.query(
    `SELECT count(DISTINCT COALESCE(capture_id,
              (COALESCE(captured_at, created_at))::text)) AS snapshots,
            count(*) AS rows
       FROM spread.depth
      WHERE upper(symbol) = $1
        AND COALESCE(trading_day, (COALESCE(captured_at, created_at) ${K})::date) = $2;`,
    [sym, tradingDay]);

  const { rows: [p] } = await db.query(
    `SELECT deep_bid_shares, thin_bid_shares, thin_offer_shares, wall_offer_shares
       FROM spread.symbol_profile WHERE upper(symbol) = $1;`, [sym]);

  const snapshots = Number(n?.snapshots || 0);
  const depthRows = Number(n?.rows || 0);
  const sufficient = snapshots >= cfg.minSnapshots;

  if (!snap) {
    return { symbol: sym, signal: 'WAIT', snapshots, sampleSufficient: false,
      reason: 'no depth captured for this symbol today' };
  }

  const book = {
    bidFils: Number(snap.bid_fils), bidShares: Number(snap.bid_shares),
    offerFils: Number(snap.offer_fils), offerShares: Number(snap.offer_shares),
    // Thresholds SCALE WITH THE STOCK. One symbol's 300,000 is ~8% of a level
    // on a 5M-share day and means nothing elsewhere.
    deepBidShares: p?.deep_bid_shares, thinBidShares: p?.thin_bid_shares,
    thinOfferShares: p?.thin_offer_shares, wallOfferShares: p?.wall_offer_shares,
  };

  const c = classify(book, cfg);

  return {
    symbol: sym, ...book, ...c,
    snapshots, sampleSufficient: sufficient,
    at: snap.at,
    depthRows,
    // The signal is computed either way; ACTING on it needs the sample.
    actionable: sufficient && !cfg.gatesNothing ? true : false,
    note: sufficient ? null
      : `${snapshots} book captures (${depthRows} rows across ten levels) — a depth-direction ` +
        `claim needs ${cfg.minSnapshots} captures. An earlier reading of nine minutes of one ` +
        'session concluded the opposite.',
  };
}

/** Persist a snapshot so the split can be RE-DERIVED rather than asserted. */
async function record(sig, tradingDay, db = pool) {
  const { rows: [r] } = await db.query(
    `INSERT INTO spread.depth_signal
       (trading_day, symbol, bid_fils, bid_shares, offer_fils, offer_shares,
        signal, reason, snapshots_behind, sample_sufficient)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id;`,
    [tradingDay, sig.symbol, sig.bidFils, sig.bidShares, sig.offerFils, sig.offerShares,
     sig.signal, sig.reason, sig.snapshots, sig.sampleSufficient]);
  return r.id;
}

/**
 * VALIDATION. This is what a second symbol has to pass before the signal gates
 * anything, and it runs against stored rows rather than a fresh analysis.
 */
async function validate(symbol, tradingDay, { db = pool } = {}) {
  const { rows } = await db.query(
    `WITH s AS (
       SELECT signal, bid_shares, next_tick_fils, bid_fils
         FROM spread.depth_signal
        WHERE upper(symbol) = upper($1) AND trading_day = $2
          AND next_tick_fils IS NOT NULL
     )
     SELECT CASE
              WHEN bid_shares > 300000 THEN 'over 300k'
              WHEN bid_shares > 150000 THEN '150k-300k'
              WHEN bid_shares >  50000 THEN '50k-150k'
              WHEN bid_shares >  20000 THEN '20k-50k'
              ELSE 'under 20k' END AS band,
            count(*) AS snapshots,
            count(*) FILTER (WHERE next_tick_fils > bid_fils) AS next_up,
            count(*) FILTER (WHERE next_tick_fils < bid_fils) AS next_down
       FROM s GROUP BY band ORDER BY min(bid_shares);`, [symbol, tradingDay]);

  const total = rows.reduce((a, r) => a + Number(r.snapshots), 0);
  return {
    symbol, tradingDay, bands: rows, totalSnapshots: total,
    sufficient: total >= DEPTH.minSnapshots,
    verdict: total < DEPTH.minSnapshots
      ? `${total} snapshots — not enough to state a direction`
      : 'sample sufficient — compare the band split against the original 91%/0%',
  };
}

module.exports = { classify, signalFor, record, validate };
