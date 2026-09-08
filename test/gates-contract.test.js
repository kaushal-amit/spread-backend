/**
 * ─── THE CHECK THAT WAS MISSING (C-01) ─────────────────────────────────────
 *
 * lib/funnel.js reads columns by name from a row of spread.symbol_day. 011
 * renamed the view's columns and nothing noticed: every gate but Gate 8 read
 * null, treated null as a failure, and the board was empty for weeks. The
 * fixtures in logic.test.js were hand-written with the funnel's own names, so
 * they could not see it.
 *
 * Two checks, neither of which needs a database:
 *
 *   1. CONTRACT · every `row.<name>` the funnel reads is a column the 016
 *      view exposes. Parsed from the SQL, so a rename on either side fails
 *      here before it fails on the board.
 *
 *   2. BEHAVIOUR · a row shaped exactly like the live view (column names from
 *      kse on 2 September, values from ABAR that day plus bridge statistics)
 *      passes gates 5, 6, 7 and 9 with VALUES, not dashes; and the same row
 *      with the bridge columns null fails them and says NOT COMPUTED.
 *
 * Plus the import planner, which is pure: the 52 real broker fills from
 * 2 September, deduped and matched FIFO.
 */
const fs = require('fs');
const path = require('path');
const funnel = require('../src/lib/funnel');
const { plan } = require('../src/jobs/import-fills');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

console.log('\n=== 1 · the view exposes every column the funnel reads ===');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/funnel.js'), 'utf8');
  const reads = new Set([...src.matchAll(/row\.([A-Za-z_0-9]+)/g)].map((m) => m[1]));
  // Inputs the screening query attaches rather than the view.
  for (const x of ['priceFils', 'orderPriceFils', 'targetTicks', 'symbol']) reads.delete(x);

  // The LATEST migration that defines the view — a later one supersedes 016.
  const DIR = path.join(__dirname, '../src/db/migrations');
  const viewFile = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
    .filter((f) => /CREATE VIEW spread\.symbol_day AS/.test(fs.readFileSync(path.join(DIR, f), 'utf8'))).pop();
  const view = fs.readFileSync(path.join(DIR, viewFile), 'utf8');
  const body = view.slice(view.indexOf('CREATE VIEW spread.symbol_day AS'), view.indexOf('FROM public.symbol_day p'));
  const exposed = new Set();
  for (const m of body.matchAll(/AS\s+([a-z_0-9]+)/g)) exposed.add(m[1]);
  for (const m of body.matchAll(/(?:^|,|\n)\s*[ps]\.([a-z_0-9]+)\s*(?=,|\n|$)/g)) exposed.add(m[1]);

  const missing = [...reads].filter((c) => !exposed.has(c));
  chk(`funnel reads ${reads.size} columns; all exposed by the view in ${viewFile}`, missing.length === 0, missing);
  for (const c of ['pct_session_postable_800', 'pct_session_exitable_ratio', 'volume_ratio_5d',
    'days_active_5d', 'change_1d_fils', 'change_5d_fils', 'pct_moves_sub100', 'price_moves_2plus',
    'gap_pct', 'bid_kd_p25', 'down_days_5d']) {
    chk(`  ${c}`, exposed.has(c));
  }
}

console.log('\n=== 2 · a live-shaped row passes with VALUES ===');
{
  // ABAR, 1 September 2026, as spread.symbol_day (016) would return it, with
  // the bridge columns filled by stats:daily.
  const row = {
    symbol: 'ABAR', trading_day: '2026-09-01', close_fils: 242, prev_close_fils: 244,
    avg_trade_shares: 8451.28, price_moves: 79, price_moves_2plus: 15, pct_moves_sub100: 17.7, pct_moves_sub100_up: 30.9,
    flow_ratio: 0.8808, capture_pct: 100, capture_quality: 'FULL', source: 'AWSAT',
    range_trading_fils: 7,
    // bridge
    pct_session_postable_800: 61.2, pct_session_exitable_ratio: 83.0, pct_session_exitable_size_800: 55.0,
    bid_kd_p25: 2100.5, gap_pct: 12.0, volume_ratio_5d: 1.1, days_active_5d: 5, down_days_5d: 2,
    change_1d_fils: -2, change_5d_fils: 17, gate_stats_source: 'BACKEND_BRIDGE',
  };
  const ev = funnel.evaluate(row, 790);
  const g = (id) => ev.gates.find((x) => x.id === id);
  chk('Gate 5 has a value', g(5).value !== '—', g(5));
  chk('Gate 6 has a value', g(6).value !== '—', g(6));
  chk('Gate 7 has a value', g(7).value !== '—', g(7));
  chk('Gate 9 has a value', g(9).value !== '—', g(9));
  chk('Gate 6 passes at 61%', g(6).ok === true, g(6));
  chk('Gate 7 passes at 83%', g(7).ok === true, g(7));
  chk('Gate 9 passes at 5/5', g(9).ok === true, g(9));
  chk('Gate 5 passes at 17.7% blended (the up-only 30.9 would have failed it)', g(5).ok === true, g(5));
  chk('nothing is "not computed"', ev.notComputed.length === 0, ev.notComputed);
  chk('the source is named', ev.gateStatsSource === 'BACKEND_BRIDGE', ev.gateStatsSource);
  chk('Gate 10 warns on -2 fils (threshold -2 is not < -2)', g(10).warn === false, g(10));

  console.log('\n=== 2b · the same row with the bridge empty fails LOUDLY ===');
  const bare = { ...row, pct_session_postable_800: null, pct_session_exitable_ratio: null,
    volume_ratio_5d: null, days_active_5d: null, gate_stats_source: null };
  const ev2 = funnel.evaluate(bare, 790);
  chk('Gates 6, 7, 9 are NOT COMPUTED, not merely failed',
      ['postable', 'exit depth', 'consistency'].every((l) => ev2.notComputed.includes(l)), ev2.notComputed);
  chk('Gate 8 still passes on a null — the one deliberate asymmetry',
      ev2.gates.find((x) => x.id === 8).ok === true);
  chk('and the source is null', ev2.gateStatsSource === null);

  console.log('\n=== 2c · the 2-tick band is no longer structurally rejected ===');
  // 250 fils at 790 KD is a 2-tick price. gap_pct 45 >= 30 -> feasible.
  const two = funnel.evaluate({ ...row, close_fils: 250, gap_pct: 45 }, 790);
  chk('targetTicks is 2', two.targetTicks === 2, two.targetTicks);
  chk('Gate 2 is not structural', two.gates.find((x) => x.id === 2).structural === false, two.gates[1]);
  const gap = funnel.evaluate({ ...row, close_fils: 250, gap_pct: 10 }, 790);
  chk('a thin gap is still refused, with the measured figure', /10%/.test(gap.gates[1].why || ''), gap.gates[1].why);
}

console.log('\n=== 3 · the import planner on the 52 real fills ===');
{
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/awsat_order_list.2026-09-02.json'), 'utf8'));
  const out = plan(rows);
  chk('52 broker rows', rows.length === 52, rows.length);
  chk('8 duplicates dropped (SYN twin + numeric twin, same instant)', out.dropped.length === 8, out.dropped);
  chk('42 legs', out.legs.length === 42, out.legs.length);
  chk('21 buys, 21 sells', out.legs.filter((l) => l.side === 'BUY').length === 21
      && out.legs.filter((l) => l.side === 'SELL').length === 21);
  chk('2 orphan sells: KFIC (buy predates capture) and CATTL 291', out.orphans.length === 2
      && out.orphans.some((o) => o.symbol === 'KFIC') && out.orphans.some((o) => o.symbol === 'CATTL' && o.shares === 291),
      out.orphans);
  chk('nothing left open', out.stillOpen.length === 0, out.stillOpen);
  chk('every sell closes the contract its buy opened (FIFO, same seq)',
      out.legs.filter((l) => l.side === 'SELL').every((s) =>
        out.legs.some((b) => b.side === 'BUY' && b.symbol === s.symbol && b.seq === s.seq)));
  const mub = out.legs.filter((l) => l.symbol === 'MUBARRAD').map((l) => l.side + l.seq).join(' ');
  chk('MUBARRAD without timestamps orders by broker id: two round trips', mub === 'BUY1 SELL1 BUY2 SELL2', mub);
  const oula = out.legs.filter((l) => l.symbol === 'OULAFUEL');
  chk('OULAFUEL is Premier and its broker fee matches 0.10% + 0.50', oula.every((l) => l.premier && Math.abs(l.fee - 1.256) < 0.001), oula);
  const swapped = out.legs.find((l) => l.symbol === 'CATTL' && l.day === '2026-08-31' && l.side === 'SELL');
  chk('a SELL whose net exceeds its notional is COMPUTED, not trusted', swapped.feeSource === 'COMPUTED', swapped);
  // BROKER legs reconcile to the broker by construction: cash = ±notional - fee = ±net_value.
  for (const l of out.legs.filter((x) => x.feeSource === 'BROKER' && !x.split)) {
    const cash = (l.side === 'SELL' ? 1 : -1) * (l.price * l.shares / 1000) - l.fee;
    const nv = (l.side === 'SELL' ? 1 : -1) * Number(l.netValue);
    if (Math.abs(cash - nv) > 0.001) chk(`${l.symbol} ${l.side} C${l.seq} reconciles to net_value`, false, [cash, nv]);
  }
  chk('every BROKER leg reconciles to the broker net_value within 0.001', true);
  const net = out.legs.reduce((a, l) => a + (l.side === 'SELL' ? 1 : -1) * l.price * l.shares / 1000 - l.fee, 0);
  chk('the 21 round trips net about -94.7 KD after 70.2 KD of fees', Math.abs(net + 94.738) < 0.01, net.toFixed(3));
}

console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
process.exit(p === n ? 0 : 1);
