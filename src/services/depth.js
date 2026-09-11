'use strict';
/**
 * ============================================================================
 *  depth.js — CR-34 · bid-depth direction signal
 * ============================================================================
 * INFORMS THE ALERT AND THE AI. GATES NOTHING.
 *
 * One stock, one session, 418 snapshots:
 *
 *   bid over 300,000   305 snapshots   10 of 11 upward ticks    91% up
 *   bid 50k-150k        34             1 up, 3 down             25%
 *   bid under 50,000    57             0 up, 10 down             0%
 *
 * WHY IT WORKS: a deep bid is buyers who CANNOT GET FILLED. They are queued;
 * the only way in is to raise the price. A thin bid is a level that has just
 * been consumed — nothing is left beneath and the next seller pushes through.
 *
 * "Buyers are piled up" is a BUY signal, not a warning. A 400,000-share bid is
 * 400,000 shares of unsatisfied demand, not resistance to a fall.
 *
 * THE CORRECTION THAT BELONGS IN THE RECORD: an earlier reading of NINE
 * MINUTES of the same session concluded the OPPOSITE. Five observations inside
 * a falling stretch, and the sign inverted. Hence minSnapshots — a
 * depth-direction claim below that sample is REFUSED, here and in the AI layer.
 * ============================================================================
 */

const { pool } = require('../db');
const { DEPTH } = require('../config/spread.config');
const P = require('./phrases');


/**
 * Classify one book snapshot.
 *
 * BLOCKED IS CHECKED FIRST. Deep on both sides is a standoff, not a signal —
 * a 1,030,681-share offer rejected the advance four times in one session.
 */
function classify(book, thresholds = DEPTH) {
  const bid = Number(book.bidShares);
  const offer = Number(book.offerShares);
  const t = {
    deepBid: Number(book.deepBidShares ?? thresholds.deepBidShares),
    thinBid: Number(book.thinBidShares ?? thresholds.thinBidShares),
    thinOffer: Number(book.thinOfferShares ?? thresholds.thinOfferShares),
    wallOffer: Number(book.wallOfferShares ?? thresholds.wallOfferShares),
  };

  if (!Number.isFinite(bid) || !Number.isFinite(offer)) {
    return { signal: 'WAIT', reason: 'no depth' };
  }
  if (offer > t.wallOffer) {
    return { signal: 'BLOCKED',
      reason: `offer ${offer.toLocaleString('en-US')} is a wall overhead — deep on both sides is a ` +
              'standoff, not a signal' };
  }
  if (bid > t.deepBid && offer < t.thinOffer) {
    return { signal: 'BUY',
      reason: `bid ${bid.toLocaleString('en-US')} against an offer of ${offer.toLocaleString('en-US')} — ` +
              'queued buyers who cannot get filled, and little above them' };
  }
  if (bid < t.thinBid) {
    return { signal: 'SELL',
      reason: `bid ${bid.toLocaleString('en-US')} — the level has been consumed and nothing is beneath it` };
  }
  return { signal: 'WAIT', reason: null };
}

/**
 * The live signal for one symbol, with its sample size attached.
 *
 * `sampleSufficient` is FALSE below the threshold and the caller must not act
 * on the direction. It is not a soft warning: five observations produced the
 * opposite conclusion on the same stock.
 */
async function signalFor(symbol, tradingDay, { db = pool, cfg = DEPTH } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();

  // Level 1 is the touch — what the signal reads. captured_at is when the book
  // looked like this; created_at is when the row was written, ~0.3s later.
  /*
   * B-05 · the columns v_depth actually has.
   *
   * v_depth is `SELECT * FROM public.awsat_stock_depth` (010). Its day column
   * is trading_date, not trading_day, and capture_id existed only on the
   * dropped spread.depth. Both raised 42703 on every call; alerts.js swallowed
   * it, /live/depth answered 503, and the AI's depth tool failed — three
   * symptoms, one wrong name.
   */
  const { rows: [snap] } = await db.query(
    `SELECT bid::numeric AS bid_fils, bid_qty::bigint AS bid_shares,
            offer::numeric AS offer_fils, offer_qty::bigint AS offer_shares,
            captured_at AS at
       FROM spread.v_depth
      WHERE symbol = $1 AND trading_date = $2 AND level = 1
      ORDER BY captured_at DESC LIMIT 1;`, [sym, tradingDay]);

  /*
   * COUNT CAPTURES, NOT ROWS.
   *
   * The scraper writes TEN LEVELS per capture, sharing one capture_id. Counting
   * rows overstates the sample TENFOLD — a symbol with 100 rows has 10 real
   * captures, and would pass a check that exists precisely because five
   * observations once inverted the sign.
   *
   * Falls back to counting level-1 rows when capture_id is absent, which is
   * still per-capture rather than per-row.
   */
  // One capture = one captured_at instant carrying ten levels.
  const { rows: [n] } = await db.query(
    `SELECT count(DISTINCT captured_at) AS snapshots, count(*) AS rows
       FROM spread.v_depth
      WHERE symbol = $1 AND trading_date = $2;`, [sym, tradingDay]);

  const { rows: [p] } = await db.query(
    `SELECT deep_bid_shares, thin_bid_shares, thin_offer_shares, wall_offer_shares
       FROM spread.symbol_profile WHERE symbol = $1;`, [sym]);

  const snapshots = Number(n?.snapshots || 0);
  const depthRows = Number(n?.rows || 0);
  const sufficient = snapshots >= cfg.minSnapshots;

  if (!snap) {
    return { symbol: sym, signal: 'WAIT', snapshots, sampleSufficient: false,
      reason: 'no depth captured for this symbol today' };
  }

  const book = {
    bidFils: Number(snap.bid_fils), bidShares: Number(snap.bid_shares),
    offerFils: Number(snap.offer_fils), offerShares: Number(snap.offer_shares),
    // Thresholds SCALE WITH THE STOCK. One symbol's 300,000 is ~8% of a level
    // on a 5M-share day and means nothing elsewhere.
    deepBidShares: p?.deep_bid_shares, thinBidShares: p?.thin_bid_shares,
    thinOfferShares: p?.thin_offer_shares, wallOfferShares: p?.wall_offer_shares,
  };

  const c = classify(book, cfg);

  return {
    symbol: sym, ...book, ...c,
    snapshots, sampleSufficient: sufficient,
    at: snap.at,
    depthRows,
    // The signal is computed either way; ACTING on it needs the sample.
    actionable: sufficient && !cfg.gatesNothing ? true : false,
    note: sufficient ? null
      : `${snapshots} book captures (${depthRows} rows across ten levels) — a depth-direction ` +
        `claim needs ${cfg.minSnapshots} captures. An earlier reading of nine minutes of one ` +
        'session concluded the opposite.',
  };
}

/** Persist a snapshot so the split can be RE-DERIVED rather than asserted. */
async function record(sig, tradingDay, db = pool) {
  const { rows: [r] } = await db.query(
    `INSERT INTO spread.depth_signal
       (trading_day, symbol, bid_fils, bid_shares, offer_fils, offer_shares,
        signal, reason, snapshots_behind, sample_sufficient)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id;`,
    [tradingDay, sig.symbol, sig.bidFils, sig.bidShares, sig.offerFils, sig.offerShares,
     sig.signal, sig.reason, sig.snapshots, sig.sampleSufficient]);
  return r.id;
}

/**
 * VALIDATION. This is what a second symbol has to pass before the signal gates
 * anything, and it runs against stored rows rather than a fresh analysis.
 */
async function validate(symbol, tradingDay, { db = pool } = {}) {
  const { rows } = await db.query(
    `WITH s AS (
       SELECT signal, bid_shares, next_tick_fils, bid_fils
         FROM spread.depth_signal
        WHERE upper(symbol) = upper($1) AND trading_day = $2
          AND next_tick_fils IS NOT NULL
     )
     SELECT CASE
              WHEN bid_shares > 300000 THEN 'over 300k'
              WHEN bid_shares > 150000 THEN '150k-300k'
              WHEN bid_shares >  50000 THEN '50k-150k'
              WHEN bid_shares >  20000 THEN '20k-50k'
              ELSE 'under 20k' END AS band,
            count(*) AS snapshots,
            count(*) FILTER (WHERE next_tick_fils > bid_fils) AS next_up,
            count(*) FILTER (WHERE next_tick_fils < bid_fils) AS next_down
       FROM s GROUP BY band ORDER BY min(bid_shares);`, [symbol, tradingDay]);

  const total = rows.reduce((a, r) => a + Number(r.snapshots), 0);
  return {
    symbol, tradingDay, bands: rows, totalSnapshots: total,
    sufficient: total >= DEPTH.minSnapshots,
    verdict: total < DEPTH.minSnapshots
      ? `${total} snapshots — not enough to state a direction`
      : 'sample sufficient — compare the band split against the original 91%/0%',
  };
}

/**
 * R-26 · the last price MOVE and whether it was PAINTED (FLOW step 4 check 3).
 * The most recent capture whose last_price differs from the prior capture's,
 * with the print size that carried it; painted = that print is under
 * paint_max_shares. A marker beside the BOOK row, never a gate. Null when no
 * move is in the day's history yet.
 */
async function lastMove(symbol, tradingDay, { db = pool, now = null } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const t = await require('../api/sizing').thresholds().catch(() => ({}));
  const paintMax = Number(t.paint_max_shares ?? 100);
  const { rows: [r] } = await db.query(
    `WITH q AS (
       SELECT created_at, last_price::numeric AS px, last_qty::bigint AS qty,
              lag(last_price::numeric) OVER (ORDER BY created_at) AS prev
         FROM public.awsat_market_quotes
        WHERE symbol = upper($1) AND trading_date = $2::date AND last_price IS NOT NULL
          AND ($3::timestamptz IS NULL OR created_at <= $3)
     )
     SELECT px, qty, created_at FROM q
      WHERE prev IS NOT NULL AND px <> prev
      ORDER BY created_at DESC LIMIT 1;`, [sym, tradingDay, now]);
  if (!r) return null;
  const qty = r.qty == null ? null : Number(r.qty);
  return { priceFils: Number(r.px), qty, painted: qty != null && qty < paintMax,
    at: new Date(r.created_at).toISOString(), paintMaxShares: paintMax };
}

module.exports = { classify, signalFor, record, validate, bookAges, stopFor, ladder, lastMove };

/**
 * ── BID AGE, from the capture history (R-23) ────────────────────────────────
 *
 * A bid level ages by PRICE: the bid at 158 is "aged 30m" if 158 has been
 * present in the bid book continuously for 30 minutes. FLOW step 5 sizes from
 * the aged bid (real support, not bait) and stops one fil below the nearest
 * aged level. SHUAIBA on 1 September had no bid at all between 284 and 280; a
 * stop at 283 from the touch would have filled four fils lower.
 *
 * Returns, for the LATEST capture of the day:
 *   bids   [{ price, qty, ageMins, aged, bait }]   deepest-first (touch first)
 *   gaps   [{ from, to, fils }]   adjacent bid levels more than one fil apart
 *   touch  the level-1 bid
 * ageMins is minutes from the FIRST capture in which this price was present in
 * the bid book (any level), walking back only while it stays present — a price
 * that vanished and came back ages from its return.
 */
async function bookAges(symbol, tradingDay, { db = pool, now = null } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const { rows } = await db.query(
    `SELECT captured_at, level, bid::numeric AS bid, bid_qty::bigint AS bid_qty
       FROM spread.v_depth
      WHERE symbol = upper($1) AND trading_date = $2::date AND bid IS NOT NULL
      ORDER BY captured_at, level;`, [sym, tradingDay]);
  if (!rows.length) return { symbol: sym, capturedAt: null, bids: [], gaps: [], touch: null, captures: 0 };

  // Group captures by instant; each is the bid book at that moment.
  const byCapture = new Map();
  for (const r of rows) {
    const k = String(r.captured_at);
    if (!byCapture.has(k)) byCapture.set(k, { at: new Date(r.captured_at), prices: new Map() });
    byCapture.get(k).prices.set(Number(r.bid), Number(r.bid_qty));
  }
  const captures = [...byCapture.values()].sort((a, b) => a.at - b.at);
  const latest = captures[captures.length - 1];
  const nowMs = (now ? new Date(now) : latest.at).getTime();

  // For each price present in the latest book, walk BACK while it stays present.
  const ageMinsOf = (price) => {
    let firstAt = latest.at;
    for (let i = captures.length - 1; i >= 0; i--) {
      if (captures[i].prices.has(price)) firstAt = captures[i].at;
      else break;
    }
    return Math.round((nowMs - firstAt.getTime()) / 60000);
  };

  const t = await require('../api/sizing').thresholds().catch(() => ({}));
  const realMin = Number(t.bid_age_real_minutes ?? 30);
  const baitMin = Number(t.bid_age_bait_minutes ?? 5);
  const baitQty = Number(t.bid_bait_min_qty ?? 100000);

  const prices = [...latest.prices.entries()].map(([price, qty]) => {
    const ageMins = ageMinsOf(price);
    return { price, qty, ageMins, aged: ageMins >= realMin, bait: ageMins < baitMin && qty >= baitQty };
  }).sort((a, b) => b.price - a.price); // touch (highest bid) first

  const gaps = [];
  for (let i = 0; i < prices.length - 1; i++) {
    const fils = Number((prices[i].price - prices[i + 1].price).toFixed(3));
    if (fils > 1) gaps.push({ from: prices[i].price, to: prices[i + 1].price, fils });
  }
  return { symbol: sym, capturedAt: new Date(latest.at).toISOString(), captures: captures.length, bids: prices, gaps, touch: prices[0] || null };
}

/**
 * ── THE STOP (R-22) ─────────────────────────────────────────────────────────
 * One fil below the nearest bid level, at or below `entryFils`, that has aged
 * >= bid_age_real_minutes. Never on a round number (multiple of
 * stop_round_number_fils — the catch bid waits there): step one more fil down
 * and say so. If the ladder shows a gap between the entry and the shelf, warn —
 * the stop may fill lower. No aged shelf below the entry -> no stop, and say
 * why rather than inventing one from the touch.
 */
async function stopFor(symbol, tradingDay, entryFils, { db = pool, now = null } = {}) {
  const t = await require('../api/sizing').thresholds().catch(() => ({}));
  const roundFils = Number(t.stop_round_number_fils ?? 10);
  const book = await bookAges(symbol, tradingDay, { db, now });
  const entry = Number(entryFils);
  const agedBelow = book.bids.filter((b) => b.aged && b.price <= entry).sort((a, b) => b.price - a.price);
  if (!agedBelow.length) {
    return { symbol: book.symbol, stopFils: null, shelfFils: null, capturedAt: book.capturedAt,
      reason: book.captures === 0 ? 'no depth captured for this symbol — no stop can be placed'
        : `no bid level at or below ${entry} has aged ${Number(t.bid_age_real_minutes ?? 30)} minutes — no real shelf to stop under`,
      gap: null };
  }
  const shelf = agedBelow[0];
  let stop = shelf.price - 1;
  let steppedForRound = false;
  // Never on a round number — step one more fil down.
  while (stop > 0 && stop % roundFils === 0) { stop -= 1; steppedForRound = true; }
  // A gap between the entry and the shelf: the stop may fill below itself.
  const gap = book.gaps.find((g) => g.from <= entry && g.to >= shelf.price - g.fils) ||
    book.gaps.find((g) => g.from > shelf.price && g.to < entry) || null;
  const notes = [];
  notes.push(`one fil below the ${shelf.price} shelf (held ${shelf.ageMins}m, ${shelf.qty.toLocaleString('en-US')} shares)`);
  if (steppedForRound) notes.push(`stepped off the round number ${shelf.price - 1}`);
  if (gap) notes.push(`GAP ${gap.from}→${gap.to} in the ladder — the stop may fill ${gap.fils} fil(s) lower`);
  return { symbol: book.symbol, stopFils: stop, shelfFils: shelf.price, shelfAgeMins: shelf.ageMins,
    shelfQty: shelf.qty, capturedAt: book.capturedAt, steppedForRound, gap, reason: notes.join('; ') };
}

/**
 * ── LADDER MARKERS (R-24) ───────────────────────────────────────────────────
 * The markers that turn a ladder into a read, computed DETERMINISTICALLY over
 * the day's capture history for the LATEST book. The label text comes from
 * spread.kb_phrase (services/phrases.js); the DECISION is here. Never a model
 * call — 20 rows every 15 seconds is 80 calls a minute.
 *
 *   BID rows (touch = highest first)
 *     BAIT     younger than bid_age_bait_minutes AND >= bid_bait_min_qty
 *     AGED     held >= bid_age_real_minutes (real support)
 *     NOPROT   the touch, below no_protection_qty — nothing beneath you
 *     CATCH    an AGED bid sitting ON a round number — the operator's chosen price
 *     SHELF    a round-number level that is not a catch bid — where stops cluster
 *   OFFER rows (touch = lowest first)
 *     CEILING  present >= ceiling_presence_pct of the session's captures
 *     UNDERCUT the touch, fresh, sitting below an AGED offer above it — a seller
 *              stepping in front of the established queue ({n} = the price undercut)
 *     SHELF    a round-number offer level
 *
 * F8 · the flow-delta labels (PLACED, PULLED, TRADED, RELOCATED, PARKED,
 * WALKDOWN) are decided in services/ladderFlow.js over the capture history and
 * the session's volume BRACKET (spread.v_quote), and the whole-book banners
 * (DOUBLE WALL from the scraper's symbol_minute.is_frozen, CLOSING BID — an
 * observation — from the previous session's closing bid) ride on `banners`.
 * THIN is not a marker — the exit depth is sizing's warning (KB gate 12).
 *
 * ageMins walks back while a price stays continuously present (same rule as
 * bookAges); presencePct counts every capture the price appears in.
 */
async function ladder(symbol, tradingDay, { db = pool, now = null } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const { rows } = await db.query(
    `SELECT captured_at, level, bid::numeric AS bid, bid_qty::bigint AS bid_qty,
            offer::numeric AS offer, offer_qty::bigint AS offer_qty
       FROM spread.v_depth
      WHERE symbol = upper($1) AND trading_date = $2::date
      ORDER BY captured_at, level;`, [sym, tradingDay]);
  if (!rows.length) return { symbol: sym, capturedAt: null, captures: 0, bids: [], offers: [] };

  const capMap = new Map();
  for (const r of rows) {
    const k = String(r.captured_at);
    if (!capMap.has(k)) capMap.set(k, { at: new Date(r.captured_at), bid: new Map(), offer: new Map() });
    const c = capMap.get(k);
    if (r.bid != null) c.bid.set(Number(r.bid), Number(r.bid_qty));
    if (r.offer != null) c.offer.set(Number(r.offer), Number(r.offer_qty));
  }
  const captures = [...capMap.values()].sort((a, b) => a.at - b.at);
  const latest = captures[captures.length - 1];
  const nowMs = (now ? new Date(now) : latest.at).getTime();
  const totalCaps = captures.length;

  const t = await require('../api/sizing').thresholds().catch(() => ({}));
  const realMin = Number(t.bid_age_real_minutes ?? 30);
  const baitMin = Number(t.bid_age_bait_minutes ?? 5);
  const baitQty = Number(t.bid_bait_min_qty ?? 100000);
  const roundFils = Number(t.stop_round_number_fils ?? 10);
  const noProtQty = Number(t.no_protection_qty ?? 20000);
  const ceilingPct = Number(t.ceiling_presence_pct ?? 75);

  const ageMinsOf = (side, price) => {
    let firstAt = latest.at;
    for (let i = captures.length - 1; i >= 0; i--) {
      if (captures[i][side].has(price)) firstAt = captures[i].at; else break;
    }
    return Math.round((nowMs - firstAt.getTime()) / 60000);
  };
  const presencePctOf = (side, price) => {
    let seen = 0;
    for (const c of captures) if (c[side].has(price)) seen += 1;
    return totalCaps ? Math.round((100 * seen) / totalCaps) : 0;
  };
  const isRound = (price) => roundFils > 0 && price % roundFils === 0;
  const fmt = (q) => Number(q).toLocaleString('en-US');

  // F8 · the session's cumulative volume series, for the flow markers. A
  // failure here leaves the series empty: the flow markers are then simply
  // not computed (never guessed), the age markers still render.
  const flow = require('./ladderFlow');
  const { rows: volRows } = await db.query(
    `SELECT created_at AS at, volume FROM spread.v_quote
      WHERE symbol = upper($1) AND trading_date = $2::date AND volume IS NOT NULL
      ORDER BY created_at;`, [sym, tradingDay]).catch(() => ({ rows: [] }));
  const volumes = volRows.map((r) => ({ at: new Date(r.at), volume: Number(r.volume) }));
  const fm = flow.flowMarkers(captures, volumes, t);
  const parked = flow.parkedBids(captures, t);
  const walkdown = flow.walkdownSteps(captures, volumes, t);
  // A marker may name a phrase KEY other than its event (PLACED while trading
  // reads PLACED_TRADING); the event stays the machine-readable one.
  const flowMarks = (side, price) => ((side === 'bid' ? fm.bids : fm.offers).get(price) || [])
    .map((m) => (m.key ? { event: m.event, text: P.render(m.key, { n: m.n, p: m.p }) } : P.marker(m.event, { n: m.n, p: m.p })));

  const bids = [...latest.bid.entries()].map(([price, qty]) => ({ price, qty }))
    .sort((a, b) => b.price - a.price)
    .map((row, i) => {
      const ageMins = ageMinsOf('bid', row.price);
      const aged = ageMins >= realMin;
      const bait = ageMins < baitMin && row.qty >= baitQty;
      const markers = [];
      if (bait) markers.push(P.marker('BAIT', { n: ageMins }));
      if (aged) markers.push(P.marker('AGED', { n: ageMins }));
      if (i === 0 && row.qty < noProtQty) markers.push(P.marker('NOPROT', { n: fmt(row.qty) }));
      if (isRound(row.price)) markers.push(aged ? P.marker('CATCH') : P.marker('SHELF'));
      if (parked.has(row.price)) markers.push(P.marker('PARKED', { n: parked.get(row.price) }));
      markers.push(...flowMarks('bid', row.price));
      return { price: row.price, qty: row.qty, ageMins, aged, bait, markers };
    });

  const offerAges = [...latest.offer.entries()].map(([price, qty]) => ({ price, qty }))
    .sort((a, b) => a.price - b.price)
    .map((row) => ({ ...row, ageMins: ageMinsOf('offer', row.price), presencePct: presencePctOf('offer', row.price) }));
  const offers = offerAges.map((row, i) => {
    const aged = row.ageMins >= realMin;
    const markers = [];
    if (row.presencePct >= ceilingPct) markers.push(P.marker('CEILING', { n: row.presencePct }));
    if (i === 0 && !aged) {
      const agedAbove = offerAges.find((o, j) => j > 0 && o.ageMins >= realMin && o.price > row.price);
      if (agedAbove) markers.push(P.marker('UNDERCUT', { n: agedAbove.price }));
    }
    if (isRound(row.price)) markers.push(P.marker('SHELF'));
    if (i === 0 && walkdown) markers.push(P.marker('WALKDOWN', { n: walkdown }));
    markers.push(...flowMarks('offer', row.price));
    return { price: row.price, qty: row.qty, ageMins: row.ageMins, aged, presencePct: row.presencePct, markers };
  });

  // F8 · the whole-book banners.
  const banners = [];
  // DOUBLE WALL · the scraper's own verdict (writeSymbolMinute: both touches
  // big and volume_delta 0), never re-derived here — and only when its LAST
  // rows are all frozen and the newest is within two minutes of this capture:
  // one 30 s tick, or a row from an hour ago (the symbol dropped from the
  // slots), is not "nothing trading".
  const { rows: smRows } = await db.query(
    `SELECT is_frozen, bid_qty, offer_qty, ts FROM public.symbol_minute
      WHERE symbol = upper($1) AND trading_date = $2::date
      ORDER BY ts DESC LIMIT 3;`, [sym, tradingDay]).catch(() => ({ rows: [] }));
  if (smRows.length >= 2 && smRows.every((r) => r.is_frozen === true)
      && Math.abs(latest.at.getTime() - new Date(smRows[0].ts).getTime()) <= 120000) {
    banners.push({ type: 'DOUBLE WALL', text: `both sides walled — ${fmt(smRows[0].bid_qty)} bid, ${fmt(smRows[0].offer_qty)} offered, nothing trading` });
  }
  // CLOSING BID (an observation) · the immediately preceding session's closing
  // touch bid — a capture after hard_exit (12:30) on the last day with captures,
  // within a week — against today's first capture. Two queries: the day first
  // (an equality is pushed below v_depth's DISTINCT; `<` is not — 038), then
  // that day's last touch.
  const { rows: [pd] } = await db.query(
    `SELECT max(trading_date) AS day FROM spread.v_depth
      WHERE symbol = upper($1) AND trading_date < $2::date AND trading_date >= $2::date - interval '7 days';`,
    [sym, tradingDay]).catch(() => ({ rows: [] }));
  if (pd && pd.day) {
    const prevDay = require('../lib/day').toDay(pd.day);
    const { rows: [pc] } = await db.query(
      `SELECT bid::numeric AS price, bid_qty::bigint AS qty, captured_at
         FROM spread.v_depth
        WHERE symbol = upper($1) AND trading_date = $2::date AND level = 1 AND bid IS NOT NULL
        ORDER BY captured_at DESC LIMIT 1;`, [sym, prevDay]).catch(() => ({ rows: [] }));
    const sess = require('../lib/session');
    if (pc && sess.kuwait(pc.captured_at).mins >= sess.get().hardExitAt) {
      const first = captures[0];
      const cb = flow.closingBid({ price: Number(pc.price), qty: Number(pc.qty), at: pc.captured_at, day: prevDay },
        { bid: first.bid, at: first.at }, flow.volumeAt(volumes, first.at), t);
      if (cb) banners.push(cb);
    }
  }

  return { symbol: sym, capturedAt: new Date(latest.at).toISOString(), captures: totalCaps, bids, offers,
    banners, flowNotes: fm.notes,
    // The traded-volume bracket between the last two captures: {min, max}, or
    // null when unknown (no reading on both sides) — then no flow marker was claimed.
    traded: fm.traded, volumeDelta: fm.traded ? fm.traded.max : null };
}

