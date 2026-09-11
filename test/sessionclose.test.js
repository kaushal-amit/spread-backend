/**
 * SPR-37 · 13:30 is the end of the trading day. Nothing evaluates after it.
 *
 * The engine reads the exchange phase from awsat_market_quotes.session, not its
 * own clock and not awsat_market_summary.session_state (which stays 'LIVE'):
 *   Trading / NULL  → evaluate
 *   any close phase → closed, one verdict, no breadth churn
 *   Trading past 13:30 (a capture left running) → closed regardless
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('sessionclose');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const stops = require('../src/services/stops');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = '2003-06-08';                     // an isolated SUNDAY nothing else touches (a Saturday is closed by rule)
const SYM = 'SZTESTCLOSE';
// A Kuwait wall-clock instant on DAY (UTC+3, no DST).
const kut = (hh, mm) => new Date(Date.UTC(2003, 5, 8, hh - 3, mm, 0));

(async () => {
  try {
    await fx.clearQuotes(SYM);
    await fx.instrument(SYM);

    console.log('\n=== a close phase near now → CLOSED, no breadth evaluation ===');
    // Close-Of-Day capture at 13:20, evaluate at 13:22.
    await fx.quote(SYM, { day: DAY, at: kut(13, 20).toISOString(), session: 'Close-Of-Day', last: 100, bid: 99, offer: 101 });
    const closed = await stops.evaluate(DAY, { now: kut(13, 22) });
    chk('mode is closed', closed.mode === 'closed', closed.mode);
    chk('cannot open', closed.canOpen === false, closed.canOpen);
    chk('market verdict is closed (not a breadth number)', closed.market.verdict === 'closed' && closed.market.breadthPct === null, closed.market);
    chk('one reason, naming the phase', closed.reasons.length === 1 && /Close-Of-Day/.test(closed.reasons[0]), closed.reasons);
    chk('marketPhase is surfaced', closed.marketPhase === 'Close-Of-Day', closed.marketPhase);

    console.log('\n=== Trading before 13:30 → NOT closed (evaluates) ===');
    await fx.clearQuotes(SYM);
    await fx.quote(SYM, { day: DAY, at: kut(11, 0).toISOString(), session: 'Trading', last: 100, bid: 99, offer: 101 });
    const open = await stops.evaluate(DAY, { now: kut(11, 2) });
    chk('not marked closed', open.closed === false && open.mode !== 'closed', [open.closed, open.mode]);

    console.log('\n=== Trading past 13:30 (capture left running) → CLOSED regardless ===');
    await fx.clearQuotes(SYM);
    await fx.quote(SYM, { day: DAY, at: kut(14, 45).toISOString(), session: 'Trading', last: 100, bid: 99, offer: 101 });
    const stuck = await stops.evaluate(DAY, { now: kut(14, 47) });
    chk('past 13:30 with a stuck Trading capture → closed', stuck.mode === 'closed' && stuck.closed === true, [stuck.mode, stuck.marketPhase]);
    chk('reason names the close (13:00 — continuous trading over)', /13:00/.test(stuck.reasons.join(' ')), stuck.reasons);
    // 10 Sep · canOpen follows the 13:00 close, not the 13:30 data window: a
    // "Trading" quote at 13:05 is a capture lag, not a session.
    await fx.clearQuotes(SYM);
    await fx.quote(SYM, { day: DAY, at: kut(13, 3).toISOString(), session: 'Trading', last: 100, bid: 99, offer: 101 });
    const lag = await stops.evaluate(DAY, { now: kut(13, 5) });
    chk('13:05 with a Trading quote → closed (continuous trading ended 13:00)', lag.closed === true && lag.canOpen === false, [lag.mode, lag.reasons]);
    const late = await stops.evaluate(DAY, { now: kut(12, 58) });
    chk('12:58 → not closed (past flat-by, but the session is on)', late.closed === false, [late.closed, late.mode]);

    console.log('\n=== no recent reading → NULL phase → evaluates (July capture defect) ===');
    await fx.clearQuotes(SYM);
    // a Trading row far in the past (outside the 15-min window) must not decide the phase
    await fx.quote(SYM, { day: DAY, at: kut(9, 0).toISOString(), session: 'Trading', last: 100, bid: 99, offer: 101 });
    const noRecent = await stops.evaluate(DAY, { now: kut(11, 30) });
    chk('a stale reading does not close the market', noRecent.closed === false && noRecent.marketPhase === null, [noRecent.closed, noRecent.marketPhase]);

    await fx.clearQuotes(SYM);
    console.log(`\n${p}/${n} PASS`);
    if (p !== n) process.exitCode = 1;
  } catch (e) {
    console.error('sessionclose.test.js FAILED', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
