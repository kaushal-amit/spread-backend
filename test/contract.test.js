/*
 * The frontend's src/types/ IS the contract.
 *
 * A missing field is a silent `undefined` on screen, not an error — which is
 * why this asserts SHAPE rather than trusting that the presenter and the types
 * were written from the same document.
 */
const present = require('../src/api/present');
let pass = 0, fail = 0;
const chk = (l, c, x = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${x ? '  ' + x : ''}`); c ? pass++ : fail++; };
const has = (o, keys) => keys.filter((k) => !(k in o));

console.log('=== StockCandidate ===');
{
  const row = {
    symbol: 'NRE', priceFils: 133, bidFils: 133, offerFils: 134, spreadFils: 1,
    entryPlacement: 'AT_BID', passed: true, failed: [], reasons: [],
    gates: [
      { id: 1, label: 'Price band', ok: true, value: '133 fils', sub: '' },
      { id: 2, label: 'Profit floor', ok: true, value: '+2.55', sub: '1 tick target' },
      { id: 4, label: 'Movement', ok: true, value: '58', sub: '' },
      { id: 10, label: 'Direction', ok: true, warn: true, value: '+1 / +3', sub: '1d / 5d' },
    ],
    netAtTarget: { shares: 5900, notionalKd: 784.7, roundTripKd: 3.34, netKd: 2.55 },
    entry: { shares: 5900, notionalKd: 784.7, placement: 'AT_BID' },
    reachable: true, minBudgetKd: 200, maxBudgetKd: 1200,
    capturePct: 100, dataQuality: 'OK', behaviour: [], structural: false,
  };
  const c = present.stockCandidate(row, 790);
  // R-06 · walkedUp is a SERVER field, so the browser stops recomputing it.
  const wu = present.stockCandidate({ ...row, pct_moves_sub100: 15, pct_moves_sub100_up: 32 }, 790);
  chk('metrics.walkedUp is emitted (32 up-only vs 15 blended → true)', wu.metrics.walkedUp === true, JSON.stringify(wu.metrics.walkedUp));
  const nwu = present.stockCandidate({ ...row, pct_moves_sub100: 18, pct_moves_sub100_up: 20 }, 790);
  chk('  and false when up-only is not 2x blended', nwu.metrics.walkedUp === false);

  const required = ['symbol', 'price', 'bid', 'offer', 'spread', 'entryPlacement', 'shares',
    'notionalKd', 'roundTripKd', 'netKd', 'netPerFilKd', 'trendWarn', 'status',
    'failingGatesCount', 'failingGateNames', 'gateGroups', 'headroom'];
  chk('every required field is present', has(c, required).length === 0, has(c, required).join(', '));

  chk('status is the SECTION', c.status === 'recommended');
  chk('verdict is the VERDICT — a different question, kept separate',
      c.verdict === 'TRADABLE', 'one pill cannot carry both');
  chk('gateGroups render in the four card groups',
      c.gateGroups.length > 0 && c.gateGroups.every((g) => Array.isArray(g.cells)));
  chk('every cell carries `sub`', c.gateGroups.every((g) => g.cells.every((x) => 'sub' in x)),
      'a percentage without its count hid a bug for a week');
  chk('headroom has all five fields',
      has(c.headroom, ['minKd', 'maxKd', 'profitPerFil', 'currentKd', 'headroomX']).length === 0);
  chk('netPerFilKd is per FIL, not per trade', c.netPerFilKd === 5.9,
      'at 119 fils a fil pays +3.57; at 235 it pays +0.04');

  // Gate 1 below the floor is arithmetic, not judgement.
  const dead = present.stockCandidate({ ...row, passed: false, failed: ['price band'],
    reasons: ['0.1-fil tick'], structural: true, priceFils: 75 }, 790);
  chk('a structural failure is flagged as such', dead.isStructuralFailure === true);
  chk('  and the verdict is REJECTED', dead.verdict === 'REJECTED');
}

console.log('\n=== OrderBook ===');
{
  const b = present.orderBook(
    { symbol: 'NRE', bid: 133, bid_qty: 71000, offer: 134, offer_qty: 44000,
      last_price: 133, trades: 58, high_fils: 136, low_fils: 132,
      created_at: new Date() },
    [{ side: 'bid', price: 133, qty: 71000 }, { side: 'offer', price: 134, qty: 44000 }],
    { bids: [{ price: 133, qty: 90000 }], offers: [] });
  chk('every required field', has(b, ['symbol', 'bid', 'bid_qty', 'offer', 'offer_qty',
    'last_price', 'trades', 'bids', 'offers', 'dayRange', 'limitBand', 'lastTickTime']).length === 0);
  chk('a thinning level is marked', b.bids[0].changed === 'thinned',
      '41,000 to 5,000 matters more than either number alone');
  chk('limitBand is zeros, not a guess', b.limitBand.low === 0,
      'it lives on the broker ticket and is not captured');
}

console.log('\n=== AccountState ===');
{
  const a = present.accountState(
    { cashKd: 854.27, settledKd: 669.23, netDepositedKd: 910, claimedKd: 0,
      investedKd: 826, marketKd: 830 },
    { todayKd: 2.1, todayTrips: 1, sinceKd: -55.73, sinceFills: 26 });
  chk('every required field', has(a, ['buyingPowerKd', 'investedKd', 'claimedKd', 'equityKd',
    'unrealisedKd', 'todayKd', 'todayTrips', 'since28JulKd', 'since28JulFills',
    'netDepositedKd', 'returnPct']).length === 0);
  chk('equity is NOT buying power', a.equityKd !== a.buyingPowerKd,
      `equity ${a.equityKd}, available ${a.buyingPowerKd}`);
  chk('unrealised is market minus cost', a.unrealisedKd === 4);
}

console.log('\n=== GateConfig ===');
{
  const g = present.gateConfigs();
  chk('every gate is described', g.length >= 10);
  chk('each carries its evidence and confidence',
      g.every((x) => 'evidence' in x && 'confidence' in x && 'observationCount' in x),
      'two thresholds were set from a single failure each');
  const g1 = g.find((x) => x.id === 'g1-floor');
  chk('the floor says it cannot be overridden', /cannot be overridden/i.test(g1.ruleDescription));
  chk('  and is HIGH confidence — 128 of 128 stocks', g1.confidence === 'HIGH');
  const g10 = g.find((x) => x.id === 'g10-direction');
  chk('direction carries its mode', g10.mode === 'warn');
  chk('  and says it never blocks', /NEVER BLOCKS/.test(g10.ruleDescription));
  chk('  and cites the 44% coin flip', /44%/.test(g10.ruleDescription));
}

console.log('\n=== TradingContract ===');
{
  const c = present.tradingContract({
    symbol: 'EQUIPMENT', contract_seq: 1, state: 'holding', shares: 3500,
    entry: 238, bid: 236, offer: 237, committedKd: 833, unrealisedKd: -7,
    breakEvenFils: 239, targetNormalFils: 240, targetTrendingFils: 244, peakBidFils: 239,
    legs: [{ id: 1, side: 'BUY', status: 'FILLED', price_fils: 238, shares: 3500,
             commission_kd: 1.75, posted_at: new Date(), note: '' }],
  });
  chk('every required field', has(c, ['symbol', 'seq', 'state', 'shares', 'entry', 'bid',
    'offer', 'committedKd', 'unrealisedKd', 'breakEvenPrice', 'targetNormal',
    'targetTrending', 'peakSinceFill', 'stepDownTime', 'legs']).length === 0);
  chk('break-even and the +2 target are BOTH present',
      c.breakEvenPrice === 239 && c.targetNormal === 240 && c.targetTrending === 244,
      'selling at 239 nets +0.001 KD; at 240 it nets +3.501');
  chk('legs carry commission to three decimals', c.legs[0].commission_kd === 1.75);
}

console.log('\n=== LedgerEntry ===');
{
  const e = present.ledgerEntry({ id: 1, at: new Date(), kind: 'FEE',
    amount_kd: -2.285, balance_kd: 851.985, note: 'sell commission', symbol: 'CATTL' });
  chk('every required field',
      has(e, ['id', 'at', 'kind', 'amount_kd', 'balance_kd', 'note']).length === 0);
  chk('three decimals survive', e.amount_kd === -2.285,
      'the per-execution finding rests on 0.105');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail}  (${pass} checks)`);
process.exit(fail ? 1 : 0);
