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
/**
 * R-25 · FLOW step 4 checks 1-2, the LIVE direction gate. From today's capture:
 *   check 1  current > open   (the stock is up on the session)
 *   check 2  high > open      (it has traded above the open at some point)
 * Runs at/after 09:20 — before that the open is not yet meaningful and the cells
 * read "not yet" (notComputed). This is DISTINCT from the yesterday-based
 * DIRECTION warn-gate (chg_5d / chg_1d); both are shown, named apart on the card.
 */
function liveDirection({ openFils, lastFils, highFils }, now = new Date(), openHhmm = 920) {
  const kMins = (() => { const k = new Date(new Date(now).getTime() + 3 * 3600000); return k.getUTCHours() * 60 + k.getUTCMinutes(); })();
  const gateMins = Math.floor(openHhmm / 100) * 60 + (openHhmm % 100);
  const ready = kMins >= gateMins;
  const have = openFils != null && lastFils != null && highFils != null;
  if (!ready || !have) {
    return { computed: false, currentAboveOpen: null, highAboveOpen: null,
      note: !ready ? 'not yet — the direction gate reads from 09:20' : 'no open captured yet' };
  }
  const currentAboveOpen = Number(lastFils) > Number(openFils);
  const highAboveOpen = Number(highFils) > Number(openFils);
  return { computed: true, currentAboveOpen, highAboveOpen,
    openFils: Number(openFils), lastFils: Number(lastFils), highFils: Number(highFils),
    note: currentAboveOpen && highAboveOpen ? 'up on the session, and has traded above the open'
      : highAboveOpen ? 'traded above the open but back at/under it now'
        : 'has not traded above the open — no upward direction' };
}

async function screen(tradingDay, budgetKd = BUDGET.slotKd,
                      { db = pool, cfg = GATES, targets = null,
                        direction = null, quality = null, now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT d.*,
            -- gap_pct, pct_session_postable_800 and the rest of the funnel's
            -- columns come from the VIEW (016): the scraper's value first,
            -- the backend bridge second. C-02: this line was NULL::numeric AS
            -- gap_pct, which failed Gate 2 STRUCTURALLY for every 2-tick stock.
            p.min_budget_kd, p.max_budget_kd, p.median_price_move_count,
            p.median_daily_trade_count, p.peak_hour AS profile_peak_hour,
            p.sessions_in_window,
            -- public.instruments is the canonical symbol list: 142 rows with
            -- is_primary and is_tradeable. It has no name_ar or
            -- market_verified, so those are NULL rather than invented.
            s.market, NULL::boolean AS market_verified, NULL::text AS name_ar,
            s.is_tradeable, s.broker_status,
            q.bid AS live_bid, q.bid_qty AS live_bid_shares,
            q.offer AS live_offer, q.offer_qty AS live_offer_shares,
            q.created_at AS quote_at
       FROM spread.symbol_day d
       /**
        * ─── public.instruments, NOT spread.symbol ─────────────────────────
        *
        * spread.symbol had ZERO ROWS for its whole life, and this is an INNER
        * join — so this query returned an empty board on every session, with
        * no error, for months. Dropping the table as an unused duplicate is
        * what finally made it fail loudly.
        *
        * The canonical list is public.instruments: 142 rows, is_primary,
        * is_tradeable, broker_status. Reading public.* is allowed; the lint
        * rule forbids WRITING to it.
        */
       JOIN public.instruments s USING (symbol)
       LEFT JOIN spread.symbol_profile p USING (symbol)
       LEFT JOIN LATERAL (
         SELECT bid::numeric, bid_qty::bigint, offer::numeric, offer_qty::bigint, created_at,
                -- R-25 · today's open / last / high from the latest capture, for the
                -- LIVE direction gate (FLOW step 4 checks 1-2), distinct from the
                -- yesterday-based DIRECTION warn-gate.
                open_price::numeric AS today_open, last_price::numeric AS today_last, high_price::numeric AS today_high
           FROM spread.v_quote_screening v
          WHERE v.symbol = d.symbol
          ORDER BY created_at DESC LIMIT 1) q ON true
      -- PARTIAL rows are INCLUDED and marked. Excluding them silently is how a
      -- stock disappears for a scraper reason rather than a trading one.
      /**
       * ─── FULL, PARTIAL, THIN — the values the column actually holds ──────
       *
       * This read IN ('OK','PARTIAL'). symbol_day stores FULL and THIN; 'OK'
       * is not a value this system produces, so the filter matched nothing —
       * a second, independent reason the board never returned a row.
       *
       * THIN is INCLUDED and marked. Excluding it silently is how a stock
       * disappears for a scraper reason rather than a trading one, and 14 of
       * 29 captured days are THIN.
       */
      WHERE d.trading_day = $1
        AND (d.capture_quality IS NULL
             OR d.capture_quality IN ('FULL','PARTIAL','THIN'));`,
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
    }, budgetKd, cfg, {
      targets, direction, quality,
      // Gate 2's net is DATED and MARKET-AWARE: commission.js drops the 0.500
      // settlement per execution from 1 October 2026 and charges Premier
      // 0.10% against Main's 0.15%. Neither reached the board before — every
      // symbol was costed as Main, pre-October, so from 1 Oct the board would
      // have overstated every round trip by 1 KD and disagreed with the ledger.
      day: tradingDay, premier: /premier/i.test(String(r.market || '')),
    });

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
      // R-25 · the live direction gate (FLOW step 4 checks 1-2).
      liveDirection: liveDirection({ openFils: r.today_open, lastFils: r.today_last, highFils: r.today_high }, now),
      minBudgetKd: minKd, maxBudgetKd: maxKd,
      // Capital determines the universe. Out of reach is NOT the stock's fault
      // and the fix is different — your capital is too small for it today.
      reachable: minKd == null || budgetKd >= minKd,
      overCeiling: maxKd != null && budgetKd > maxKd,
      sizedDownToShares: maxKd != null && budgetKd > maxKd && bidFils
        ? pricing.sharesFor(maxKd, bidFils) : null,
      profileSessions: r.sessions_in_window,
      behaviour: behaviourFlags(r, evaluated, cfg),
    };
  });

  // A5 · the m45 ranking column, read by (symbol, day) from spread.m45 — never a
  // join, never a gate. Absent (before the 09:45 job) → null → the board shows "—".
  const m45 = await require('../jobs/m45').m45For(tradingDay, results.map((r) => r.symbol), db).catch(() => new Map());
  for (const r of results) {
    const row = m45.get(String(r.symbol).toUpperCase());
    r.m45 = row ? row.rangeOverCost : null;
    r.m45Reason = row ? row.reason : null;
  }

  /*
   * SPR-38 · THREE BUCKETS, NOT TWO. A gate that could not be computed (its
   * statistic is missing) is not a failed stock — so a card that fails ONLY on
   * NOT COMPUTED gates belongs in its own bucket, never in `rejected`. Filing
   * all 140 under "140 rejected" beside a card reading NOT COMPUTED is what made
   * the whole board untrustworthy.
   *
   * A real failure is a failed gate that is NOT in the notComputed set.
   */
  const realFailed = (r) => r.failed.filter((f) => !(r.notComputed || []).includes(f));
  const isPureNotComputed = (r) => !r.passed && r.failed.length > 0 && realFailed(r).length === 0;

  const reachable = results.filter((r) => r.reachable);
  const recommended = funnel.rank(reachable.filter((r) => r.passed));
  const notComputed = reachable.filter(isPureNotComputed);
  const decided = reachable.filter((r) => !r.passed && !isPureNotComputed(r)); // has a real failure
  const nearMiss = funnel.rank(decided.filter((r) => r.failed.length === 1));
  // By what they WOULD have paid, descending. A well-paying rejection belongs
  // where it gets read.
  const rejected = decided
    .filter((r) => r.failed.length > 1)
    .sort((a, b) => (b.netAtTarget.netKd ?? -Infinity) - (a.netAtTarget.netKd ?? -Infinity));

  const counts = { all: results.length, recommended: recommended.length,
    nearMiss: nearMiss.length, rejected: rejected.length, notComputed: notComputed.length };
  // Failures by gate counts REAL failures only — a NOT COMPUTED gate is a
  // missing number, not a failed stock, and must not swell the tally.
  for (const r of results) for (const f of realFailed(r)) counts[f] = (counts[f] || 0) + 1;
  // R-38 · why a gate could not be computed, split so TODAY can say which fix
  // applies. No live quote this session is a scraper/market question; a quote
  // present with no gate-statistics source is "stats:daily has not run". The
  // no-quote case takes precedence — it is the more fundamental absence.
  counts.noQuotes = results.filter((r) => r.quoteAt == null).length;
  counts.noStats = results.filter((r) => r.quoteAt != null && !r.gateStatsSource).length;

  return {
    tradingDay, budgetKd, recommended, nearMiss, rejected, notComputed, counts,
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
function behaviourFlags(row, ev, cfg = GATES) {
  const f = [];
  const n = (v) => (v == null ? null : Number(v));
  // B-02 · the same thresholds the gates use. These were 2/1.3/50/20/15/3000
  // literals, so an operator override moved the gate and not the flag.
  const WALL_PCT = 50;

  if (n(row.volume_ratio_5d) >= cfg.distVolumeRatio && n(row.flow_ratio) >= cfg.distFlowRatio) {
    f.push({ flag: 'DISTRIBUTING', icon: '📦', priority: 1,
      why: `volume ${n(row.volume_ratio_5d)}× baseline with outward flow ${n(row.flow_ratio)}` });
  }
  if (n(row.pct_session_exitable_ratio) != null && n(row.pct_session_exitable_ratio) < WALL_PCT) {
    f.push({ flag: 'WALL', icon: '🧱', priority: 1,
      why: `exitable on only ${Math.round(n(row.pct_session_exitable_ratio))}% of the session` });
  }
  if (n(row.pct_moves_sub100) > cfg.maxPctMovesSub100) {
    f.push({ flag: 'PAINTED', icon: '🎨', priority: 2,
      why: `${Math.round(n(row.pct_moves_sub100))}% of moves from trades under 100 shares` });
  }
  if (n(row.price_moves) != null && n(row.price_moves) < cfg.minPriceMoves) {
    f.push({ flag: 'FROZEN', icon: '🧊', priority: 3,
      why: `${n(row.price_moves)} price moves — a round trip needs price down AND up` });
  }
  if (n(row.days_active_5d) === 0 && n(row.avg_trade_shares) < cfg.minAvgTradeShares) {
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

module.exports = { screen, behaviourFlags, liveDirection };
