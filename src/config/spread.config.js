'use strict';
/*
 * ─── KNOWN GAPS IN THE GATE SET (3 September 2026) ──────────────────────────
 * ABAR passed every gate on 1 September and fell 24 fils on 2 September with
 * buying prints at 1:2.5 against selling. No gate reads the PRINT-SIZE RATIO
 * (avg_uptick_shares / avg_downtick_shares, both in symbol_day) or INTRADAY
 * DIRECTION, so a stock being distributed can still read TRADABLE. Noted, not
 * fixed: a new gate needs the ten-session sample before it gets a threshold.
 */
/**
 * ============================================================================
 *  spread.config.js — every threshold, with the evidence behind it
 * ============================================================================
 * The strength column is not decoration. Two thresholds have been set from a
 * SINGLE failure each and both hid good stocks, so anyone changing a number
 * here needs to see what it is standing on.
 * ============================================================================
 */

const SESSION = {
  openAt: '09:00',
  closeAt: '13:00',
  auctionCloseAt: '13:25',
  // F5 · Trading at Last — 13:10–13:14, the exchange's 'Trading at Last'
  // label alone (confirmed 11 Sep): closing at the auction price only.
  // Close-Of-Day (13:15–13:25) is NOT a closing venue for us.
  talStartAt: '13:10',
  talEndAt: '13:15',
  timezoneOffsetHours: 3,          // Kuwait, UTC+3
  // Before this hour the session that matters is still yesterday's. Work done
  // in the evening straddles a calendar roll that has nothing to do with the
  // market — a claim made at 20:45 UTC vanished at 21:15.
  dayRollHourKuwait: 4,
};

const BUDGET = {
  slotKd: 790,
  lotSize: 100,
  // 2 x 400 KD earned +0.02; 1 x 850 KD earned +1.16. The settlement fee is
  // per ORDER, so two positions means four orders on a 1-3 KD edge.
  maxPositions: 1,
};

const COMMISSION = {
  rateMain: 0.0015,
  ratePremier: 0.0010,
  minPerSide: 0.250,
  settlementPerExecution: 0.500,
  // PER EXECUTION, proven exactly. A 6,100 sell that filled as 5,350 + 750 was
  // charged 2.285 against a formula expecting 1.680 — 0.500 for the second
  // settlement plus 0.105 because the 96.75 KD piece fell under the minimum.
  // Only that explanation reproduces the figure to three decimals.
  perExecution: true,
  // ABOLISHED 1 OCTOBER 2026. Every threshold resting on "3.4 KD round trip"
  // must be re-derived on that date.
  settlementAbolishedFrom: '2026-10-01',
};

const GATES = {
  // G1 · the only structural gate. Below 100 fils the exchange tick is 0.1:
  // 14 of 14 below, 114 of 114 above. One tick pays ~1.1 KD against 3.4 in
  // commission — a guaranteed loss at any budget.
  priceFloorFils: 100,
  // 3.5, not 3.4. Round-trip commission runs 3.34-3.40 and RISES with
  // notional, so a constant with no headroom drifts wrong in the direction
  // that matters. 3.5 makes the ceiling 200 at 800 KD, matching the spec table.
  ceilingCommissionKd: 3.5,

  netFloorKd: 0.5,                 // G2
  minAvgTradeShares: 3000,         // G3
  minPriceMoves: 15,               // G4 — moves, never a trade count
  minPriceMoves2plus: 3,           // G4 at a 2-tick target
  maxPctMovesSub100: 20,           // G5
  minPctPostable: 20,              // G6 — % OF THE SESSION, never a median
  minPctExitableRatio: 70,         // G7 — offer <= 2x bid
  minPctExitableForSize: 60,       // G7 — offer <= 3x my shares
  distVolumeRatio: 2.0,            // G8 — BOTH, or neither
  distFlowRatio: 1.3,
  minDaysActive5d: 3,              // G9
  consistencyWindow: 5,
  queueBandPct: [5, 30],
};

// CR-35 · direction. WARN, NEVER BLOCK.
//
// A stock that fell yesterday is 44% to rise today — a coin flip. And the four
// bad picks that raised this each failed a gate that ALREADY EXISTS: 11 moves,
// 5% exitable, 35% painted. Direction correlated with the real failures rather
// than causing them.
const DIRECTION = {
  mode: 'warn',                    // 'warn' | 'block' — flip only on the log
  warnChange5dFils: 0,
  warnChange1dFils: -2,
  logForSessions: 20,
};

// CR-34 · depth signal. INFORMS the alert and the AI. GATES NOTHING until a
// second symbol confirms.
const DEPTH = {
  // Thresholds scale with the stock — one symbol's 300,000 is ~8% of a level
  // on a 5M-share day and means nothing elsewhere. These are the fallbacks.
  deepBidShares: 300000,
  thinBidShares: 20000,
  thinOfferShares: 30000,
  wallOfferShares: 200000,
  deepBidPctOfVolume: 0.08,
  thinBidPctOfVolume: 0.005,
  // A depth-direction claim with fewer than this many snapshots is REFUSED.
  // An earlier reading of nine minutes concluded the OPPOSITE — five
  // observations inside a falling stretch, and the sign inverted.
  minSnapshots: 100,
  gatesNothing: true,
};

// CR-32 · entry window alert. Ten windows in a session, 3.3 minutes each,
// and manual checking every ten minutes caught none of them.
const ALERT = {
  offerSharesMultiple: 5,          // offer_qty <= 5 x my shares
  maxEstFillMins: 15,
  cooldownMinutes: 3,
  audible: true,
};

const EXIT = {
  // R-41 · the exit target IS the rule (FLOW step 7): +2 fils normally, +6 on
  // a trending day. The prototype's trailing-offer arithmetic (armAtTicks,
  // trailTicks) is gone — a trailing exit was never the rule and it competed
  // with the target on the card.
  targetNormalTicks: 2,            // +2 fils, the standing target — A1: now the kb row exit_target_normal_fils (this is the fallback default)
  targetTrendingTicks: 6,          // +6 fils when the day is trending (RISK ON) — A1: kb row exit_target_trending_fils, stays 6
  // A1 · when no target is hit, hold to flat_by_hhmm (12:45) rather than taking
  // the first profitable tick. The kb row exit_hold_to_flat overrides this.
  holdToFlatBy: true,
  stepDownAtClock: '11:00',        // three findings; drift turns negative at noon
  hardExitAtClock: '12:30',        // the WARNING; the flat-by RULE is 12:45 (kb_threshold flat_by_hhmm)
  neverCarryOvernight: true,
  maxFillEstMins: 30,
  warnFillEstMins: 15,
  maxRepositions: 1,
};

const QUALITY = {
  minCapturePct: 90,               // below this a row is PARTIAL
  refuseBelowPct: 70,              // below this the queue gates cannot compute
  sessionMinutes: 240,
  captureIntervalSecs: 33,         // INFERRED from ~442 ticks. Confirm the scraper.
  minMarketCoverageRatio: 0.80,
  throttleGapMultiple: 1.5,        // 60s tab throttle shows as 74-94s gaps
  baselineDays: 20,
  fillPaceWindowMins: 15,          // 1 minute is noise in BOTH directions
};

// Only G1 and G8 rest on more than a handful of observations.
const EVIDENCE = {
  g1Floor:   { basis: '128/128 stocks, one day', strength: 'strong' },
  g1Ceiling: { basis: 'arithmetic', strength: 'exact' },
  g2:        { basis: 'keeps the only 4-fill stock', strength: 'judgement' },
  g3:        { basis: 'one clear failure', strength: 'weak' },
  g4:        { basis: '25 moves gave 4 fills, once', strength: 'weak' },
  g5:        { basis: 'one extreme case — 28 shares', strength: 'judgement' },
  g6:        { basis: 'one session', strength: 'weak' },
  g7:        { basis: 'one case, −24 KD', strength: 'weak' },
  g8:        { basis: '83 spike-days market-wide', strength: 'moderate' },
  g9:        { basis: 'three one-day-flash failures', strength: 'judgement' },
  g10:       { basis: 'five stocks, one evening', strength: 'weak — WARN ONLY' },
  depth:     { basis: '418 snapshots, ONE symbol, ONE session', strength: 'weak — GATES NOTHING' },
};

module.exports = {
  SESSION, BUDGET, COMMISSION, GATES, DIRECTION, DEPTH, ALERT, EXIT, QUALITY, EVIDENCE,
};
