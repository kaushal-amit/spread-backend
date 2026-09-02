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

const K = "AT TIME ZONE 'UTC' + interval '3 hours'";

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
const isoDay = (v) => {
  if (v == null || v === '') return null;
  const t = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const e = new Error(`"${t}" is not a date`);
    e.status = 400; e.code = 'BAD_REQUEST';
    e.detail = 'expected YYYY-MM-DD';
    throw e;
  }
  return t;
};

async function orders({ from = null, to = null, db = pool } = {}) {
  from = isoDay(from); to = isoDay(to);
  const { rows } = await db.query(
    `SELECT l.*, COALESCE(l.carried_from_day, l.trading_day) AS contract_day
       FROM spread.order_leg l
      WHERE ($1::date IS NULL OR l.trading_day >= $1)
        AND ($2::date IS NULL OR l.trading_day <= $2)
      ORDER BY l.posted_at, l.id;`, [from, to]);

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

  // The two counters nobody was measuring.
  const allLegs = rows.length;
  const fillsTotal = rows.filter((l) => l.status === 'FILLED').length;
  const exitsAsPosted = out.filter((c) => c.flags.some((f) => f.flag === 'EXIT_AS_POSTED')).length;
  const exitsMovedDown = out.filter((c) => c.flags.some((f) => f.flag === 'SELL_MOVED_DOWN'
    || f.flag === 'SOLD_BELOW_COST')).length;

  return {
    contracts: out,
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
async function dailyPnl({ from = null, to = null, db = pool } = {}) {
  from = isoDay(from); to = isoDay(to);
  const { rows } = await db.query(
    `WITH legs AS (
       SELECT COALESCE(carried_from_day, trading_day) AS day, symbol, contract_seq,
              side, status, price_fils, COALESCE(filled_shares, shares) AS shares,
              commission_kd
         FROM spread.order_leg
        WHERE status = 'FILLED'
          AND ($1::date IS NULL OR trading_day >= $1)
          AND ($2::date IS NULL OR trading_day <= $2)
     ), contracts AS (
       SELECT day, symbol, contract_seq,
              sum(CASE WHEN side='SELL' THEN price_fils*shares/1000.0
                       ELSE -price_fils*shares/1000.0 END) AS gross_kd,
              sum(commission_kd) AS commission_kd,
              count(*) AS fills,
              count(*) FILTER (WHERE side='SELL') AS sells
         FROM legs GROUP BY 1,2,3
     )
     SELECT day, count(*) FILTER (WHERE sells > 0) AS trips,
            sum(fills) AS fills,
            array_agg(DISTINCT symbol) AS symbols,
            round(sum(gross_kd)::numeric, 3) AS gross_kd,
            round(sum(commission_kd)::numeric, 3) AS commission_kd,
            round(sum(gross_kd - commission_kd)::numeric, 3) AS net_kd
       FROM contracts
      WHERE sells > 0
      GROUP BY day ORDER BY day DESC;`, [from, to]);

  let running = 0;
  const days = rows.slice().reverse().map((r) => {
    running += Number(r.net_kd);
    return {
      day: toDay(r.day), symbols: r.symbols, trips: Number(r.trips), fills: Number(r.fills),
      grossKd: Number(r.gross_kd), commissionKd: Number(r.commission_kd),
      netKd: Number(r.net_kd), cumulativeKd: Number(running.toFixed(3)),
    };
  }).reverse();

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

  const { rows } = await db.query(
    `WITH t AS (
       SELECT (created_at ${K}) AS at, last_price::numeric AS px, volume::bigint AS vol
         FROM spread.v_quote_screening
        WHERE upper(symbol) = $1
          AND ($2::date IS NULL OR (created_at ${K})::date = $2)
        ORDER BY created_at
     ), b AS (
       SELECT to_timestamp(floor(extract(epoch FROM at) / ($3 * 60)) * ($3 * 60)) AS bucket,
              px, vol,
              row_number() OVER (PARTITION BY floor(extract(epoch FROM at) / ($3*60)) ORDER BY at)      AS first_rn,
              row_number() OVER (PARTITION BY floor(extract(epoch FROM at) / ($3*60)) ORDER BY at DESC) AS last_rn
         FROM t
     )
     SELECT bucket,
            max(px) FILTER (WHERE first_rn = 1) AS open,
            max(px)                             AS high,
            min(px)                             AS low,
            max(px) FILTER (WHERE last_rn = 1)  AS close,
            max(vol) - min(vol)                 AS volume
       FROM b GROUP BY bucket ORDER BY bucket;`, [sym, day, mins]);

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
