'use strict';
/**
 * ============================================================================
 *  api/holdFacts.js — F6 · the facts you watch while you hold, in one block
 * ============================================================================
 * The reference's hold block: MARK · BID PROTECTED · EXIT AT · VOLUME ·
 * CEILING · REFILL · EXIT OK. Every one of these already exists somewhere on
 * the detail bundle (the contract, the ladder's markers, the sizing basis,
 * the candidate's metrics, kb_threshold); this assembles them into one
 * object so the page renders a grid instead of hunting. NO NEW ARITHMETIC
 * beyond a comparison against a threshold the server already holds, and
 * every fact has `computed:false` + a reason when its number is not known —
 * "—" on the page, never a zero that reads as a measurement (SPR-38).
 *
 * REFILL is not measured yet (it needs per-level change tracking across
 * captures — the F8 markers) and says so rather than guessing.
 * ============================================================================
 */
const nc = (reason) => ({ computed: false, reason });
const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * @param {object} p
 * @param {object|null} p.contract   the presented TradingContract (holding/carried) or null
 * @param {object|null} p.book       the presented OrderBook (with ladder markers) or null
 * @param {object|null} p.sizing     the sizing view (basis.*) or null / {error}
 * @param {object|null} p.candidate  the presented StockCandidate or null
 * @param {object}      p.thresholds kb thresholds (no_protection_qty, exit_depth_max_x)
 * @param {number|null} p.yourShares the lot-rounded size the ladder's % uses
 */
function holdFacts({ contract, book, sizing, candidate, thresholds = {}, yourShares = null }) {
  const held = contract && contract.state !== 'picked' ? Number(contract.shares) : null;
  const shares = held ?? (yourShares != null ? Number(yourShares) : null);

  // MARK · the bid and what the position is worth against the entry.
  const mark = contract && contract.state !== 'picked'
    ? (contract.bid == null
      ? nc('no quote today — the position is marked at entry, not at a bid')
      : { computed: true, bidFils: contract.bid, entryFils: contract.entry, unrealisedKd: contract.unrealisedKd, markedAt: contract.quoteAt || null })
    : nc('no open position');

  // BID PROTECTED · the touch bid's size against the no-protection threshold,
  // and whether an AGED level sits beneath the entry (the stop's shelf).
  const noProt = Number(thresholds.no_protection_qty ?? 20000);
  const touch = book ? (book.bids || [])[0] : null;
  const bidProtected = !book || !touch
    ? nc('no depth captured for this symbol today')
    : {
      computed: true, qty: Number(touch.qty), thresholdQty: noProt,
      protectedNow: Number(touch.qty) >= noProt,
      agedBelow: (book.bids || []).some((l) => l.aged && (contract?.entry == null || Number(l.price) <= Number(contract.entry))),
      note: (touch.markers || []).some((m) => m.event === 'NOPROT') ? 'nothing beneath — the touch is thin'
        : Number(touch.qty) >= noProt ? `${fmt(touch.qty)} at the touch` : `${fmt(touch.qty)} at the touch — under ${fmt(noProt)}`,
    };

  // EXIT AT · the rule's targets and the break-even, from the contract.
  const exitAt = contract && contract.state !== 'picked' && contract.targetNormal != null
    ? { computed: true, targetNormal: contract.targetNormal, targetTrending: contract.targetTrending, breakEven: contract.breakEvenPrice, stopFils: contract.stopFils ?? null }
    : nc('no open position');

  // VOLUME · the candidate's spike ratio (today vs the 20-day, stats:daily).
  const vol = candidate?.metrics?.volSpikeRatio;
  const volume = vol == null
    ? nc(candidate ? 'volume ratio not computed for this symbol (stats:daily)' : 'no card on today\'s board')
    : { computed: true, ratio: Number(vol), note: `${Number(vol).toFixed(2)}× the 20-day volume` };

  // CEILING · an offer level the ladder marked CEILING (present most of the session).
  const ceilRow = book ? (book.offers || []).find((l) => (l.markers || []).some((m) => m.event === 'CEILING')) : null;
  const ceiling = !book
    ? nc('no depth captured for this symbol today')
    : ceilRow
      ? { computed: true, priceFils: Number(ceilRow.price), qty: Number(ceilRow.qty), presencePct: ceilRow.presencePct ?? null,
          note: `${ceilRow.price} × ${fmt(ceilRow.qty)}${ceilRow.presencePct != null ? ` — present ${ceilRow.presencePct}% of the session` : ''}` }
      : { computed: true, priceFils: null, qty: null, presencePct: null, note: 'no offer wall has held most of the session' };

  // REFILL · not measured: needs per-level change tracking across captures.
  const refill = nc('not measured — the bid-rebuild count needs per-level change tracking (F8)');

  // EXIT OK · KB gate 12: the offer at the touch should be NO MORE than
  // exit_depth_max_x times your size — a bigger offer means you queue behind
  // it to get out ("100,000 at your exit means you do not get out", FLOW 7).
  const maxX = Number(thresholds.exit_depth_max_x ?? 3);
  const offerQty = book?.offers?.length ? Number(book.offers[0].qty) : (sizing?.basis?.offer_qty ?? null);
  const exitOk = shares == null || !shares
    ? nc('no size to compare the exit depth against')
    : offerQty == null
      ? nc('no offer depth captured')
      : { computed: true, offerQty: Number(offerQty), yourShares: shares, multiple: Number((Number(offerQty) / shares).toFixed(2)),
          thresholdX: maxX, ok: Number(offerQty) / shares <= maxX,
          note: `offer ${fmt(offerQty)} = ${(Number(offerQty) / shares).toFixed(1)}× your ${fmt(shares)}${Number(offerQty) / shares <= maxX ? ' — clears' : ` — over ${maxX}×, you queue behind it`}` };

  return { mark, bidProtected, exitAt, volume, ceiling, refill, exitOk };
}

module.exports = { holdFacts };
