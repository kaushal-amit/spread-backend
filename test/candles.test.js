/**
 * Step 3.4 / D-08 · candles are bucketed in timestamptz and volume is the
 * difference of cumulative totals ACROSS buckets.
 *
 * Seeded prints on the fixture day (Kuwait = UTC+3):
 *   09:00  px 200  cum 100
 *   09:02  px 202  cum 250      -> 09:00 candle: o200 h202 l200 c202 v250
 *   09:06  px 201  cum 400      -> 09:05 candle: v150
 *   09:11  px 203  cum 700      -> 09:10 candle: v300
 * Σ volume = 700 = the day's cumulative total. The old max−min inside a
 * bucket gave 150 + 0 + 0 = 150.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('candles');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const history = require('../src/api/history');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const SYM = 'SZTESTCDL', DAY = fx.TEST_DAY;
const PRINTS = [['06:00', 200, 100], ['06:02', 202, 250], ['06:06', 201, 400], ['06:11', 203, 700]]; // UTC

(async () => {
  try {
    await fx.clearQuotes(SYM); await fx.instrument(SYM);
    for (const [hhmm, px, cum] of PRINTS) {
      await fx.quote(SYM, { day: DAY, at: `${DAY}T${hhmm}:00Z`, last: px, bid: px - 1, offer: px, volume: cum, trades: 1 });
    }

    console.log('\n=== 5-minute candles on the fixture day ===');
    const r = await history.candles(SYM, { day: DAY, minutes: 5 });
    chk('three candles', r.candles.length === 3, r.candles);
    chk('the first candle\'s epoch is 09:00 Asia/Kuwait (06:00Z)',
        r.candles[0].time === `${DAY}T06:00:00.000Z`, r.candles[0].time);
    chk('  not 03:00Z (the old wall-clock-as-UTC shift)', r.candles[0].time !== `${DAY}T03:00:00.000Z`);
    chk('OHLC of the first bucket', JSON.stringify([r.candles[0].open, r.candles[0].high, r.candles[0].low, r.candles[0].close]) === '[200,202,200,202]', r.candles[0]);
    chk('volume per bucket = max − lag(max)', r.candles.map((c) => c.volume).join() === '250,150,300', r.candles.map((c) => c.volume));
    const sum = r.candles.reduce((a, c) => a + c.volume, 0);
    chk('Σ candle volume = day volume (700)', sum === 700, sum);

    console.log('\n=== one-minute grain: a bucket with a single print still carries its volume ===');
    const r1 = await history.candles(SYM, { day: DAY, minutes: 1 });
    chk('four candles', r1.candles.length === 4, r1.candles.length);
    chk('Σ still equals the day volume', r1.candles.reduce((a, c) => a + c.volume, 0) === 700);
    chk('the 09:11 print alone is 300, not 0', r1.candles[3].volume === 300, r1.candles[3]);

    console.log('\n=== across sessions the lag never subtracts yesterday ===');
    const PREV = '2001-01-07';
    await fx.quote(SYM, { day: PREV, at: `${PREV}T06:00:00Z`, last: 190, bid: 189, offer: 190, volume: 5000, trades: 1 });
    const r2 = await history.candles(SYM, { day: null, minutes: 5 });
    chk('no negative candle', r2.candles.every((c) => c.volume >= 0), r2.candles.map((c) => c.volume));
    chk('the fixture day still sums to 700', r2.candles.filter((c) => c.time.startsWith(DAY)).reduce((a, c) => a + c.volume, 0) === 700);
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }
  await fx.clearQuotes(SYM).catch(() => {}); await fx.clearInstruments(SYM).catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
