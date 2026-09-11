'use strict';
/**
 * ============================================================================
 *  present.js — engine output -> the frontend's type contract, exactly
 * ============================================================================
 * The frontend's `src/types/` IS the contract. Every field name below is copied
 * from it rather than chosen, because a translation layer on the client is one
 * more place to get a name wrong — and a name that does not match is a silent
 * `undefined`, not an error.
 *
 * ONE DIRECTION ONLY. Nothing here computes; it renames and formats what the
 * engine already decided. If a number is wrong the fix is in the engine, never
 * here.
 * ============================================================================
 */

const { GATES, DIRECTION, EVIDENCE, EXIT, BUDGET, QUALITY } = require('../config/spread.config');

/*
 * A NUMBER THAT IS NOT KNOWN TRAVELS AS NULL, NEVER AS 0.
 *
 * n2() turned null into 0 for price, bid, offer, spread, net and every metric.
 * With the stats bridge empty the board printed "tiny 0% · mv 0 · vol 0×" for
 * 140 NOT COMPUTED symbols, and "0" is a measurement — a stock with 0 moves is
 * dead, a stock with an unknown count is uncounted. n2 is kept for the few
 * fields that are genuinely zero when absent (a count of flags, a shares
 * figure derived from a known price); everything measured uses n2n.
 */
const n2 = (v) => (v == null || Number.isNaN(Number(v)) ? 0 : Number(Number(v).toFixed(2)));
const n2n = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(Number(v).toFixed(2)));
const n3 = (v) => (v == null || Number.isNaN(Number(v)) ? 0 : Number(Number(v).toFixed(3)));

/* The four groups the card renders, in the order the design fixed. */
const GROUP = {
  1: 'Can I trade it',  2: 'Can I trade it',  3: 'Is it really trading',
  4: 'Does it move',    5: 'Does it move',    6: 'Can I trade it',
  7: 'Can I trade it',  8: 'Is it really trading', 9: 'Is it really trading',
  10: 'Risk and timing',
};

/**
 * A gate cell. `sub` is MANDATORY on the frontend type and it is not
 * decoration: a percentage without the count it came from hid a bug for a week
 * — 9.0% was arithmetically right against a bid depth 7.4x thinner than its own
 * median, and nothing on screen said so.
 */
function gateCell(g) {
  return {
    label: g.label,
    ok: !!g.ok,
    warn: !!g.warn,
    value: String(g.value ?? '—'),
    sub: g.sub ? String(g.sub) : '',
    rawNumber: typeof g.rawNumber === 'number' ? g.rawNumber : undefined,
    // CR-7 · the server-formatted "value vs threshold — PASS/FAIL" the funnel
    // built. The card prints check.text verbatim (C3) — the browser never
    // re-derives a verdict it lacks the threshold to compute. null only for a
    // gate that predates the funnel (none today); shape: { text, verdict, ok,
    // warn, computed, actual, cmp, threshold }.
    check: g.check || null,
  };
}

function gateGroups(gates = []) {
  const byGroup = new Map();
  for (const g of gates) {
    const name = GROUP[g.id] || 'Risk and timing';
    if (!byGroup.has(name)) byGroup.set(name, []);
    byGroup.get(name).push(gateCell(g));
  }
  return ['Can I trade it', 'Is it really trading', 'Does it move', 'Risk and timing']
    .filter((n) => byGroup.has(n))
    .map((groupName) => ({ groupName, cells: byGroup.get(groupName) }));
}

/** Prose for the card. Both halves can appear at once — that is honest. */
function takeItBecause(r) {
  if (!r.passed) return undefined;
  const bits = [];
  const moves = r.gates.find((g) => g.id === 4);
  const tape = r.gates.find((g) => g.id === 5);
  const size = r.gates.find((g) => g.id === 3);
  if (moves?.ok) bits.push(`${moves.value} price moves`);
  if (size?.ok) bits.push(`average trade ${size.value} shares, no tape painting`);
  if (r.entry?.placement === 'INSIDE_GAP') bits.push('a gap to post inside at queue zero');
  if (tape?.ok) bits.push(`only ${tape.value} of moves from trades under 100 shares`);
  return bits.length ? bits.join(' · ') : undefined;
}

function careful(r) {
  const bits = [];
  if (r.directionWarn) {
    bits.push(`down ${Math.abs(r.gates.find((g) => g.id === 10)?.change5dFils ?? 0)} fils over ` +
              '5 sessions — a warning only, since a stock that fell yesterday is 44% to rise today');
  }
  if (r.dataQuality === 'PARTIAL') {
    bits.push(`computed from ${Math.round(r.capturePct)}% of the session — real, but not ` +
              'comparable with a fully captured symbol');
  }
  if (r.overCeiling) {
    bits.push(`your slot exceeds this stock's ceiling of ${Math.round(r.maxBudgetKd)} KD — ` +
              'sized down rather than becoming the book');
  }
  const wall = r.behaviour?.find((b) => b.flag === 'WALL');
  if (wall) bits.push(wall.why);
  return bits.length ? bits.join('. ') : undefined;
}

const FLAG_LABEL = {
  DISTRIBUTING: 'Distributing', WALL: 'Offer wall', PAINTED: 'Painted tape',
  FROZEN: 'Frozen', DEAD: 'Dead', FALLING_4_5: 'Falling 4 of 5',
  RISING: 'Rising', FALLING: 'Falling', WAKING_UP: 'Waking up',
};

/**
 * One screened row -> StockCandidate.
 *
 * `verdict` and `status` are BOTH emitted because they answer different
 * questions and the frontend renders them in different places — the pill and
 * the section. They must never be collapsed into one.
 */
function stockCandidate(r, budgetKd) {
  // SPR-38 · a card whose only failures are NOT COMPUTED gates is its own
  // status — never counted as rejected. A real failure is a failed gate not in
  // the notComputed set.
  const realFailedCount = (r.failed || []).filter((f) => !(r.notComputed || []).includes(f)).length;
  // Same ordering for the section: a structural failure is never a near miss.
  const status = r.passed ? 'recommended'
    : (!r.passed && r.failed.length > 0 && realFailedCount === 0) ? 'not_computed'
    : (!r.structural && r.failed.length === 1) ? 'near_miss'
    : 'rejected';

  /*
   * STRUCTURAL IS CHECKED BEFORE COUNTING FAILURES.
   *
   * A stock failing ONLY the price band fails exactly one gate, so a naive
   * count called it NEAR_MISS — and NEAR_MISS means "one gate away, overridable"
   * on this screen.
   *
   * Below 100 fils the tick is 0.1 and one tick pays ~1.05 KD against 3.36 in
   * commission. That is negative at any budget, on any day. Offering an
   * override there is offering a button that only ever loses money.
   */
  const verdict = !r.reachable ? 'OUT_OF_REACH'
    : r.behaviour?.some((b) => b.flag === 'DEAD') ? 'DEAD'
    : r.passed ? 'TRADABLE'
    : r.structural ? 'REJECTED'
    : r.failed.length === 1 ? 'NEAR_MISS'
    : 'NOT_RECOMMENDED';

  const shares = r.entry?.shares ?? r.netAtTarget?.shares ?? null;
  const netKd = n2n(r.netAtTarget?.netKd);

  return {
    symbol: r.symbol,
    nameAr: r.nameAr || undefined,
    price: n2n(r.priceFils),
    bid: n2n(r.bidFils),
    offer: n2n(r.offerFils),
    spread: n2n(r.spreadFils),
    entryPlacement: r.entryPlacement === 'INSIDE_GAP' ? 'INSIDE' : 'AT_BID',
    shares,
    notionalKd: n2n(r.entry?.notionalKd ?? r.netAtTarget?.notionalKd),
    roundTripKd: n2n(r.netAtTarget?.roundTripKd),
    netKd,
    // Net per FIL, not per trade. At 119 fils a fil pays +3.57; at 235 it pays
    // +0.04, and that ratio is the whole price-band argument.
    netPerFilKd: shares ? n3(shares / 1000) : null,
    trendWarn: !!r.directionWarn,
    /*
     * The day's change, in fils, against the previous SESSION close.
     *
     * The watchlist had no field for this, so a component invented one — a
     * literal −11 for KFH and 1 for KIB, giving two symbols permanent arrows
     * while every other row read flat whatever the market did.
     *
     * Direction ORDERS the list and FLAGS. It never filters: a stock that fell
     * yesterday is 44% to rise today, which is a coin flip.
     */
    changeFils: r.changeFils == null ? null : n2n(r.changeFils),
    changePct: r.priceFils != null && r.changeFils != null && Number(r.priceFils) !== Number(r.changeFils)
      ? n2((100 * r.changeFils) / (r.priceFils - r.changeFils)) : null,
    rising: r.rising ?? null,
    status,
    verdict,
    failingGatesCount: r.failed.length,
    failingGateNames: r.failed,
    rejectionDetail: r.reasons?.[0] || undefined,
    gateGroups: gateGroups(r.gates),
    takeItBecause: takeItBecause(r),
    careful: careful(r),
    headroom: {
      minKd: n2n(r.minBudgetKd),
      maxKd: n2n(r.maxBudgetKd),
      profitPerFil: shares ? n3(shares / 1000) : null,
      currentKd: n2n(budgetKd),
      headroomX: r.maxBudgetKd && budgetKd ? n2(r.maxBudgetKd / budgetKd) : null,
    },
    // Premier pays 0.10% against Main's 0.15%. `marketVerified` is false when
    // the market is an assumption rather than listing data.
    market: r.market || 'MAIN',
    marketVerified: !!r.marketVerified,
    isDead: verdict === 'DEAD',
    isOutOfReach: !r.reachable,
    // Arithmetic, not judgement. Below 100 fils the tick is 0.1 and one tick
    // loses money at any budget — an override button there only ever loses.
    isStructuralFailure: !!r.structural,
    behaviourFlags: (r.behaviour || []).map((b) => ({
      flag: b.flag, icon: b.icon, label: FLAG_LABEL[b.flag] || b.flag, why: b.why,
    })),
    /*
     * RAW GATE METRICS.
     *
     * The gate cells carry display STRINGS — "58", "12%", "+2.55" — which are
     * right for a card and useless for a threshold simulation. The config
     * page's impact panel needs the numbers, and it previously read them from a
     * locally-declared interface whose fields nothing sends, so every
     * comparison ran against `undefined` and the panel reported zero.
     */
    metrics: {
      priceFils: n2n(r.priceFils),
      netKd,
      // A5 · the 09:00–09:45 range-over-cost. A ranking column, NOT a gate: null
      // before the 09:45 job has run (the board shows "—"); a THIN/absent window
      // carries the reason for the tooltip. Sourced from spread.m45 by day.
      m45: r.m45 == null ? null : n3(r.m45),
      m45Reason: r.m45Reason ?? null,
      netPerFilKd: shares ? n3(shares / 1000) : null,
      tradeSizeShares: n2n(r.avg_trade_shares),
      movesPerDay: n2n(r.price_moves),
      moves2PlusPerDay: n2n(r.price_moves_2plus),
      tapeQualityPct: n2n(r.pct_moves_sub100),
      // The up-only figure beside the blended one. Divergence is information:
      // up-only at twice blended means the up-moves are the small prints.
      tapeQualityUpPct: r.pct_moves_sub100_up == null ? null : n2(r.pct_moves_sub100_up),
      // R-06 · the walked-up marker, computed HERE (funnel.js gate 5), never in
      // the browser: up-only tiny prints at >= 2x the blended figure and >= 30%.
      walkedUp: (() => {
        const b = r.pct_moves_sub100, u = r.pct_moves_sub100_up;
        return b != null && u != null && Number(b) > 0 && Number(u) >= 2 * Number(b) && Number(u) >= 30;
      })(),
      postablePct: n2n(r.pct_session_postable_800),
      exitDepthPct: n2n(r.pct_session_exitable_ratio),
      volSpikeRatio: n2n(r.volume_ratio_5d),
      // OUTWARD flow. High means the big trades are on the way down — size
      // leaving while the price rises, which is what makes a spike dangerous.
      outwardBlockFlowRatio: n2n(r.flow_ratio ?? r.block_ratio),
      consistencyDays: n2n(r.days_active_5d),
      gapPresentPct: n2n(r.gap_pct),
      dailyRangeFils: n2n(r.range_trading_fils),
      targetTicks: r.targetTicks ?? 1,
    },
    dataQuality: r.dataQuality || 'OK',
    dataQualityPct: r.capturePct == null ? undefined : n2(r.capturePct),
    // The screener's two facts (screening.js screenerFacts), measured server
    // side: NEVER TRADED = everTraded false (no order_leg row ever); BOOK
    // CAPTURED = bookCapturedToday true (≥ 1 depth capture today). null when
    // the board was built without them (a review board, a fixture) — the chip
    // then matches nothing rather than everything.
    everTraded: typeof r.everTraded === 'boolean' ? r.everTraded : null,
    bookCapturedToday: typeof r.bookCapturedToday === 'boolean' ? r.bookCapturedToday : null,
    // C-01 · a gate that failed for want of a NUMBER, named. The screen must
    // render these differently from a stock that is bad — for weeks they were
    // indistinguishable and the board read as a quiet market.
    notComputed: r.notComputed || [],
    // R-25 · the live direction gate (FLOW step 4 checks 1-2), computed here from
    // today's open/last/high, distinct from the yesterday-based DIRECTION warn-gate.
    liveDirection: r.liveDirection || null,
    // SCRAPER | BACKEND_BRIDGE | null — where the queue statistics came from.
    gateStatsSource: r.gateStatsSource ?? null,
  };
}

/** The book. Five levels when the ladder is captured; one when it is not. */
function orderBook(row, ladder = [], prev = null) {
  const level = (l, prevLevels) => {
    const before = prevLevels?.find((p) => p.price === Number(l.price));
    const qty = Number(l.qty);
    return {
      price: Number(l.price),
      qty,
      ordersCount: l.ordersCount ?? undefined,
      // The CHANGE is the signal. A bid thinning from 41,000 to 5,000 matters
      // more than either number on its own.
      changed: !before ? 'same'
        : qty < before.qty ? 'thinned' : qty > before.qty ? 'thickened' : 'same',
      prevQty: before?.qty,
      // R-24 · ladder markers, filled by routes.orderBookFor from depth.ladder
      // (BAIT/AGED/UNDERCUT/CEILING/SHELF/NOPROT/CATCH). Empty by default so the
      // shape is stable when no depth history is captured.
      markers: [],
    };
  };

  const bids = ladder.filter((l) => l.side === 'bid').map((l) => level(l, prev?.bids));
  const offers = ladder.filter((l) => l.side === 'offer').map((l) => level(l, prev?.offers));

  return {
    symbol: row.symbol,
    bid: n2(row.bid),
    bid_qty: Number(row.bid_qty || 0),
    offer: n2(row.offer),
    offer_qty: Number(row.offer_qty || 0),
    last_price: n2(row.last_price),
    trades: Number(row.trades || 0),
    bids: bids.length ? bids : [{ price: n2(row.bid), qty: Number(row.bid_qty || 0), changed: 'same' }],
    offers: offers.length ? offers : [{ price: n2(row.offer), qty: Number(row.offer_qty || 0), changed: 'same' }],
    dayRange: { low: n2(row.low_fils), high: n2(row.high_fils) },
    // Not captured anywhere — it lives on the broker ticket. Zeros rather than
    // a guess, so the screen can show "not captured" instead of a wrong band.
    limitBand: { low: 0, high: 0 },
    lastTickTime: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

/** The account strip. Every figure derived from the ledger, none stored. */
function accountState(a, pnl = {}) {
  const equity = Number(a.cashKd || 0) + Number(a.marketKd || 0);
  const deposited = Number(a.netDepositedKd || 0);
  return {
    buyingPowerKd: n2(a.settledKd ?? a.cashKd),
    investedKd: n2(a.investedKd),
    claimedKd: n2(a.claimedKd),
    equityKd: n2(equity),
    unrealisedKd: n2(Number(a.marketKd || 0) - Number(a.investedKd || 0)),
    todayKd: n2(pnl.todayKd),
    todayTrips: Number(pnl.todayTrips || 0),
    since28JulKd: n2(pnl.sinceKd),
    since28JulFills: Number(pnl.sinceFills || 0),
    netDepositedKd: n2(deposited),
    returnPct: deposited ? n2((100 * (equity - deposited)) / deposited) : 0,
  };
}

/** The market strip: breadth and regime from the scraper's market_day. */
function marketDay(r) {
  if (!r) return null;
  return {
    tradingDay: r.trading_day,
    symbolsTraded: Number(r.symbols_traded || 0),
    up: Number(r.advancing || 0), down: Number(r.declining || 0), flat: Number(r.unchanged || 0),
    breadthPct: n2(r.pct_advancing),
    breadth5dAvgPct: n2(r.breadth_5d_avg),
    regime: r.regime || null,
    // R-05 · the band the strip colours by, from the scraper's regime text —
    // so the 35/50 thresholds live in ONE place (the stats job / the stops
    // service), never re-derived in the browser. null when regime is absent.
    breadthBand: (() => {
      const g = String(r.regime || '').toUpperCase().replace(/\s+/g, '_');
      if (/RISK_OFF|BEAR|WEAK/.test(g)) return 'risk_off';
      if (/RISK_ON|BULL|STRONG/.test(g)) return 'risk_on';
      if (g) return 'neutral';
      return null;
    })(),
    volumeShares: Number(r.total_volume || 0),
    trades: Number(r.total_trades || 0),
    turnoverKd: n2(r.turnover_kd),
    volumeVs20d: n2(r.volume_vs_20d),
    indexYtdPct: r.index_ytd_pct == null ? null : n2(r.index_ytd_pct),
    computedAt: r.computed_at ? new Date(r.computed_at).toISOString() : null,
  };
}

function ledgerEntry(r) {
  return {
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    kind: r.kind,
    // Three decimals. The per-execution commission finding rests on 0.105, and
    // rounding to two loses the evidence.
    amount_kd: n3(r.amount_kd),
    balance_kd: n3(r.balance_kd),
    note: r.note || '',
    refSymbol: r.symbol || undefined,
  };
}

/** /api/health. Pure, so the stale rule can be tested without a clock. */
const HEALTH_STALE_AFTER_SEC = 300;
function health({ now, latestQuoteAt, latestStatsDay, statsSource = null, session, staleSlots = null }) {
  const nowMs = new Date(now).getTime();
  const quoteAgeSec = latestQuoteAt ? Math.max(0, Math.round((nowMs - new Date(latestQuoteAt).getTime()) / 1000)) : null;
  const open = !!session?.open;
  // A4 · stale slots are REPORTED, never a 503. The 503 stays the quote-age rule
  // (the whole feed is down); a single stale slot is a per-slot warning, not an
  // outage. staleSlots is the count when known, null when not computed.
  const stale = open && (quoteAgeSec == null || quoteAgeSec > HEALTH_STALE_AFTER_SEC);
  return {
    status: stale ? 'stale' : 'ok',
    time: new Date(now).toISOString(),
    quoteAgeSec,
    staleSlots: staleSlots == null ? null : Number(staleSlots),
    latestQuoteAt: latestQuoteAt ? new Date(latestQuoteAt).toISOString() : null,
    latestStatsDay: latestStatsDay ? require('../lib/day').toDay(latestStatsDay) : null,
    statsSource: statsSource ?? null,
    session: { open, phase: session?.phase ?? null },
    staleAfterSec: HEALTH_STALE_AFTER_SEC,
    note: stale ? `no quote for ${quoteAgeSec == null ? 'ever' : quoteAgeSec + ' s'} while the session is open — the scraper is not writing` : null,
  };
}

function tradingContract(c) {
  return {
    symbol: c.symbol,
    seq: Number(c.contract_seq ?? c.seq ?? 1),
    state: c.state,
    shares: Number(c.shares || 0),
    entry: n2n(c.entry),
    // null when there is no quote today (markedAt = 'entry'), never the entry
    // price wearing the bid's name.
    bid: n2n(c.bid),
    offer: n2n(c.offer),
    committedKd: n2(c.committedKd),
    unrealisedKd: n2n(c.unrealisedKd),
    // Break-even and trail-arm are adjacent on the card DELIBERATELY. On one
    // real position they were 239 and 240, and selling at 239 nets +0.001 KD.
    breakEvenPrice: n2n(c.breakEvenFils),
    // R-41 · the exit target, +2 / +6 (FLOW step 7). The prototype trailing
    // offer is gone.
    targetNormal: n2n(c.targetNormalFils),
    targetTrending: n2n(c.targetTrendingFils),
    peakSinceFill: n2n(c.peakBidFils),
    stepDownTime: require('../lib/session').get().stepDownClock,
    // B-08 · shares is what is STILL HELD; boughtShares is the fill. They
    // differ after a partial sell, and the difference used to be invisible.
    boughtShares: Number(c.boughtShares ?? c.shares ?? 0),
    openedOn: c.openedOn ?? null,
    // 'quote' when marked at today's bid, 'entry' when no quote exists today
    // (unrealised then reads 0.00 and must not be trusted), null for a claim.
    markedAt: c.markedAt ?? null,
    quoteAt: c.quoteAt ? new Date(c.quoteAt).toISOString() : null,
    legs: (c.legs || []).map((l) => ({
      id: Number(l.id),
      contractId: Number(c.contract_seq ?? c.seq ?? 1),
      symbol: c.symbol,
      time: l.posted_at ? new Date(l.posted_at).toISOString() : '',
      side: l.side,
      status: l.status,
      price: n2(l.price_fils),
      shares: Number(l.shares || 0),
      commission_kd: n3(l.commission_kd),
      note: l.note || '',
    })),
  };
}

/** Session phase. Every clock display asks this before rendering. */
function sessionInfo(p, drift) {
  const phaseMap = { pre_open: 'pre_open', open: 'calm', peak: 'peak',
    step_down: 'step_down', late: 'step_down', closed: 'closed' };
  return {
    phase: phaseMap[p.phase] || 'closed',
    hour: p.hour ?? 0,
    timeStr: p.timeStr || '',
    driftVsOpen: drift ?? 0,
    minutesToStepDown: p.minutesToStepDown ?? 0,
    lateToOpen: !!p.lateToOpen,
    note: p.note || '',
  };
}

/**
 * The configuration screen.
 *
 * `evidence`, `observationCount` and `confidence` are the most important
 * fields here. Two of the last three thresholds were set from a SINGLE failure
 * each and both hid good stocks — anyone changing a number must see what it is
 * standing on.
 */
function gateConfigs(cfg = null, meta = {}) {
  // The EFFECTIVE thresholds, so the screen shows what is enforced. Reading
  // the file meant an edit appeared to save and changed nothing.
  const g = cfg?.GATES || GATES;
  const dir = cfg?.DIRECTION || DIRECTION;
  const exit = cfg?.EXIT || EXIT;
  const bud = cfg?.BUDGET || BUDGET;
  const qual = cfg?.QUALITY || QUALITY;
  const tgt = cfg?.TARGETS || { allow1Tick: 1, allow2Ticks: 1, allow3Ticks: 0,
    minGapPctFor2Tick: 30, minRangeFilsFor3Tick: 6 };
  const ev = (k) => EVIDENCE[k] || { basis: '', strength: 'weak' };
  const conf = (s) => (s === 'strong' || s === 'exact' ? 'HIGH'
    : s === 'moderate' ? 'MEDIUM' : 'LOW');
  const count = (b) => (/(\d[\d,]*)/.exec(b || '')?.[1]?.replace(/,/g, '') ?? '1');

  const rows = [
    ['g1-floor', 'Can I trade it', 'Price band floor', `${g.priceFloorFils} fils`,
      g.priceFloorFils, 'fils',
      'Below 100 fils the exchange tick is 0.1. One tick pays about 1.05 KD against 3.36 in ' +
      'commission — negative at any budget, on any day. STRUCTURAL: cannot be overridden.',
      'g1Floor'],
    ['g2-net', 'Can I trade it', 'Net profit floor', `${g.netFloorKd} KD`,
      g.netFloorKd, 'KD',
      'Minimum net per round trip at the target capture.', 'g2'],
    ['g3-size', 'Is it really trading', 'Average trade size', `${g.minAvgTradeShares} shares`,
      g.minAvgTradeShares, 'shares',
      'On a stock averaging 1,200 shares a 100-share order is 8% of normal and moves the tape.',
      'g3'],
    ['g4-moves', 'Does it move', 'Price moves', `${g.minPriceMoves}/day`,
      g.minPriceMoves, 'moves/day',
      'NOT a trade count. One stock traded 227 times and changed price 8 times — a count gate ' +
      'keeps that one and cuts a good one.', 'g4'],
    ['g5-tape', 'Does it move', 'Tape quality', `${g.maxPctMovesSub100}% max`,
      g.maxPctMovesSub100, '%',
      'Percentage of price moves caused by trades of 100 shares or fewer. One stock had 7 of 31 ' +
      'moves from trades totalling 28 shares.', 'g5'],
    ['g6-postable', 'Can I trade it', 'Postable', `${g.minPctPostable}% min`,
      g.minPctPostable, '%',
      'A PERCENTAGE OF THE SESSION, never a median. One bid swung 33-fold across a session; the ' +
      'median said 2.0% and rejected the stock that produced four fills that day.', 'g6'],
    ['g7-exit', 'Can I trade it', 'Exit depth', `${g.minPctExitableRatio}% min`,
      g.minPctExitableRatio, '%',
      'Entry is optional; exit is not. One book showed a bid of 20,000 against an offer of ' +
      '226,114 and the position closed −24 KD two sessions later.', 'g7'],
    ['g8-dist', 'Is it really trading', 'Distribution',
      `${g.distVolumeRatio}× AND ${g.distFlowRatio}×`, g.distVolumeRatio, '×',
      'BOTH, or neither. A spike alone predicts nothing — one 17.56× spike with inward flow ran ' +
      'six days. Spike WITH outward flow averaged −1.36 the next day.', 'g8'],
    ['g9-consistency', 'Is it really trading', 'Consistency',
      `${g.minDaysActive5d} of ${g.consistencyWindow}`, g.minDaysActive5d, 'days',
      'Three dead stocks topped the screen after one busy day. The cost is explicit: this blocks ' +
      'day one of a real breakout, and the wake-up scan catches those live instead.', 'g9'],
    ['g10-direction', 'Risk and timing', 'Direction 1d / 5d', dir.mode.toUpperCase(),
      dir.warnChange1dFils, 'fils',
      'WARNS, NEVER BLOCKS. A stock that fell yesterday is 44% to rise today — a coin flip. The ' +
      'four bad picks that raised this each failed a gate that already existed.', 'g10'],
    ['exit-stepdown', 'Exit', 'Step down at', exit.stepDownAtClock, 11, 'clock',
      'Three separate findings. On one session the exit was −3.48 at 10:50 and −7.18 at 11:15.', 'g4'],
    ['exit-hard', 'Exit', 'Flatten at', exit.hardExitAtClock, 12.5, 'clock',
      'Never carry overnight. Every overnight hold in ten sessions lost money, the worst −44.94 ' +
      'over a weekend.', 'g9'],
    ['session-budget', 'Session', 'Slot size', `${bud.slotKd} KD`, bud.slotKd, 'KD',
      'One position, full size. 2 × 400 KD earned +0.02; 1 × 850 KD earned +1.16.', 'g2'],
    /*
     * R-01 · the six controls that saved and were never returned.
     *
     * Without these rows GET /gates omits them, the config page's seed effect
     * cannot read them back, and the toggles silently revert to the file
     * defaults on reload — despite the operator having saved them.
     */
    ['g8-flow', 'Is it really trading', 'Outward block flow',
      `${g.distFlowRatio}×`, g.distFlowRatio, '×',
      'The SECOND half of Gate 8, and it must be read as OUTWARD flow: average trade size on ' +
      'downticks divided by upticks. High means the big trades are on the way down — size ' +
      'leaving while the price rises. Both halves fire, or neither blocks.', 'g8'],

    ['target-1tick', 'Session', '1-tick capture',
      tgt.allow1Tick ? 'ON' : 'OFF', tgt.allow1Tick, 'on/off',
      'Every fill in the record has been a 1-fil target.', 'g2'],
    ['target-2ticks', 'Session', '2-tick capture',
      tgt.allow2Ticks ? 'ON' : 'OFF', tgt.allow2Ticks, 'on/off',
      'A wider capture is a HARDER capture. Two ticks needs a 2-fil spread present often ' +
      'enough to enter at queue zero — otherwise you are joining a 1-fil queue and hoping for ' +
      'a 2-fil move, which is a directional trade.', 'g2'],
    ['target-3ticks', 'Session', '3-tick capture',
      tgt.allow3Ticks ? 'ON' : 'OFF', tgt.allow3Ticks, 'on/off',
      'OFF by default. A 3-tick capture has never been attempted, so enabling it puts ' +
      'untested trades at the top of the board.', 'g2'],
    ['target-2gap-pct', 'Session', '2-tick gap frequency',
      `${tgt.minGapPctFor2Tick}%`, tgt.minGapPctFor2Tick, '%',
      'How often a 2-fil spread must be present. One stock had the widest range on the board ' +
      'at 16.6 fils and still failed: its gap was there only 22% of the session.', 'g6'],
    ['target-3range', 'Session', '3-tick daily range',
      `${tgt.minRangeFilsFor3Tick} fils`, tgt.minRangeFilsFor3Tick, 'fils',
      'The range a stock must cover before three ticks is reachable.', 'g4'],

    ['quality-capture', 'Session', 'Capture floor', `${qual.minCapturePct}%`,
      qual.minCapturePct, '%',
      'Below this a row is PARTIAL. A percentage from half a session is not wrong — it is not ' +
      'COMPARABLE, and it sorts beside a full one as though it meant the same thing.', 'g6'],
  ];

  return rows.map(([id, group, gateName, currentValue, numericValue, unit, ruleDescription, evKey]) => ({
    id, group, gateName, currentValue, numericValue, unit, ruleDescription,
    evidence: ev(evKey).basis,
    observationCount: Number(count(ev(evKey).basis)) || 1,
    confidence: conf(ev(evKey).strength),
    // When it was last changed, and by which version. '' made every gate look
    // untouched even after an edit.
    lastChanged: meta.loadedAt ? new Date(meta.loadedAt).toISOString() : '',
    configVersion: meta.version ?? 0,
    // A locked gate is arithmetic, not a preference — the UI must not offer a
    // control that only ever loses money.
    locked: id === 'g1-floor',
    // A toggle renders as a switch, not a slider.
    isToggle: unit === 'on/off',
    rejectsCount: 0,
    mode: id === 'g10-direction' ? dir.mode : undefined,
  }));
}

module.exports = {
  health,
  marketDay,
  stockCandidate, orderBook, accountState, ledgerEntry, tradingContract,
  sessionInfo, gateConfigs, gateGroups,
};
