// A stub backend serving the OFFLINE board (real 1 Sep rows through the real
// pipeline) so the built frontend can be exercised without Postgres.
const express = require('express'); const http = require('http'); const path = require('path'); const fs = require('fs');
process.chdir('/root/spread/be');
const screening = require('../src/services/screening'); const gateStore = require('../src/services/gateStore'); const present = require('../src/api/present');
const F = (n) => fs.readFileSync(path.join('test/fixtures', n), 'utf8').trim().split('\n').map((l) => l.split('|').map((v) => (v === '' ? null : v)));
const stats = new Map(F('bridge_stats.2026-09-01.txt').map((r) => [r[0], { pct_session_postable_800: r[2], pct_session_exitable_ratio: r[3], pct_session_exitable_size_800: r[4], bid_kd_p25: r[5], gap_pct: r[6], volume_ratio_5d: r[7], days_active_5d: r[8], down_days_5d: r[9], change_5d_fils: r[10] }]));
const blended = new Map(F('tiny_blended.2026-09-01.txt').map((r) => [r[0], r[1]]));
const rows = F('symbol_day.2026-09-01.txt').map((r) => { const [symbol, close, prev, avgTrade, moves, up2, tiny, bsr, cov, quality, source, range, chgFils, market, tradeable, bid, offer] = r; return { symbol, trading_day: '2026-09-01', close_fils: close, prev_close_fils: prev, avg_trade_shares: avgTrade, price_moves: moves, price_moves_2plus: up2, pct_moves_sub100: blended.get(symbol) ?? null, flow_ratio: bsr, capture_pct: cov, capture_quality: quality, source, range_trading_fils: range, change_1d_fils: chgFils, ...(stats.get(symbol) || {}), gate_stats_source: stats.has(symbol) ? 'BACKEND_BRIDGE' : null, market, is_tradeable: tradeable === 't', live_bid: bid, live_offer: offer }; });
(async () => {
  const cfg = gateStore.effective();
  const b = await screening.screen('2026-09-01', 790, { db: { query: async () => ({ rows }) }, cfg: cfg.GATES, targets: cfg.TARGETS, direction: cfg.DIRECTION, quality: cfg.QUALITY });
  const cards = [...b.recommended, ...b.nearMiss, ...b.rejected].map((x) => present.stockCandidate(x, 790));
  const app = express(); app.use(express.json());
  app.use(express.static('/root/spread/fe/dist'));
  app.get('/api/stocks', (q, r) => r.json(cards));
  app.get('/api/account', (q, r) => r.json(present.accountState({ cashKd: 905.26, settledKd: 905.26, netDepositedKd: 1000, claimedKd: 0, investedKd: 0, marketKd: 0, openPositions: 0 }, { todayKd: -1.89, todayTrips: 2, sinceKd: -94.74, sinceFills: 42 })));
  app.get('/api/budget', (q, r) => r.json({ budget_kd: 790, reserve_kd: 197.5, reserve_held: true, reserve_releases_at_hhmm: 1100, committed_kd: 0, open_positions: 0, free_kd: 592.5, min_position_kd: 333, max_price_fils: 333 }));
  app.get('/api/session', (q, r) => r.json({ ...present.sessionInfo({ phase: 'peak', open: true, note: 'peak hour', hour: 10, timeStr: '10:17', minutesToStepDown: 103, lateToOpen: true }, 0.3), open: true, kuwaitDay: '2026-09-01', reserveReleased: false, driftByHour: [], driftMeasured: true }));
  app.get('/api/market', (q, r) => r.json({ ...present.marketDay({ trading_day: '2026-09-01', symbols_traded: 132, advancing: 32, declining: 80, unchanged: 20, pct_advancing: 24.24, breadth_5d_avg: 41.0, regime: 'RISK_OFF', total_volume: 344519488, total_trades: 24964, turnover_kd: 76739682, volume_vs_20d: 1.188, index_ytd_pct: -2.46, computed_at: new Date() }), isToday: true, available: true }));
  // The detail bundle for any symbol on the board, with EMIRATES holding a position.
  const legs = { EMIRATES: [{ id: 1, seq: 3, side: 'BUY', status: 'FILLED', price: 160, shares: 4200, filledShares: 4200, commissionKd: 1.533, postedAt: new Date(Date.now() - 9 * 60000).toISOString(), resolvedAt: new Date(Date.now() - 8 * 60000).toISOString(), note: '', exitVenue: null },
    { id: 2, seq: 3, side: 'SELL', status: 'POSTED', price: 162, shares: 4200, filledShares: null, commissionKd: null, postedAt: new Date(Date.now() - 5 * 60000).toISOString(), resolvedAt: null, note: '', exitVenue: null }] };
  const emiratesContract = () => present.tradingContract({ symbol: 'EMIRATES', contract_seq: 3, state: 'holding', shares: 4200, entry: 160, bid: 161, offer: 162, committedKd: 672, unrealisedKd: 4.2, breakEvenFils: 161, trailArmFils: 162, trailingOfferFils: 162, peakBidFils: 161, boughtShares: 4200, openedOn: '2026-09-01', markedAt: 'quote', quoteAt: new Date(), legs: [{ id: 1, side: 'BUY', status: 'FILLED', price_fils: 160, shares: 4200, posted_at: new Date(Date.now() - 9 * 60000), commission_kd: 1.5 }] });
  app.get('/api/stocks/:symbol/detail', (q, r) => {
    const sym = q.params.symbol.toUpperCase();
    const c = cards.find((x) => x.symbol === sym) || null;
    const px = c ? c.price : 200;
    const ladder = [];
    for (let i = 0; i < 5; i++) ladder.push({ side: 'bid', price: px - i, qty: 20000 * (i + 1) + (i === 1 ? 90000 : 0) }, { side: 'offer', price: px + 1 + i, qty: 15000 * (i + 1) });
    const book = present.orderBook({ symbol: sym, bid: px, bid_qty: 20000, offer: px + 1, offer_qty: 15000, last_price: px, trades: 143, high_fils: px + 4, low_fils: px - 3, created_at: new Date() }, ladder);
    r.json({ symbol: sym, tradingDay: '2026-09-01', budgetKd: 790, candidate: c, orderBook: book,
      sizing: { symbol: sym, price_fils: px, floor_kd: 333, ceiling_kd: 592.5, suggested_kd: 592.5, suggested_shares: Math.floor(592500 / px), your_pct: 12.3, net_per_fil_kd: 2.9, reachable: true, reasons: [], basis: { free_kd: 592.5, committed_kd: 0, budget_kd: 790, bid_qty: 20000, offer_qty: 15000, sized_from: 'free_kd' } },
      fillTime: { symbol: sym, bidFils: px, bidShares: 20000, queueAheadShares: 20000, queueSharePct: 14.8, sharesPerMin: 1200, windowMins: 15, estFillMins: 17, state: 'ok', label: '~17 min' },
      depthSignal: { symbol: sym, signal: 'BUY', snapshots: 212, sampleSufficient: true, reason: 'bid deep, offer thin' },
      contract: sym === 'EMIRATES' ? emiratesContract() : null, legs: legs[sym] || [], closedToday: [], session: { open: true, phase: 'peak', note: 'peak hour' } });
  });
  app.post('/api/trading/:action', (q, r) => r.status(409).json({ error: 'stub: writes are not recorded here', code: 'REFUSED', detail: `${q.params.action} ${JSON.stringify(q.body)}` }));
  app.get('/api/trading/contracts', (q, r) => r.json([present.tradingContract({ symbol: 'EMIRATES', contract_seq: 3, state: 'holding', shares: 4200, entry: 160, bid: 161, offer: 162, committedKd: 672, unrealisedKd: 4.2, breakEvenFils: 161, trailArmFils: 162, trailingOfferFils: 162, peakBidFils: 161, boughtShares: 4200, openedOn: '2026-09-01', markedAt: 'quote', quoteAt: new Date(), legs: [{ id: 1, side: 'BUY', status: 'FILLED', price_fils: 160, shares: 4200, posted_at: new Date(Date.now() - 9 * 60000), commission_kd: 1.5 }] })]));
  const server = http.createServer(app);
  const { Server } = require('socket.io'); const io = new Server(server);
  io.on('connection', (s) => { s.emit('spread:update', { tradingDay: '2026-09-01', budgetKd: 790, recommended: cards.filter((c) => c.status === 'recommended'), nearMiss: cards.filter((c) => c.status === 'near_miss'), rejected: cards.filter((c) => c.status === 'rejected'), counts: b.counts, reach: b.reach, session: { open: true }, coverage: null }); });
  server.listen(4555, () => console.log('stub on 4555'));
})();
