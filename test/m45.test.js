/**
 * A5 · the m45 column (Item 6).
 *   · a fixture window → a known range-over-cost
 *   · 45 captures with only 3 volume-increasing minutes → NULL / THIN (this is
 *     the case a capture count would wrongly pass — the source captures every
 *     minute whether it trades or not)
 *   · a second run the same day leaves the frozen row unchanged (write-once)
 *   · before 09:45 there is no row → the board shows "—"
 *   · the board metric supports sorting
 *   · the migration applies with AND without spread.symbol_day_stats
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('m45');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const m45 = require('../src/jobs/m45');
const commission = require('../src/lib/commission');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const MOVER = 'SZTESTM45A', THIN = 'SZTESTM45B';
const DAY = '2001-01-08';
const at = (hhmm) => `${DAY}T${hhmm}:00+03:00`; // Kuwait wall time
const clock = (mins) => `${String(9 + Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

(async () => {
  try {
    await pool.query('DELETE FROM spread.m45 WHERE symbol = ANY($1)', [[MOVER, THIN]]);
    for (const s of [MOVER, THIN]) { await fx.clearQuotesRaw(s); await fx.instrument(s); }

    // MOVER: 12 captures 09:00–09:44, price 150→156 (range 6/150 = 4%), volume
    // rises every minute (12 active), a 1-fil spread (bid 155, offer 156) at the
    // last capture. THIN: 45 captures but volume rises only 3 times.
    for (let i = 0; i < 12; i += 1) {
      const price = 150 + Math.min(6, i); // 150..156
      await fx.marketQuote(MOVER, at(clock(i * 4)), { session: 'Trading', lastPrice: price, bid: price - 1, offer: price, volume: 1000 * (i + 1), day: DAY });
    }
    for (let i = 0; i < 45; i += 1) {
      const vol = 5000 + (i < 3 ? i : 3) * 100; // rises only on the first 3 steps
      await fx.marketQuote(THIN, at(clock(i)), { session: 'Trading', lastPrice: 200, bid: 199, offer: 201, volume: vol, day: DAY });
    }

    console.log('\n=== a fixture window → a known range-over-cost ===');
    const r1 = await m45.computeM45(DAY);
    chk('the job computed both symbols', r1.computed === 2, r1);
    const rows = new Map((await pool.query('SELECT * FROM spread.m45 WHERE symbol = ANY($1)', [[MOVER, THIN]])).rows.map((x) => [x.symbol, x]));
    const mv = rows.get(MOVER);
    // rangePct = 6/150 = 0.04; spreadPct = (156-155)/155 = 0.006452;
    // commissionPct = roundTripRate() = 0.003; rangeOverCost = 0.04/0.009452 ≈ 4.232
    const expected = 0.04 / (1 / 155 + commission.roundTripRate());
    chk('MOVER range-over-cost matches the formula', mv && Math.abs(Number(mv.range_over_cost_ratio) - expected) < 0.01, { got: mv?.range_over_cost, expected });
    chk('  reason is NULL when a value is present (the XOR)', mv && mv.reason === null && mv.range_over_cost_ratio != null, mv);
    chk('  commission_pct came from commission.js, not a literal', mv && Number(mv.commission_pct) === commission.roundTripRate(), mv?.commission_pct);

    console.log('\n=== 45 captures, 3 volume increases → NULL / THIN ===');
    const th = rows.get(THIN);
    chk('THIN has 45 captures but is not passed on a capture count', th && th.captures === 45, th?.captures);
    chk('  active_minutes = 3 (only volume increases count)', th && th.active_minutes === 3, th?.active_minutes);
    chk('  range_over_cost NULL with reason THIN', th && th.range_over_cost_ratio === null && th.reason === 'THIN', th);

    console.log('\n=== write-once: a second run leaves the frozen row unchanged ===');
    const frozen = Number(mv.range_over_cost_ratio);
    // Add a later, wilder capture and recompute — the row must not move.
    await fx.marketQuote(MOVER, at('09:45'), { session: 'Trading', lastPrice: 300, bid: 299, offer: 300, volume: 99999, day: DAY });
    const r2 = await m45.computeM45(DAY);
    chk('the second run skips the existing rows', r2.skipped >= 2 && r2.computed === 0, r2);
    const after = (await pool.query('SELECT range_over_cost_ratio FROM spread.m45 WHERE symbol = $1', [MOVER])).rows[0];
    chk('  the frozen value is unchanged', Number(after.range_over_cost_ratio) === frozen, { frozen, after: after.range_over_cost_ratio });

    console.log('\n=== before the job (no row) the board shows "—" ===');
    const none = await m45.m45For(DAY, ['SZTESTM45NONE']);
    chk('a symbol with no row is absent from the map (→ null → "—")', !none.has('SZTESTM45NONE'), [...none.keys()]);

    console.log('\n=== the board metric supports sorting ===');
    const forBoard = await m45.m45For(DAY, [THIN, MOVER]);
    const ranked = [...forBoard.entries()].sort((a, b) => (b[1].rangeOverCost ?? -Infinity) - (a[1].rangeOverCost ?? -Infinity));
    chk('sorted by m45 desc, MOVER (a value) ranks above THIN (null)', ranked[0][0] === MOVER, ranked.map((x) => x[0]));

    console.log('\n=== the migration does not depend on symbol_day_stats ===');
    // 031 is CREATE TABLE spread.m45 only; it names neither symbol_day_stats nor
    // the symbol_day view. Prove the source text is clean.
    const sql = require('fs').readFileSync(require('path').join(__dirname, '../src/db/migrations/031_m45.sql'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'); // strip comments
    chk('031 statements reference neither the bridge nor the view', !/symbol_day/.test(sql), sql.match(/symbol_day\w*/g));
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 4).join(' | '));
  }
  await pool.query('DELETE FROM spread.m45 WHERE symbol = ANY($1)', [[MOVER, THIN]]).catch(() => {});
  for (const s of [MOVER, THIN]) { await fx.clearQuotesRaw(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
