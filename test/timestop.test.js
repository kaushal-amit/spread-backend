/**
 * R-21 · the 20-minute time stop (FLOW step 6). A filled buy that has not printed
 * above its entry within time_stop_mins is a time stop; one that moved is not.
 *
 *   filled 09:40, bid still at entry at 10:00   → fires
 *   filled 09:40, printed +1 at 09:55           → does not
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('timestop');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const stops = require('../src/services/stops');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const A = 'SZTESTTSA', B = 'SZTESTTSB';
const DAY = '2001-01-08';
const at = (hhmm) => `${DAY}T${hhmm}:00+03:00`;

(async () => {
  try {
    for (const s of [A, B]) { await fx.clearLegs(s); await fx.clearQuotes(s); await fx.instrument(s); }
    // A: bought 164 at 09:40, the bid sits at 164 (never above) through 10:00.
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, posted_at, resolved_at)
       VALUES ($1,$2,1,'BUY','FILLED',164,1000,1000,$3,$3)`, [DAY, A, at('09:40')]);
    await fx.quote(A, { day: DAY, at: at('09:45'), last: 164, bid: 164, offer: 165 });
    await fx.quote(A, { day: DAY, at: at('09:59'), last: 164, bid: 164, offer: 165 });
    // B: bought 200 at 09:40, printed 201 at 09:55 — it moved.
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, posted_at, resolved_at)
       VALUES ($1,$2,1,'BUY','FILLED',200,1000,1000,$3,$3)`, [DAY, B, at('09:40')]);
    await fx.quote(B, { day: DAY, at: at('09:55'), last: 201, bid: 201, offer: 202 });
    await fx.quote(B, { day: DAY, at: at('09:59'), last: 200, bid: 200, offer: 201 });

    console.log('\n=== R-21 · the time stop fires only when the position never moved ===');
    const ts = await stops.timeStops(DAY, { now: new Date(at('10:00')), t: { time_stop_mins: 20 } });
    const a = ts.find((x) => x.symbol === A);
    const b = ts.find((x) => x.symbol === B);
    chk('A (bid at entry for 20 min) fires', !!a && a.minutesHeld >= 20 && a.entry === 164 && a.bid === 164, a);
    chk('B (printed +1 at 09:55) does not fire', !b, b);
    // Before 20 minutes, A does not fire either.
    const early = await stops.timeStops(DAY, { now: new Date(at('09:55')), t: { time_stop_mins: 20 } });
    chk('A does not fire at 09:55 (only 15 minutes held)', !early.find((x) => x.symbol === A), early);
    // evaluate() carries the list and the threshold.
    const ev = await stops.evaluate(DAY, { now: new Date(at('10:00')) });
    chk('evaluate() carries timeStops and timeStopMins', Array.isArray(ev.timeStops) && ev.timeStopMins === 20 && ev.timeStops.some((x) => x.symbol === A), { mins: ev.timeStopMins, syms: ev.timeStops.map((x) => x.symbol) });

    console.log('\n=== A1 · the time stop takes precedence over hold-to-flat ===');
    // A is a dead position at 20 min → the time stop. B moved (+1 print) and is
    // still open before 12:45 → held to flat. A must be on the time-stop list and
    // NOT told to hold; the two never conflict.
    const aHeld = ev.holdToFlat.some((x) => x.symbol === A);
    const aStopped = ev.timeStops.some((x) => x.symbol === A);
    chk('A (dead 20 min) gets the time stop, not a hold', aStopped && !aHeld, { aStopped, aHeld });
    chk('B (moved, open, pre-12:45) is held to flat', ev.holdToFlat.some((x) => x.symbol === B), ev.holdToFlat);
    chk('hold-to-flat is on and carries the flat time', ev.holdToFlatBy === true && ev.holdToFlat.every((x) => x.flatBy), ev.holdToFlat);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  for (const s of [A, B]) { await fx.clearLegs(s).catch(() => {}); await fx.clearQuotes(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
