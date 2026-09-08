'use strict';
/**
 * scripts/board-offline.js — the REAL screening pipeline over rows captured
 * from the live database, with no database connection.
 *
 * Used to answer "how many symbols reach recommended on 1 September" from a
 * machine that can read kse but not run the backend against it. The two
 * fixtures are exactly what the 016 view + the stats job produce, captured
 * with read-only SQL on 2 September.
 *
 *   node scripts/board-offline.js [budgetKd]
 */
const fs = require('fs');
const path = require('path');
const screening = require('../src/services/screening');
const gateStore = require('../src/services/gateStore');

const F = (name) => fs.readFileSync(path.join(__dirname, '../test/fixtures', name), 'utf8')
  .trim().split('\n').map((l) => l.split('|').map((v) => (v === '' ? null : v)));

const stats = new Map(F('bridge_stats.2026-09-01.txt').map((r) => [r[0], {
  minutes: r[1], pct_session_postable_800: r[2], pct_session_exitable_ratio: r[3],
  pct_session_exitable_size_800: r[4], bid_kd_p25: r[5], gap_pct: r[6], volume_ratio_5d: r[7],
  days_active_5d: r[8], down_days_5d: r[9], change_5d_fils: r[10] }]));

const blended = new Map(F('tiny_blended.2026-09-01.txt').map((r) => [r[0], r[1]]));
const rows = F('symbol_day.2026-09-01.txt').map((r) => {
  const [symbol, close, prev, avgTrade, moves, up2, tiny, bsr, cov, quality, source, range, chgFils,
    market, tradeable, bid, offer] = r;
  const s = stats.get(symbol) || {};
  return {
    symbol, trading_day: '2026-09-01', close_fils: close, prev_close_fils: prev,
    avg_trade_shares: avgTrade, price_moves: moves, price_moves_2plus: up2,
    pct_moves_sub100: blended.get(symbol) ?? null, pct_moves_sub100_up: tiny,
    flow_ratio: bsr, capture_pct: cov, capture_quality: quality, source, range_trading_fils: range,
    change_1d_fils: chgFils, block_ratio: null,
    ...s, gate_stats_source: stats.has(symbol) ? 'BACKEND_BRIDGE' : null,
    min_budget_kd: null, max_budget_kd: null, median_price_move_count: null,
    median_daily_trade_count: null, profile_peak_hour: null, sessions_in_window: null,
    market, market_verified: null, name_ar: null, is_tradeable: tradeable === 't', broker_status: null,
    live_bid: bid, live_bid_shares: null, live_offer: offer, live_offer_shares: null, quote_at: null,
  };
});

const budgetKd = Number(process.argv[2]) || gateStore.effective().BUDGET.slotKd;
const cfg = gateStore.effective();
const fakeDb = { query: async () => ({ rows }) };

screening.screen('2026-09-01', budgetKd, { db: fakeDb, cfg: cfg.GATES, targets: cfg.TARGETS,
  direction: cfg.DIRECTION, quality: cfg.QUALITY }).then((b) => {
  const line = (x) => `  ${x.symbol.padEnd(10)} ${String(x.priceFils).padStart(6)} fils  ` +
    `${x.targetTicks || '-'}t  net ${x.netAtTarget.netKd == null ? '   —' : x.netAtTarget.netKd.toFixed(2).padStart(6)}  ` +
    `moves ${String(x.gates[3].value).padStart(4)}  ` + (x.failed.length ? `fails: ${x.failed.join(', ')}` : 'PASS') +
    (x.notComputed.length ? `  [not computed: ${x.notComputed.join(', ')}]` : '');
  console.log(`board for 2026-09-01 at ${budgetKd} KD · ${b.counts.all} symbols · ` +
    `${b.counts.recommended} recommended · ${b.counts.nearMiss} near-miss · ${b.counts.rejected} rejected`);
  console.log(`bands: ${b.bands.map((x) => `${x.ticks}t ${x.minPriceFils}-${x.maxPriceFils}`).join(', ')}`);
  console.log('\nRECOMMENDED'); for (const x of b.recommended) console.log(line(x));
  console.log('\nNEAR MISS (one gate)'); for (const x of b.nearMiss) console.log(line(x));
  const byGate = Object.entries(b.counts).filter(([k]) => !['all', 'recommended', 'nearMiss', 'rejected'].includes(k))
    .sort((a, c) => c[1] - a[1]);
  console.log('\nfailures by gate:'); for (const [k, v] of byGate) console.log(`  ${k.padEnd(14)} ${v}`);
  const nc = b.rejected.concat(b.nearMiss).filter((x) => x.notComputed.length).length;
  console.log(`\nsymbols with a NOT COMPUTED gate: ${nc}`);
  const noStats = rows.filter((r) => !r.gate_stats_source).map((r) => r.symbol);
  console.log(`symbols with no bridge row (no quotes that day): ${noStats.length} — ${noStats.join(', ')}`);
});
