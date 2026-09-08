'use strict';
/**
 * ============================================================================
 *  jobs/import-fills — the broker's filled orders, into the ledger
 * ============================================================================
 * public.awsat_order_list held 54 filled orders on 2 September; spread.order_leg
 * held none. Every account figure was zero against real trading.
 *
 * This walks the broker's fills oldest-first and books them the way the API
 * would have: a BUY opens a contract, a SELL closes the oldest open contract
 * in that symbol (FIFO), every fill writes its two cash rows, and the fee is
 * the BROKER'S where the row carries a net_value that makes sense for its
 * side — otherwise the formula, labelled COMPUTED.
 *
 * THE MATCHING IS A PURE FUNCTION (plan) so it can be checked without a
 * database, and the write is ONE transaction so a failure leaves nothing.
 *
 * What the broker list contains that a naive import gets wrong:
 *
 *   DUPLICATES  the same fill is recorded under TWO ids — a broker numeric id
 *               and a SYNTHETIC reconstruction (`syn:…` / `SYN-…`), because the
 *               Order List grid shows the id column only intermittently, so one
 *               capture reads the real id and another synthesises one. One fill,
 *               two rows, and `order_time` is NULL on client rows so a key that
 *               leans on it cannot see the twin. So the rule does NOT depend on
 *               order_time: a synthetic row is dropped whenever a REAL row
 *               exists for the same (symbol, side, price, shares, day). Two
 *               REAL ids at that key are kept — they are distinct trades
 *               (MUBARRAD's repeated round trips), never merged. Among
 *               synthetics-only, one is kept and the net_value row wins.
 *   ORPHANS     a SELL with no open contract (KFIC 11 Aug: the buy predates
 *               capture; CATTL 291 on 24 Aug after the position closed). Not
 *               booked — a sell of shares the ledger never saw would open a
 *               short. Reported instead.
 *   SWAPPED     a row whose order_value/net_value are the wrong way round for
 *               its side (a BUY whose net is BELOW the notional). The broker
 *               figure is discarded for that row and the formula used.
 *
 *   npm run import:fills            dry run — prints the plan, writes nothing
 *   npm run import:fills -- --apply writes, in one transaction
 * ============================================================================
 */
require('dotenv').config();
const { pool } = require('../db');
const COMMISSION = require('../lib/commission');
const { toDay } = require('../lib/day');
const { bookFill } = require('../api/trading_routes');

const SQL_FILLS = `
  SELECT o.order_id, o.symbol, upper(o.side) AS side, o.price::numeric AS price,
         COALESCE(o.filled_quantity, o.quantity)::bigint AS shares,
         o.order_value::numeric AS order_value, o.net_value::numeric AS net_value,
         o.executions_observed, o.trading_date, o.order_time, i.market
    FROM public.awsat_order_list o
    LEFT JOIN public.instruments i ON i.symbol = o.symbol
   WHERE lower(o.order_status) = 'filled'
   ORDER BY o.trading_date, o.order_time NULLS LAST, o.order_id;`;

/** Dedupe key: one fill recorded by two ingest sources. */
const dupKey = (r) => [r.symbol, r.side, Number(r.price), Number(r.shares),
  toDay(r.trading_date), r.order_time ? new Date(r.order_time).toISOString() : 'no-time', r.order_id_when_no_time || '']
  .join('|');

/** The broker's fee for this row, or null when the row cannot be trusted. */
function brokerFee(r) {
  if (r.net_value == null || r.order_value == null) return null;
  const nv = Number(r.net_value), ov = Number(r.order_value);
  const notional = (Number(r.price) * Number(r.shares)) / 1000;
  // order_value IS the notional. When it is not (CATTL 31 Aug: 685.627 on a
  // 687.6 trade, with net_value = the notional) the row's columns are shifted
  // and neither figure can be read as a fee.
  if (Math.abs(ov - notional) > Math.max(0.01, notional * 0.002)) return null;
  const fee = r.side === 'BUY' ? nv - ov : ov - nv;
  // A buy costs MORE than notional and a sell returns LESS. Anything else is
  // a swapped or mislabelled row, and a negative fee is not a fee.
  if (!(fee > 0) || fee > ov * 0.02) return null;
  return Number(fee.toFixed(3));
}

/**
 * The plan: which rows become legs, on which contract, at what fee.
 *
 * @param {object[]} rows  awsat_order_list rows, any order
 * @param {object}   opts  { seqStart: {SYMBOL: n}, known: Set<order_id> }
 */
const isSynthetic = (id) => /^(syn:|SYN-)/i.test(String(id || ''));
/** The fill's natural key, WITHOUT order_time or id — same fill, same key. */
const natKey = (r) => [r.symbol, r.side, Number(r.price), Number(r.shares), toDay(r.trading_date)].join('|');

function plan(rows, { seqStart = {}, known = new Set() } = {}) {
  // 1 · dedupe
  //
  // The natural keys a REAL broker order fills. A synthetic reconstruction of
  // any of them is the same fill under a second id and must not be booked
  // twice — and because client rows carry no order_time, this cannot lean on
  // a timestamp.
  const realNat = new Set();
  for (const r of rows) if (!isSynthetic(r.order_id)) realNat.add(natKey(r));

  const seen = new Map();
  const dropped = [];
  for (const r of rows) {
    // A synthetic row whose fill a REAL order already covers is a duplicate,
    // whatever its id or (missing) time.
    if (isSynthetic(r.order_id) && realNat.has(natKey(r))) { dropped.push(r.order_id); continue; }
    // Distinct REAL ids are distinct trades and never merge (MUBARRAD's two
    // round trips at one price). Timed rows still de-dupe an exact twin by
    // (symbol,side,price,shares,day,time); synthetics-only collapse on the
    // natural key so repeat captures of one fill become one.
    const key = isSynthetic(r.order_id) ? 'S|' + natKey(r)
      : (r.order_time ? dupKey(r) : 'R|' + String(r.order_id));
    const prev = seen.get(key);
    if (!prev) { seen.set(key, r); continue; }
    // keep the one with a usable broker figure
    if (brokerFee(prev) == null && brokerFee(r) != null) { dropped.push(prev.order_id); seen.set(key, r); }
    else dropped.push(r.order_id);
  }
  // Order within a day: order_time when both have one; otherwise the broker's
  // numeric order id, which is issued in sequence (MUBARRAD on 1 Sep has no
  // times and its ids read BUY, SELL, BUY, SELL — two round trips, not one
  // double position).
  const numId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : null);
  const fills = [...seen.values()].sort((a, b) =>
    toDay(a.trading_date).localeCompare(toDay(b.trading_date))
    || (a.order_time && b.order_time ? new Date(a.order_time) - new Date(b.order_time) : 0)
    || (numId(a.order_id) != null && numId(b.order_id) != null ? numId(a.order_id) - numId(b.order_id) : 0)
    || (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1)
    || String(a.order_id).localeCompare(String(b.order_id)));

  // 2 · FIFO per symbol
  const seq = { ...seqStart };
  const open = new Map();          // symbol -> [{seq, remaining, day}]
  const legs = [], orphans = [], skipped = [];

  for (const r of fills) {
    if (known.has(r.order_id)) { skipped.push(r.order_id); continue; }
    const day = toDay(r.trading_date);
    const shares = Number(r.shares);
    const premier = /premier/i.test(String(r.market || ''));
    const bf = brokerFee(r);
    const execs = Number(r.executions_observed) || null;
    const notionalKd = (Number(r.price) * shares) / 1000;
    const computed = COMMISSION.sideFeeKd(notionalKd, { day, premier, executions: execs });
    const fee = bf ?? computed.kd;
    const feeSource = bf != null ? 'BROKER' : 'COMPUTED';

    if (r.side === 'BUY') {
      seq[r.symbol] = (seq[r.symbol] || 0) + 1;
      const s = seq[r.symbol];
      if (!open.has(r.symbol)) open.set(r.symbol, []);
      open.get(r.symbol).push({ seq: s, remaining: shares, day });
      legs.push({ order_id: r.order_id, symbol: r.symbol, side: 'BUY', day, seq: s, price: Number(r.price),
        shares, filled: shares, fee, feeSource, executions: execs, netValue: r.net_value,
        premier, computedFee: computed.kd });
      continue;
    }

    // SELL: oldest open contract first; split across contracts if needed.
    const q = open.get(r.symbol) || [];
    let left = shares;
    while (left > 0 && q.length) {
      const c = q[0];
      const take = Math.min(left, c.remaining);
      const part = take / shares;
      legs.push({ order_id: r.order_id, symbol: r.symbol, side: 'SELL', day, seq: c.seq, price: Number(r.price),
        shares: take, filled: take,
        fee: Number((fee * part).toFixed(3)), feeSource, executions: execs, netValue: r.net_value,
        premier, computedFee: Number((computed.kd * part).toFixed(3)),
        split: take !== shares ? { of: shares } : null });
      c.remaining -= take; left -= take;
      if (c.remaining === 0) q.shift();
    }
    if (left > 0) orphans.push({ order_id: r.order_id, symbol: r.symbol, day, price: Number(r.price), shares: left,
      why: q.length ? 'partial — remainder exceeds what is held' : 'no open contract in this symbol' });
  }

  const stillOpen = [];
  for (const [symbol, q] of open) for (const c of q) stillOpen.push({ symbol, seq: c.seq, remaining: c.remaining, since: c.day });

  return { legs, orphans, dropped, skipped, stillOpen };
}

/** Write the plan. ONE transaction. */
async function apply(p, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const l of p.legs) {
      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares,
            commission_kd, executions, posted_at, resolved_at, broker_order_id, broker_net_value_kd,
            fee_source, fee_delta_kd, exit_venue, note)
         VALUES ($1,$2,$3,$4,'FILLED',$5,$6,$7,$8,$9,$1::date + time '09:00',$1::date + time '09:00',
                 $10,$11,$12,$13,$14,$15)
         RETURNING *;`,
        [l.day, l.symbol, l.seq, l.side, l.price, l.shares, l.filled, l.fee, l.executions,
         l.order_id, l.netValue, l.feeSource === 'BROKER' ? 'BROKER' : 'IMPORTED',
         l.feeSource === 'BROKER' ? Number((l.fee - l.computedFee).toFixed(3)) : null,
         l.side === 'SELL' ? 'MARKET' : null,
         `imported from awsat_order_list ${l.order_id}` + (l.split ? ` (${l.shares} of ${l.split.of})` : '')]);
      await bookFill(client, { day: l.day, leg, side: l.side, shares: l.filled,
        priceFils: l.price, feeKd: l.fee, symbol: l.symbol });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function run({ apply: doApply = false, db = pool } = {}) {
  const { rows } = await db.query(SQL_FILLS);
  const { rows: seqs } = await db.query(
    'SELECT symbol, max(contract_seq) AS seq FROM spread.order_leg GROUP BY symbol;');
  const { rows: knownRows } = await db.query(
    'SELECT broker_order_id FROM spread.order_leg WHERE broker_order_id IS NOT NULL;');
  const seqStart = Object.fromEntries(seqs.map((s) => [s.symbol, Number(s.seq)]));
  const known = new Set(knownRows.map((k) => k.broker_order_id));

  const p = plan(rows, { seqStart, known });
  if (doApply && p.legs.length) await apply(p, db);
  return { ...p, brokerRows: rows.length, applied: doApply };
}

function describe(p) {
  const lines = [];
  lines.push(`${p.brokerRows} filled broker rows → ${p.legs.length} legs, ` +
    `${p.dropped.length} duplicates dropped, ${p.skipped.length} already imported, ` +
    `${p.orphans.length} orphan sells`);
  for (const l of p.legs) {
    lines.push(`  ${l.day}  ${l.symbol.padEnd(9)} ${l.side.padEnd(4)} C${l.seq}  ` +
      `${String(l.shares).padStart(5)} @ ${String(l.price).padStart(4)}  fee ${l.fee.toFixed(3)} ${l.feeSource}` +
      (l.split ? `  (split of ${l.split.of})` : ''));
  }
  for (const o of p.orphans) lines.push(`  ORPHAN ${o.day} ${o.symbol} SELL ${o.shares} @ ${o.price} — ${o.why}`);
  for (const s of p.stillOpen) lines.push(`  OPEN   ${s.symbol} C${s.seq} ${s.remaining} shares since ${s.since}`);
  return lines.join('\n');
}

module.exports = { plan, apply, run, describe, brokerFee };

if (require.main === module) {
  const doApply = process.argv.includes('--apply');
  run({ apply: doApply })
    .then((p) => { console.log(describe(p)); console.log(doApply ? '\nWRITTEN.' : '\nDRY RUN — add --apply to write.'); return pool.end(); })
    .catch((e) => require('../lib/dberror').die(e));
}
