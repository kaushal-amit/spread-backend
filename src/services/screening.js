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

/**
 * CR-8 · place EVERY evaluated row in exactly one bucket, and assert that
 * nothing went missing. Exported so the assertion can be tested on its own.
 */
function bucketize(results, { tradingDay, budgetKd, cfg = GATES } = {}) {
  const realFailed = (r) => r.failed.filter((f) => !(r.notComputed || []).includes(f));
  const isPureNotComputed = (r) => !r.passed && r.failed.length > 0 && realFailed(r).length === 0;
  /*
   * PRICE WARN · "the price ceiling is the only failure" — read as the only
   * FACT that fails. Above the ceiling Gate 2 (profit floor) fails too, for
   * the same reason: at this price the target does not net the floor at this
   * budget. One fact, two gates; a stock that fails ONLY those two is a
   * price-warn, not a two-gate LEAVE. Anything else failing (or NOT COMPUTED)
   * and the row takes the ordinary path.
   */
  const ECON = new Set(['price band', 'profit floor']);
  const priceCeilingOnly = (r) => {
    if (r.structural || !r.failed.length || !r.failed.includes('price band')) return false;
    if (!r.failed.every((f) => ECON.has(f))) return false;
    const g = (r.gates || []).find((x) => x.id === 1);
    return !!g && !g.notComputed && r.priceFils != null && Number(r.priceFils) > Number(g.ceiling ?? r.ceiling);
  };
  // "needs N fils": the smallest tick move at which this price nets the floor
  // at this budget (CR-2's break-even by budget). null when nothing under 12
  // fils does — the row then says so rather than printing a number.
  const needsFils = (r) => {
    const price = r.orderPriceFils ?? r.priceFils;
    if (price == null || !budgetKd) return null;
    for (let t = 1; t <= 12; t++) {
      const n = funnel.netAtTicks(budgetKd, Number(price), t, { day: tradingDay, premier: /premier/i.test(String(r.market || '')) });
      if (n.netKd != null && n.netKd >= cfg.netFloorKd) return t;
    }
    return null;
  };

  for (const r of results) {
    r.suspended = r.isTradeable === false;
    if (!r.reachable) { r.structural = true; r.structuralReason = 'OUT_OF_REACH'; }
    else if (r.suspended) { r.structural = true; r.structuralReason = 'SUSPENDED'; }
    else if (r.structural) {
      r.structuralReason = (r.gates || []).some((g) => g.id === 1 && g.structural) ? 'BELOW_TICK' : 'INFEASIBLE_TARGET';
    } else r.structuralReason = null;

    if (r.structural) r.bucket = 'LEAVE';
    else if (isPureNotComputed(r)) r.bucket = 'NOT_COMPUTED';
    else if (r.passed) r.bucket = 'TAKE';
    else if (priceCeilingOnly(r)) r.bucket = 'PRICE_WARN';
    else if (r.failed.length === 1) r.bucket = 'ONE_AWAY';
    else r.bucket = 'LEAVE';
    r.needsFils = r.bucket === 'PRICE_WARN' ? needsFils(r) : null;
    // The ABAR line: no symbol_day row for this day, and when the last one was.
    r.noRow = r.no_row === true;
    r.lastRowDay = r.last_row_day || null;
    r.noRowReason = r.noRow
      ? `no symbol_day row for ${tradingDay}` + (r.lastRowDay ? ` — last row ${r.lastRowDay}` : ' — never computed')
      : null;
  }

  const byBucket = (b) => results.filter((r) => r.bucket === b);
  const take = funnel.rank(byBucket('TAKE'));
  const oneAway = funnel.rank(byBucket('ONE_AWAY'));
  const priceWarn = funnel.rank(byBucket('PRICE_WARN'));
  const notComputed = byBucket('NOT_COMPUTED');
  // LEAVE: by what they WOULD have paid, descending — a well-paying rejection
  // belongs where it gets read. Structural rows last (the fold), still present.
  const byNet = (a, b) => (b.netAtTarget?.netKd ?? -Infinity) - (a.netAtTarget?.netKd ?? -Infinity);
  const leave = [...byBucket('LEAVE').filter((r) => !r.structural).sort(byNet),
    ...byBucket('LEAVE').filter((r) => r.structural).sort(byNet)];

  const universe = results.length;
  const placed = take.length + oneAway.length + priceWarn.length + leave.length + notComputed.length;
  if (placed !== universe) {
    const e = new Error(`UNIVERSE_MISMATCH: ${universe} instruments screened, ${placed} placed in buckets — a symbol was removed`);
    e.code = 'UNIVERSE_MISMATCH';
    throw e;
  }

  return { take, oneAway, priceWarn, leave, notComputed, realFailed };
}

async function screen(tradingDay, budgetKd = BUDGET.slotKd,
                      { db = pool, cfg = GATES, targets = null,
                        direction = null, quality = null, now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT d.*,
            s.symbol AS symbol,                       -- d.symbol is NULL when there is no row
            d.symbol IS NULL          AS no_row,
            lr.last_row_day::text     AS last_row_day,
            COALESCE(d.capture_quality, 'MISSING') AS capture_quality_effective,
            s.is_primary,
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
       FROM public.instruments s
       /*
        * ─── CR-8 · THE UNIVERSE IS public.instruments, NOT symbol_day ─────────
        *
        * This was FROM spread.symbol_day JOIN instruments, filtered on
        * capture_quality. Every symbol WITHOUT a row for the day — not captured
        * (ABAR left the scrape on 26 July and nobody noticed for a month),
        * halted all day, newly listed, or simply not yet computed — was absent
        * from the board, and a board without ABAR looks exactly like a board
        * where ABAR failed. A gate that hides a candidate is indistinguishable
        * from a gate that had no candidates to hide.
        *
        * Now every primary instrument is a row on every day's board. A missing
        * symbol_day row is NOT COMPUTED with the last row named; a MISSING
        * capture grade is a mark on the row, never a WHERE. The row count is
        * asserted below (UNIVERSE_MISMATCH) — nothing between here and the
        * buckets may reduce it.
        *
        * spread.symbol had ZERO ROWS for its whole life and an INNER join on it
        * returned an empty board for months, silently. public.instruments is
        * the canonical list: 142 rows, is_primary, is_tradeable, broker_status.
        * Reading public.* is allowed; the lint rule forbids WRITING to it.
        */
       LEFT JOIN spread.symbol_day d
         ON d.symbol = s.symbol AND d.trading_day = $1
       LEFT JOIN spread.symbol_profile p ON p.symbol = s.symbol
       LEFT JOIN LATERAL (
         SELECT bid::numeric, bid_qty::bigint, offer::numeric, offer_qty::bigint, created_at,
                -- R-25 · today's open / last / high from the latest capture, for the
                -- LIVE direction gate (FLOW step 4 checks 1-2), distinct from the
                -- yesterday-based DIRECTION warn-gate.
                open_price::numeric AS today_open, last_price::numeric AS today_last, high_price::numeric AS today_high
           FROM spread.v_quote_screening v
          WHERE v.symbol = s.symbol
          ORDER BY created_at DESC LIMIT 1) q ON true
       -- The last symbol_day row on or before the screen day, for the NOT
       -- COMPUTED reason when today's is missing ("last row 2026-07-25").
       LEFT JOIN LATERAL (
         SELECT max(x.trading_day) AS last_row_day
           FROM spread.symbol_day x
          WHERE x.symbol = s.symbol AND x.trading_day <= $1) lr ON true
      WHERE s.is_primary;`,
    [tradingDay]);

  const results = rows.map((r) => {
    const closeFils = r.close_fils == null ? null : Number(r.close_fils);
    const bidFils = r.live_bid == null ? null : Number(r.live_bid);

    const evaluated = funnel.evaluate({
      ...r,
      // CR-8 · no row for the day is a MISSING capture grade on the row, not an
      // absent row: the funnel then reads every gate NOT COMPUTED.
      capture_quality: r.capture_quality_effective,
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
      isTradeable: r.is_tradeable, brokerStatus: r.broker_status, no_row: r.no_row, last_row_day: r.last_row_day,
      orderPriceFils: bidFils ?? closeFils,
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
   * The two screener facts the reference's chips SELECT on, defined by Amit
   * (10 Sep) and measured here, never inferred in the browser:
   *   NEVER TRADED    no spread.order_leg row for the symbol, EVER — our own
   *                   ledger, any day (not "active on 0 of 5 sessions", which
   *                   is the market's activity, a different question).
   *   BOOK CAPTURED   at least one depth capture for the symbol TODAY (v_depth
   *                   on the day key) — not dataQuality, which is symbol_day's
   *                   quote-capture grade.
   * Two set queries per board build; the sets ride the board cache.
   */
  const facts = await screenerFacts(tradingDay, db);
  for (const r of results) {
    const sym = String(r.symbol).toUpperCase();
    r.everTraded = facts.traded.has(sym);
    r.bookCapturedToday = facts.captured.has(sym);
  }

  /*
   * ─── CR-8 · FOUR VERDICT BUCKETS + NOT COMPUTED. NOTHING REMOVED. ─────────
   *
   * SPR-38 gave NOT COMPUTED its own bucket (a gate without a number is not a
   * failed stock). CR-8 finishes the rule: EVERY row lands in exactly one of
   *
   *   TAKE         every gate passes, and every gate was computed
   *   ONE AWAY     exactly one gate fails — overridable, and not the ceiling
   *   PRICE WARN   the ONLY failure is the price ceiling for this budget: an
   *                economics warning ("needs 3 fils at 2,000 KD"), not a stock
   *                verdict. Today it hid inside nearMiss/rejected unmarked.
   *   LEAVE        two or more failures — and the STRUCTURAL rows, which used
   *                to vanish: out of reach at this budget (a JS filter dropped
   *                them before the buckets — the quiet one), below the 100-fil
   *                tick, an infeasible target, a suspended instrument. They
   *                stay on the board with `structural: true` and a reason, so
   *                the SPA can FOLD them at the foot of LEAVE — folded, never
   *                filtered. Non-overridable, as before.
   *   NOT COMPUTED a row whose only failures are missing numbers — including
   *                "no symbol_day row for this day" (the ABAR case).
   *
   * Out of reach / suspended are MEASURED facts about the row and outrank a
   * verdict the gates could not reach: an unreachable symbol with missing
   * stats is LEAVE (OUT_OF_REACH), not NOT COMPUTED. Both read on the card.
   *
   * The universe assertion below is what makes "nothing removed" a property
   * rather than a promise: the buckets must sum to the instruments count or
   * the board is an ERROR, never a shorter board.
   */
  const { take, oneAway, priceWarn, leave, notComputed, realFailed } = bucketize(results, { tradingDay, budgetKd, cfg });
  const universe = results.length;
  const reachable = results.filter((r) => r.reachable);
  const counts = { all: universe, universe,
    take: take.length, oneAway: oneAway.length, priceWarn: priceWarn.length, leave: leave.length,
    notComputed: notComputed.length,
    outOfReach: results.filter((r) => r.structuralReason === 'OUT_OF_REACH').length,
    belowTick: results.filter((r) => r.structuralReason === 'BELOW_TICK').length,
    suspended: results.filter((r) => r.structuralReason === 'SUSPENDED').length,
    noRow: results.filter((r) => r.noRow).length,
    // The old names, for one release (the AI screen tool and the SPA read them).
    recommended: take.length, nearMiss: oneAway.length, rejected: priceWarn.length + leave.length };
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
    tradingDay, budgetKd,
    take, oneAway, priceWarn, leave, notComputed, counts,
    // Deprecated aliases (one release): recommended = take, nearMiss = oneAway,
    // rejected = priceWarn + leave. New readers use the bucket names.
    recommended: take, nearMiss: oneAway, rejected: [...priceWarn, ...leave],
    reach: {
      reachable: reachable.length, total: universe,
      at2500: results.filter((r) => r.minBudgetKd == null || r.minBudgetKd <= 2500).length,
      // Saying this is more useful than showing an empty board.
      note: `at ${budgetKd} KD, ${reachable.length} of ${universe} are reachable`,
    },
    bands: funnel.tickBands(budgetKd, cfg, targets),
  };
}

/** { traded: Set<symbol with any order_leg row ever>, captured: Set<symbol with a depth capture on `day`> } */
async function screenerFacts(day, db = pool) {
  const [{ rows: t }, { rows: c }] = await Promise.all([
    db.query('SELECT DISTINCT upper(symbol) AS symbol FROM spread.order_leg;'),
    db.query('SELECT DISTINCT upper(symbol) AS symbol FROM spread.v_depth WHERE trading_date = $1::date;', [day]),
  ]);
  return { traded: new Set(t.map((r) => r.symbol)), captured: new Set(c.map((r) => r.symbol)) };
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

module.exports = { screen, bucketize, behaviourFlags, liveDirection };
