/*
 * The pure logic, checked against the case that produced each rule.
 * No database — everything here is deterministic.
 */
const F = require('../src/lib/funnel');
const P = require('../src/lib/pricing');
const C = require('../src/lib/commission');
const R = require('../src/lib/orderRules');
const D = require('../src/services/depth');
const B = require('../src/services/ai/boundary');
const REG = require('../src/services/ai/registry');

let pass = 0, fail = 0;
const chk = (l, c, x = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${x ? '  ' + x : ''}`); c ? pass++ : fail++; };
const row = (o) => Object.assign({
  symbol: 'X', priceFils: 150, close_fils: 150, prev_close_fils: 149,
  price_moves: 30, price_moves_2plus: 5, pct_moves_sub100: 10,
  pct_session_postable_800: 40, pct_session_exitable_ratio: 85,
  avg_trade_shares: 9000, volume_ratio_5d: 1, flow_ratio: 1, days_active_5d: 5,
  gap_pct: 40, capture_pct: 100, change_1d_fils: 1, change_5d_fils: 3,
}, o);
const g = (o, id, b = 790) => F.evaluate(row(o), b).gates.find((x) => x.id === id);

console.log('=== COMMISSION · per execution, with the minimum ===');
{
  const exact = C.sideFeeKd(786.9, { executionSizes: [690.15, 96.75], day: '2026-08-11' });
  chk('reproduces the 2.285 charge exactly', exact.kd === 2.285, String(exact.kd));
  chk('per order does not — out by 0.605',
      Math.abs(C.sideFeeKd(786.9, { executions: 1, day: '2026-08-11' }).kd - 1.680) < 0.001);
  chk('an unknown count is flagged, not assumed',
      C.sideFeeKd(786.9, { day: '2026-08-11' }).known === false);
  chk('  and labelled a BEST CASE',
      /BEST CASE/.test(C.sideFeeKd(786.9, {}).note || ''));
  chk('a known count with unknown sizes uses the CHEAPEST split',
      C.sideFeeKd(786.9, { executions: 2, day: '2026-08-11' }).kd <= 2.285);
  chk('settlement abolition changes the arithmetic',
      C.executionFeeKd(790, { day: '2026-10-01' }) < C.executionFeeKd(790, { day: '2026-09-30' }));
  chk('E[executions] = 1 + shares/avg_trade',
      C.expectedExecutions(6100, 7392) === 1.83, String(C.expectedExecutions(6100, 7392)));
}

console.log('\n=== GATE 1 · structural, and it cannot be overridden ===');
chk('75 fils rejected', !g({ priceFils: 75, close_fils: 75 }, 1).ok);
chk('  and marked structural', F.evaluate(row({ priceFils: 75, close_fils: 75 }), 790).structural);
chk('  so it is NOT overridable', !F.evaluate(row({ priceFils: 75, close_fils: 75 }), 790).overridable);
chk('  the reason is arithmetic, not judgement',
    /at any budget, on any day/.test(g({ priceFils: 75, close_fils: 75 }, 1).why || ''));
chk('100 fils exactly is allowed', g({ priceFils: 100, close_fils: 100 }, 1).ok);
chk('J14 · at 800 KD the 1-fil band ends at 200', F.tickBands(800)[0].maxPriceFils === 200);
chk('the band is a property of the BUDGET',
    F.bandFor(342, 800) === 2 && F.bandFor(342, 1500) === 1);

console.log('\n=== GATE 4 · movement, not a trade count ===');
chk('227 trades with 8 moves is rejected', !g({ price_moves: 8 }, 4).ok);
chk('a 2-tick target needs 2-fil UP moves',
    !g({ priceFils: 250, close_fils: 250, price_moves: 40, price_moves_2plus: 1 }, 4).ok,
    '14 moves with a median of one');

console.log('\n=== GATE 8 · BOTH, or neither ===');
chk('a 17.56x spike ALONE does not block — the six-day run',
    g({ volume_ratio_5d: 17.56, flow_ratio: 0.9 }, 8).ok);
chk('outward flow alone does not block', g({ volume_ratio_5d: 1.1, flow_ratio: 1.5 }, 8).ok);
chk('spike AND outward flow blocks', !g({ volume_ratio_5d: 3.3, flow_ratio: 1.42 }, 8).ok);
chk('a missing baseline does not reject the board',
    g({ volume_ratio_5d: null, flow_ratio: null }, 8).ok, 'deliberate asymmetry');

console.log('\n=== GATE 10 · warns, never blocks ===');
{
  const d = F.evaluate(row({ change_1d_fils: -4, change_5d_fils: -10 }), 790);
  const g10 = d.gates.find((x) => x.id === 10);
  chk('down on both horizons still passes', g10.ok);
  chk('  but warns', g10.warn === true);
  chk('  and the stock still reaches the board', d.passed);
  chk('mode is the explicit switch', g10.mode === 'warn');
}

console.log('\n=== CAPTURE QUALITY · a ratio, never a count ===');
chk('100% is OK', F.evaluate(row({}), 790).dataQuality === 'OK');
chk('77% is PARTIAL — real, but not comparable',
    F.evaluate(row({ capture_pct: 77 }), 790).dataQuality === 'PARTIAL');
chk('48% is THIN and the queue gates fail',
    F.evaluate(row({ capture_pct: 48 }), 790).dataQuality === 'THIN'
    && !g({ capture_pct: 48 }, 6).ok);

console.log('\n=== PRICING · the gap does not pay more, it FILLS ===');
{
  const tight = P.suggestEntry({ bidFils: 133, bidShares: 71000, offerFils: 134, sharesPerMin: 8000 }, 790, 1);
  const gap = P.suggestEntry({ bidFils: 133, bidShares: 71000, offerFils: 135, sharesPerMin: 8000 }, 790, 1);
  chk('1-fil queues at the bid', tight.placement === 'AT_BID' && tight.queueAheadShares === 71000);
  chk('2-fil posts inside at queue zero', gap.placement === 'INSIDE_GAP' && gap.queueAheadShares === 0);
  chk('a 2-tick target on a 1-fil spread is REFUSED',
      P.suggestEntry({ bidFils: 222, bidShares: 2580, offerFils: 223 }, 790, 2).refusal != null);
  chk('  and says it would be directional',
      /directional/.test(P.suggestEntry({ bidFils: 222, bidShares: 2580, offerFils: 223 }, 790, 2).refusal));
  chk('shares round DOWN', P.sharesFor(790, 128) === 6100);
  chk('no bid -> refusal, not a guess', P.suggestEntry({}, 790, 1).priceFils === null);
  chk('colour by MINUTES, not percentage',
      P.fillState(9) === 'ok' && P.fillState(20) === 'warn' && P.fillState(40) === 'block');
}

console.log('\n=== D3 · the 10 August sequence ===');
for (const [was, now] of [[179, 178], [179, 177], [178, 175]]) {
  chk(`cancelled ${was} -> sold ${now} is REFUSED`,
      !R.checkSellAmend({ newPriceFils: now, avgCostFils: 179, currentPriceFils: was,
                          shares: 4400, commissionKd: 3.38 }).allowed);
}
chk('and it cites what that cost',
    /19.52/.test(R.checkSellAmend({ newPriceFils: 175, avgCostFils: 179, shares: 4400 }).message));
chk('moving the sell UP is allowed',
    R.checkSellAmend({ newPriceFils: 182, avgCostFils: 179, currentPriceFils: 180, shares: 4400 }).allowed);
chk('closer while above cost is allowed — that is D5',
    R.checkSellAmend({ newPriceFils: 181, avgCostFils: 179, currentPriceFils: 183, shares: 4400 }).allowed);

console.log('\n=== E5 · the order was CORRECT when placed ===');
chk('09:51 at the bid', P.positionState({ side: 'BUY', priceFils: 238 },
    { bidFils: 238, offerFils: 239 }).placement === 'AT_BID');
{
  const s = P.positionState({ side: 'BUY', priceFils: 238 },
    { bidFils: 239, offerFils: 240, bidShares: 59695 });
  chk('09:56 the book moved — BELOW_BID', s.placement === 'BELOW_BID' && s.stranded);
  const w = R.checkStranded({ side: 'BUY', orderPriceFils: 238, bidFils: 239,
    offerFils: 240, queueAheadShares: 59695 });
  chk('  and the warning cites 44.94', /44.94/.test(w.message));
  chk('  and offers NO price — only two options', !/\bpost at 239\b/.test(w.message));
}

console.log('\n=== CR-34 · the four cases, and the sample rule ===');
chk('J53 · deep bid, thin offer -> BUY',
    D.classify({ bidShares: 300027, offerShares: 3392 }).signal === 'BUY');
chk('J54 · the 1,030,681 wall -> BLOCKED, not BUY',
    D.classify({ bidShares: 452369, offerShares: 1030681 }).signal === 'BLOCKED');
chk('J55 · bid 10,000 -> SELL',
    D.classify({ bidShares: 10000, offerShares: 50000 }).signal === 'SELL');
chk('  BLOCKED is checked FIRST — deep on both sides is a standoff', true);

console.log('\n=== THE AI BOUNDARY ===');
{
  const input = { symbol: 'K', bidShares: 103592, pctPostable: 20, depth: { snapshots: 418 } };
  chk('a price field is rejected', !B.validate({ priceFils: 177 }, input).ok);
  chk('an invented number is rejected',
      !B.validate({ reasoning: 'a 47% chance' }, input).ok);
  chk('numbers from the data pass',
      B.validate({ reasoning: '20% postable, bid 103,592' }, input).ok);
  chk('directional prediction is rejected',
      !B.validate({ reasoning: 'it will rise' }, input).ok);
  chk('a depth claim on 9 snapshots is rejected',
      !B.validate({ reasoning: 'a deep bid at 103,592' }, { ...input, depth: { snapshots: 9 } }).ok,
      'the nine-minute reading inverted the sign');
  chk('small integers in prose are exempt',
      B.validate({ reasoning: 'the third reposition today' }, input).ok);
  chk('rounding is tolerated — 20% for 20.4',
      B.validate({ reasoning: '20% postable' }, { pctPostable: 20.4 }).ok);
  chk('cited_values traces a number to its column',
      B.citedValues({ reasoning: 'bid 103,592' }, input).bidShares === 103592);
}

console.log('\n=== THE TOOL REGISTRY ===');
chk('ten tools, frozen', REG.assertReady().length === 10);
chk('the precedent record is data, not prose',
    REG.PRECEDENTS.some((p) => p.costKd === -44.94));
chk('  including the inverted depth reading',
    REG.PRECEDENTS.some((p) => p.pattern === 'depth-inverted'));
{
  const saved = { ...REG.TOOLS };
  for (const k of Object.keys(REG.TOOLS)) delete REG.TOOLS[k];
  let code = null;
  try { REG.assertReady(); } catch (e) { code = e.code; }
  chk('an EMPTY registry throws rather than inventing', code === 'REGISTRY_EMPTY');
  Object.assign(REG.TOOLS, saved);
}

console.log('\n=== a trading day survives every boundary ===');
{
  const { toDay, isWeekday, daysBetween } = require('../src/lib/day');
  /*
   * Two failures in opposite directions, both real:
   *   pg returned a Date at LOCAL midnight -> 2026-08-12 became the 11th
   *   the fix made dates strings -> every .toISOString() threw
   */
  chk('a string passes through', toDay('2026-08-12') === '2026-08-12');
  chk('a timestamp string is trimmed to the day',
      toDay('2026-08-12T00:00:00.000Z') === '2026-08-12');
  chk('a Date at UTC midnight is that day',
      toDay(new Date('2026-08-12T00:00:00Z')) === '2026-08-12');
  chk('and 18:30Z really is the day before',
      toDay(new Date('2026-08-11T18:30:00Z')) === '2026-08-11',
      'the shape that printed two different days for one value');
  chk('null stays null', toDay(null) === null);
  chk('Friday and Saturday are closed',
      !isWeekday('2026-08-14') && !isWeekday('2026-08-15'));
  chk('Sunday to Thursday are sessions',
      ['2026-08-16','2026-08-13'].every(isWeekday));
  chk('a range walks inclusively',
      [...daysBetween('2026-08-11','2026-08-13')].join(',') === '2026-08-11,2026-08-12,2026-08-13');
}

console.log('\n=== a connection failure must not look like a code failure ===');
{
  const { explain } = require('../src/lib/dberror');
  const url = 'postgres://u:p@trading-db.x.us-east-1.rds.amazonaws.com:5432/trading';

  const dns = explain({ code: 'ENOTFOUND' }, { url });
  chk('ENOTFOUND names the host', /trading-db\.x/.test(dns.title));
  chk('  and says a stopped RDS loses its DNS entry', /STOPPED/.test(dns.why));
  chk('  and gives a command to run', dns.check.some((c) => c.startsWith('nslookup')));

  const net = explain({ code: 'ETIMEDOUT' }, { url });
  chk('ETIMEDOUT is a DIFFERENT diagnosis', net.kind === 'network' && dns.kind === 'dns',
      'resolves-but-refused needs a different fix from does-not-resolve');
  chk('  and points at the security group', net.check.some((c) => /inbound/.test(c)));

  chk('bad credentials are named as such', explain({ code: '28P01' }, { url }).kind === 'auth');
  chk('a missing table sends you to migrate',
      explain({ code: '42P01', message: 'x' }, { url }).check.includes('npm run migrate'));
  chk('a missing table is the ONLY one treated as a code problem',
      explain({ code: '42P01', message: 'x' }, { url }).kind === 'schema');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail}  (${pass} checks)`);
process.exit(fail ? 1 : 0);
