/**
 * import-fills dedup · a fill recorded under a real broker id AND a synthetic
 * reconstruction is ONE fill, booked once — but two distinct real ids at the
 * same price are two trades, never merged.
 *
 * From live data (8 Sep): today's EQUIPMENT fills each sit in awsat_order_list
 * twice — a numeric id and a `syn:…` id, both client-source, both order_time
 * NULL — because the Order List grid shows the id column only intermittently.
 * Without this dedup, import:fills would book every one of them twice.
 */
const { plan } = require('../src/jobs/import-fills');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const rows = [
  // EQUIPMENT — the same buy under a real id and its synthetic twin (order_time
  // NULL on both, as the client captures them).
  { order_id: '26090890603', symbol: 'EQUIPMENT', side: 'BUY', price: 188, shares: 3500,
    order_value: 658, net_value: 659.487, trading_date: '2026-09-07', order_time: null },
  { order_id: 'syn:EQUIPMENT|Buy|188|3,500|08-09-202609:21:57', symbol: 'EQUIPMENT', side: 'BUY',
    price: 188, shares: 3500, order_value: 658, net_value: 659.487, trading_date: '2026-09-07', order_time: null },

  // MUBARRAD — TWO distinct real buys at the same price: two round trips, kept apart.
  { order_id: '26090170556', symbol: 'MUBARRAD', side: 'BUY', price: 153, shares: 4500,
    order_value: 688.5, net_value: 690.0, trading_date: '2026-08-31', order_time: null },
  { order_id: '26090170729', symbol: 'MUBARRAD', side: 'BUY', price: 153, shares: 4500,
    order_value: 688.5, net_value: 690.0, trading_date: '2026-08-31', order_time: null },

  // BETA — a fill only the synthetic path ever saw (no real twin): still booked, once.
  { order_id: 'syn:BETA|Buy|100|1,000|08-09-202611:00:00', symbol: 'BETA', side: 'BUY', price: 100,
    shares: 1000, order_value: 100, net_value: 100.3, trading_date: '2026-09-07', order_time: null },
];

(async () => {
  const r = plan(rows);
  const eq = r.legs.filter((l) => l.symbol === 'EQUIPMENT');
  const mub = r.legs.filter((l) => l.symbol === 'MUBARRAD');
  const beta = r.legs.filter((l) => l.symbol === 'BETA');

  console.log('\n=== a synthetic twin of a real fill is dropped ===');
  chk('EQUIPMENT is booked once, not twice', eq.length === 1, eq.map((l) => l.order_id));
  chk('  and the REAL id is the one kept (broker figures win)', eq[0] && eq[0].order_id === '26090890603', eq[0] && eq[0].order_id);
  chk('  the synthetic id is recorded as dropped', r.dropped.includes('syn:EQUIPMENT|Buy|188|3,500|08-09-202609:21:57'), r.dropped);

  console.log('\n=== two distinct REAL ids stay two trades ===');
  chk('both MUBARRAD buys survive (not merged on price/qty)', mub.length === 2, mub.map((l) => l.order_id));

  console.log('\n=== a synthetic-only fill is still booked once ===');
  chk('BETA is booked', beta.length === 1, beta.map((l) => l.order_id));

  console.log('\n=== the fee travels with the fill: a twin carrying the broker figure hands it to the real row ===');
  {
    // 8 MRC legs on 25 Aug: the real-id row had NO net_value; its syn: twin did.
    // Dropping the twin dropped the broker fee — the −94.127 vs −94.738 red.
    const twin = plan([
      { order_id: '26082500001', symbol: 'MRC', side: 'BUY', price: 202, shares: 3500,
        order_value: null, net_value: null, trading_date: '2026-08-25', order_time: null },
      { order_id: 'syn:MRC|Buy|202|3,500|25-08-202610:00:00', symbol: 'MRC', side: 'BUY', price: 202, shares: 3500,
        order_value: 707, net_value: 709.171, trading_date: '2026-08-25', order_time: null },
    ]);
    const mrc = twin.legs.find((l) => l.symbol === 'MRC');
    chk('one MRC leg, under the real id', twin.legs.length === 1 && mrc.order_id === '26082500001', twin.legs.map((l) => l.order_id));
    chk('  with the BROKER fee from the twin (2.171), not the computed rate', mrc.feeSource === 'BROKER' && mrc.fee === 2.171, [mrc.feeSource, mrc.fee]);
    chk('  the carry-over is recorded', twin.feeCarried.length === 1 && twin.feeCarried[0].to === '26082500001' && twin.feeCarried[0].feeKd === 2.171, twin.feeCarried);
    const both = plan([
      { order_id: '26082500002', symbol: 'MRC2', side: 'BUY', price: 202, shares: 3500,
        order_value: 707, net_value: 709.5, trading_date: '2026-08-25', order_time: null },
      { order_id: 'syn:MRC2|Buy|202|3,500|25-08-202610:00:00', symbol: 'MRC2', side: 'BUY', price: 202, shares: 3500,
        order_value: 707, net_value: 709.171, trading_date: '2026-08-25', order_time: null },
    ]);
    chk('a real row that already has a broker figure keeps its own', both.legs[0].fee === 2.5 && both.feeCarried.length === 0, [both.legs[0].fee, both.feeCarried]);
  }

  console.log('\n=== an incremental run seeds the FIFO from the ledger\'s open buys ===');
  {
    // Run 1 imported the buy. Run 2 sees the buy (known → skipped) and a new sell.
    const run2 = plan([
      { order_id: '26090100001', symbol: 'GAMMA', side: 'BUY', price: 150, shares: 2000,
        order_value: 300, net_value: 300.95, trading_date: '2026-09-01', order_time: null },
      { order_id: '26090100002', symbol: 'GAMMA', side: 'SELL', price: 153, shares: 2000,
        order_value: 306, net_value: 305.04, trading_date: '2026-09-01', order_time: null },
    ], { seqStart: { GAMMA: 1 }, known: new Set(['26090100001']),
         openStart: [{ symbol: 'GAMMA', seq: 1, remaining: 2000, day: '2026-09-01' }] });
    chk('the known buy is skipped, not re-booked', run2.skipped.includes('26090100001') && !run2.legs.some((l) => l.side === 'BUY'), run2.skipped);
    chk('the sell closes contract 1 — NOT an orphan', run2.orphans.length === 0 && run2.legs.length === 1 && run2.legs[0].seq === 1 && run2.legs[0].closesCarried === true, { orphans: run2.orphans, legs: run2.legs });
    chk('nothing is left open', run2.stillOpen.length === 0, run2.stillOpen);
    // Without the seed (the old behaviour) the same sell was an orphan.
    const old = plan([
      { order_id: '26090100002', symbol: 'GAMMA', side: 'SELL', price: 153, shares: 2000,
        order_value: 306, net_value: 305.04, trading_date: '2026-09-01', order_time: null },
    ], { seqStart: { GAMMA: 1 }, known: new Set(['26090100001']) });
    chk('(control) with no seed the sell is an orphan', old.orphans.length === 1);
    // A partial: 1,200 of 2,000 held → 800 still open, on the carried contract.
    const part = plan([
      { order_id: '26090100003', symbol: 'GAMMA', side: 'SELL', price: 153, shares: 1200,
        order_value: 183.6, net_value: 183.0, trading_date: '2026-09-02', order_time: '2026-09-02T07:15:00Z' },
    ], { seqStart: { GAMMA: 1 }, openStart: [{ symbol: 'GAMMA', seq: 1, remaining: 2000, day: '2026-09-01' }] });
    chk('a partial sell leaves the remainder open on the carried contract', part.stillOpen.length === 1 && part.stillOpen[0].remaining === 800 && part.stillOpen[0].carried === true, part.stillOpen);
    chk('the leg carries the broker\'s order_time for posted_at', part.legs[0].at === '2026-09-02T07:15:00Z', part.legs[0].at);
  }

  console.log('\n=== totals ===');
  chk('4 legs in all (1 EQUIPMENT + 2 MUBARRAD + 1 BETA), 1 dropped', r.legs.length === 4 && r.dropped.length === 1, { legs: r.legs.length, dropped: r.dropped.length });

  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
