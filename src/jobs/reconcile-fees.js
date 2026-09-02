'use strict';
/**
 * src/jobs/reconcile-fees.js — correct the fee from the broker's own charge.
 *
 * ─── WHY THIS IS A NIGHTLY PASS AND NOT A WRITE-PATH FIX ───────────────────
 * The orders userscript posts every 60 seconds. The trader taps GO the moment
 * the order is placed in Awsat. So at write time awsat_order_list holds
 * nothing for that order — a write-path lookup would find no row on every
 * single trade and silently fall back to the formula forever.
 *
 * The write path keeps computing. This pass corrects.
 *
 * ─── AND IT ADJUSTS THE LEDGER, IT DOES NOT EDIT IT ────────────────────────
 * A correction is a new cash_movement row, never an edit to the original. The
 * history of the correction is worth keeping: a ledger that silently changes
 * cannot be reconciled against a statement.
 */

const { pool } = require('../db');
const COMMISSION = require('../lib/commission');

/**
 * Matched on (symbol, side, price, day) — NOT on broker_order_id.
 *
 * The three trading routes take symbol, price and shares. None takes an order
 * id, and the trader will not type one: they tap GO after posting in Awsat.
 *
 * TWO MATCHES MEAN NEITHER. Two identical orders in a day are indistinguishable
 * here, and picking one would attach a real charge to the wrong leg. AMBIGUOUS
 * is an honest answer; a guess is not.
 */
const MATCH = `
  SELECT o.order_id, o.net_value, o.order_value, o.executions_observed,
         count(*) OVER (PARTITION BY o.symbol, o.side, o.price, o.trading_date) AS candidates
    FROM public.awsat_order_list o
   WHERE o.symbol = $1
     AND upper(o.side) = $2
     AND o.price = $3
     AND o.trading_date = $4
     AND o.order_status = 'Filled'`;

async function reconcile(day, { apply = false } = {}) {
  const { rows: legs } = await pool.query(
    `SELECT id, symbol, side, price_fils, shares, filled_shares,
            commission_kd, executions, fee_source
       FROM spread.order_leg
      WHERE trading_day = $1 AND status = 'FILLED'
      ORDER BY id`, [day]);

  const out = { day, legs: legs.length, broker: 0, ambiguous: 0, computed: 0, adjusted: 0, deltaKd: 0 };

  for (const leg of legs) {
    const { rows: m } = await pool.query(MATCH,
      [leg.symbol, String(leg.side).toUpperCase(), leg.price_fils, day]);

    const computed = Number(leg.commission_kd || 0);

    if (m.length > 1 || (m.length === 1 && Number(m[0].candidates) > 1)) {
      out.ambiguous += 1;
      if (apply) {
        await pool.query(
          `UPDATE spread.order_leg SET fee_source = 'AMBIGUOUS' WHERE id = $1`, [leg.id]);
      }
      continue;
    }

    if (!m.length) {
      out.computed += 1;
      if (apply) {
        await pool.query(
          `UPDATE spread.order_leg SET fee_source = 'COMPUTED' WHERE id = $1`, [leg.id]);
      }
      continue;
    }

    const row = m[0];
    const notional = (Number(leg.price_fils) * Number(leg.filled_shares || leg.shares)) / 1000;

    /**
     * The broker's fee is order_value minus net_value on a SELL, and net_value
     * minus order_value on a BUY: a buy costs more than the notional, a sell
     * returns less.
     */
    let brokerFee = null;
    if (row.net_value !== null && row.order_value !== null) {
      const nv = Number(row.net_value);
      const ov = Number(row.order_value);
      brokerFee = Math.abs(String(leg.side).toUpperCase() === 'BUY' ? nv - ov : ov - nv);
    }

    if (brokerFee === null) {
      /**
       * No net_value — but executions_observed IS populated on every row, so
       * the fee can still be corrected for a split fill. Cheaper than the main
       * change and it fixes the same direction of error.
       */
      const execs = Number(row.executions_observed) || null;
      if (execs && execs > 1 && execs !== Number(leg.executions)) {
        const better = COMMISSION.sideFeeKd(notional, { day, executions: execs });
        const delta = Number((better.kd - computed).toFixed(3));
        out.computed += 1;
        out.deltaKd += delta;
        if (apply) {
          await pool.query(
            `UPDATE spread.order_leg
                SET commission_kd = $2, executions = $3,
                    fee_source = 'COMPUTED', fee_delta_kd = $4
              WHERE id = $1`, [leg.id, better.kd, execs, delta]);
          await adjustLedger(leg, delta, day, `executions ${leg.executions || 1} -> ${execs}`);
          out.adjusted += 1;
        }
      } else {
        out.computed += 1;
        if (apply) {
          await pool.query(
            `UPDATE spread.order_leg SET fee_source = 'COMPUTED' WHERE id = $1`, [leg.id]);
        }
      }
      continue;
    }

    const delta = Number((brokerFee - computed).toFixed(3));
    out.broker += 1;
    out.deltaKd += delta;

    if (apply) {
      await pool.query(
        `UPDATE spread.order_leg
            SET commission_kd = $2, fee_source = 'BROKER', fee_delta_kd = $3,
                broker_order_id = $4, broker_net_value_kd = $5,
                executions = COALESCE($6, executions)
          WHERE id = $1`,
        [leg.id, brokerFee, delta, row.order_id, row.net_value,
          Number(row.executions_observed) || null]);
      if (Math.abs(delta) >= 0.001) {
        await adjustLedger(leg, delta, day, `broker charge ${brokerFee} vs computed ${computed}`);
        out.adjusted += 1;
      }
    }
  }

  out.deltaKd = Number(out.deltaKd.toFixed(3));
  return out;
}

/** A NEW row, never an edit. A ledger that silently changes cannot be reconciled. */
async function adjustLedger(leg, deltaKd, day, why) {
  // order_leg_id, not just a note: the correction is traceable to the leg it
  // corrects without parsing prose.
  await pool.query(
    `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, order_leg_id, note)
     VALUES ($1, 'FEE_CORRECTION', $2, $3, $4)`,
    [day, -deltaKd, leg.id, `${leg.symbol}: ${why}`]);
}

module.exports = { reconcile };
