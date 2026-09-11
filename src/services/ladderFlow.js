'use strict';
/**
 * ============================================================================
 *  services/ladderFlow.js — F8 · what the size DID between captures
 * ============================================================================
 * The reference's flow markers, each from a measured loss, decided here over
 * the capture history and the session's volume series — deterministic, pure,
 * no model call:
 *
 *   PLACED     a level grew by ≥ flow_change_min_qty between the previous and
 *              the latest capture. Growth is never explained by trading, so
 *              it is PLACED whatever traded; the label says "nothing traded"
 *              only when nothing could have. MRC 210, +70,000 while 2,000
 *              traded.
 *   PULLED     a level shrank by ≥ min while NOTHING traded (the volume
 *              bracket's maximum is 0) — size that was never for sale. MRC
 *              210, −102,151 with 33,094 traded.
 *   TRADED     the levels that shrank, together, shrank by no more than what
 *              CERTAINLY traded (the bracket's minimum) — the prints happened.
 *   (a fall with some trading but not enough to explain it is UNKNOWN: no
 *    marker — the delta is symbol-wide and the print side is not captured)
 *   RELOCATED  a level vanished at A and the same size (±1%) appeared at B on
 *              the same side in ONE capture with nothing traded. MRC 50,000
 *              moved 207→205.
 *   PARKED     a BID present ≥ ceiling_presence_pct of a span of captures at
 *              least bid_age_real_minutes long, with at most
 *              parked_max_changes size changes — an absence counts as a
 *              change (a cancel/replace is the opposite of parked).
 *   WALKDOWN   the touch OFFER has stepped DOWN ≥ walkdown_min_steps distinct
 *              prices, each step (the last capture at the higher price to the
 *              first at the lower) with nothing traded, the last step within
 *              walkdown_max_age_mins of now. ABAR 239→228→226→225.
 *
 * Banners, for the whole book:
 *   DOUBLE WALL  the scraper's own is_frozen (symbol_minute), read from its
 *                last rows within two minutes of the capture — decided
 *                there, never re-derived here.
 *   CLOSING BID  an OBSERVATION, not a verdict (11 Sep: whether resting bids
 *                survive the close is not established): the previous
 *                session's closing touch bid against this session's first
 *                capture, when the previous capture is a real closing one
 *                (after 12:30, the immediately preceding session).
 *
 * THE VOLUME BRACKET. The quotes are captured on their own clock (~60 s) and
 * the depth on its own (~30 s), so a capture pair often straddles ONE quote
 * reading — a point read at each end would say "nothing traded" half the
 * time whatever happened. volumeBracket(from, to) returns what CERTAINLY
 * traded (readings strictly inside the pair) and what could AT MOST have
 * traded (the readings just outside it): "nothing traded" needs max === 0,
 * "it traded" needs min ≥ the fall, and anything in between is unknown —
 * no marker. Without readings on both sides the bracket is unknown too.
 *
 * THE CAPTURE WINDOW. Ten levels a side are captured (depth_levels); when a
 * side is full, a level that slides past the tenth is not "pulled" and one
 * that slides in is not "placed": vanished levels are only judged inside the
 * latest capture's price range, arrivals only inside the previous capture's.
 * A side with fewer levels shows the whole book — nothing slid past.
 *
 * Every threshold is a kb_threshold row (migration 042); the fallbacks are
 * the seeded values.
 * ============================================================================
 */

const fmt = (q) => Number(q).toLocaleString('en-US');

/**
 * What traded between two instants, as a bracket, from a series of
 * {at: Date, volume} ascending cumulative readings.
 *   max  the reading at/after `to` minus the reading at/before `from` —
 *        everything that could have traded in the pair
 *   min  the reading at/before `to` minus the reading at/after `from`, floored
 *        at 0 — what certainly traded strictly inside the pair
 * null when a bounding reading is missing or the counter went down (a reset).
 */
function volumeBracket(series, from, to) {
  const f = new Date(from).getTime(), t = new Date(to).getTime();
  let beforeFrom = null, afterFrom = null, beforeTo = null, afterTo = null;
  for (const q of (series || [])) {
    const qt = q.at.getTime(), v = Number(q.volume);
    if (qt <= f) beforeFrom = v;
    if (qt >= f && afterFrom === null) afterFrom = v;
    if (qt <= t) beforeTo = v;
    if (qt >= t && afterTo === null) { afterTo = v; break; }
  }
  if (beforeFrom === null || afterTo === null) return null;
  const max = afterTo - beforeFrom;
  if (max < 0) return null;
  const min = (afterFrom !== null && beforeTo !== null) ? Math.max(0, beforeTo - afterFrom) : 0;
  return { min: Math.min(min, max), max };
}

/** Cumulative volume at `at`: the last reading at or before it, else null. */
function volumeAt(series, at) {
  const t = new Date(at).getTime();
  let v = null;
  for (const q of (series || [])) { if (q.at.getTime() <= t) v = Number(q.volume); else break; }
  return v;
}

/**
 * Flow markers for the latest capture.
 * @param {Array<{at: Date, bid: Map<number,number>, offer: Map<number,number>}>} captures ascending
 * @param {Array<{at: Date, volume: number}>} volumes ascending cumulative volume readings
 * @param {object} t thresholds
 * @returns {{ bids: Map<number, object[]>, offers: Map<number, object[]>, notes: string[], traded: {min:number,max:number}|null }}
 */
function flowMarkers(captures, volumes, t = {}) {
  const minQty = Number(t.flow_change_min_qty ?? 20000);
  const out = { bids: new Map(), offers: new Map(), notes: [], traded: null };
  if (!captures || captures.length < 2) return out;
  const prev = captures[captures.length - 2], latest = captures[captures.length - 1];
  const br = volumeBracket(volumes, prev.at, latest.at);
  out.traded = br;

  const push = (side, price, m) => {
    const map = side === 'bid' ? out.bids : out.offers;
    if (!map.has(price)) map.set(price, []);
    map.get(price).push(m);
  };
  // The capture window is `depth_levels` a side (10). A capture with fewer
  // levels shows the whole side — nothing slid past its edge.
  const windowLevels = Number(t.depth_levels ?? 10);
  const range = (map, side) => {
    const ps = [...map.keys()];
    if (ps.length < windowLevels) return null;
    return side === 'bid' ? { lo: Math.min(...ps), hi: Infinity } : { lo: -Infinity, hi: Math.max(...ps) };
  };
  const inRange = (r, p) => !r || (p >= r.lo && p <= r.hi);

  for (const side of ['bid', 'offer']) {
    const before = prev[side], after = latest[side];
    // The window: a level outside the other capture's price range slid past
    // the tenth level — not flow.
    const gone = [...before.entries()].filter(([p]) => !after.has(p) && inRange(range(after, side), p));
    const arrived = [...after.entries()].filter(([p]) => !before.has(p) && inRange(range(before, side), p));
    const relocatedTo = new Set(), relocatedFrom = new Set();

    // PLACED · growth is placed whatever traded; the phrase says when nothing could have.
    const placed = (price, d) => push(side, price, br && br.max === 0
      ? { event: 'PLACED', n: fmt(d) }
      : { event: 'PLACED', key: 'PLACED_TRADING', n: fmt(d), p: br ? fmt(br.max) : null });

    if (br && br.max === 0) {
      // RELOCATED · the same size left one price and appeared at another, nothing traded.
      for (const [pFrom, qFrom] of gone) {
        if (qFrom < minQty) continue;
        const hit = arrived.find(([pTo, qTo]) => !relocatedTo.has(pTo) && Math.abs(qTo - qFrom) <= Math.max(1, qFrom * 0.01));
        if (hit) { relocatedTo.add(hit[0]); relocatedFrom.add(pFrom); push(side, hit[0], { event: 'RELOCATED', n: fmt(hit[1]), p: pFrom }); }
      }
    }
    for (const [price, qty] of arrived) {
      if (relocatedTo.has(price)) continue;
      if (qty >= minQty) placed(price, qty);
    }
    // The falls, judged together against the bracket.
    const falls = [];
    for (const [price, qty] of after.entries()) {
      const was = before.get(price);
      if (was == null) continue;
      const d = qty - was;
      if (d >= minQty) placed(price, d);
      else if (-d >= minQty) falls.push({ price, fall: -d });
    }
    if (falls.length && br) {
      const total = falls.reduce((a, f) => a + f.fall, 0);
      if (br.max === 0) for (const f of falls) push(side, f.price, { event: 'PULLED', n: fmt(f.fall) });
      else if (br.min >= total) for (const f of falls) push(side, f.price, { event: 'TRADED', n: fmt(f.fall) });
      // else: some trading, not enough to explain the falls — unknown, nothing claimed
    }
    // Levels that vanished without a relocation: a note (there is no row to mark).
    for (const [price, qty] of gone) {
      if (qty < minQty || relocatedFrom.has(price)) continue;
      if (!br) continue;
      if (br.max === 0) out.notes.push(`${side} ${price} × ${fmt(qty)} gone, nothing traded — pulled`);
      else if (br.min >= qty) out.notes.push(`${side} ${price} × ${fmt(qty)} traded through`);
      // else unknown — nothing said
    }
  }
  return out;
}

/**
 * PARKED · bids present ≥ ceiling_presence_pct of a span of captures at least
 * bid_age_real_minutes long, with ≤ parked_max_changes changes; an absence
 * gap counts as a change. Returns Map price → changes for the parked ones.
 */
function parkedBids(captures, t = {}) {
  const presencePct = Number(t.ceiling_presence_pct ?? 75);
  const maxChanges = Number(t.parked_max_changes ?? 2);
  const minSpanMs = Number(t.bid_age_real_minutes ?? 30) * 60000;
  const out = new Map();
  if (!captures || captures.length < 4) return out;
  const latest = captures[captures.length - 1];
  if (latest.at - captures[0].at < minSpanMs) return out;   // too early in the session to call anything parked
  for (const price of latest.bid.keys()) {
    let seen = 0, changes = 0, last = null, present = false;
    for (const c of captures) {
      const q = c.bid.get(price);
      if (q == null) { if (present) { changes += 1; present = false; } continue; }
      seen += 1;
      if (last != null && q !== last) changes += 1;
      last = q; present = true;
    }
    if ((100 * seen) / captures.length >= presencePct && changes <= maxChanges) out.set(price, changes);
  }
  return out;
}

/**
 * WALKDOWN · the touch offer's distinct prices, latest backwards, strictly
 * descending, each STEP (the last capture at the higher price → the first at
 * the lower) with nothing traded (bracket max 0), the last step within
 * walkdown_max_age_mins of the latest capture. Returns the step count
 * (≥ walkdown_min_steps) or 0.
 */
function walkdownSteps(captures, volumes, t = {}) {
  const minSteps = Number(t.walkdown_min_steps ?? 3);
  const maxAgeMs = Number(t.walkdown_max_age_mins ?? 20) * 60000;
  if (!captures || captures.length < 2) return 0;
  const touch = (c) => (c.offer.size ? Math.min(...c.offer.keys()) : null);
  // distinct touch-offer prices in time order: first and last capture at each
  const seq = [];
  for (const c of captures) {
    const p = touch(c);
    if (p == null) continue;
    if (!seq.length || seq[seq.length - 1].price !== p) seq.push({ price: p, firstAt: c.at, lastAt: c.at });
    else seq[seq.length - 1].lastAt = c.at;
  }
  if (seq.length < 2) return 0;
  const latest = captures[captures.length - 1];
  if (latest.at - seq[seq.length - 1].firstAt > maxAgeMs) return 0;   // the last step is old news
  let steps = 0;
  for (let i = seq.length - 1; i > 0; i--) {
    if (!(seq[i - 1].price > seq[i].price)) break;
    const br = volumeBracket(volumes, seq[i - 1].lastAt, seq[i].firstAt);
    if (!br || br.max !== 0) break;   // unknown or traded: the walk is not clean
    steps += 1;
  }
  return steps >= minSteps ? steps : 0;
}

/**
 * CLOSING BID · an observation (not a verdict): the previous session's
 * closing touch bid against this session's first capture. `prevClose` =
 * {price, qty, at, day}; `firstToday` = {bid: Map, at}; `tradedSince` = today's
 * cumulative volume at the first capture (null = unknown → no line).
 */
function closingBid(prevClose, firstToday, tradedSince, t = {}) {
  const shrinkPct = Number(t.phantom_shrink_pct ?? 90);
  const minQty = Number(t.flow_change_min_qty ?? 20000);
  if (!prevClose || !firstToday || prevClose.qty < minQty) return null;
  if (tradedSince == null || tradedSince > 0) return null;
  const now = firstToday.bid.get(prevClose.price) ?? 0;
  if (now > prevClose.qty * (1 - shrinkPct / 100)) return null;
  return { type: 'CLOSING BID', text: `${fmt(prevClose.qty)} bid at ${prevClose.price} at ${prevClose.day}'s close, ${fmt(now)} at this morning's first capture, nothing traded — an observation: whether resting bids survive the close is not established` };
}

module.exports = { flowMarkers, parkedBids, walkdownSteps, closingBid, volumeAt, volumeBracket };
