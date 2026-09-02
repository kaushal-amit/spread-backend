'use strict';
/**
 * ============================================================================
 *  pricing.js — AT WHAT PRICE
 * ============================================================================
 *   screening.js   WHICH stock      the gates, ranking, sections
 *   pricing.js     AT WHAT PRICE    entry, exit, size, queue
 *   commission.js  WHAT IT COSTS    fees only
 *
 * THE ONLY MODULE THAT MAY RETURN A PRICE OR A SHARE COUNT — never the AI,
 * never a screening module, never inline.
 *
 * NO PRICE IS A VALID ANSWER. Both suggest functions may return `refusal` with
 * a null price. A module that always produces a number will produce one on the
 * days it should have declined.
 * ============================================================================
 */

const COMMISSION = require('./commission');
const { BUDGET, GATES, EXIT } = require('../config/spread.config');

/** Round DOWN to a lot. Never to nearest — rounding up oversizes the order. */
function sharesFor(budgetKd, priceFils, lot = BUDGET.lotSize) {
  if (!(budgetKd > 0) || !(priceFils > 0)) return 0;
  return Math.floor((budgetKd * 1000) / priceFils / lot) * lot;
}

/**
 * Queue share as a SHARE-COUNT ratio: 100 * shares / bid_shares.
 *
 * Computing it from KD value is identical only when the order price equals the
 * bid, and diverges ~0.8% when posting inside a gap — which CR-13 means we do
 * often. One formula, expressed once.
 */
function queueSharePct(shares, bidShares) {
  const q = Number(bidShares);
  return q > 0 ? Number(((100 * Number(shares)) / q).toFixed(2)) : null;
}

/**
 * Minutes to fill at the last 15 minutes' pace.
 *
 * The window is 15 because ONE MINUTE IS NOISE IN BOTH DIRECTIONS. Against the
 * same queue of 410,846, at the same moment: a dead minute read "never", a
 * minute containing a block print read "2 min", fifteen minutes read 24.
 * The middle reading is the trap.
 */
function estFillMins(queueAhead, sharesPerMin) {
  if (!(sharesPerMin > 0)) return null;
  return Number((Number(queueAhead) / sharesPerMin).toFixed(1));
}

/** COLOUR BY MINUTES, NOT PERCENTAGE. 1.2% on a fast tape is fine; 20% on a dead one is not. */
function fillState(minutes) {
  if (minutes == null) return 'block';
  if (minutes > EXIT.maxFillEstMins) return 'block';
  if (minutes > EXIT.warnFillEstMins) return 'warn';
  return 'ok';
}

/**
 * Where to buy, and how much.
 *
 * CR-13 · with a spread of 2+ there is room INSIDE: post at bid+1 and nobody
 * is ahead of you. THE GAP DOES NOT PAY MORE — it is the same one-fil capture.
 * It changes whether you FILL: 71,000 shares ahead becomes zero.
 */
function suggestEntry(book = {}, slotKd, targetTicks = 1, opts = {}) {
  const bid = Number(book.bidFils);
  const offer = Number(book.offerFils);
  const refuse = (why) => ({
    priceFils: null, shares: 0, notionalKd: null, queueSharePct: null,
    queueAheadShares: null, placement: null, sizedDownFromKd: null,
    estFillMins: null, fillState: 'block', refusal: why,
  });

  if (!Number.isFinite(bid) || bid <= 0) return refuse('no bid — nothing to post against');
  if (!(slotKd > 0)) return refuse('no buying power');

  const spread = Number.isFinite(offer) ? offer - bid : null;
  const canPostInside = spread != null && spread >= 2;
  const priceFils = canPostInside ? bid + 1 : bid;
  const placement = canPostInside ? 'INSIDE_GAP' : 'AT_BID';

  if (Number.isFinite(offer) && priceFils >= offer) {
    return refuse(`posting at ${priceFils} would cross the offer at ${offer} — never cross the spread`);
  }

  /*
   * A 2-tick target must NOT be entered by joining a 1-fil queue. Joining and
   * hoping for a 2-fil move is a directional trade, and 131 attempts at
   * direction have failed.
   */
  if (Number(targetTicks) >= 2 && placement === 'AT_BID') {
    return refuse(
      `${targetTicks}-tick target needs a queue-zero entry inside a gap, and the spread is ` +
      `${spread} fil. Joining a 1-fil queue and hoping for a ${targetTicks}-fil move is directional.`);
  }

  // The per-stock ceiling. One stock's max was 775 KD and it was traded at 854
  // — 33% of the bid. Size down, never silently oversize.
  const maxKd = opts.maxBudgetKd == null ? null : Number(opts.maxBudgetKd);
  const capped = maxKd != null && slotKd > maxKd;
  const useKd = capped ? maxKd : slotKd;

  const shares = sharesFor(useKd, priceFils);
  if (shares <= 0) return refuse(`${useKd.toFixed(0)} KD does not buy a lot at ${priceFils}`);

  const queueAhead = placement === 'INSIDE_GAP' ? 0 : Number(book.bidShares ?? 0);
  const mins = estFillMins(queueAhead, book.sharesPerMin);

  return {
    priceFils, shares,
    notionalKd: Number(((shares * priceFils) / 1000).toFixed(3)),
    // Inside a gap nothing is ahead of you; the band then applies to the depth
    // BENEATH you, because that is what you sell back into.
    queueSharePct: placement === 'INSIDE_GAP' ? 0 : queueSharePct(shares, book.bidShares),
    depthSharePct: queueSharePct(shares, book.bidShares),
    queueAheadShares: queueAhead,
    placement,
    sizedDownFromKd: capped ? slotKd : null,
    sizedDownNote: capped
      ? `slot ${slotKd.toFixed(0)} KD exceeds this stock's ceiling of ${maxKd.toFixed(0)} — sized down`
      : null,
    estFillMins: mins,
    fillState: fillState(mins),
    refusal: null,
  };
}

/**
 * Where to sell.
 *
 * D3 IS ENFORCED HERE, AT THE SOURCE — not only at the order form. A module
 * that can return a price below cost will eventually be called by something
 * that does not check, and three such amendments cost 19.52 KD in one session.
 *
 * D5 · the returned price is the NEAREST level above cost whose queue actually
 * clears, not the highest. One sell was posted at 130 with 29,889 ahead when
 * 129 had 16,100; ten minutes were lost before the correction.
 */
function suggestExit(entryFils, targetTicks = 1, book = {}, opts = {}) {
  const entry = Number(entryFils);
  const refuse = (why) => ({ priceFils: null, queueAheadShares: null,
    estFillMins: null, alternatives: [], refusal: why });

  if (!Number.isFinite(entry)) return refuse('no entry price');

  const target = entry + Number(targetTicks || 1);
  const maxMins = opts.maxFillMins ?? EXIT.maxFillEstMins;
  const shares = Number(opts.shares || 0);

  // Break-even, so "above cost" means above the price that clears commission.
  const rt = shares > 0
    ? COMMISSION.roundTripKd((entry * shares) / 1000, (target * shares) / 1000, opts).kd
    : 0;
  const floor = shares > 0 ? entry + Math.ceil((rt * 1000) / shares) : entry;

  const levels = Array.isArray(book.offerLevels) ? book.offerLevels : [];
  if (!levels.length) {
    return { priceFils: Math.max(target, floor), queueAheadShares: null, estFillMins: null,
      alternatives: [], floorFils: floor, targetFils: target, refusal: null,
      note: 'no offer-side depth — target only, queue unknown' };
  }

  const viable = levels
    .map((l) => ({ priceFils: Number(l.priceFils), queueAheadShares: Number(l.queueAheadShares) }))
    .filter((l) => l.priceFils >= floor)                 // D3, at the source
    .map((l) => ({ ...l, estFillMins: estFillMins(l.queueAheadShares, book.sharesPerMin) }))
    .sort((a, b) => a.priceFils - b.priceFils);

  if (!viable.length) {
    return refuse(`no level at or above ${floor} — every offer price is below cost plus commission`);
  }

  const clears = viable.find((l) => l.estFillMins != null && l.estFillMins <= maxMins);
  const best = clears || viable.find((l) => l.priceFils >= target) || viable[0];

  return {
    priceFils: best.priceFils,
    queueAheadShares: best.queueAheadShares,
    estFillMins: best.estFillMins,
    floorFils: floor, targetFils: target,
    alternatives: viable.slice(0, 4),
    refusal: null,
    note: clears
      ? `${best.queueAheadShares.toLocaleString('en-US')} ahead, about ${Math.round(best.estFillMins)} min`
      : `nothing above cost clears within ${maxMins} minutes — the exit is the problem, not the entry`,
  };
}

/**
 * E5 · where a resting order sits relative to the book, RIGHT NOW.
 *
 * The largest single loss in the record, and it is one comparison. An order
 * placed at 238 with the book at 238/239 was CORRECT. Five minutes later the
 * book was 239/240 and the order was one level below the bid behind 59,695
 * shares. Nothing noticed for nineteen minutes; it cost 44.94 KD.
 *
 * No placement rule prevents this. Only a check that runs AFTER placement does.
 */
function positionState(order = {}, book = {}) {
  const px = Number(order.priceFils);
  const bid = Number(book.bidFils);
  const offer = Number(book.offerFils);
  const isBuy = String(order.side || 'BUY').toUpperCase() === 'BUY';

  if (!Number.isFinite(px) || !Number.isFinite(bid)) {
    return { placement: null, filsFromBid: null, stranded: false, reason: 'no book' };
  }
  const filsFromBid = Number((px - bid).toFixed(1));

  if (!isBuy) {
    const filsFromOffer = Number.isFinite(offer) ? Number((px - offer).toFixed(1)) : null;
    return {
      placement: filsFromOffer == null ? 'UNKNOWN'
        : filsFromOffer > 0 ? 'ABOVE_OFFER' : filsFromOffer === 0 ? 'AT_OFFER' : 'INSIDE_SPREAD',
      filsFromBid, filsFromOffer,
      stranded: filsFromOffer != null && filsFromOffer > 0,
    };
  }
  if (filsFromBid < 0) {
    // The only way it fills is price falling onto it — adverse selection by
    // construction. You buy exactly as the market leaves.
    return { placement: 'BELOW_BID', filsFromBid, stranded: true,
      queueAheadShares: Number(book.bidShares ?? 0) };
  }
  if (filsFromBid > 0) {
    const inGap = Number.isFinite(offer) && px < offer;
    return { placement: inGap ? 'INSIDE_GAP' : 'ABOVE_BID', filsFromBid, stranded: !inGap };
  }
  return { placement: 'AT_BID', filsFromBid: 0, stranded: false };
}

module.exports = {
  suggestEntry, suggestExit, positionState,
  sharesFor, queueSharePct, estFillMins, fillState,
};
