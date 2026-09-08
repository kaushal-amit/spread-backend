'use strict';
/**
 * ============================================================================
 *  legs-stale.js — POSTED legs left from an earlier session (R-40)
 * ============================================================================
 * A POSTED leg whose trading_day is before today is an order that was placed in
 * a prior session and never resolved here — usually one cancelled in Awsat but
 * not recorded. R-03 keeps such a leg out of the live E5 stranded-order judging
 * (it is announced once as `stale_posted`, not paged every tick); this is the
 * operator's list of them, so they can be resolved CANCELLED before the first
 * live session rather than surfacing mid-morning.
 *
 * Read-only. `npm run legs:stale` prints the list; staleLegs() returns it.
 * ============================================================================
 */
const { pool } = require('../db');
const { kuwaitDay } = require('../jobs/daily');
const { toDay } = require('../lib/day');

/** POSTED legs dated before `today`, oldest first. */
async function staleLegs(db = pool, today = kuwaitDay()) {
  const { rows } = await db.query(
    `SELECT id, trading_day, symbol, contract_seq, side, price_fils, shares, posted_at
       FROM spread.order_leg
      WHERE status = 'POSTED' AND trading_day < $1::date
      ORDER BY trading_day, posted_at, id;`, [today]);
  return rows;
}

async function main() {
  const today = kuwaitDay();
  const rows = await staleLegs(pool, today);
  if (!rows.length) {
    console.log(`[legs:stale] none — no POSTED leg is dated before ${today}.`);
  } else {
    console.log(`[legs:stale] ${rows.length} POSTED leg(s) from an earlier session (resolve CANCELLED before the live session):`);
    for (const l of rows) {
      console.log(`  #${l.id}  ${toDay(l.trading_day)}  ${l.symbol} C${l.contract_seq}  ${l.side} ${l.shares} @ ${l.price_fils}`);
    }
  }
  await pool.end();
  return rows;
}

if (require.main === module) {
  main().catch((e) => { console.error('[legs:stale]', e.message); process.exit(1); });
}

module.exports = { staleLegs };
