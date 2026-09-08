/**
 * SPR-01 · the board screens the latest COMPLETED session, not today's empty row.
 *
 * spread.symbol_day is written at 13:30 after the close, so mid-session TODAY has
 * no row and the board defaulted to it — returning 0 symbols while the market
 * traded. resolveScreenDay falls back to the latest symbol_day on or before the
 * asked day, so a live session screens yesterday's stats (joined with today's
 * live quotes elsewhere).
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('boardday');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const { resolveScreenDay } = require('../src/api/routes');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const HAS = '2003-04-05';        // a completed session (fossil, isolated, after other suites' fossils)
const LATER = '2003-04-12';      // a later day with no row — "today, mid-session"

(async () => {
  try {
    await fx.clearSymbolDay('SZTESTBD');
    await fx.instrument('SZTESTBD');
    await fx.symbolDay('SZTESTBD', HAS, { close_px: 250, prev_close: 248 });

    const askedHas = await resolveScreenDay(HAS);
    chk('a day that has a symbol_day row screens that day', askedHas === HAS, askedHas);

    const askedLater = await resolveScreenDay(LATER);
    chk('a later day with no row falls back to the latest completed session', askedLater === HAS, askedLater);

    // Nothing on or before an early day → return the asked day unchanged (empty
    // board then means no data, not the wrong day).
    const askedEarly = await resolveScreenDay('1990-01-01');   // before any fossil row
    chk('a day with nothing on or before it returns unchanged (no silent jump forward)', askedEarly === '1990-01-01', askedEarly);

    await fx.clearSymbolDay('SZTESTBD');
    console.log(`\nboard day: ${p}/${n}`);
    await pool.end();
    process.exit(p === n ? 0 : 1);
  } catch (e) {
    console.error('boardday suite error:', e);
    process.exit(1);
  }
})();
