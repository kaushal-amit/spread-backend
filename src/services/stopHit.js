'use strict';
/**
 * ============================================================================
 *  services/stopHit.js — F2 · the bid printed through the stop
 * ============================================================================
 * The stop (R-22) is recorded on the BUY leg at the fill and never moves.
 * Until now the terminal printed it and nothing watched it: a bid trading
 * through the stop was silent, and the next thing the trader saw was the
 * loss. The reference's STOP HIT state — "the stop was set before the fill;
 * moving it is how the large losses happened" — is this check plus one alert.
 *
 * `check(day)` reads every open buy whose stop is armed (stop_fils set,
 * stop_hit_at null) against the latest quote OF THE DAY (B-11), marks the leg
 * once (stop_hit_at, the bid that did it in the note) and returns the hits.
 * The row poller calls it every 2 s and emits `spread:alert kind:'stop_hit'`
 * for each; the contract then carries stopHitAt so the detail page shows
 * STOP HIT with HIT THE BID first. There is no auto-sell — hit-bid is the
 * action, as with the time stop (R-21).
 *
 * A symbol with no quote today, or whose latest quote has an empty bid side
 * (0 — a halt, a CB auction), is skipped and named in `notComputed`: no bid
 * is not "the stop held", and it is not a hit either. The quote is the
 * latest CONTINUOUS-trading one (v_quote_screening): a Trading-at-Last
 * print is not judged here — TAL trades at one price and closeVenue closes
 * at it.
 * ============================================================================
 */
const { pool } = require('../db');
const positions = require('../api/positions');

async function check(day, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT l.id, l.symbol, l.contract_seq, l.price_fils, l.stop_fils,
            COALESCE(l.filled_shares, l.shares) AS bought_shares,
            ${positions.REMAINING('l')} AS remaining_shares
       FROM spread.order_leg l
      WHERE ${positions.OPEN_BUY('l')} AND l.stop_fils IS NOT NULL AND l.stop_hit_at IS NULL
      ORDER BY l.symbol;`);
  const hits = [], notComputed = [];
  for (const l of rows) {
    const q = await positions.latestQuote(l.symbol, day, db);
    // No quote, or an EMPTY bid side (0 — a halt, a CB auction, a capture with
    // nothing bid) is not a print through the stop: it is not computed.
    if (!q || q.bid == null || !(Number(q.bid) > 0)) { notComputed.push(l.symbol); continue; }
    const bid = Number(q.bid);
    const stop = Number(l.stop_fils);
    if (bid > stop) continue;
    // Marked ONCE, under the leg's row lock; a second poller pass (or a second
    // process) that lost the race sees stop_hit_at set and says nothing.
    const { rows: [marked] } = await db.query(
      `UPDATE spread.order_leg
          SET stop_hit_at = now(),
              note = concat_ws(' · ', note, $2::text)
        WHERE id = $1 AND stop_hit_at IS NULL
        RETURNING stop_hit_at;`,
      [l.id, `STOP HIT: bid ${bid} at or through the ${stop} stop (quote ${new Date(q.created_at).toISOString()})`]);
    if (!marked) continue;
    const entry = Number(l.price_fils);
    const shares = Number(l.remaining_shares);
    hits.push({
      symbol: l.symbol, seq: Number(l.contract_seq), legId: Number(l.id),
      stopFils: stop, bidFils: bid, entryFils: entry, shares,
      // Gross, at the bid — the fee is the trade's, not this alert's to guess.
      grossKd: Number((((bid - entry) * shares) / 1000).toFixed(3)),
      quoteAt: q.created_at ? new Date(q.created_at).toISOString() : null,
      at: new Date(marked.stop_hit_at).toISOString(),
    });
  }
  return { hits, notComputed };
}

/** The alert the socket pushes for one hit. */
function alertFor(h) {
  return {
    kind: 'stop_hit', level: 'danger', symbol: h.symbol, audible: true,
    title: `STOP HIT — ${h.symbol} bid ${h.bidFils} through the ${h.stopFils} stop`,
    body: `The stop was set at the fill (${h.stopFils}, entry ${h.entryFils}). The bid is ${h.bidFils}: ` +
      `${h.shares.toLocaleString('en-US')} shares are ${h.grossKd >= 0 ? '+' : ''}${h.grossKd.toFixed(2)} KD gross at the bid. ` +
      'Hit the bid. Moving the stop is how the large losses happened.',
    at: h.at,
  };
}

module.exports = { check, alertFor };
