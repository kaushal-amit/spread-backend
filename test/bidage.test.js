/**
 * R-23 · bid age from the capture history, and R-22 · the stop.
 *
 *   the touch bid may be BAIT — large and seconds old; size from the aged bid
 *   the stop is one fil below the nearest AGED level, never on a round number,
 *   and warns where the ladder shows a gap
 *
 * SHUAIBA on 1 September: a stop of 283 from the touch, with no bid between 284
 * and 280 beneath it. This is the gap the stop must see.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('bidage');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const depth = require('../src/services/depth');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const SYM = 'SZTESTAGE';
const DAY = kuwaitDay();

const capture = (at, levels) => fx.depthAt(SYM, at, levels);

(async () => {
  try {
    // A2 · sizing now requires a session budget (no silent default). Load the
    // gate store and set one if this fresh test DB has none.
    const gateStore = require('../src/services/gateStore');
    await gateStore.load();
    if (gateStore.sessionBudgetKd() == null) await gateStore.save({ 'session-budget': 790 }, { changedBy: 'bidage.test' });
    await fx.clearDepth(SYM); await fx.instrument(SYM);
    const now = new Date();
    const mAgo = (m) => new Date(now.getTime() - m * 60000);
    // 158 has been the touch for 40 minutes (aged); 159 appeared 2 minutes ago
    // as a large bait bid on top; 150 is an aged deeper shelf; there is a GAP
    // between 150 and the next real level 145 (nothing at 149–146).
    for (let m = 40; m >= 3; m -= 1) {
      await capture(mAgo(m), [[1, 158, 120000], [2, 150, 200000], [3, 145, 80000]]);
    }
    // the latest two captures: bait 159 jumps on top
    await capture(mAgo(2), [[1, 159, 900000], [2, 158, 120000], [3, 150, 200000], [4, 145, 80000]]);
    await capture(mAgo(0.2), [[1, 159, 900000], [2, 158, 120000], [3, 150, 200000], [4, 145, 80000]]);

    console.log('\n=== bid age from the history ===');
    const b = await depth.bookAges(SYM, DAY, { now });
    const touch = b.touch;
    chk('the touch is 159', touch.price === 159, touch);
    chk('  and it is BAIT — 900k, ~2 minutes old', touch.bait && !touch.aged && touch.ageMins <= 3, touch);
    const aged158 = b.bids.find((x) => x.price === 158);
    chk('158 has aged ~40 minutes', aged158 && aged158.aged && aged158.ageMins >= 35, aged158);
    const aged150 = b.bids.find((x) => x.price === 150);
    chk('150 is an aged deeper shelf', aged150 && aged150.aged, aged150);
    chk('the 150 → 145 gap is seen', b.gaps.some((g) => g.from === 150 && g.to === 145 && g.fils === 5), b.gaps);

    console.log('\n=== sizing uses the AGED bid, not the bait touch ===');
    await fx.symbolDay(SYM, '2001-01-08', { close: 158 }); // a close so sizingFor has a price fallback
    const sizing = await require('../src/api/sizing').sizingFor(SYM);
    chk('bid_basis is the aged bid', sizing.basis.bid_basis === 'aged_bid', sizing.basis.bid_basis);
    chk('  aged_bid_qty is 158\'s 120k, not the touch 900k', sizing.basis.aged_bid_qty === 120000 && sizing.basis.touch_bid_qty === 900000, sizing.basis);
    chk('  the note names the bait', /not aged/.test(sizing.basis.bid_note || ''), sizing.basis.bid_note);

    console.log('\n=== the stop (R-22) ===');
    // Entry at 158: the nearest aged level at or below 158 is 158 itself →
    // stop one fil below = 157.
    const s158 = await depth.stopFor(SYM, DAY, 158, { now });
    chk('entry 158 → stop 157 (one fil below the aged 158 shelf)', s158.stopFils === 157 && s158.shelfFils === 158, s158);
    chk('  the reason names the shelf and its age', /158 shelf/.test(s158.reason) && /held/.test(s158.reason), s158.reason);

    console.log('\n=== never on a round number ===');
    // A book whose only aged shelf is 151: entry 151 → 150 (round) → step to 149.
    const RN = 'SZTESTROUND';
    await fx.clearDepth(RN); await fx.instrument(RN);
    for (let m = 40; m >= 0; m -= 1) await fx.depthAt(RN, mAgo(m), [[1, 151, 300000], [2, 148, 100000]]);
    const s151 = await depth.stopFor(RN, DAY, 151, { now });
    chk('entry 151 → shelf 151 → stop steps off the round 150 to 149', s151.stopFils === 149 && s151.shelfFils === 151 && s151.steppedForRound, s151);
    await fx.clearDepth(RN); await fx.clearInstruments(RN);

    console.log('\n=== the SHUAIBA gap ===');
    // A separate book: touch 284 aged, next real bid 280, nothing between.
    const SH = 'SZTESTSHUAIBA';
    await fx.clearDepth(SH); await fx.instrument(SH);
    for (let m = 40; m >= 0; m -= 1) await fx.depthAt(SH, mAgo(m), [[1, 284, 50000], [2, 280, 3700]]);
    const shStop = await depth.stopFor(SH, DAY, 283, { now });
    // The aged shelf at or below 283 is 280 → stop 279, and the 284→280 gap is flagged.
    chk('a stop under 283 lands under the 280 shelf, not at 283 from the touch', shStop.shelfFils === 280 && shStop.stopFils === 279, shStop);
    chk('  and the 284 → 280 gap is named', /GAP/.test(shStop.reason) && /284/.test(shStop.reason), shStop.reason);
    await fx.clearDepth(SH); await fx.clearInstruments(SH);

    console.log('\n=== no aged shelf → no stop, not one from the touch ===');
    const YOUNG = 'SZTESTYOUNG';
    await fx.clearDepth(YOUNG); await fx.instrument(YOUNG);
    await fx.depthAt(YOUNG, mAgo(1), [[1, 200, 50000]]);
    const ys = await depth.stopFor(YOUNG, DAY, 200, { now });
    chk('a book with no aged level → no stop', ys.stopFils === null && /no real shelf|no bid level/.test(ys.reason), ys);
    await fx.clearDepth(YOUNG); await fx.clearInstruments(YOUNG);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await fx.clearDepth(SYM).catch(() => {}); await fx.clearDay('2001-01-08').catch(() => {}); await fx.clearInstruments(SYM).catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
