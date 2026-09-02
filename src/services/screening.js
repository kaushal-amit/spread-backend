'use strict';
/**
 * ============================================================================
 *  screening.js — run the funnel over the board
 * ============================================================================
 * Reads STORED columns written by the 13:30 job and applies thresholds. It does
 * not compute a single statistic of its own, and that restraint is the point:
 * every time a screening query recomputed something the job already knew, it
 * used a different statistic and inverted the answer.
 *
 * RETURNS EVERY SYMBOL. `passed` is a property of a row, not a reason to omit
 * it. The reject list sorted by net descending is what would have caught the
 * tick bug days earlier — a stock showing +7.68 at the top of it demands an
 * explanation, and the explanation was that its tick is 0.1 fil.
 * ============================================================================
 */

const { pool } = require('../db');
const funnel = require('../lib/funnel');
const pricing = require('../lib/pricing');
const { GATES, BUDGET } = require('../config/spread.config');

/**
 * @param {object} opts.cfg  the EFFECTIVE gate thresholds — the file defaults
 *                           with any stored operator overrides on top. Passing
 *                           the file directly meant a saved edit changed nothing.
 */
/**
 * @param {object} opts.targets  which tick captures are enabled, and their
 *   feasibility thresholds. R-01: this was never passed, so the config page's
 *   target checkboxes saved and changed nothing.
 */
async function screen(tradingDay, budgetKd = BUDGET.slotKd,
                      { db = pool, cfg = GATES, targets = null } = {}) {
  const { rows } = await db.query(
    `SELECT d.*,
            -- The 2-fil gap frequency. A 2-tick target needs a queue-zero
            -- entry, and one stock had the widest range on the board while its
            -- gap was present only 22% of the session.
            NULL::numeric AS gap_pct,
            p.min_budget_kd, p.max_budget_kd, p.median_price_move_count,
            p.median_daily_trade_count, p.peak_hour AS profile_peak_hour,
            p.sessions_in_window,
            s.market, s.market_verified, s.name_ar,
            q.bid AS live_bid, q.bid_qty AS live_bid_shares,
            q.offer AS live_offer, q.offer_qty AS live_offer_shares,
            q.created_at AS quote_at
       FROM spread.symbol_day d
       JOIN spread.symbol s USING (symbol)
       LEFT JOIN spread.symbol_profile p USING (symbol)
       LEFT JOIN LATERAL (
         SELECT bid::numeric, bid_qty::bigint, offer::numeric, offer_qty::bigint, created_at
           FROM spread.v_quote_screening v
          WHERE v.symbol = d.symbol
          ORDER BY created_at DESC LIMIT 1) q ON true
      -- PARTIAL rows are INCLUDED and marked. Excluding them silently is how a
      -- stock disappears for a scraper reason rather than a trading one.
      WHERE d.trading_day = $1 AND d.capture_quality IN ('OK','PARTIAL');`,
    [tradingDay]);

  const results = rows.map((r) => {
    const closeFils = r.close_fils == null ? null : Number(r.close_fils);
    const bidFils = r.live_bid == null ? null : Number(r.live_bid);

    const evaluated = funnel.evaluate({
      ...r,
      // Gate 1 judges the STOCK — the tick regime is a property of the security
      // and does not change because the bid ticked down.
      priceFils: closeFils ?? bidFils,
      // Gate 2 prices the ORDER.
      orderPriceFils: bidFils ?? closeFils,
    }, budgetKd, cfg, { targets });

    const entry = bidFils == null ? null : pricing.suggestEntry(
      { bidFils, bidShares: Number(r.live_bid_shares),
        offerFils: Number(r.live_offer), offerShares: Number(r.live_offer_shares) },
      budgetKd, evaluated.targetTicks || 1, { maxBudgetKd: r.max_budget_kd });

    const minKd = r.min_budget_kd == null ? null : Number(r.min_budget_kd);
    const maxKd = r.max_budget_kd == null ? null : Number(r.max_budget_kd);

    return {
      ...evaluated,
      market: r.market, marketVerified: r.market_verified, nameAr: r.name_ar,
      bidFils, offerFils: r.live_offer == null ? null : Number(r.live_offer),
      spreadFils: bidFils != null && r.live_offer != null
        ? Number(r.live_offer) - bidFils : null,
      entry,
      entryPlacement: entry?.placement ?? null,
      quoteAt: r.quote_at,
      minBudgetKd: minKd, maxBudgetKd: maxKd,
      // Capital determines the universe. Out of reach is NOT the stock's fault
      // and the fix is different — your capital is too small for it today.
      reachable: minKd == null || budgetKd >= minKd,
      overCeiling: maxKd != null && budgetKd > maxKd,
      sizedDownToShares: maxKd != null && budgetKd > maxKd && bidFils
        ? pricing.sharesFor(maxKd, bidFils) : null,
      profileSessions: r.sessions_in_window,
      behaviour: behaviourFlags(r, evaluated),
    };
  });

  const reachable = results.filter((r) => r.reachable);
  const recommended = funnel.rank(reachable.filter((r) => r.passed));
  const nearMiss = funnel.rank(reachable.filter((r) => !r.passed && r.failed.length === 1));
  // By what they WOULD have paid, descending. A well-paying rejection belongs
  // where it gets read.
  const rejected = results
    .filter((r) => !r.passed && r.failed.length > 1)
    .sort((a, b) => (b.netAtTarget.netKd ?? -Infinity) - (a.netAtTarget.netKd ?? -Infinity));

  const counts = { all: results.length, recommended: recommended.length,
    nearMiss: nearMiss.length, rejected: rejected.length };
  for (const r of results) for (const f of r.failed) counts[f] = (counts[f] || 0) + 1;

  return {
    tradingDay, budgetKd, recommended, nearMiss, rejected, counts,
    reach: {
      reachable: reachable.length, total: results.length,
      at2500: results.filter((r) => r.minBudgetKd == null || r.minBudgetKd <= 2500).length,
      // Saying this is more useful than showing an empty board.
      note: `at ${budgetKd} KD, ${reachable.length} of ${results.length} are reachable`,
    },
    bands: funnel.tickBands(budgetKd, cfg, targets),
  };
}

/**
 * Behaviour flags. ZERO OR MANY — this is the axis that stacks.
 *
 * Pre-sorted by priority, RISK BEFORE OPPORTUNITY: a stock that is both waking
 * up and distributing shows distribution first, because that combination
 * measured −1.36 the next day.
 */
function behaviourFlags(row, ev) {
  const f = [];
  const n = (v) => (v == null ? null : Number(v));

  if (n(row.volume_ratio_5d) >= 2 && n(row.flow_ratio) >= 1.3) {
    f.push({ flag: 'DISTRIBUTING', icon: '📦', priority: 1,
      why: `volume ${n(row.volume_ratio_5d)}× baseline with outward flow ${n(row.flow_ratio)}` });
  }
  if (n(row.pct_session_exitable_ratio) != null && n(row.pct_session_exitable_ratio) < 50) {
    f.push({ flag: 'WALL', icon: '🧱', priority: 1,
      why: `exitable on only ${Math.round(n(row.pct_session_exitable_ratio))}% of the session` });
  }
  if (n(row.pct_moves_sub100) > 20) {
    f.push({ flag: 'PAINTED', icon: '🎨', priority: 2,
      why: `${Math.round(n(row.pct_moves_sub100))}% of moves from trades under 100 shares` });
  }
  if (n(row.price_moves) != null && n(row.price_moves) < 15) {
    f.push({ flag: 'FROZEN', icon: '🧊', priority: 3,
      why: `${n(row.price_moves)} price moves — a round trip needs price down AND up` });
  }
  if (n(row.days_active_5d) === 0 && n(row.avg_trade_shares) < 3000) {
    f.push({ flag: 'DEAD', icon: '💀', priority: 3,
      why: 'no active session in five, retail-sized prints' });
  }
  if (ev.downFlag) {
    f.push({ flag: 'FALLING_4_5', icon: '▼▼', priority: 5,
      why: 'four of the last five sessions closed down' });
  } else if (ev.rising != null) {
    f.push({ flag: ev.rising ? 'RISING' : 'FALLING', icon: ev.arrow, priority: 5,
      why: `${ev.changeFils >= 0 ? '+' : ''}${ev.changeFils} fils yesterday` });
  }
  return f.sort((a, b) => a.priority - b.priority);
}

module.exports = { screen, behaviourFlags };
