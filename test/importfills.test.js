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

  console.log('\n=== totals ===');
  chk('4 legs in all (1 EQUIPMENT + 2 MUBARRAD + 1 BETA), 1 dropped', r.legs.length === 4 && r.dropped.length === 1, { legs: r.legs.length, dropped: r.dropped.length });

  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
