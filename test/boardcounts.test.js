/**
 * R-38 · TODAY must say WHICH fix applies when a gate cannot be computed.
 *   no quote for this symbol on this day  → a scraper / market question (noQuotes)
 *   a quote present, no gate-stats source → "stats:daily has not run"   (noStats)
 * The board carries the two counts so the browser words the line, not computes it.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('boardcounts');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const screening = require('../src/services/screening');
const { GATES } = require('../src/config/spread.config');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = fx.TEST_DAY;
const NOQ = 'SZTESTNOQ', NOS = 'SZTESTNOS';

(async () => {
  try {
    for (const s of [NOQ, NOS]) { await fx.clearQuotes(s); await fx.instrument(s); await fx.clearSymbolDay(s); }
    // NOQ · a symbol_day row, no quote ever captured → quoteAt null.
    await fx.symbolDay(NOQ, DAY, { close: 200 });
    // NOS · a symbol_day row and a quote, but no bridge stats → gateStatsSource null.
    await fx.symbolDay(NOS, DAY, { close: 200 });
    await fx.quote(NOS, { day: DAY, at: `${DAY}T06:00:00Z`, last: 200, bid: 199, offer: 201 });

    const b = await screening.screen(DAY, 2000, { cfg: GATES });
    // SPR-38 · the board now has a NOT COMPUTED bucket; NOQ/NOS (which fail only
    // on missing stats) live there rather than in rejected. Rebuild the full
    // list from all four buckets — the same shape the board now returns.
    const all = [...b.recommended, ...b.nearMiss, ...b.rejected, ...b.notComputed];
    const noq = all.find((r) => r.symbol === NOQ);
    const nos = all.find((r) => r.symbol === NOS);

    console.log('\n=== R-38 · noQuotes vs noStats ===');
    chk('a symbol with no quotes shows "no quotes" (quoteAt null)', noq && noq.quoteAt == null, noq && { quoteAt: noq.quoteAt });
    chk('a symbol with a quote and no bridge shows "stats:daily has not run"', nos && nos.quoteAt != null && !nos.gateStatsSource, nos && { quoteAt: nos.quoteAt, src: nos.gateStatsSource });
    chk('the board carries the two counts separately', typeof b.counts.noQuotes === 'number' && typeof b.counts.noStats === 'number' && b.counts.noQuotes >= 1 && b.counts.noStats >= 1, { noQuotes: b.counts.noQuotes, noStats: b.counts.noStats });

    console.log('\n=== the screener facts · NEVER TRADED = no order_leg row ever; BOOK CAPTURED = a depth capture today ===');
    // NOS traded ONCE, on a day long before DAY, and has one depth level captured today (DAY).
    await fx.clearLegs(NOS); await fx.clearDepth(NOS);
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, posted_at)
       VALUES ('2000-12-04', $1, 1, 'BUY', 'FILLED', 200, 1000, 1000, '2000-12-04T07:00:00Z')`, [NOS]);
    await fx.depthAt(NOS, `${DAY}T06:30:00Z`, [[1, 199, 1000]]);
    const b2 = await screening.screen(DAY, 2000, { cfg: GATES });
    const all2 = [...b2.recommended, ...b2.nearMiss, ...b2.rejected, ...b2.notComputed];
    const nos2 = all2.find((r) => r.symbol === NOS);
    const noq2 = all2.find((r) => r.symbol === NOQ);
    chk('a symbol with a leg on ANY day is everTraded (not "active on 0 of 5 sessions")', nos2 && nos2.everTraded === true, nos2 && { everTraded: nos2.everTraded });
    chk('a symbol with no leg ever is NOT everTraded', noq2 && noq2.everTraded === false, noq2 && { everTraded: noq2.everTraded });
    chk('a depth capture on the board day is bookCapturedToday', nos2 && nos2.bookCapturedToday === true, nos2 && { captured: nos2.bookCapturedToday });
    chk('no capture on the day is not', noq2 && noq2.bookCapturedToday === false, noq2 && { captured: noq2.bookCapturedToday });
    const present = require('../src/api/present');
    const shown = present.stockCandidate(nos2, 2000);
    chk('the presenter carries both as booleans', shown.everTraded === true && shown.bookCapturedToday === true, { e: shown.everTraded, b: shown.bookCapturedToday });
    const bare = present.stockCandidate({ ...nos2, everTraded: undefined, bookCapturedToday: undefined }, 2000);
    chk('  and null — never false — when the board was built without them', bare.everTraded === null && bare.bookCapturedToday === null, { e: bare.everTraded, b: bare.bookCapturedToday });
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  for (const s of [NOQ, NOS]) { await fx.clearLegs(s).catch(() => {}); await fx.clearDepth(s).catch(() => {}); await fx.clearQuotes(s).catch(() => {}); await fx.clearSymbolDay(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
