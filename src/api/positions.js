'use strict';
/**
 * ============================================================================
 *  api/positions.js — ONE definition of "open", by QUANTITY, on ONE contract key
 * ============================================================================
 * Three faults shared a root cause, and this module is the fix for all three:
 *
 *  B-08  any SELL FILLED closed the contract regardless of size. Record a
 *        750-share partial sell of a 6,100 position and the other 5,350
 *        vanished from positions and P&L. A 10,000-share sell against a
 *        4,200-share buy was accepted and booked proceeds for shares never held.
 *
 *  C-11  realised P&L grouped FILLED legs by COALESCE(carried_from_day,
 *        trading_day) — but nothing ever writes carried_from_day, so a buy on
 *        day A and its sell on day B fell into different groups and day B
 *        booked the whole sale as profit. An OPEN buy showed today as -791.
 *
 *  B-07  CARRIED counted as open for the position limit but was invisible in
 *        /trading/contracts and could not be sold.
 *
 * THE CONTRACT KEY IS (symbol, contract_seq). contract_seq is allocated per
 * symbol (max+1, under an advisory lock — see allocateSeq), so the day was
 * never part of the identity; it only looked that way. The buy's trading_day
 * is the contract's day for reporting.
 *
 * A contract is OPEN while bought - sold > 0, where both are FILLED quantities.
 * CARRIED is a FILLED buy that survived a session boundary; it is open.
 * ============================================================================
 */
const { pool } = require('../db');
const { toDay } = require('../lib/day');
const present = require('./present');
const { EXIT } = require('../config/spread.config');
const thresholds = require('../config/thresholds');

/** Sum of FILLED sell shares against one contract. `l` aliases the buy leg. */
const SOLD = (l = 'l') => `
  COALESCE((SELECT sum(COALESCE(s.filled_shares, s.shares)) FROM spread.order_leg s
             WHERE s.symbol = ${l}.symbol AND s.contract_seq = ${l}.contract_seq
               AND s.side = 'SELL' AND s.status = 'FILLED'), 0)`;

/** A BUY leg with shares still held. */
const OPEN_BUY = (l = 'l') => `
  ${l}.side = 'BUY' AND ${l}.status IN ('FILLED','CARRIED')
  AND COALESCE(${l}.filled_shares, ${l}.shares) > ${SOLD(l)}`;

/** Shares still held on that buy. */
const REMAINING = (l = 'l') => `(COALESCE(${l}.filled_shares, ${l}.shares) - ${SOLD(l)})`;

/**
 * F1 · a RESTING order: a POSTED leg, or the remainder of a partial fill
 * (a FILLED leg whose rest_status is 'POSTED' — the part still queued in
 * Awsat, on the same leg, the same contract). One filled buy per contract
 * (017) is kept: the rest fills INTO the leg, never as a second buy.
 * `rest_status IS NULL` on a partial leg is "not tracked" (pre-041) — never
 * read as resting.
 */
const RESTING = (l = 'l') => `(${l}.status = 'POSTED' OR (${l}.status = 'FILLED' AND ${l}.rest_status = 'POSTED'))`;
/** Shares of that leg still queued. */
const RESTING_SHARES = (l = 'l') =>
  `(CASE WHEN ${l}.status = 'POSTED' THEN ${l}.shares ELSE ${l}.shares - COALESCE(${l}.filled_shares, 0) END)`;

/** The resting legs of a symbol (POSTED, and partial remainders), oldest first. */
async function restingLegs(symbol, db = pool, { side = null, contractSeq = null } = {}) {
  const { rows } = await db.query(
    `SELECT l.*, ${RESTING_SHARES('l')} AS resting_shares
       FROM spread.order_leg l
      WHERE l.symbol = $1 AND ${RESTING('l')}
        AND ($2::text IS NULL OR l.side = $2)
        AND ($3::int IS NULL OR l.contract_seq = $3)
      ORDER BY l.posted_at, l.id;`, [symbol, side, contractSeq]);
  return rows.map((r) => ({ ...r, resting_shares: Number(r.resting_shares) }));
}

/**
 * The open buy for a symbol, with its remaining quantity, or null.
 * `db` may be a transaction client — callers inside BEGIN must pass it.
 */
async function openBuy(symbol, db = pool) {
  const { rows: [b] } = await db.query(
    `SELECT l.*, ${REMAINING('l')} AS remaining_shares
       FROM spread.order_leg l
      WHERE l.symbol = $1 AND ${OPEN_BUY('l')}
      ORDER BY l.posted_at DESC LIMIT 1;`, [symbol]);
  return b ? { ...b, remaining_shares: Number(b.remaining_shares) } : null;
}

/** Every open buy, for the account. */
async function openBuys(db = pool) {
  const { rows } = await db.query(
    `SELECT l.id, l.symbol, l.contract_seq, l.price_fils, l.commission_kd, l.trading_day,
            l.carried_from_day, l.posted_at, l.resolved_at, l.peak_bid_fils, l.status,
            l.stop_fils, l.stop_hit_at, l.rest_status, l.shares,
            COALESCE(l.filled_shares, l.shares) AS bought_shares,
            ${REMAINING('l')} AS remaining_shares
       FROM spread.order_leg l
      WHERE ${OPEN_BUY('l')}
      ORDER BY l.posted_at;`);
  return rows.map((r) => ({ ...r, remaining_shares: Number(r.remaining_shares) }));
}

/**
 * B-09 · contract_seq under a per-symbol transaction lock.
 *
 * `COALESCE($3, (SELECT max(contract_seq)+1 …))` inside an INSERT gave two
 * concurrent records the same seq. The lock is transaction-scoped, so it
 * releases on COMMIT or ROLLBACK and cannot leak; hashtext() keys it on the
 * symbol so unrelated symbols never wait on each other.
 *
 * MUST be called on a client inside BEGIN.
 */
async function allocateSeq(client, symbol) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${symbol}`]);
  const { rows: [r] } = await client.query(
    'SELECT COALESCE(max(contract_seq), 0) + 1 AS seq FROM spread.order_leg WHERE symbol = $1;',
    [symbol]);
  return Number(r.seq);
}

/**
 * B-11 · the latest quote FOR THE DAY, never the latest quote ever.
 *
 * On a Saturday the latest row is Thursday's close; marking a position at it
 * is stale, and hit-bid "selling" at it records a trade that did not happen.
 * A symbol with no quote today returns null and the caller says so.
 */
async function latestQuote(symbol, day, db = pool) {
  const { rows: [q] } = await db.query(
    `SELECT bid::numeric AS bid, bid_qty::bigint AS bid_qty,
            offer::numeric AS offer, offer_qty::bigint AS offer_qty,
            last_price::numeric AS last_price, trades, created_at
       FROM spread.v_quote_screening
      WHERE symbol = $1 AND trading_date = $2
      ORDER BY created_at DESC LIMIT 1;`, [symbol, day]);
  return q || null;
}

/**
 * F5 · the latest executable print AFTER continuous trading — Trading at Last
 * / Close-Of-Day rows (spread.v_quote carries them; v_quote_screening does
 * not). This is the auction price a position closes at in TAL. null = no
 * such print today yet.
 */
async function latestClosePrint(symbol, day, db = pool) {
  const { rows: [q] } = await db.query(
    `SELECT last_price::numeric AS last_price, bid::numeric AS bid, offer::numeric AS offer,
            session, created_at
       FROM spread.v_quote
      WHERE symbol = $1 AND trading_date = $2
        AND session IN ('Trading at Last', 'Close-Of-Day')
      ORDER BY created_at DESC LIMIT 1;`, [symbol, day]);
  return q || null;
}

/** B-12 · Premier pays 0.10%, Main 0.15%. Read from the instrument list. */
async function isPremier(symbol, db = pool) {
  const { rows: [r] } = await db.query(
    'SELECT market FROM public.instruments WHERE symbol = $1 LIMIT 1;', [symbol]);
  return /premier/i.test(String(r?.market || ''));
}

/**
 * Realised P&L, BY CONTRACT.
 *
 * A contract counts on the day it CLOSED (its last FILLED sell), and only
 * once closed. An open position contributes nothing here — it is unrealised
 * and lives on /account as marketKd - investedKd.
 */
async function pnlSummary(day, db = pool) {
  const { rows: [r] } = await db.query(
    `WITH legs AS (
       SELECT symbol, contract_seq, side, status, trading_day, price_fils,
              COALESCE(filled_shares, shares) AS shares, COALESCE(commission_kd, 0) AS commission_kd
         FROM spread.order_leg
        WHERE (side = 'BUY' AND status IN ('FILLED','CARRIED'))
           OR (side = 'SELL' AND status = 'FILLED')
     ), c AS (
       SELECT symbol, contract_seq,
              sum(shares) FILTER (WHERE side = 'BUY')  AS bought,
              sum(shares) FILTER (WHERE side = 'SELL') AS sold,
              max(trading_day) FILTER (WHERE side = 'SELL') AS closed_on,
              sum(CASE WHEN side = 'SELL' THEN price_fils * shares / 1000.0
                       ELSE -price_fils * shares / 1000.0 END) AS gross_kd,
              sum(commission_kd) AS commission_kd,
              count(*) AS fills
         FROM legs GROUP BY 1, 2
     ), closed AS (
       SELECT * FROM c WHERE bought IS NOT NULL AND sold >= bought
     )
     SELECT COALESCE(sum(gross_kd - commission_kd) FILTER (WHERE closed_on = $1), 0) AS today_kd,
            count(*) FILTER (WHERE closed_on = $1)                                   AS today_trips,
            COALESCE(sum(gross_kd - commission_kd), 0)                              AS since_kd,
            COALESCE(sum(fills), 0)                                                 AS since_fills
       FROM closed;`, [day]);
  return {
    todayKd: Number(r.today_kd), todayTrips: Number(r.today_trips),
    sinceKd: Number(r.since_kd), sinceFills: Number(r.since_fills),
  };
}

/** Cash, settled cash, and what the open buys are worth at today's bid. */
async function accountSummary(day, db = pool) {
  const { rows: [c] } = await db.query(
    `SELECT COALESCE(sum(amount_kd),0) AS cash_kd,
            COALESCE(sum(amount_kd) FILTER (WHERE settles_on IS NULL OR settles_on <= $1),0) AS settled_kd,
            COALESCE(sum(amount_kd) FILTER (WHERE kind IN ('DEPOSIT','WITHDRAWAL')),0) AS net_deposited_kd
       FROM spread.cash_movement;`, [day]);

  const { rows: [cl] } = await db.query(
    'SELECT COALESCE(sum(amount_kd),0) AS claimed FROM spread.claim WHERE trading_day = $1;', [day]);

  const open = await openBuys(db);
  let investedKd = 0, marketKd = 0, unmarked = 0;
  for (const p of open) {
    const sh = p.remaining_shares, px = Number(p.price_fils);
    const q = await latestQuote(p.symbol, day, db);
    if (!q) unmarked += 1;
    investedKd += (px * sh) / 1000;
    marketKd += (Number(q?.bid ?? px) * sh) / 1000;
  }

  return {
    cashKd: Number(c.cash_kd), settledKd: Number(c.settled_kd),
    netDepositedKd: Number(c.net_deposited_kd), claimedKd: Number(cl.claimed),
    investedKd, marketKd, openPositions: open.length,
    // How many positions are marked at ENTRY because no quote exists today.
    // Zero unrealised on a position that moved is the silent kind of wrong.
    unmarkedPositions: unmarked,
  };
}

/** Open positions and today's claims, as the frontend's TradingContract. */
async function contracts(day, db = pool) {
  const buys = await openBuys(db);
  const out = [];

  for (const b of buys) {
    const { rows: legs } = await db.query(
      `SELECT * FROM spread.order_leg
        WHERE symbol = $1 AND contract_seq = $2
        ORDER BY posted_at;`, [b.symbol, b.contract_seq]);

    const q = await latestQuote(b.symbol, day, db);
    const entry = Number(b.price_fils);
    const shares = b.remaining_shares;
    // 3.8 · NO PLACEHOLDERS. No quote today → bid, unrealised, peak and the
    // trailing offer are null and markedAt says 'entry'. The old code marked
    // the bid AT ENTRY, so a position that had moved read 0.00 unrealised —
    // the silent kind of wrong.
    const bid = q?.bid != null ? Number(q.bid) : null;
    const rt = Number(b.commission_kd || 0) * 2;
    const breakEven = entry + Math.ceil((rt * 1000) / shares);
    // R-41 · the exit TARGET, the rule (FLOW step 7): +2 fils normally, +6 on a
    // trending day. Both are shown; the day's regime decides which applies, and
    // that lives on the market strip, not baked in here. Never below break-even.
    // A1 · the target ticks come from the R-36 store (kb rows), config as the
    // fallback, so the seeded value drives the target — never a literal here.
    const normalTicks = thresholds.get('exit_target_normal_fils') ?? EXIT.targetNormalTicks;
    const trendingTicks = thresholds.get('exit_target_trending_fils') ?? EXIT.targetTrendingTicks;
    const targetNormal = Math.max(breakEven, entry + normalTicks);
    const targetTrending = Math.max(breakEven, entry + trendingTicks);
    // The peak bid since the fill, MEASURED from the tape — informative, not an
    // exit rule. The prototype's trailing offer is gone (R-41).
    const { rows: [pk] } = await db.query(
      `SELECT max(bid)::numeric AS peak FROM spread.v_quote_screening
        WHERE symbol = $1 AND created_at >= $2;`, [b.symbol, b.resolved_at || b.posted_at || b.created_at]);
    const peak = pk?.peak != null ? Number(pk.peak) : null;

    const openedOn = toDay(b.carried_from_day || b.trading_day);
    const isCarried = b.status === 'CARRIED' || !!b.carried_from_day || (openedOn && openedOn < day);

    out.push(present.tradingContract({
      symbol: b.symbol, contract_seq: b.contract_seq,
      state: isCarried ? 'carried' : 'holding',
      shares, entry, bid,
      offer: q?.offer != null ? Number(q.offer) : null,
      committedKd: (entry * shares) / 1000,
      unrealisedKd: bid == null ? null : ((bid - entry) * shares) / 1000,
      breakEvenFils: breakEven,
      targetNormalFils: targetNormal,
      targetTrendingFils: targetTrending,
      peakBidFils: peak,
      boughtShares: Number(b.bought_shares),
      openedOn,
      markedAt: q ? 'quote' : 'entry',
      quoteAt: q?.created_at || null,
      // F2 · the stop recorded at the fill (fixed), and when the bid printed
      // through it. F1 · the remainder of a partial buy still resting.
      stopFils: b.stop_fils == null ? null : Number(b.stop_fils),
      stopHitAt: b.stop_hit_at || null,
      restingBuyShares: b.rest_status === 'POSTED' ? Number(b.shares) - Number(b.bought_shares) : 0,
      legs,
    }));
  }

  const { rows: claims } = await db.query(
    'SELECT * FROM spread.claim WHERE trading_day = $1;', [day]);
  for (const cl of claims) {
    if (out.some((o) => o.symbol === cl.symbol)) continue;
    out.push(present.tradingContract({
      symbol: cl.symbol, contract_seq: 0, state: 'picked',
      shares: 0, entry: null, bid: null, offer: null,
      committedKd: Number(cl.amount_kd), unrealisedKd: null,
      breakEvenFils: null, targetNormalFils: null, targetTrendingFils: null, peakBidFils: null,
      boughtShares: 0, openedOn: toDay(cl.trading_day), markedAt: null, quoteAt: null,
      stopFils: null, stopHitAt: null, restingBuyShares: 0, legs: [],
    }));
  }
  return out;
}

module.exports = {
  OPEN_BUY, REMAINING, SOLD, RESTING, RESTING_SHARES, openBuy, openBuys, restingLegs, allocateSeq,
  latestQuote, latestClosePrint, isPremier, pnlSummary, accountSummary, contracts,
};
