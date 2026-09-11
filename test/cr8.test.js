/**
 * CR-8 · four buckets, nothing removed — the ABAR test.
 *
 * ABAR left the scrape on 26 July 2026 and it took a month to notice: no
 * quotes → no symbol_day row → the board joined FROM symbol_day → ABAR was not
 * on the board, and a board without ABAR looks exactly like a board where ABAR
 * failed. The date is a parameter (CR8_DAY / the fixture day): the test is
 * about the SHAPE — a primary instrument with no row for the day, one out of
 * reach at the budget, one suspended, one that only fails the price ceiling —
 * and every one of them must be IN the payload, in the right bucket, with its
 * reason. The buckets must sum to the universe.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('cr8');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const screening = require('../src/services/screening');
const present = require('../src/api/present');
const { GATES } = require('../src/config/spread.config');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = process.env.CR8_DAY || fx.TEST_DAY;          // the screen day — a parameter
const LAST = '2000-12-04';                                // the last day ABAR had a row
const BUDGET = 700;
// The five shapes. Test-prefixed so the fixtures accept them; ABAR is the first.
const ABAR = 'SZTESTABAR';      // R1 · primary, tradeable, NO row for DAY (last row LAST)
const REACH = 'SZTESTREACH';    // R3 · a row, but min_budget_kd 2,500 at a 700 KD slot
const SUSP = 'SZTESTSUSP';      // suspended (is_tradeable false)
const PRICE = 'SZTESTPRICE';    // fails ONLY the price ceiling → PRICE WARN
const OK = 'SZTESTOK';          // a plain row with a quote

const all = (b) => [...b.take, ...b.oneAway, ...b.priceWarn, ...b.leave, ...b.notComputed];
const find = (b, s) => all(b).find((r) => r.symbol === s);

(async () => {
  const syms = [ABAR, REACH, SUSP, PRICE, OK];
  const clean = async () => {
    for (const s of syms) {
      await fx.clearQuotes(s).catch(() => {}); await fx.clearSymbolDay(s).catch(() => {});
      await pool.query('DELETE FROM spread.symbol_profile WHERE symbol = $1', [s]).catch(() => {});
      await fx.clearInstruments(s).catch(() => {});
    }
  };
  try {
    await clean();
    for (const s of syms) await fx.instrument(s);
    await fx.setInstrumentStatus(SUSP, { tradeable: false, brokerStatus: 'DELISTED' });
    // ABAR: a row on LAST only — never on DAY.
    await fx.symbolDay(ABAR, LAST, { close: 210 });
    // the others: a row on DAY
    await fx.symbolDay(REACH, DAY, { close: 200 });
    await fx.symbolDay(SUSP, DAY, { close: 200 });
    await fx.symbolDay(PRICE, DAY, { close: 900 });   // Gate 1 judges the STOCK by its close
    await fx.symbolDay(OK, DAY, { close: 200 });
    await pool.query(
      `INSERT INTO spread.symbol_profile (symbol, as_of, sessions_in_window, min_budget_kd, max_budget_kd)
       VALUES ($1, $2::date, 5, 2500, 9000)`, [REACH, DAY]);
    for (const s of [REACH, SUSP, OK]) await fx.quote(s, { day: DAY, at: `${DAY}T06:00:00Z`, last: 200, bid: 199, offer: 201 });
    // PRICE: a quote far above the 700-KD ceiling (bands: 1t 100-197 … at 790 KD) — the
    // ONLY gate it can fail structurally-not is the ceiling; the stats gates are
    // NOT COMPUTED like every fixture, so the ceiling must be the one REAL failure.
    await fx.quote(PRICE, { day: DAY, at: `${DAY}T06:00:00Z`, last: 900, bid: 899, offer: 901 });

    const { rows: [{ n: universe }] } = await pool.query('SELECT count(*)::int AS n FROM public.instruments WHERE is_primary');
    const b = await screening.screen(DAY, BUDGET, { cfg: GATES });

    console.log('\n=== the universe: every primary instrument is on the board, once ===');
    chk('counts.universe = the primary instruments', b.counts.universe === universe, { got: b.counts.universe, universe });
    chk('the five buckets sum to the universe', all(b).length === universe, { placed: all(b).length, universe });
    chk('no symbol appears twice', new Set(all(b).map((r) => r.symbol)).size === all(b).length);
    for (const s of syms) chk(`${s} is on the board`, !!find(b, s));

    console.log('\n=== R1 · ABAR: no symbol_day row for the day → NOT COMPUTED, the last row named ===');
    const abar = find(b, ABAR);
    chk('ABAR is in NOT COMPUTED', abar && abar.bucket === 'NOT_COMPUTED', abar && abar.bucket);
    chk('  every gate is NOT COMPUTED (none failed for a reason)', abar && abar.failed.length > 0 && abar.notComputed.length === abar.failed.length, abar && { failed: abar.failed.length, nc: abar.notComputed.length });
    chk('  dataQuality MISSING', abar && abar.dataQuality === 'MISSING', abar && abar.dataQuality);
    chk('  noRow, with the last row day', abar && abar.noRow === true && abar.lastRowDay === LAST, abar && { noRow: abar.noRow, last: abar.lastRowDay });
    const abarShown = present.stockCandidate(abar, BUDGET);
    chk('  the card says so: "no symbol_day row for <day> — last row <last>"',
        abarShown.bucket === 'NOT_COMPUTED' && abarShown.status === 'not_computed' && abarShown.noRow === true
        && new RegExp(`no symbol_day row for ${DAY} — last row ${LAST}`).test(abarShown.rejectionDetail || ''), abarShown.rejectionDetail);
    chk('  counts.noRow counts it', b.counts.noRow >= 1, b.counts.noRow);

    console.log('\n=== R3 · out of reach at the budget → LEAVE, structural, present ===');
    const reach = find(b, REACH);
    chk('REACH is in LEAVE', reach && reach.bucket === 'LEAVE', reach && reach.bucket);
    chk('  structural: true, reason OUT_OF_REACH', reach && reach.structural === true && reach.structuralReason === 'OUT_OF_REACH', reach && { s: reach.structural, r: reach.structuralReason });
    const reachShown = present.stockCandidate(reach, BUDGET);
    chk('  the card names the budget it needs', reachShown.isOutOfReach && /out of reach at 700 KD — needs 2500 KD/.test(reachShown.rejectionDetail || ''), reachShown.rejectionDetail);
    chk('  it sorts LAST in LEAVE (the fold), after the non-structural rows', b.leave.findIndex((r) => r.symbol === REACH) >= b.leave.filter((r) => !r.structural).length);
    chk('  counts.outOfReach counts it', b.counts.outOfReach >= 1, b.counts.outOfReach);

    console.log('\n=== suspended → LEAVE, structural SUSPENDED ===');
    const susp = find(b, SUSP);
    chk('SUSP is in LEAVE with reason SUSPENDED', susp && susp.bucket === 'LEAVE' && susp.structuralReason === 'SUSPENDED', susp && { b: susp.bucket, r: susp.structuralReason });
    chk('  the card says suspended with the broker status', /suspended — broker status DELISTED/.test(present.stockCandidate(susp, BUDGET).rejectionDetail || ''));

    console.log('\n=== PRICE WARN · the ceiling is the ONLY real failure ===');
    const price = find(b, PRICE);
    const priceReal = price ? price.failed.filter((f) => !price.notComputed.includes(f)) : null;
    chk('PRICE\'s real failures are the economics pair — price band + profit floor (the rest NOT COMPUTED)',
        priceReal && priceReal.length === 2 && priceReal.includes('price band') && priceReal.includes('profit floor'), priceReal);
    console.log('\n=== the assertion: a removed row is an ERROR, never a shorter board ===');
    // bucketize() on synthetic rows, with funnel.rank patched to lose one: the
    // buckets no longer sum to the input and the screen must THROW, not shrink.
    const funnel = require('../src/lib/funnel');
    const row = (symbol, extra = {}) => ({ symbol, passed: true, failed: [], notComputed: [], reachable: true, structural: false, gates: [], netAtTarget: { netKd: 1 }, ...extra });
    const ok3 = screening.bucketize([row('A'), row('B'), row('C', { passed: false, failed: ['movement'] })], { tradingDay: DAY, budgetKd: BUDGET, cfg: GATES });
    chk('three synthetic rows → TAKE 2, ONE AWAY 1', ok3.take.length === 2 && ok3.oneAway.length === 1);
    const realRank = funnel.rank;
    funnel.rank = (rows) => realRank(rows).slice(1);
    let threw = null;
    try { screening.bucketize([row('A'), row('B')], { tradingDay: DAY, budgetKd: BUDGET, cfg: GATES }); } catch (e) { threw = e; }
    funnel.rank = realRank;
    chk('a bucket that lost a row throws UNIVERSE_MISMATCH', threw && threw.code === 'UNIVERSE_MISMATCH' && /removed/.test(threw.message), threw && threw.message);
    // and the pure PRICE WARN shape, through the real rule
    const pwRow = row('P', { passed: false, failed: ['price band', 'profit floor'], priceFils: 900, orderPriceFils: 899, ceiling: 197,
      gates: [{ id: 1, label: 'Price band', ok: false, notComputed: false, ceiling: 197 }] });
    const pwOut = screening.bucketize([pwRow], { tradingDay: DAY, budgetKd: BUDGET, cfg: GATES });
    chk('a row whose only failing FACT is the price ceiling (Gate 1 + Gate 2) is PRICE WARN, with needsFils', pwOut.priceWarn.length === 1 && Number.isInteger(pwRow.needsFils) && pwRow.needsFils >= 1, { pw: pwOut.priceWarn.length, needs: pwRow.needsFils });
    const btRow = row('T', { passed: false, failed: ['price band'], structural: true, priceFils: 80,
      gates: [{ id: 1, label: 'Price band', ok: false, notComputed: false, structural: true, ceiling: 197 }] });
    const btOut = screening.bucketize([btRow], { tradingDay: DAY, budgetKd: BUDGET, cfg: GATES });
    chk('below the tick is LEAVE, structural BELOW_TICK — present, folded, not removed', btOut.leave.length === 1 && btRow.structuralReason === 'BELOW_TICK');

    console.log('\n=== the old names still answer, for one release ===');
    chk('recommended = take, nearMiss = oneAway, rejected = priceWarn + leave',
        b.recommended === b.take && b.nearMiss === b.oneAway && b.rejected.length === b.priceWarn.length + b.leave.length);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 4).join(' | '));
  }
  await clean().catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
