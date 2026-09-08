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
 *
 * ─── D-05 · ONE TRANSACTION PER LEG, AND NO FLIP-FLOP ───────────────────────
 * The leg update and the ledger correction were two autocommit statements. A
 * failure between them left the leg at the broker fee with no ledger row, and
 * the rerun computed delta = broker - broker = 0 and never wrote it. Now the
 * two go together or not at all.
 *
 * A leg already labelled BROKER is FINAL. The broker rows are pruned after a
 * time; re-running once they were gone re-labelled a corrected leg COMPUTED
 * while keeping the broker's numbers — a row that contradicted itself.
 *
 *   npm run reconcile:fees                 dry run for today
 *   npm run reconcile:fees -- 2026-08-24 --apply
 */

require('dotenv').config();
const { pool } = require('../db');
const COMMISSION = require('../lib/commission');
const { kuwaitDay } = require('./daily');

/**
 * Matched on (symbol, side, price, FILLED QUANTITY, day) — NOT on broker_order_id,
 * because the trading routes take symbol, price and shares and the trader will
 * not type an order id. A leg that was IMPORTED carries the id and is matched
 * on it directly.
 *
 * TWO MATCHES MEAN NEITHER. Two identical orders in a day are indistinguishable
 * here, and picking one would attach a real charge to the wrong leg.
 */
const MATCH = `
  SELECT o.order_id, o.net_value, o.order_value, o.executions_observed,
         count(*) OVER () AS candidates
    FROM public.awsat_order_list o
   WHERE o.symbol = $1
     AND upper(o.side) = $2
     AND o.price = $3
     AND COALESCE(o.filled_quantity, o.quantity) = $4
     AND o.trading_date = $5
     AND lower(o.order_status) = 'filled'`;

const BY_ID = `
  SELECT o.order_id, o.net_value, o.order_value, o.executions_observed, 1 AS candidates
    FROM public.awsat_order_list o
   WHERE o.order_id = $1 AND lower(o.order_status) = 'filled'`;

/** The broker's fee, oriented by side, or null when the row cannot be trusted. */
function brokerFeeOf(row, side, notional = null) {
  if (row.net_value == null || row.order_value == null) return null;
  const nv = Number(row.net_value), ov = Number(row.order_value);
  // order_value must BE the notional, or the row's columns are shifted.
  if (notional != null && Math.abs(ov - notional) > Math.max(0.01, notional * 0.002)) return null;
  const fee = side === 'BUY' ? nv - ov : ov - nv;
  if (!(fee > 0) || fee > ov * 0.02) return null;
  return Number(fee.toFixed(3));
}

async function reconcile(day, { apply = false, db = pool } = {}) {
  const { rows: legs } = await db.query(
    `SELECT id, symbol, side, price_fils, shares, filled_shares,
            commission_kd, executions, fee_source, broker_order_id
       FROM spread.order_leg
      WHERE trading_day = $1 AND status = 'FILLED'
        AND COALESCE(fee_source, '') <> 'BROKER'
      ORDER BY id`, [day]);

  const out = { day, legs: legs.length, broker: 0, ambiguous: 0, computed: 0, unmatched: 0,
    adjusted: 0, deltaKd: 0 };

  for (const leg of legs) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: m } = leg.broker_order_id
        ? await client.query(BY_ID, [leg.broker_order_id])
        : await client.query(MATCH, [leg.symbol, String(leg.side).toUpperCase(), leg.price_fils,
          Number(leg.filled_shares || leg.shares), day]);

      const computed = Number(leg.commission_kd || 0);

      if (m.length > 1 || (m.length === 1 && Number(m[0].candidates) > 1)) {
        out.ambiguous += 1;
        if (apply) {
          await client.query(`UPDATE spread.order_leg SET fee_source = 'AMBIGUOUS' WHERE id = $1`, [leg.id]);
        }
        await client.query('COMMIT');
        continue;
      }

      if (!m.length) {
        // No broker row. The leg stays what it is: COMPUTED if that is what it
        // was, IMPORTED if it came from the import. It is NOT re-labelled.
        out.unmatched += 1;
        if (apply && leg.fee_source == null) {
          await client.query(`UPDATE spread.order_leg SET fee_source = 'COMPUTED' WHERE id = $1`, [leg.id]);
        }
        await client.query('COMMIT');
        continue;
      }

      const row = m[0];
      const notional = (Number(leg.price_fils) * Number(leg.filled_shares || leg.shares)) / 1000;
      const brokerFee = brokerFeeOf(row, String(leg.side).toUpperCase(), notional);

      if (brokerFee === null) {
        // No usable net_value — but executions_observed is populated, so a
        // split fill can still be corrected.
        const execs = Number(row.executions_observed) || null;
        if (execs && execs > 1 && execs !== Number(leg.executions)) {
          const better = COMMISSION.sideFeeKd(notional, { day, executions: execs });
          const delta = Number((better.kd - computed).toFixed(3));
          out.computed += 1;
          out.deltaKd += delta;
          if (apply) {
            await client.query(
              `UPDATE spread.order_leg
                  SET commission_kd = $2, executions = $3,
                      fee_source = 'COMPUTED', fee_delta_kd = $4, broker_order_id = $5
                WHERE id = $1`, [leg.id, better.kd, execs, delta, row.order_id]);
            await adjustLedger(client, leg, delta, day, `executions ${leg.executions || 1} -> ${execs}`);
            out.adjusted += 1;
          }
        } else {
          out.computed += 1;
          if (apply && leg.fee_source == null) {
            await client.query(`UPDATE spread.order_leg SET fee_source = 'COMPUTED' WHERE id = $1`, [leg.id]);
          }
        }
        await client.query('COMMIT');
        continue;
      }

      const delta = Number((brokerFee - computed).toFixed(3));
      out.broker += 1;
      out.deltaKd += delta;

      if (apply) {
        await client.query(
          `UPDATE spread.order_leg
              SET commission_kd = $2, fee_source = 'BROKER', fee_delta_kd = $3,
                  broker_order_id = $4, broker_net_value_kd = $5,
                  executions = COALESCE($6, executions)
            WHERE id = $1`,
          [leg.id, brokerFee, delta, row.order_id, row.net_value,
            Number(row.executions_observed) || null]);
        if (Math.abs(delta) >= 0.001) {
          await adjustLedger(client, leg, delta, day, `broker charge ${brokerFee} vs computed ${computed}`);
          out.adjusted += 1;
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  out.deltaKd = Number(out.deltaKd.toFixed(3));
  return out;
}

/** A NEW row, never an edit. On the SAME client as the leg update. */
async function adjustLedger(client, leg, deltaKd, day, why) {
  await client.query(
    `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, order_leg_id, note)
     VALUES ($1, 'FEE_CORRECTION', $2, $3, $4)`,
    [day, -deltaKd, leg.id, `${leg.symbol}: ${why}`]);
}

module.exports = { reconcile, brokerFeeOf };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const day = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || kuwaitDay();
  reconcile(day, { apply: argv.includes('--apply') })
    .then((r) => { console.log(JSON.stringify(r, null, 1)); return pool.end(); })
    .catch((e) => require('../lib/dberror').die(e));
}
