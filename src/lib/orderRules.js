'use strict';
/**
 * ============================================================================
 *  orderRules.js — the rules that stop money being lost
 * ============================================================================
 * PURE. The funnel decides WHAT to trade; this decides whether an ORDER is
 * allowed.
 *
 * Nine gates were built before any of this existed, and the record says that
 * was the wrong order of work:
 *
 *   9 Aug   KFIC   exits taken as posted      +2.95
 *   10 Aug  KFIC   exits moved down 3 times  -19.52
 *   11 Aug  CATTL  exit taken as posted       +2.10
 *
 * Same stock on the 9th and 10th, same entries, same size. A 22 KD swing from
 * one behaviour — larger than any screening improvement in three weeks.
 * ============================================================================
 */

const COMMISSION = require('./commission');
const { EXIT } = require('../config/spread.config');

/*
 * D3 · A SELL IS NEVER AMENDED BELOW COST.
 *
 * The 10 August sequence:
 *   09:09:20  cancelled sell 179 -> sold 178   flat
 *   09:49:09  cancelled sell 179 -> sold 177   -1 fil
 *   11:24:08  cancelled sell 178 -> sold 175   -1 fil
 *
 * Each amendment felt like realism. Together they were -19.52.
 *
 * Moving a sell CLOSER while staying above cost is allowed — that is D5. What
 * is refused is crossing below what you paid.
 *
 * Note the interaction with the trailing exit: a trail moves the offer UP only,
 * and D3 forbids it moving DOWN. The same constraint from opposite directions,
 * which is why the trail becomes safe once this ships.
 */
function checkSellAmend({ newPriceFils, avgCostFils, currentPriceFils, shares = 0,
                          commissionKd = 0 }) {
  const px = Number(newPriceFils);
  const cost = Number(avgCostFils);
  if (!Number.isFinite(px) || !Number.isFinite(cost)) {
    return { allowed: false, code: 'BAD_INPUT', message: 'price and average cost are required' };
  }

  if (px < cost) {
    const lossKd = shares ? ((px - cost) * shares) / 1000 - commissionKd : null;
    return {
      allowed: false, code: 'BELOW_COST', floorFils: cost,
      message: `A sell cannot be amended below cost. You paid ${cost}; ` +
               `${px} is ${(cost - px).toFixed(1)} fil${cost - px === 1 ? '' : 's'} below it` +
               (lossKd != null ? `, locking in ${lossKd.toFixed(2)} KD.` : '.') +
               ' Moving a sell down three times on 10 August cost 19.52 KD.',
    };
  }

  const breakEven = shares > 0 ? cost + (commissionKd * 1000) / shares : cost;
  if (px < breakEven) {
    return {
      allowed: true, code: 'BELOW_BREAKEVEN', floorFils: cost,
      breakEvenFils: Math.ceil(breakEven),
      warning: `${px} is above your cost of ${cost} but below break-even ` +
               `${Math.ceil(breakEven)} — the trip nets ` +
               `${(((px - cost) * shares) / 1000 - commissionKd).toFixed(2)} KD after commission.`,
    };
  }

  const movedDown = currentPriceFils != null && px < Number(currentPriceFils);
  return {
    allowed: true, code: movedDown ? 'MOVED_CLOSER' : 'OK',
    floorFils: cost, breakEvenFils: Math.ceil(breakEven),
    // D5 — moving closer is legitimate when the ambitious level will not clear.
    warning: movedDown
      ? `Moving the sell from ${currentPriceFils} to ${px}. Above cost, so allowed — but check ` +
        'the queue at both levels before deciding this is the achievable exit.'
      : null,
  };
}

/*
 * D4 · DO NOT CHASE A RISING STOCK.
 *
 * One order was placed at 168, moved to 170, and the price ran to 173 within
 * two minutes and finished at 172. Never filled. The stock rose 164 to 174
 * while the order followed it up.
 *
 * The count is per symbol per session, because chasing is a SEQUENCE — each
 * individual move looks reasonable.
 */
function checkBuyReposition({ newPriceFils, currentPriceFils, priorUpwardMoves = 0,
                              maxRepositions = EXIT.maxRepositions }) {
  const px = Number(newPriceFils);
  const cur = Number(currentPriceFils);
  if (!Number.isFinite(px) || !Number.isFinite(cur)) return { allowed: true, code: 'OK' };
  if (px <= cur) return { allowed: true, code: 'OK' };   // down or flat is not chasing

  const n = priorUpwardMoves + 1;
  if (n > maxRepositions) {
    return {
      allowed: false, requiresConfirmation: true, code: 'CHASING', upwardMoves: n,
      message: `This is upward move ${n} on this symbol today — ${cur} to ${px}. One order ` +
               'followed a stock from 164 to 174 on 11 August and never filled. Confirm ' +
               'explicitly, or wait for the price to come back.',
    };
  }
  return { allowed: true, code: 'REPOSITION_UP', upwardMoves: n,
    warning: `Moving the buy up from ${cur} to ${px}. That is one chase; a second needs confirmation.` };
}

/*
 * D5 · POST THE ACHIEVABLE EXIT, NOT THE AMBITIOUS ONE.
 *
 * One sell was posted at 130 with 29,889 shares ahead when 129 had 16,100. Ten
 * minutes were lost before the correction, and it then filled within ten.
 *
 * The nearest level ABOVE COST whose queue actually clears — using the live
 * fill estimate, not the queue percentage. D3 sets the floor.
 */
function suggestExitPrice({ avgCostFils, levels = [], sharesPerMin,
                            maxMinutes = EXIT.maxFillEstMins, breakEvenFils }) {
  const floor = Math.max(Number(avgCostFils), Number(breakEvenFils ?? avgCostFils));
  const viable = levels
    .filter((l) => Number(l.priceFils) >= floor)
    .map((l) => ({
      priceFils: Number(l.priceFils),
      queueAheadShares: Number(l.queueAheadShares),
      estFillMins: sharesPerMin > 0 ? Number(l.queueAheadShares) / sharesPerMin : Infinity,
    }))
    .sort((a, b) => a.priceFils - b.priceFils);

  if (!viable.length) return null;

  // The LOWEST viable level that clears in time — not the highest price. The
  // ambitious level is the one that does not fill.
  const clears = viable.find((l) => l.estFillMins <= maxMinutes);
  const best = clears || viable[0];

  return {
    priceFils: best.priceFils,
    queueAheadShares: best.queueAheadShares,
    estFillMins: Number.isFinite(best.estFillMins) ? Number(best.estFillMins.toFixed(1)) : null,
    floorFils: floor,
    alternatives: viable.slice(0, 4),
    why: clears
      ? `${best.queueAheadShares.toLocaleString('en-US')} ahead, clearing in about ${Math.round(best.estFillMins)} minutes`
      : `no level above cost clears within ${maxMinutes} minutes — the exit is the problem, not the entry`,
  };
}

/*
 * I4 · ONE POSITION AT A TIME, FULL SIZE.
 *
 * 2 x 400 KD earned +0.02; 1 x 850 KD earned +1.16. The settlement fee is per
 * ORDER, so two positions means four orders and 1.00 KD of extra fee on a
 * strategy whose whole edge is 1-3 KD a trip.
 */
/*
 * R-13 · the slot and the fee band are not a rule in a string literal
 * (BACKEND_spec §11). The caller supplies `slotKd` (from the gate store) and the
 * two computed round-trip fees (from commission.js), so the message names the
 * live numbers and the sentence survives the 1 October commission change.
 */
function checkNewPosition({ openPositions = 0, maxPositions = 1, slotKd = null, feeSingleKd = null, feeSplitKd = null }) {
  if (openPositions >= maxPositions) {
    const cost = (slotKd != null && feeSingleKd != null && feeSplitKd != null)
      ? `Splitting ${Math.round(slotKd)} KD into two halves raises commission from `
        + `${feeSingleKd.toFixed(2)} to ${feeSplitKd.toFixed(2)} — the settlement fee is per order. `
      : 'A second position doubles the order count, and the settlement fee is per order. ';
    return { allowed: false, code: 'POSITION_LIMIT',
      message: `${openPositions} position${openPositions === 1 ? ' is' : 's are'} already open `
               + `and the limit is ${maxPositions}. ${cost}Close the open position first.` };
  }
  return { allowed: true, code: 'OK' };
}

/*
 * E5 · IS MY RESTING ORDER STILL WHERE I PUT IT?
 *
 * The largest single loss in the record, and it is one comparison.
 *
 *   09:51  book 238/239, buy placed at 238        CORRECT WHEN PLACED
 *   09:56  book moves to 239/240                  now one level BELOW the bid
 *   10:10  filled at 238 as price fell through    -44.94
 *
 * No placement rule prevents this — the order obeyed every rule at 09:51. What
 * is needed is a check that runs AFTER placement, comparing where the order
 * sits against where the book has moved to.
 */
function checkStranded({ side, orderPriceFils, bidFils, offerFils,
                         queueAheadShares, minutesResting = 0 }) {
  const px = Number(orderPriceFils);
  const bid = Number(bidFils);
  const offer = Number(offerFils);
  if (!Number.isFinite(px) || !Number.isFinite(bid)) return { stranded: false, code: 'NO_BOOK' };

  const isBuy = String(side).toUpperCase() === 'BUY';

  if (isBuy) {
    if (px < bid) {
      const levels = Math.round(bid - px);
      return {
        stranded: true, code: 'BELOW_BID', levels, severity: 'danger',
        message: `Your buy at ${px} is ${levels} level${levels === 1 ? '' : 's'} below the bid ` +
                 `at ${bid}` +
                 (queueAheadShares ? ` — ${Number(queueAheadShares).toLocaleString('en-US')} shares ahead` : '') +
                 '. The only way this fills is price falling onto it. This is the 29 July ' +
                 'setup, which cost 44.94 KD.',
        // No price. The engine owns that; this names the situation.
        options: ['cancel and repost at the bid', 'cancel and stand aside'],
      };
    }
    if (px > bid) {
      const inGap = Number.isFinite(offer) && px < offer;
      return inGap
        ? { stranded: false, code: 'INSIDE_GAP',
            message: `Best bid at ${px}, inside the ${offer - bid}-fil gap.` }
        : { stranded: true, code: 'CROSSING', severity: 'danger',
            message: `Your buy at ${px} is at or above the offer ${offer}. That is crossing the spread.` };
    }
    return { stranded: false, code: 'AT_BID', minutesResting };
  }

  // A resting SELL drifts the other way: the offer moves down and leaves you
  // above the market, where nothing reaches you.
  if (Number.isFinite(offer) && px > offer) {
    const levels = Math.round(px - offer);
    return {
      stranded: true, code: 'ABOVE_OFFER', levels, severity: 'warn',
      message: `Your sell at ${px} is ${levels} level${levels === 1 ? '' : 's'} above the offer ` +
               `at ${offer}` +
               (minutesResting ? `, resting ${Math.round(minutesResting)} minutes` : '') +
               '. Nothing reaches it until the offer comes back up.',
      // D3 still binds: any correction stays above cost.
      options: ['leave it and wait', 'move it closer, but never below cost'],
    };
  }
  return { stranded: false, code: px === offer ? 'AT_OFFER' : 'INSIDE_SPREAD', minutesResting };
}

/*
 * I2 · THE SELL IS POSTED ON FILL, IN THE SAME MINUTE.
 *
 * The most expensive silence in the record. A position was up 11.40 KD, the
 * exit was named twice, and it closed -31 because the sell was never posted
 * while the price was there.
 */
function checkSellPosted({ buyFilledAt, sellPostedAt, now = new Date() }) {
  if (!buyFilledAt) return { ok: true, code: 'NO_FILL' };

  if (sellPostedAt) {
    const gapMin = (new Date(sellPostedAt) - new Date(buyFilledAt)) / 60000;
    return { ok: gapMin <= 1, code: gapMin <= 1 ? 'OK' : 'LATE',
      gapMinutes: Number(gapMin.toFixed(1)),
      warning: gapMin > 1
        ? `The sell went out ${Math.round(gapMin)} minutes after the fill, not the same minute.` : null };
  }

  const heldMin = (now - new Date(buyFilledAt)) / 60000;
  return {
    ok: false, code: 'NOT_POSTED', heldMinutes: Math.round(heldMin),
    severity: heldMin > 15 ? 'danger' : 'warn',
    message: `Filled ${Math.round(heldMin)} minute${Math.round(heldMin) === 1 ? '' : 's'} ago ` +
             'with no sell posted. On 5 August a position was up 11.40 KD, the exit was named ' +
             'twice, and it closed −31 because the sell was never posted while the price was there.',
  };
}

/* I8 · No overnight carry — prompt to flatten at the hard exit hour. */
function checkHardExit({ hasPosition, now = new Date(), hardExitAt = EXIT.hardExitAtClock }) {
  if (!hasPosition) return { due: false };
  const k = new Date(now.getTime() + 3 * 3600000);
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  const [h, m] = hardExitAt.split(':').map(Number);
  const left = h * 60 + (m || 0) - mins;

  if (left > 0) return { due: false, minutesLeft: left };
  return { due: true, minutesLate: -left,
    message: `${hardExitAt} — flatten now, be flat by 12:45 (not into the auction). Never carry ` +
             'overnight either — every overnight hold in ten sessions lost money, the worst −44.94 ' +
             'over a weekend. Hit the bid if the offer will not lift; after 12:45 it is too late to trade.' };
}

module.exports = {
  checkSellAmend, checkBuyReposition, suggestExitPrice, checkNewPosition,
  checkStranded, checkSellPosted, checkHardExit,
};
