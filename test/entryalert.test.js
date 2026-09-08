/**
 * SPR-06/23 + SPR-24 · the entry-alert window is RECORDED and CLOSED.
 *
 *   fire(suppressed) writes the row marked held, with the reason      (06/23)
 *   fire() default    writes the row not suppressed                   (06/23)
 *   closeWindow()      stamps window_closed_at and a real duration     (24)
 *
 * The bug these close: every entry_alert.window_seconds was NULL, because the
 * scanner deduped on a cooldown timer and never told the row its window had
 * ended; and a non-BUY depth read that opened a window on spread alone went to
 * the phone instead of being recorded off it.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('entryalert');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const alerts = require('../src/services/alerts');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = kuwaitDay();
const SYM = 'SZTESTALERT';

(async () => {
  try {
    await fx.instrument(SYM);
    await pool.query('DELETE FROM spread.entry_alert WHERE symbol = $1', [SYM]);

    const base = { symbol: SYM, bidFils: 240, offerFils: 243, spreadFils: 3,
      offerShares: 5000, myShares: 4000, estFillMins: 2, depthSignal: 'SELL' };

    console.log('\n=== SPR-06/23 · a vetoed window is recorded, off the phone ===');
    const heldId = await alerts.fire(base, DAY, {
      suppressed: true, suppressedReason: 'held off the phone — depth SELL' });
    const { rows: [held] } = await pool.query(
      'SELECT suppressed, suppressed_reason, depth_signal FROM spread.entry_alert WHERE id = $1', [heldId]);
    chk('the row exists and is marked suppressed', held.suppressed === true, held);
    chk('  with the reason recorded', /depth SELL/.test(held.suppressed_reason || ''), held.suppressed_reason);
    chk('  and the depth signal is stored', held.depth_signal === 'SELL', held.depth_signal);

    console.log('\n=== SPR-06/23 · a clean BUY window is recorded, not suppressed ===');
    const buyId = await alerts.fire({ ...base, depthSignal: 'BUY' }, DAY);
    const { rows: [buy] } = await pool.query(
      'SELECT suppressed FROM spread.entry_alert WHERE id = $1', [buyId]);
    chk('suppressed defaults false', buy.suppressed === false, buy);

    console.log('\n=== SPR-24 · closeWindow stamps a real duration ===');
    // A window that opened 90 seconds ago (the study's shape: ~3.3-minute windows).
    const { rows: [seed] } = await pool.query(
      `INSERT INTO spread.entry_alert (trading_day, symbol, fired_at, depth_signal)
       VALUES ($1, $2, now() - interval '90 seconds', 'BUY') RETURNING id;`, [DAY, SYM]);
    await alerts.closeWindow(seed.id);
    const { rows: [closed] } = await pool.query(
      'SELECT window_closed_at, window_seconds FROM spread.entry_alert WHERE id = $1', [seed.id]);
    chk('window_closed_at is set', closed.window_closed_at != null, closed);
    chk('window_seconds is ~90, not NULL', closed.window_seconds >= 85 && closed.window_seconds <= 95, closed.window_seconds);

    console.log('\n=== SPR-24 · closeWindow is idempotent (a second call does not move it) ===');
    const firstClose = closed.window_closed_at;
    await alerts.closeWindow(seed.id);
    const { rows: [again] } = await pool.query(
      'SELECT window_closed_at FROM spread.entry_alert WHERE id = $1', [seed.id]);
    chk('the close time did not change', String(again.window_closed_at) === String(firstClose), again);

    await pool.query('DELETE FROM spread.entry_alert WHERE symbol = $1', [SYM]);
    console.log(`\n${p}/${n} PASS`);
    if (p !== n) process.exitCode = 1;
  } catch (e) {
    console.error('entryalert.test.js FAILED', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
