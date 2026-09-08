'use strict';
/**
 * ============================================================================
 *  funnel.js — the nine gates, and Gate 10 which warns
 * ============================================================================
 * PURE. No database, no clock, no network. Everything arrives as a row of
 * already-computed columns, which is the whole point:
 *
 *   THE SAME CHECK MUST NOT BE EXPRESSED TWICE.
 *
 * Three times a correctly-specified check was implemented with the wrong
 * statistic, and the wrong statistic INVERTED the answer. So the statistics are
 * computed once by the 13:30 job into stored columns, and this module only ever
 * compares them against thresholds.
 *
 * RETURNS EVERY GATE, PASSING OR FAILING. A stock is never silently dropped —
 * filters hid three of the four best candidates on one day and nobody could see
 * it happen.
 * ============================================================================
 */

const COMMISSION = require('./commission');
const { GATES, BUDGET, DIRECTION, QUALITY } = require('../config/spread.config');

const MAX_TICKS = 3;
const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/**
 * What the round trip nets at N ticks.
 *
 * Commission is effectively fixed at 3.34-3.40 across the tradeable band, so
 * net is decided almost entirely by share count. Shortcut worth remembering:
 * net ~= (budget / price) - 3.4.
 */
function netAtTicks(budgetKd, priceFils, ticks = 1, opts = {}) {
  const shares = Math.floor((budgetKd * 1000) / priceFils / BUDGET.lotSize) * BUDGET.lotSize;
  if (shares <= 0) return { shares: 0, ticks, notionalKd: 0, roundTripKd: null, netKd: null };

  const entryKd = (shares * priceFils) / 1000;
  const exitKd = (shares * (priceFils + ticks)) / 1000;
  const rt = COMMISSION.roundTripKd(entryKd, exitKd, opts);

  return {
    shares, ticks,
    notionalKd: round(entryKd, 3),
    roundTripKd: rt.kd,
    netKd: round((ticks * shares) / 1000 - rt.kd, 3),
    // FALSE when an execution count is unknown. The figure is then a BEST CASE
    // and a two-piece fill costs 0.50-0.75 more.
    commissionKnown: rt.known,
  };
}

/** CR-30 · net at 1, 2 and 3 ticks. The card shows all three. */
function netByTicks(budgetKd, priceFils, opts = {}) {
  const out = {};
  for (let t = 1; t <= MAX_TICKS; t++) out[t] = netAtTicks(budgetKd, priceFils, t, opts);
  return out;
}

/**
 * CR-30 · which tick band a price falls in AT THIS BUDGET.
 *
 * THE BAND IS A PROPERTY OF THE BUDGET, NOT THE STOCK. A 342-fil stock is
 * 2-tick at 800 KD and 1-tick at 1,500.
 */
/**
 * @param {object} targets  which tick targets the operator has ENABLED.
 *
 * R-01 · this was ignored, so the config page's target checkboxes saved and
 * changed nothing — an edit that appears to take effect and does not, which is
 * the exact failure B-08 was raised for, relocated one layer deeper.
 *
 * Default 1 and 2 on, 3 off: every fill in the record has been a 1-fil target
 * and a 3-tick capture has never been attempted, so shipping it enabled would
 * put untested trades at the top of the board.
 */
function bandFor(priceFils, budgetKd, cfg = GATES, targets = null) {
  const px = Number(priceFils);
  if (!(px >= cfg.priceFloorFils)) return null;
  const allowed = (t) => {
    if (!targets) return true;
    return t === 1 ? targets.allow1Tick !== 0
      : t === 2 ? targets.allow2Ticks !== 0
      : targets.allow3Ticks !== 0;
  };
  for (let t = 1; t <= MAX_TICKS; t++) {
    const sharesNeeded = ((cfg.netFloorKd + cfg.ceilingCommissionKd) * 1000) / t;
    if (px <= Math.floor((budgetKd * 1000) / sharesNeeded)) {
      // A price inside a DISABLED band is out of reach, not silently promoted
      // to the next one — the operator turned that capture off.
      return allowed(t) ? t : null;
    }
  }
  return null;
}

/** The band table for the screen. Boundaries move with the budget. */
function tickBands(budgetKd, cfg = GATES, targets = null) {
  const out = [];
  let lo = cfg.priceFloorFils;
  for (let t = 1; t <= MAX_TICKS; t++) {
    const sharesNeeded = ((cfg.netFloorKd + cfg.ceilingCommissionKd) * 1000) / t;
    const hi = Math.floor((budgetKd * 1000) / sharesNeeded);
    out.push({
      ticks: t, minPriceFils: lo, maxPriceFils: hi,
      sharesNeeded: Math.ceil(sharesNeeded),
      // So the screen can grey a disabled band rather than silently omitting it.
      enabled: !targets || (t === 1 ? targets.allow1Tick !== 0
        : t === 2 ? targets.allow2Ticks !== 0 : targets.allow3Ticks !== 0),
    });
    lo = hi + 1;
  }
  return out;
}

/** The top of the highest band — NOT a separate figure. */
function priceCeilingFils(budgetKd, maxTicks = 1, cfg = GATES) {
  const bands = tickBands(budgetKd, cfg);
  return bands[Math.min(maxTicks, MAX_TICKS) - 1].maxPriceFils;
}

/**
 * A wider capture is a HARDER capture.
 *
 * One tick needs only that the price move. Two ticks needs a 2-fil spread
 * often enough to enter at queue zero — one stock had the widest range on the
 * board at 16.6 fils and still failed, because its gap was present only 22% of
 * the session.
 */
function feasible(ticks, { gapPct, rangeFils } = {}, targets = null) {
  const minGap = targets?.minGapPctFor2Tick ?? 30;
  const minRange = targets?.minRangeFilsFor3Tick ?? 6;

  if (ticks === 1) return { ok: true, why: null };
  if (ticks === 2) {
    // A gap that is not there most of the session is not a queue-zero entry.
    // One stock had the widest range on the board at 16.6 fils and still
    // failed: its 2-fil spread was present only 22% of the time.
    const ok = Number(gapPct) >= minGap;
    return { ok, why: ok ? null
      : `a 2-fil spread is present only ${Math.round(gapPct || 0)}% of the session — below the ` +
        `${minGap}% needed to enter at queue zero. Joining a 1-fil queue and hoping for a 2-fil ` +
        'move is a directional trade.' };
  }
  if (ticks === 3) {
    const ok = Number(rangeFils) >= minRange;
    return { ok, why: ok ? null
      : `average range ${rangeFils} fils — below the ${minRange} needed for 3 ticks` };
  }
  return { ok: false, why: `${ticks} ticks is beyond the ${MAX_TICKS}-tick cap — that is directional` };
}

const pass = (id, label, ok, value, why, extra = {}) =>
  ({ id, label, ok: !!ok, value, why: ok ? null : why, ...extra });

/**
 * Run the funnel over one symbol-day.
 *
 * @param {object} row  a spread.symbol_day row plus today's live price
 */
function evaluate(row, budgetKd, cfg = GATES, opts = {}) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const known = (v) => v != null && Number.isFinite(v);

  const priceFils = num(row.priceFils ?? row.close_fils);
  const orderPriceFils = num(row.orderPriceFils ?? priceFils);

  const targets = opts.targets ?? null;
  /*
   * B-02 · Gate 10 and the capture thresholds come from the EFFECTIVE config.
   *
   * This read the module-level DIRECTION and hardcoded 90/70, so the
   * `g10-direction` and `quality-capture` bindings in gateStore saved and
   * changed nothing — the exact failure the store's header says it fixed,
   * relocated one layer deeper. The file constants remain the default.
   */
  const direction = opts.direction ?? DIRECTION;
  const quality = opts.quality ?? QUALITY;
  const targetTicks = row.targetTicks ?? bandFor(priceFils, budgetKd, cfg, targets);
  const econ = netAtTicks(budgetKd, orderPriceFils, targetTicks || 1, opts);
  const byTicks = netByTicks(budgetKd, orderPriceFils, opts);
  const feas = targetTicks
    ? feasible(targetTicks, { gapPct: num(row.gap_pct), rangeFils: num(row.range_trading_fils) }, targets)
    : { ok: false,
        why: targets && bandFor(priceFils, budgetKd, cfg) != null
          ? `${bandFor(priceFils, budgetKd, cfg)}-tick capture is switched off, and this price ` +
            'only reaches that band'
          : `no feasible target at ${budgetKd} KD — the price is above every band` };

  const moves      = num(row.price_moves);
  const moves2     = num(row.price_moves_2plus);
  const tinyPct    = num(row.pct_moves_sub100);
  // The scraper's up-only figure. NOT the gate's input (018) — shown beside it
  // because a stock where up-only is double the blended is being walked up.
  const tinyUpPct  = num(row.pct_moves_sub100_up);
  const postable   = num(row.pct_session_postable_800);
  const exitRatio  = num(row.pct_session_exitable_ratio);
  const exitSize   = num(row.pct_session_exitable_size_800);
  const avgTrade   = num(row.avg_trade_shares);
  const volRatio   = num(row.volume_ratio_5d);
  const flowRatio  = num(row.flow_ratio);
  const blockRatio = num(row.block_ratio);
  const daysActive = num(row.days_active_5d);
  const capturePct = num(row.capture_pct);

  const ceiling = priceCeilingFils(budgetKd, MAX_TICKS, cfg);

  const gates = [
    pass(1, 'Price band',
      known(priceFils) && priceFils >= cfg.priceFloorFils && priceFils <= ceiling,
      `${priceFils} fils`,
      priceFils < cfg.priceFloorFils
        ? `${priceFils} fils — below 100 the tick is 0.1 fil, so one tick pays about 1.05 KD ` +
          'against 3.36 in commission. Net is negative at any budget, on any day.'
        : `${priceFils} fils — above the ${ceiling}-fil ceiling for ${budgetKd} KD`,
      { ceiling, floor: cfg.priceFloorFils,
        // Arithmetic, not judgement. There is no market condition under which
        // this trade wins, so an override button here only ever loses money.
        structural: priceFils < cfg.priceFloorFils }),

    pass(2, 'Profit floor',
      known(econ.netKd) && econ.netKd >= cfg.netFloorKd && feas.ok,
      econ.netKd == null ? '—' : `${econ.netKd >= 0 ? '+' : '−'}${Math.abs(econ.netKd).toFixed(2)}`,
      !feas.ok ? feas.why
        : `net ${econ.netKd} KD at ${targetTicks} tick${targetTicks === 1 ? '' : 's'} — ` +
          `below the ${cfg.netFloorKd} floor`,
      { shares: econ.shares, roundTripKd: econ.roundTripKd, targetTicks,
        sub: `${targetTicks || '—'} tick target`, structural: !feas.ok }),

    pass(3, 'Trade size',
      known(avgTrade) && avgTrade >= cfg.minAvgTradeShares,
      known(avgTrade) ? Math.round(avgTrade).toLocaleString('en-US') : '—',
      known(avgTrade)
        ? `average trade ${Math.round(avgTrade).toLocaleString('en-US')} shares — a 100-share order ` +
          'would move this tape'
        : 'average trade size not computed'),

    pass(4, 'Movement',
      targetTicks >= 2
        ? known(moves2) && moves2 >= cfg.minPriceMoves2plus
        : known(moves) && moves >= cfg.minPriceMoves,
      targetTicks >= 2
        ? (known(moves2) ? `${moves2} of 2+` : '—')
        : (known(moves) ? String(moves) : '—'),
      targetTicks >= 2
        ? `${moves2} up-moves of 2+ fils — a 2-tick target needs 2-fil moves, and one stock ` +
          'had 14 moves a day with a median of ONE'
        : known(moves)
          ? `${moves} price moves — a round trip needs price down to your bid AND up to your offer`
          : 'moves not computed',
      { sub: known(moves2) ? `${moves2} of 2+ fils` : null }),

    pass(5, 'Tape quality',
      known(tinyPct) && tinyPct <= cfg.maxPctMovesSub100,
      known(tinyPct) ? `${Math.round(tinyPct)}%` : '—',
      known(tinyPct)
        ? `${Math.round(tinyPct)}% of price moves came from trades of 100 shares or fewer — painted tape`
        : 'tape quality not computed',
      { sub: known(tinyUpPct) ? `up-only ${Math.round(tinyUpPct)}%` : null,
        tinyUpPct,
        // up-only at twice the blended: the up-moves are the small prints.
        walkedUp: known(tinyPct) && known(tinyUpPct) && tinyPct > 0 && tinyUpPct >= 2 * tinyPct && tinyUpPct >= 30 }),

    pass(6, 'Postable',
      known(postable) && postable >= cfg.minPctPostable,
      known(postable) ? `${Math.round(postable)}%` : '—',
      known(postable)
        ? `postable on ${Math.round(postable)}% of the session — under 5% of the bid you are ` +
          'invisible, over 30% you are the book'
        : 'postable percentage not computed',
      { sub: known(row.bid_kd_p25) ? `p25 ${Math.round(row.bid_kd_p25)} KD` : null }),

    // Gate 7 keeps the RATIO — it catches the offer-wall shape that cost 24 KD.
    // The size-relative figure answers a different question and drives the
    // alert and the AI rather than the gate.
    pass(7, 'Exit depth',
      known(exitRatio) && exitRatio >= cfg.minPctExitableRatio,
      known(exitRatio) ? `${Math.round(exitRatio)}%` : '—',
      known(exitRatio)
        ? `exitable on only ${Math.round(exitRatio)}% of the session — entry is optional, exit is not`
        : 'exit depth not computed',
      { sub: known(exitSize) ? `${Math.round(exitSize)}% for your size` : null,
        forSizePct: exitSize, bestHourPct: num(row.exitable_best_hour_pct) }),

    /*
     * Gate 8 blocks only when BOTH fire. A spike alone predicts nothing, and
     * blocking on it alone wrongly rejected a stock whose 17.56x spike ran six
     * days from 143 to 181 — the only profitable session in eight.
     *
     * DELIBERATE ASYMMETRY: every other gate treats a null as a FAILURE. This
     * is the only BLOCKING gate, so unknown means "no reason to block".
     * Without it, a missing baseline rejects the entire board.
     *
     * CR-33: flow_ratio is MEASURED print location. The tick rule it replaces
     * is blind to a large seller hitting the same bid repeatedly — 35 events
     * and 432,685 shares dropped on one session.
     */
    pass(8, 'Distribution',
      !(known(volRatio) && known(flowRatio ?? blockRatio)
        && volRatio >= cfg.distVolumeRatio && (flowRatio ?? blockRatio) >= cfg.distFlowRatio),
      known(volRatio) ? `${volRatio.toFixed(1)}× vol` : '—',
      `volume ${volRatio}× baseline with outward flow ${flowRatio ?? blockRatio} — ` +
      'size is leaving while the price rises',
      { volumeRatio: volRatio, flowRatio: flowRatio ?? blockRatio,
        sub: known(flowRatio) ? `flow ${flowRatio.toFixed(2)}` : null }),

    pass(9, 'Consistency',
      known(daysActive) && daysActive >= cfg.minDaysActive5d,
      known(daysActive) ? `${daysActive}/${cfg.consistencyWindow}` : '—',
      known(daysActive)
        ? `active on ${daysActive} of the last ${cfg.consistencyWindow} sessions — one busy day ` +
          'after a quiet week is a flash, not a regime'
        : 'session history not available'),
  ];

  /*
   * GATE 10 · DIRECTION. WARN, NEVER BLOCK.
   *
   * A stock that fell yesterday is 44% to rise today — a coin flip. And the
   * four bad picks that raised this each failed a gate that ALREADY EXISTS:
   * 11 moves, 5% exitable, 35% painted. Direction correlated with the real
   * failures rather than causing them.
   *
   * `mode` is the explicit switch, so setting a threshold without also setting
   * mode does nothing. One reading of intent, not two.
   */
  const change1d = num(row.change_1d_fils);
  const change5d = num(row.change_5d_fils);
  const directionWarn =
    (known(change5d) && change5d < direction.warnChange5dFils) ||
    (known(change1d) && change1d < direction.warnChange1dFils);
  const directionBlocks = direction.mode === 'block' && directionWarn;

  gates.push(pass(10, 'Direction',
    !directionBlocks,
    `${change1d >= 0 ? '+' : ''}${change1d ?? '—'} / ${change5d >= 0 ? '+' : ''}${change5d ?? '—'}`,
    `down ${Math.abs(change5d)} fils over 5 sessions and ${Math.abs(change1d)} yesterday`,
    { warn: directionWarn && !directionBlocks,
      change1dFils: change1d, change5dFils: change5d,
      sub: '1d / 5d',
      mode: direction.mode }));

  /*
   * CAPTURE QUALITY. Gates 6 and 7 are percentages OF THE SESSION, and a
   * session only half captured produces a percentage of half a session. The
   * number is not wrong — it is NOT COMPARABLE, which is worse, because it
   * sorts beside a full-session symbol as though it meant the same thing.
   */
  const partial = known(capturePct) && capturePct < quality.minCapturePct;
  const tooThin = known(capturePct) && capturePct < quality.refuseBelowPct;
  if (partial) {
    for (const g of gates) {
      if (g.id !== 6 && g.id !== 7) continue;
      g.capturePct = capturePct;
      if (tooThin) {
        g.ok = false;
        g.why = `computed from ${Math.round(capturePct)}% of the session — ` +
                `${g.label.toLowerCase()} over half a day is not the same measurement`;
      } else {
        g.warn = true;
        g.sub = `${Math.round(capturePct)}% captured`;
      }
    }
  }

  /*
   * C-01 · a gate that failed because the STATISTIC IS MISSING is a different
   * failure from a gate that failed because the stock is bad, and the board
   * has to say which. Every one of these read null for weeks and the result
   * was indistinguishable from a quiet market.
   */
  for (const g of gates) {
    g.notComputed = !g.ok && /not computed|not available/.test(g.why || '');
  }
  const failed = gates.filter((g) => !g.ok);
  const notComputed = failed.filter((g) => g.notComputed).map((g) => g.label.toLowerCase());
  const rising = known(num(row.close_fils)) && known(num(row.prev_close_fils))
    ? Number(row.close_fils) > Number(row.prev_close_fils) : null;

  return {
    symbol: row.symbol,
    priceFils,
    targetTicks,
    feasible: feas.ok,
    feasibleWhy: feas.why,
    gates,
    passed: failed.length === 0,
    failed: failed.map((g) => g.label.toLowerCase()),
    reasons: failed.map((g) => g.why),
    // Arithmetic, not judgement. An override button here only ever loses money.
    structural: failed.some((g) => g.structural),
    // Which gates failed for want of a number, not for want of a stock.
    notComputed,
    // SCRAPER | BACKEND_BRIDGE | null — where the queue statistics came from.
    gateStatsSource: row.gate_stats_source ?? null,
    overridable: !failed.some((g) => g.structural),
    netAtTarget: econ,
    netByTicks: byTicks,
    ceiling,
    // Ranking: net x moves. Neither works alone — net alone puts a 19-move
    // stock first; moves alone ignores what a fil pays.
    score: known(econ.netKd) && known(moves) ? round(econ.netKd * moves, 3) : null,
    rising,
    changeFils: known(change1d) ? change1d : null,
    arrow: change1d == null ? '—' : change1d > 0 ? '▲' : change1d < 0 ? '▼' : '–',
    directionWarn,
    downFlag: known(num(row.down_days_5d)) && num(row.down_days_5d) >= 4,
    capturePct: known(capturePct) ? capturePct : null,
    /*
     * N-16 · the FULL enum, so a consumer testing NO_BOOK is not testing a
     * value that never arrives.
     *
     * The three states mean different things and only one is about coverage:
     *   NO_BOOK   the row came from a source with no bid or offer at all —
     *             TradingView has price and volume and nothing to post against
     *   MISSING   no row for this symbol today
     *   THIN      a broker row, but under 70% of the session captured
     */
    dataQuality: row.source === 'TRADINGVIEW' ? 'NO_BOOK'
      : row.capture_quality === 'MISSING' || row.source === 'NONE' ? 'MISSING'
      : tooThin ? 'THIN' : partial ? 'PARTIAL' : 'OK',
  };
}

/** Risers first, then score descending. */
function rank(results) {
  return [...results].sort((a, b) => {
    if (a.rising !== b.rising) return (b.rising ? 1 : 0) - (a.rising ? 1 : 0);
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });
}

module.exports = {
  evaluate, rank, netAtTicks, netByTicks, bandFor, tickBands,
  priceCeilingFils, feasible, MAX_TICKS,
};
