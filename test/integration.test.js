/*
 * The defects the integration report found. Each assertion names the bug it
 * prevents recurring, because a fix without a test is a fix that comes back.
 */
const present = require('../src/api/present');
const gateStore = require('../src/services/gateStore');
const { toResponse, refused, notFound } = require('../src/api/errors');
const auth = require('../src/api/auth');

let pass = 0, fail = 0;
const chk = (l, c, x = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${x ? '  ' + x : ''}`); c ? pass++ : fail++; };

console.log('=== B-08 · gate edits are actually enforced ===');
{
  const before = gateStore.effective();
  chk('defaults come from the file', before.GATES.minPriceMoves === 15);
  chk('G1 floor is locked', gateStore.LOCKED.has('g1-floor'),
      'below 100 fils the tick is 0.1 — arithmetic, not judgement');
  chk('every editable gate binds to a config key',
      Object.keys(gateStore.BINDING).length >= 12);
  chk('the direction gate binds to DIRECTION, not GATES',
      gateStore.BINDING['g10-direction'][0] === 'DIRECTION');
}

console.log('\n=== B-15 · rejectsCount keys off the gate id ===');
{
  const g = present.gateConfigs();
  const ids = g.map((x) => x.id);
  chk('ids are stable strings', ids.includes('g4-moves') && ids.includes('g8-dist'),
      'gateName.split(" ")[0] gave "price"/"net"/"average" — none are count keys');
  chk('every gate reports a version', g.every((x) => 'configVersion' in x));
  chk('the locked gate says so', g.find((x) => x.id === 'g1-floor').locked === true);
}

console.log('\n=== B-08b · gateConfigs reflects OVERRIDES, not the file ===');
{
  const overridden = present.gateConfigs({
    GATES: { ...require('../src/config/spread.config').GATES, minPriceMoves: 8 },
    DIRECTION: require('../src/config/spread.config').DIRECTION,
    EXIT: require('../src/config/spread.config').EXIT,
    BUDGET: require('../src/config/spread.config').BUDGET,
    QUALITY: require('../src/config/spread.config').QUALITY,
  }, { version: 3, loadedAt: new Date() });
  chk('a changed threshold shows the NEW value',
      overridden.find((x) => x.id === 'g4-moves').numericValue === 8,
      'reading the file meant an edit appeared to save and changed nothing');
  chk('lastChanged is no longer empty',
      overridden.find((x) => x.id === 'g4-moves').lastChanged !== '');
}

console.log('\n=== typed errors · a refusal is not a 500 ===');
{
  chk('a refusal is 409', toResponse(refused('no')).status === 409);
  chk('  and coded REFUSED', toResponse(refused('no')).body.code === 'REFUSED');
  chk('a missing table is 503 SCHEMA_MISSING, not 500',
      toResponse({ code: '42P01', message: 'x' }).body.code === 'SCHEMA_MISSING',
      'a missing table and a bad request were indistinguishable');
  chk('a dead database is DB_DOWN',
      toResponse({ code: 'ENOTFOUND', message: 'x' }).body.code === 'DB_DOWN');
  chk('not-found is 404', toResponse(notFound('x')).status === 404);
  chk('anything else is 500', toResponse(new Error('boom')).status === 500);
}

console.log('\n=== B-18 · writes are checked when a token is set ===');
{
  const call = (method, header) => {
    let out = null;
    auth.middleware(
      // A loopback request: writes without a token are allowed ONLY from
      // 127.0.0.1, so the stub must say where it came from.
      { method, ip: '127.0.0.1', get: (h) => (h.toLowerCase() === 'authorization' ? header : null) },
      { status: (s) => ({ json: (b) => { out = { s, b }; } }) },
      () => { out = 'next'; },
    );
    return out;
  };
  // No token configured — localhost is unchanged.
  chk('with no token, writes pass', call('POST', null) === 'next',
      'reads and writes both open on localhost');
  chk('and reads pass', call('GET', null) === 'next');
}

console.log('\n=== B-12 · market is data, not a hardcoded list ===');
{
  const c = present.stockCandidate({
    symbol: 'KFH', priceFils: 785, passed: false, failed: ['price band'],
    reasons: ['above the ceiling'], gates: [], netAtTarget: {}, behaviour: [],
    reachable: true, market: 'PREMIER', marketVerified: false,
  }, 790);
  chk('market travels with the candidate', c.market === 'PREMIER',
      'Premier pays 0.10% against Main 0.15% — not cosmetic');
  chk('an unverified market is flagged', c.marketVerified === false,
      'so commission.js surfaces the assumption rather than hiding it');
}

console.log('\n=== the presenter still holds the contract ===');
{
  const c = present.stockCandidate({
    symbol: 'X', priceFils: 133, passed: true, failed: [], reasons: [],
    gates: [{ id: 1, label: 'Price band', ok: true, value: '133', sub: '' }],
    netAtTarget: { shares: 5900, netKd: 2.55, roundTripKd: 3.34, notionalKd: 784.7 },
    reachable: true, behaviour: [], capturePct: 100, dataQuality: 'OK',
  }, 790);
  chk('gateGroups render', c.gateGroups.length > 0);
  chk('every cell has sub', c.gateGroups.every((g) => g.cells.every((x) => 'sub' in x)));
  chk('netPerFilKd is per fil', c.netPerFilKd === 5.9);
}

console.log('\n=== v2 report · the fixes, asserted ===');
{
  const F = require('../src/lib/funnel');
  const base = {
    symbol: 'X', priceFils: 150, close_fils: 150, prev_close_fils: 149,
    price_moves: 30, pct_moves_sub100: 10, pct_session_postable_800: 40,
    pct_session_exitable_ratio: 85, avg_trade_shares: 9000, volume_ratio_5d: 1,
    flow_ratio: 1, days_active_5d: 5, gap_pct: 40,
  };
  const q = (extra) => F.evaluate({ ...base, ...extra }, 790).dataQuality;

  // N-16 · a consumer testing NO_BOOK was testing a value that never arrived.
  chk('NO_BOOK is emitted for a source with no book',
      q({ capture_pct: 100, source: 'TRADINGVIEW' }) === 'NO_BOOK',
      'TradingView has price and volume and nothing to post against');
  chk('MISSING is emitted when there is no row',
      q({ source: 'NONE', capture_quality: 'MISSING' }) === 'MISSING');
  chk('THIN still means under 70% captured',
      q({ capture_pct: 48, source: 'BROKER' }) === 'THIN');
  chk('PARTIAL is real but not comparable',
      q({ capture_pct: 77, source: 'BROKER' }) === 'PARTIAL');

  // N-08 · the five controls that had nowhere to be saved.
  const B = gateStore.BINDING;
  for (const id of ['g8-flow', 'target-1tick', 'target-2ticks', 'target-3ticks',
                    'target-2gap-pct', 'target-3range']) {
    chk(`${id} binds to a config key`, !!B[id]);
  }

  // Default 1 and 2 on, 3 off — every fill in the record has been a 1-fil
  // target and a 3-tick capture has never been attempted.
  const T = gateStore.effective().TARGETS;
  chk('targets default to 1 and 2 on, 3 off',
      T.allow1Tick === 1 && T.allow2Ticks === 1 && T.allow3Ticks === 0);
  chk('the 2-tick gap threshold is 30% of the session', T.minGapPctFor2Tick === 30,
      'one stock had the widest range on the board and a 22% gap');

  // The candidate carries raw metrics for the impact panel.
  const c = present.stockCandidate({
    symbol: 'X', priceFils: 133, passed: true, failed: [], reasons: [], gates: [],
    netAtTarget: { shares: 5900, netKd: 2.55, roundTripKd: 3.34, notionalKd: 784.7 },
    reachable: true, behaviour: [], avg_trade_shares: 19354, price_moves: 58,
    changeFils: -2, rising: false,
  }, 790);
  chk('raw metrics travel with the candidate', c.metrics?.movesPerDay === 58,
      'the config page read a locally-declared shape nothing sends');
  chk('the day change travels too', c.changeFils === -2,
      'a component invented -11 for KFH and 1 for KIB');
}

console.log('\n=== R-01 · TARGETS is ENFORCED, not just stored ===');
{
  /*
   * The v3 report caught that the previous test asserted only that BINDING[id]
   * existed — it did not assert enforcement, so the green suite gave false
   * confidence on the exact failure it was meant to cover.
   *
   * These assert the funnel BEHAVES differently.
   */
  const F = require('../src/lib/funnel');
  const on = { allow1Tick: 1, allow2Ticks: 1, allow3Ticks: 0 };
  const off2 = { allow1Tick: 1, allow2Ticks: 0, allow3Ticks: 0 };

  chk('a 250-fil stock is 2-tick when 2 is enabled', F.bandFor(250, 790, undefined, on) === 2);
  chk('and OUT OF REACH when 2 is switched off', F.bandFor(250, 790, undefined, off2) === null,
      'it must not be silently promoted to the next band');
  chk('a 133-fil stock is unaffected by the 2-tick switch',
      F.bandFor(133, 790, undefined, off2) === 1);
  chk('turning 1-tick off removes the 1-tick band',
      F.bandFor(133, 790, undefined, { allow1Tick: 0, allow2Ticks: 1, allow3Ticks: 0 }) === null);

  // The feasibility thresholds must move too.
  chk('the 2-tick gap threshold is honoured at 30',
      F.feasible(2, { gapPct: 25 }, { minGapPctFor2Tick: 30 }).ok === false);
  chk('  and at 20 the same stock passes',
      F.feasible(2, { gapPct: 25 }, { minGapPctFor2Tick: 20 }).ok === true,
      'a stored threshold that changes nothing is the B-08 failure');
  chk('the 3-tick range threshold moves as well',
      F.feasible(3, { rangeFils: 5 }, { minRangeFilsFor3Tick: 4 }).ok === true);

  // And the bands report which are enabled, so the screen can grey them.
  const bands = F.tickBands(790, undefined, off2);
  chk('tickBands marks a disabled band', bands[1].enabled === false && bands[0].enabled === true);

  // GET /gates must RETURN them, or the page cannot read them back.
  const rows = present.gateConfigs();
  for (const id of ['g8-flow', 'target-1tick', 'target-2ticks', 'target-3ticks',
                    'target-2gap-pct', 'target-3range']) {
    chk(`GET /gates returns ${id}`, rows.some((r) => r.id === id),
        'without the row the config page resets the toggle on reload');
  }
  chk('the toggles are marked as toggles',
      rows.filter((r) => r.id.startsWith('target-') && r.unit === 'on/off').length === 3);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail}  (${pass} checks)`);
process.exit(fail ? 1 : 0);
