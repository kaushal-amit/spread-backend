'use strict';
/**
 * ============================================================================
 *  history.js — the three feeds the pages were inventing
 * ============================================================================
 *   /orders       had ~300 lines of fixture that read as a real audit trail
 *   /performance  had a 7-row P&L table and "12 Fills / 6 sessions", invented
 *   the chart      had a Math.sin random walk over a base price of 238
 *
 * Every one of those is derivable from data already captured. A page that
 * invents its own numbers is the exact failure the boundary exists to prevent,
 * and a fabricated audit trail is worse than an empty one.
 * ============================================================================
 */

const { pool } = require('../db');
const { toDay } = require('../lib/day');


/**
 * Order history, GROUPED INTO CONTRACTS.
 *
 * A flat list by date hides the thing that matters: a cancel followed by a
 * replace on the same symbol and side is ONE decision, not two rows. Reading
 * the record required noticing that two timestamps were twenty seconds apart.
 *
 * The behaviour flags are computed here because they are properties of the
 * SEQUENCE, and each individual leg looks reasonable on its own.
 */
/** ISO or nothing. A malformed date reaching `$1::date` throws a 503 that
 *  reads like the engine is down. */
// B-14 · an ApiError, so errors.js answers 400 rather than 500.
const isoDay = (v) => (v == null || v === '' ? null : require('./params').dayParam(v));

async function orders({ from = null, to = null, limit = 500, cursor = null, db = pool } = {}) {
  from = isoDay(from); to = isoDay(to);
  limit = Math.min(Math.max(1, Number(limit) || 500), 500);
  // 6.4 · the cursor is BY CONTRACT (R-01), keyed on the contract's newest leg
  // (max posted_at, max id): the next page is the contracts older than it.
  const curAt = cursor && cursor.at ? cursor.at : null;
  const curId = cursor && cursor.id != null ? cursor.id : null;
  /*
   * R-01 · the limit is on CONTRACTS, never on legs. Limiting legs cut the
   * newest contract in half — a sell with no buy — and the behaviour flags
   * (exit moved down, stranded, fill rate) were computed on a torn sequence.
   * The newest `limit` contracts (by their latest leg) are chosen first; every
   * leg of each is then returned, oldest first.
   */
  const { rows } = await db.query(
    `WITH keyed AS (
       SELECT l.*, COALESCE(l.carried_from_day, l.trading_day) AS contract_day
         FROM spread.order_leg l
        WHERE ($1::date IS NULL OR l.trading_day >= $1)
          AND ($2::date IS NULL OR l.trading_day <= $2)
     ), newest AS (
       SELECT symbol, contract_day, contract_seq
         FROM keyed
        GROUP BY symbol, contract_day, contract_seq
       HAVING ($4::timestamptz IS NULL
               OR (max(posted_at), max(id)) < ($4::timestamptz, $5::bigint))
        ORDER BY max(posted_at) DESC NULLS LAST, max(id) DESC
        LIMIT $3
     )
     SELECT k.* FROM keyed k
       JOIN newest n USING (symbol, contract_day, contract_seq)
      ORDER BY k.posted_at, k.id;`, [from, to, limit, curAt, curId]);

  const byContract = new Map();
  for (const l of rows) {
    const key = `${l.symbol}:${toDay(l.contract_day)}:${l.contract_seq}`;
    if (!byContract.has(key)) {
      byContract.set(key, {
        key, symbol: l.symbol, contractDay: toDay(l.contract_day),
        seq: Number(l.contract_seq), legs: [],
      });
    }
    byContract.get(key).legs.push(l);
  }

  const out = [];
  for (const c of byContract.values()) {
    const filled = c.legs.filter((l) => l.status === 'FILLED');
    const buys = filled.filter((l) => l.side === 'BUY');
    const sells = filled.filter((l) => l.side === 'SELL');

    const grossKd = filled.reduce((a, l) => {
      const v = (Number(l.price_fils) * Number(l.filled_shares || l.shares)) / 1000;
      return a + (l.side === 'SELL' ? v : -v);
    }, 0);
    const commissionKd = filled.reduce((a, l) => a + Number(l.commission_kd || 0), 0);

    // The named behaviours, detected from the sequence rather than a single leg.
    const flags = [];
    const sellsDesc = c.legs.filter((l) => l.side === 'SELL')
      .sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
    for (let i = 1; i < sellsDesc.length; i++) {
      if (Number(sellsDesc[i].price_fils) < Number(sellsDesc[i - 1].price_fils)) {
        const belowCost = buys.length &&
          Number(sellsDesc[i].price_fils) < Number(buys[0].price_fils);
        flags.push({
          flag: belowCost ? 'SOLD_BELOW_COST' : 'SELL_MOVED_DOWN',
          severity: belowCost ? 'danger' : 'warning',
          why: `sell moved ${sellsDesc[i - 1].price_fils} → ${sellsDesc[i].price_fils}` +
               (belowCost ? ', below the entry' : ', still above cost') +
               '. Three of these cost 19.52 KD in one session.',
        });
        break;
      }
    }
    const buysAsc = c.legs.filter((l) => l.side === 'BUY')
      .sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
    for (let i = 1; i < buysAsc.length; i++) {
      if (Number(buysAsc[i].price_fils) > Number(buysAsc[i - 1].price_fils)) {
        flags.push({ flag: 'CHASED', severity: 'warning',
          why: `buy moved up ${buysAsc[i - 1].price_fils} → ${buysAsc[i].price_fils}. ` +
               'One order followed a stock from 164 to 174 and never filled.' });
        break;
      }
    }
    if (sells.length && sells.every((s) => {
      const posted = c.legs.find((l) => l.side === 'SELL' && l.status === 'POSTED'
        && Number(l.price_fils) === Number(s.price_fils));
      return !!posted || c.legs.filter((l) => l.side === 'SELL').length === 1;
    })) {
      flags.push({ flag: 'EXIT_AS_POSTED', severity: 'ok',
        why: 'the sell filled at the price first posted' });
    }
    if (filled.some((l) => Number(l.executions) > 1)) {
      flags.push({ flag: 'FRAGMENTED', severity: 'warning',
        why: 'filled in more than one execution — the settlement fee is charged per execution' });
    }
    if (c.legs.some((l) => l.status === 'EXPIRED')) {
      flags.push({ flag: 'EXPIRED', severity: 'warning', why: 'still live at the close' });
    }

    out.push({
      key: c.key, symbol: c.symbol, contractDay: c.contractDay, seq: c.seq,
      state: sells.length ? 'closed' : buys.length ? 'open' : 'no_fill',
      grossKd: Number(grossKd.toFixed(3)),
      commissionKd: Number(commissionKd.toFixed(3)),
      netKd: sells.length ? Number((grossKd - commissionKd).toFixed(3)) : null,
      fills: filled.length,
      executions: filled.reduce((a, l) => a + Number(l.executions || 1), 0),
      heldMinutes: buys[0] && sells[0]
        ? Math.round((new Date(sells[0].resolved_at || sells[0].posted_at)
                    - new Date(buys[0].resolved_at || buys[0].posted_at)) / 60000)
        : null,
      flags,
      legs: c.legs.map((l) => ({
        id: Number(l.id), symbol: c.symbol, side: l.side, status: l.status,
        price: Number(l.price_fils), shares: Number(l.shares),
        filledShares: l.filled_shares == null ? null : Number(l.filled_shares),
        commission_kd: Number(l.commission_kd || 0),
        executions: l.executions == null ? null : Number(l.executions),
        placement: l.placement, brokerOrderId: l.broker_order_id,
        time: l.posted_at ? new Date(l.posted_at).toISOString() : '',
        resolvedAt: l.resolved_at ? new Date(l.resolved_at).toISOString() : null,
        note: l.note || '',
      })),
    });
  }

  out.sort((a, b) => (b.contractDay > a.contractDay ? 1 : b.contractDay < a.contractDay ? -1 : b.seq - a.seq));

  // 6.4 · the next-page cursor: the least-recent contract returned, so the next
  // page continues older than it. Computed from the RAW legs (byContract), which
  // carry posted_at — the presented legs in `out` do not. Only on a full page.
  const recencyOf = (key) => (byContract.get(key)?.legs || []).reduce((acc, l) => {
    const at = l.posted_at ? new Date(l.posted_at).getTime() : 0;
    const id = Number(l.id);
    return (at > acc.at || (at === acc.at && id > acc.id)) ? { at, id, atIso: l.posted_at } : acc;
  }, { at: -1, id: -1, atIso: null });
  let next = null;
  if (out.length >= limit && out.length) {
    let oldest = null;
    for (const c of out) {
      const rr = recencyOf(c.key);
      if (!oldest || rr.at < oldest.at || (rr.at === oldest.at && rr.id < oldest.id)) oldest = rr;
    }
    if (oldest && oldest.atIso) next = `${new Date(oldest.atIso).toISOString()}|${oldest.id}`;
  }

  // The two counters nobody was measuring.
  const allLegs = rows.length;
  const fillsTotal = rows.filter((l) => l.status === 'FILLED').length;
  const exitsAsPosted = out.filter((c) => c.flags.some((f) => f.flag === 'EXIT_AS_POSTED')).length;
  const exitsMovedDown = out.filter((c) => c.flags.some((f) => f.flag === 'SELL_MOVED_DOWN'
    || f.flag === 'SOLD_BELOW_COST')).length;

  return {
    contracts: out,
    next,
    summary: {
      ordersPlaced: allLegs, fills: fillsTotal,
      // The only feedback the queue estimator ever gets.
      fillRatePct: allLegs ? Number(((100 * fillsTotal) / allLegs).toFixed(1)) : 0,
      exitsAsPosted, exitsMovedDown,
      contractsClosed: out.filter((c) => c.state === 'closed').length,
    },
  };
}

/**
 * Daily P&L, by SESSION.
 *
 * Gross and commission stay SEPARATE columns. On one session the gross was
 * +16.95 and commission took 14.00 of it — four small trips are expensive, and
 * a net-only view hides that completely.
 */
async function dailyPnl({ from = null, to = null, limit = 500, db = pool } = {}) {
  from = isoDay(from); to = isoDay(to);
  limit = Math.min(Math.max(1, Number(limit) || 500), 500);
  /*
   * C-11 · BY CONTRACT, counted on the day it CLOSED.
   *
   * This grouped FILLED legs by COALESCE(carried_from_day, trading_day), and
   * nothing writes carried_from_day — so a buy on day A and its sell on day B
   * were two groups, and day B booked the whole sale as profit. The contract
   * key is (symbol, contract_seq); its day is when the last sell filled.
   */
  const { rows } = await db.query(
    `WITH legs AS (
       SELECT symbol, contract_seq, side, trading_day, price_fils,
              COALESCE(filled_shares, shares) AS shares, COALESCE(commission_kd, 0) AS commission_kd
         FROM spread.order_leg
        WHERE (side = 'BUY' AND status IN ('FILLED','CARRIED'))
           OR (side = 'SELL' AND status = 'FILLED')
     ), contracts AS (
       SELECT symbol, contract_seq,
              max(trading_day) FILTER (WHERE side = 'SELL') AS day,
              sum(shares) FILTER (WHERE side = 'BUY')  AS bought,
              sum(shares) FILTER (WHERE side = 'SELL') AS sold,
              sum(CASE WHEN side='SELL' THEN price_fils*shares/1000.0
                       ELSE -price_fils*shares/1000.0 END) AS gross_kd,
              sum(commission_kd) AS commission_kd,
              count(*) AS fills
         FROM legs GROUP BY 1, 2
     )
     , days AS (
       SELECT day, count(*) AS trips,
              sum(fills) AS fills,
              array_agg(DISTINCT symbol) AS symbols,
              round(sum(gross_kd)::numeric, 3) AS gross_kd,
              round(sum(commission_kd)::numeric, 3) AS commission_kd,
              round(sum(gross_kd - commission_kd)::numeric, 3) AS net_kd
         FROM contracts
        WHERE bought IS NOT NULL AND sold >= bought
        GROUP BY day
     )
     -- R-02 · the running total is the ACCOUNT's, from the first closed
     -- contract, computed over every day and only then cut to the window. It
     -- used to be summed over the returned rows, so a from/to or a limit made
     -- "cumulative" mean "since the start of this page".
     , cum AS (
       -- the window runs over EVERY day; the WHERE below only cuts the page
       SELECT *, round(sum(net_kd) OVER (ORDER BY day)::numeric, 3) AS cumulative_kd FROM days
     )
     SELECT day, trips, fills, symbols, gross_kd, commission_kd, net_kd, cumulative_kd
       FROM cum
      WHERE ($1::date IS NULL OR day >= $1)
        AND ($2::date IS NULL OR day <= $2)
      ORDER BY day DESC LIMIT $3;`, [from, to, limit]);

  const days = rows.map((r) => ({
    day: toDay(r.day), symbols: r.symbols, trips: Number(r.trips), fills: Number(r.fills),
    grossKd: Number(r.gross_kd), commissionKd: Number(r.commission_kd),
    netKd: Number(r.net_kd), cumulativeKd: Number(r.cumulative_kd),
  }));

  const totalNet = days.reduce((a, d) => a + d.netKd, 0);
  const totalComm = days.reduce((a, d) => a + d.commissionKd, 0);

  return {
    days,
    summary: {
      sessions: days.length,
      fills: days.reduce((a, d) => a + d.fills, 0),
      trips: days.reduce((a, d) => a + d.trips, 0),
      netKd: Number(totalNet.toFixed(3)),
      commissionKd: Number(totalComm.toFixed(3)),
      // Commission as a share of the damage. Worth stating rather than making
      // the operator divide two numbers on screen.
      commissionPctOfLoss: totalNet < 0
        ? Number(((100 * totalComm) / Math.abs(totalNet - totalComm)).toFixed(1)) : null,
      winners: days.filter((d) => d.netKd > 0).length,
      losers: days.filter((d) => d.netKd < 0).length,
    },
  };
}

/**
 * Intraday candles from captured quotes.
 *
 * The chart previously rendered a `Math.sin`-seeded random walk over a base
 * price of 238, with SMA, EMA, RSI, MACD and Bollinger bands all computed on
 * invented prices. Indicators over fabricated data are worse than no chart:
 * they look exactly like analysis.
 */
async function candles(symbol, { day = null, minutes = 5, db = pool } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const mins = Number(minutes) || 5;
  day = isoDay(day);

  /*
   * N-12 · DAILY AND WEEKLY ARE DIFFERENT GRAINS, not a longer minute bucket.
   *
   * The chart mapped 1h, 1D and 1W all to 60 minutes and handed the same series
   * to every selector, so the timeframe control was decorative.
   *
   * Above 60 minutes the source changes: intraday buckets come from quote
   * captures, daily and weekly from spread.symbol_day — which is where the
   * close already excludes the auction print that made one 2-fil range look
   * like 9.
   */
  if (mins >= 1440) {
    const weekly = mins >= 10080;
    const { rows } = await db.query(
      weekly
        ? `SELECT date_trunc('week', trading_day)::date AS bucket,
                  (array_agg(open_fils  ORDER BY trading_day))[1]                 AS open,
                  max(high_fils)                                                  AS high,
                  min(low_fils)                                                   AS low,
                  (array_agg(close_fils ORDER BY trading_day DESC))[1]            AS close,
                  sum(volume_shares)                                              AS volume
             FROM spread.symbol_day
            WHERE upper(symbol) = $1 AND capture_quality <> 'MISSING'
            GROUP BY bucket ORDER BY bucket;`
        : `SELECT trading_day AS bucket, open_fils AS open, high_fils AS high,
                  low_fils AS low, close_fils AS close, volume_shares AS volume
             FROM spread.symbol_day
            WHERE upper(symbol) = $1 AND capture_quality <> 'MISSING'
              AND close_fils IS NOT NULL
            ORDER BY trading_day;`, [sym]);

    return {
      symbol: sym, intervalMinutes: mins, grain: weekly ? 'week' : 'day',
      candles: rows.map((r) => ({
        time: new Date(`${toDay(r.bucket)}T00:00:00Z`).toISOString(),
        open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close),
        volume: Number(r.volume || 0),
      })),
    };
  }

  /*
   * 3.4 / D-08 · buckets in timestamptz.
   *
   * This used to shift created_at to Kuwait wall-clock (a timestamp WITHOUT
   * zone), take extract(epoch) of THAT — which reads it as UTC — and so
   * labelled every candle three hours early. date_bin() bins the instant
   * itself; the origin is a Kuwait midnight so a 5-minute grid lands on
   * 09:00 Kuwait, and the bucket is emitted as the instant it is.
   *
   * Volume: the scraper's `volume` is the session's CUMULATIVE total. A
   * bucket's volume is its last cumulative minus the previous bucket's last —
   * max − lag(max) ACROSS buckets — never max − min inside one, which loses
   * every print that fell between two captures and made Σ candles < day
   * volume. The first bucket of a session is its cumulative total (the
   * session starts from zero); the lag is partitioned by session day so a
   * multi-day series never subtracts yesterday's close from today's open.
   */
  const { rows } = await db.query(
    `WITH t AS (
       SELECT created_at AS at, spread.kuwait_day(created_at) AS day,
              last_price::numeric AS px, volume::bigint AS vol
         FROM spread.v_quote_screening
        WHERE upper(symbol) = $1
          AND ($2::date IS NULL OR spread.kuwait_day(created_at) = $2)
     ), b AS (
       SELECT date_bin(($3::int * interval '1 minute'), at,
                       timestamptz '2000-01-01 00:00:00 Asia/Kuwait') AS bucket,
              day, px, vol,
              row_number() OVER (PARTITION BY date_bin(($3::int * interval '1 minute'), at,
                       timestamptz '2000-01-01 00:00:00 Asia/Kuwait') ORDER BY at)      AS first_rn,
              row_number() OVER (PARTITION BY date_bin(($3::int * interval '1 minute'), at,
                       timestamptz '2000-01-01 00:00:00 Asia/Kuwait') ORDER BY at DESC) AS last_rn
         FROM t
     ), c AS (
       SELECT bucket, day,
              max(px) FILTER (WHERE first_rn = 1) AS open,
              max(px)                             AS high,
              min(px)                             AS low,
              max(px) FILTER (WHERE last_rn = 1)  AS close,
              max(vol)                            AS cum
         FROM b GROUP BY bucket, day
     )
     SELECT bucket, open, high, low, close,
            cum - COALESCE(lag(cum) OVER (PARTITION BY day ORDER BY bucket), 0) AS volume
       FROM c ORDER BY bucket;`, [sym, day, mins]);

  return {
    symbol: sym, intervalMinutes: mins, grain: 'intraday',
    // An empty array is a legitimate answer and the caller must render "no
    // history captured" rather than a generated one.
    candles: rows.map((r) => ({
      time: new Date(r.bucket).toISOString(),
      open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close),
      volume: Number(r.volume || 0),
    })),
  };
}

module.exports = { orders, dailyPnl, candles };
