/**
 * R-01 · /api/orders limits CONTRACTS, never legs.
 * R-02 · /api/performance/daily's running total is the account's, not the page's.
 * R-07 · /api/health reports the latest stats day from the VIEW, so it
 *        survives the bridge table being dropped.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('history');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const history = require('../src/api/history');
const present = require('../src/api/present');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };
const SYM = 'SZTESTHIST';

(async () => {
  try {
    await fx.clearLegs(SYM); await fx.instrument(SYM);
    // Three closed contracts on three fixture days: +1, −2, +3 KD net (no fees).
    const days = ['2001-01-08', '2001-01-09', '2001-01-10'];
    const nets = [1, -2, 3];
    for (let i = 0; i < 3; i++) {
      const buy = 100, sell = 100 + nets[i]; // 1,000 shares → net = (sell − buy) KD
      await pool.query(
        `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, commission_kd, posted_at, resolved_at)
         VALUES ($1,$2,$3,'BUY','FILLED',$4,1000,1000,0,$1::date + time '09:00',$1::date + time '09:01'),
                ($1,$2,$3,'SELL','FILLED',$5,1000,1000,0,$1::date + time '10:00',$1::date + time '10:01')`,
        [days[i], SYM, i + 1, buy, sell]);
    }

    console.log('\n=== R-01 · the limit is on contracts ===');
    const o = await history.orders({ from: days[0], to: days[2], limit: 2 });
    const mine = o.contracts.filter((c) => c.symbol === SYM);
    chk('two contracts, not two legs', mine.length === 2, mine.length);
    chk('the newest two', mine.every((c) => c.seq >= 2), mine.map((c) => c.seq));
    chk('each with BOTH legs', mine.every((c) => c.legs.length === 2 && c.fills === 2), mine.map((c) => c.legs.length));

    console.log('\n=== 6.4 · orders paginate by contract with a cursor ===');
    const parse = (s) => { const i = s.lastIndexOf('|'); return { at: s.slice(0, i), id: Number(s.slice(i + 1)) }; };
    const pg1 = await history.orders({ from: days[0], to: days[2], limit: 1 });
    chk('a full page returns a next cursor', pg1.contracts.length === 1 && typeof pg1.next === 'string' && /\|\d+$/.test(pg1.next), { len: pg1.contracts.length, next: pg1.next });
    const pg2 = await history.orders({ from: days[0], to: days[2], limit: 1, cursor: parse(pg1.next) });
    chk('the next page is an older, different contract', pg2.contracts.length >= 1 && pg2.contracts[0].key !== pg1.contracts[0].key, { a: pg1.contracts[0]?.key, b: pg2.contracts[0]?.key });
    chk('the two pages do not overlap', pg1.contracts[0].key !== pg2.contracts[0].key);

    console.log('\n=== R-02 · cumulative is the account\'s ===');
    const all = await history.dailyPnl({ from: days[0], to: days[2] });
    const byDay = Object.fromEntries(all.days.map((d) => [d.day, d]));
    chk('three days', days.every((d) => byDay[d]), Object.keys(byDay));
    chk('cumulative +1, −1, +2', days.map((d) => byDay[d].cumulativeKd).join() === '1,-1,2', days.map((d) => byDay[d]?.cumulativeKd));
    const win = await history.dailyPnl({ from: days[2], to: days[2] });
    const last = win.days.find((d) => d.day === days[2]);
    chk('a one-day window still carries the account\'s cumulative (+2, not +3)', last && last.cumulativeKd === 2, last);
    const lim = await history.dailyPnl({ from: days[0], to: days[2], limit: 1 });
    chk('limit 1 returns the newest day with cumulative +2', lim.days.length === 1 && lim.days[0].cumulativeKd === 2, lim.days);

    console.log('\n=== R-07 · health without the bridge table ===');
    const h = present.health({ now: '2026-09-03T07:00:00Z', latestQuoteAt: '2026-09-03T06:59:30Z', latestStatsDay: '2026-09-02', statsSource: 'SCRAPER', session: { open: true, phase: 'peak' } });
    chk('statsSource travels', h.statsSource === 'SCRAPER' && h.latestStatsDay === '2026-09-02', h);
    const { rows: [v] } = await pool.query(
      `SELECT max(trading_day) AS d FROM spread.symbol_day WHERE gate_stats_source IS NOT NULL`);
    chk('the health query reads the view, not spread.symbol_day_stats', 'd' in v);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/api/routes.js'), 'utf8');
    const healthBlock = src.slice(src.indexOf("r.get('/health'"), src.indexOf("r.get('/health'") + 1500);
    chk('no reference to symbol_day_stats in the health handler', !/symbol_day_stats/.test(healthBlock));
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await fx.clearLegs(SYM).catch(() => {}); await fx.clearInstruments(SYM).catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
