'use strict';
/**
 * ============================================================================
 *  alerts.js — CR-32 · live entry window alert
 * ============================================================================
 * THE GAP BETWEEN KNOWING A STOCK IS TRADEABLE AND BEING THERE WHEN IT IS.
 *
 * One stock, one session: the funnel would have passed it, the trader watched
 * it for four hours and never filled.
 *
 *   session minutes                    239
 *   minutes with a 3-fil spread         33
 *   TIMES THE WINDOW OPENED             10
 *   AVERAGE WINDOW LENGTH              3.3 minutes
 *
 * The trader checked manually roughly every ten minutes and caught none. At one
 * window the offer went 143,760 -> 1,012 -> 34,012 in NINETY SECONDS.
 *
 * The daily screen answers WHICH STOCK. It runs once, on yesterday's data. It
 * cannot answer WHEN — the same stock's book opened and closed eighteen times
 * in a session while its mark-up ratio read 0.44, which is clean.
 * ============================================================================
 */

const { pool } = require('../db');
const { ALERT, BUDGET } = require('../config/spread.config');
const live = require('./live');
const depth = require('./depth');
const pricing = require('../lib/pricing');

const cooldown = new Map();   // `${day}:${symbol}` -> last fired ms

/**
 * Evaluate one symbol. Called every minute against the live feed.
 *
 * FIRE when the spread has room to post inside AND sell above, the offer is
 * reachable at your size, and the queue clears inside the window.
 */
async function evaluate(symbol, tradingDay, {
  budgetKd = BUDGET.slotKd, targetTicks = 1, db = pool, cfg = ALERT, now = new Date(),
} = {}) {
  const sym = String(symbol || '').trim().toUpperCase();

  const { rows: [q] } = await db.query(
    `SELECT bid::numeric AS bid, bid_qty::bigint AS bid_shares,
            offer::numeric AS offer, offer_qty::bigint AS offer_shares, created_at
       FROM spread.v_quote_screening
      WHERE upper(symbol) = $1 ORDER BY created_at DESC LIMIT 1;`, [sym]);
  if (!q) return { symbol: sym, fire: false, reason: 'no quote' };

  const bid = Number(q.bid), offer = Number(q.offer);
  const spread = offer - bid;
  const shares = pricing.sharesFor(budgetKd, bid);
  const fill = await live.fillTime(sym, { budgetKd, db });

  /*
   * spread >= targetTicks + 1 — you need room to post INSIDE and sell
   * targetTicks above. At a 2-fil spread with a 2-fil target you would be
   * selling at the offer, which means joining a queue rather than being first.
   */
  const roomOk = spread >= Number(targetTicks) + 1;
  /*
   * offer_shares <= 5 x my shares — this is the EXIT test for alerting, and it
   * replaces the ratio. 2,100 shares against a 10,000 offer is reachable;
   * against 143,760 it is not.
   */
  const exitOk = Number(q.offer_shares) <= cfg.offerSharesMultiple * shares;
  const fillOk = fill?.estFillMins != null && fill.estFillMins <= cfg.maxEstFillMins;

  // CR-34 rides along. The alert fires on a BUY signal too, not only on spread.
  const sig = await depth.signalFor(sym, tradingDay, { db }).catch(() => null);
  const depthBuy = sig?.signal === 'BUY' && sig.sampleSufficient;
  const depthBlocked = sig?.signal === 'BLOCKED';

  const fire = !depthBlocked && ((roomOk && exitOk && fillOk) || (depthBuy && exitOk && fillOk));

  const key = `${tradingDay}:${sym}`;
  const last = cooldown.get(key) || 0;
  const withinCooldown = now.getTime() - last < cfg.cooldownMinutes * 60000;

  return {
    symbol: sym, fire: fire && !withinCooldown, suppressed: fire && withinCooldown,
    bidFils: bid, offerFils: offer, spreadFils: spread,
    offerShares: Number(q.offer_shares), myShares: shares,
    estFillMins: fill?.estFillMins ?? null,
    depthSignal: sig?.signal ?? null,
    depthSufficient: sig?.sampleSufficient ?? null,
    checks: { roomOk, exitOk, fillOk, depthBuy, depthBlocked },
    reason: !fire
      ? (depthBlocked ? 'a wall overhead — deep on both sides is a standoff'
        : !roomOk ? `spread ${spread} fil — no room to post inside and sell ${targetTicks} above`
        : !exitOk ? `offer ${Number(q.offer_shares).toLocaleString('en-US')} against your ${shares.toLocaleString('en-US')} — not reachable`
        : 'queue will not clear inside the window')
      : null,
  };
}

/** Fire, record, and start the cooldown so one window produces one alert. */
async function fire(result, tradingDay, { db = pool, targetTicks = 1, now = new Date() } = {}) {
  cooldown.set(`${tradingDay}:${result.symbol}`, now.getTime());
  const { rows: [r] } = await db.query(
    `INSERT INTO spread.entry_alert
       (trading_day, symbol, bid_fils, offer_fils, spread_fils, offer_shares,
        my_shares, est_fill_mins, target_ticks, depth_signal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id;`,
    [tradingDay, result.symbol, result.bidFils, result.offerFils, result.spreadFils,
     result.offerShares, result.myShares, result.estFillMins, targetTicks, result.depthSignal]);
  return r.id;
}

/**
 * Close a window when the condition stops holding.
 *
 * `window_seconds` is the MEASUREMENT. The claim is 3.3-minute windows; storing
 * open and close proves or disproves it over a month rather than leaving it as
 * one observation.
 */
async function closeWindow(alertId, { db = pool, now = new Date() } = {}) {
  await db.query(
    `UPDATE spread.entry_alert
        SET window_closed_at = $2,
            window_seconds = EXTRACT(EPOCH FROM ($2 - fired_at))::int
      WHERE id = $1 AND window_closed_at IS NULL;`, [alertId, now]);
}

module.exports = { evaluate, fire, closeWindow, cooldown };
