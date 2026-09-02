/**
 * The broker's charge outranks our arithmetic.
 *
 * Commission is per EXECUTION. A 6,100-share sell filling as 5,350 + 750 was
 * charged 2.285; the formula, assuming one execution, expects 1.680. Wrong by
 * 0.605 KD and ALWAYS in the same direction — every split fill under-reports.
 */
const { pool } = require('../src/db');
const { reconcile } = require('../src/jobs/reconcile-fees');
const COMMISSION = require('../src/lib/commission');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = '2026-08-24';

(async () => {
  /**
   * cash_movement FIRST: it has a foreign key to order_leg, so deleting the
   * leg while a correction row points at it fails. Order matters, and the
   * first version had it backwards.
   */
  const clean = async () => {
    await pool.query(
      `DELETE FROM spread.cash_movement WHERE order_leg_id IN
         (SELECT id FROM spread.order_leg WHERE symbol LIKE 'FEE%')`);
    await pool.query("DELETE FROM spread.order_leg WHERE symbol LIKE 'FEE%'");
    await pool.query("DELETE FROM public.awsat_order_list WHERE symbol LIKE 'FEE%'");
  };
  try {
    await clean();
    // spread.symbol dropped — its foreign key from order_leg went too, so
    // these rows no longer need registering anywhere.

    console.log('\n=== the arithmetic, before anything is stored ===');
    const notional = (128 * 6100) / 1000;
    const one = COMMISSION.sideFeeKd(notional, { day: DAY, executions: null });
    const two = COMMISSION.sideFeeKd(notional, { day: DAY, executions: 2 });
    chk('assuming ONE execution under-reports', one.kd < two.kd, [one.kd, two.kd]);
    chk('and the gap is the settlement fee, charged twice',
        Number((two.kd - one.kd).toFixed(3)) > 0, Number((two.kd - one.kd).toFixed(3)));

    console.log('\n=== BROKER wins where a row matches ===');
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status,
         price_fils, shares, filled_shares, commission_kd, executions, posted_at)
       VALUES ($1,'FEESPLIT',1,'SELL','FILLED',128,6100,6100,$2,1,now())`, [DAY, one.kd]);
    await pool.query(
      `INSERT INTO public.awsat_order_list (order_id, symbol, side, order_status, price,
         quantity, filled_quantity, order_value, net_value, executions_observed,
         trading_date, ingest_source, created_at)
       VALUES ('BRK-1','FEESPLIT','SELL','Filled',128,6100,6100,780.8,778.515,2,$1,'awsat_client',now())`, [DAY]);

    const dry = await reconcile(DAY);
    chk('a dry run changes nothing', dry.broker === 1, dry);
    const { rows: before } = await pool.query(
      "SELECT fee_source FROM spread.order_leg WHERE symbol='FEESPLIT'");
    chk('and really nothing', before[0].fee_source === null, before[0]);

    const r = await reconcile(DAY, { apply: true });
    const { rows: after } = await pool.query(
      `SELECT commission_kd, fee_source, fee_delta_kd, broker_order_id,
              broker_net_value_kd, executions FROM spread.order_leg WHERE symbol='FEESPLIT'`);
    const a = after[0];
    chk('fee_source is BROKER', a.fee_source === 'BROKER', a);
    chk('the fee is the broker CHARGE, 780.8 - 778.515',
        Math.abs(Number(a.commission_kd) - 2.285) < 0.001, a.commission_kd);
    chk('fee_delta_kd records the disagreement',
        Number(a.fee_delta_kd) > 0.5, a.fee_delta_kd);
    chk('the broker order id is stored — the column existed and was dead',
        a.broker_order_id === 'BRK-1', a.broker_order_id);
    chk('and net_value with it', Math.abs(Number(a.broker_net_value_kd) - 778.515) < 0.001);
    chk('executions comes across as a FLOOR', Number(a.executions) === 2, a.executions);

    console.log('\n=== the ledger is ADJUSTED, not edited ===');
    const { rows: cm } = await pool.query(
      `SELECT kind, amount_kd, order_leg_id FROM spread.cash_movement
        WHERE kind = 'FEE_CORRECTION' AND trading_day = $1`, [DAY]);
    chk('a new cash_movement row exists', cm.length === 1, cm.length);
    chk('it is negative — the fee was higher than we thought',
        Number(cm[0].amount_kd) < 0, cm[0].amount_kd);
    chk('and it names the leg it corrects', cm[0].order_leg_id !== null, cm[0]);

    console.log('\n=== TWO matches mean NEITHER ===');
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status,
         price_fils, shares, filled_shares, commission_kd, posted_at)
       VALUES ($1,'FEEDUP',1,'BUY','FILLED',200,1000,1000,0.5,now())`, [DAY]);
    for (const id of ['DUP-1', 'DUP-2']) {
      await pool.query(
        `INSERT INTO public.awsat_order_list (order_id, symbol, side, order_status, price,
           quantity, filled_quantity, order_value, net_value, executions_observed,
           trading_date, ingest_source, created_at)
         VALUES ($2,'FEEDUP','BUY','Filled',200,1000,1000,200,200.3,1,$1,'awsat_client',now())`,
        [DAY, id]);
    }
    const amb = await reconcile(DAY, { apply: true });
    const { rows: d } = await pool.query(
      "SELECT fee_source, commission_kd FROM spread.order_leg WHERE symbol='FEEDUP'");
    chk('two candidates -> AMBIGUOUS', d[0].fee_source === 'AMBIGUOUS', d[0]);
    chk('and the fee is UNCHANGED — a guess is worse than an honest computed',
        Math.abs(Number(d[0].commission_kd) - 0.5) < 0.001, d[0].commission_kd);
    chk('the run counts it', amb.ambiguous >= 1, amb);

    console.log('\n=== no broker row -> COMPUTED, and it says so ===');
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status,
         price_fils, shares, filled_shares, commission_kd, posted_at)
       VALUES ($1,'FEENONE',1,'BUY','FILLED',150,2000,2000,0.45,now())`, [DAY]);
    await reconcile(DAY, { apply: true });
    const { rows: none } = await pool.query(
      "SELECT fee_source FROM spread.order_leg WHERE symbol='FEENONE'");
    chk('fee_source is COMPUTED', none[0].fee_source === 'COMPUTED', none[0]);

    console.log('\n=== executions_observed fixes a split fill with NO net_value ===');
    const cheap = COMMISSION.sideFeeKd((190 * 4000) / 1000, { day: DAY, executions: null });
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status,
         price_fils, shares, filled_shares, commission_kd, executions, posted_at)
       VALUES ($1,'FEEEXEC',1,'SELL','FILLED',190,4000,4000,$2,1,now())`, [DAY, cheap.kd]);
    await pool.query(
      `INSERT INTO public.awsat_order_list (order_id, symbol, side, order_status, price,
         quantity, filled_quantity, order_value, net_value, executions_observed,
         trading_date, ingest_source, created_at)
       VALUES ('EXEC-1','FEEEXEC','SELL','Filled',190,4000,4000,NULL,NULL,3,$1,'awsat_client',now())`, [DAY]);
    await reconcile(DAY, { apply: true });
    const { rows: ex } = await pool.query(
      "SELECT commission_kd, executions, fee_source FROM spread.order_leg WHERE symbol='FEEEXEC'");
    chk('the count is taken even without net_value', Number(ex[0].executions) === 3, ex[0]);
    chk('and the fee rises to match', Number(ex[0].commission_kd) > Number(cheap.kd), ex[0]);
    chk('marked COMPUTED — it is still our arithmetic', ex[0].fee_source === 'COMPUTED', ex[0]);

    console.log('\n=== one query answers "how often, and by how much" ===');
    const { rows: q } = await pool.query(
      `SELECT fee_source, count(*)::int AS legs, COALESCE(sum(fee_delta_kd),0) AS delta
         FROM spread.order_leg WHERE trading_day = $1 AND fee_source IS NOT NULL
        GROUP BY fee_source ORDER BY fee_source`, [DAY]);
    chk('every source is represented', q.length >= 3, q.map((x) => x.fee_source));
    chk('and the delta survives the broker row being pruned',
        q.some((x) => Number(x.delta) !== 0), q);
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }
  await clean().catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
