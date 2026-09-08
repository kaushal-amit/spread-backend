/**
 * A4 · the per-slot stale rule (Item 5).
 *   · a slot with no depth capture for 10 min, during the session, is stale
 *   · the same gap AFTER 13:30 is not (the session is closing — a gap is expected)
 *   · the swap decision displaces a stale slot before a live one, never one
 *     holding a position or a POSTED leg
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('staleslots');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const slots = require('../src/services/slots');
const halts = require('../src/services/halts');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const LIVE = 'SZTESTSLLIVE', STALE = 'SZTESTSLSTALE';
const DAY = '2001-01-08';
const at = (hhmm) => `${DAY}T${hhmm}:00+03:00`; // Kuwait wall time

(async () => {
  try {
    await fx.clearDepthSlots(DAY);
    for (const s of [LIVE, STALE]) { await fx.clearQuotesRaw(s); await fx.instrument(s); }
    // Two slots. STALE last captured at 09:05; LIVE captured at 10:08 (fresh).
    await fx.depthSlot(LIVE, { slotNo: 1, day: DAY });
    await fx.depthSlot(STALE, { slotNo: 2, day: DAY });
    await fx.depthAt(STALE, at('09:05'), [[1, 158, 100000]]);
    await fx.depthAt(LIVE, at('10:08'), [[1, 200, 100000]]);

    console.log('\n=== a slot 65 min without a capture, at 10:10, is stale ===');
    const s1 = await slots.staleSlots(DAY, { now: new Date(at('10:10')) });
    const st = s1.find((x) => x.symbol === STALE);
    chk('the stale slot fires', !!st && st.slot === 2, s1);
    chk('  and carries its last capture time', !!st && new Date(st.lastCaptureAt).getTime() === new Date(at('09:05')).getTime(), st?.lastCaptureAt);
    chk('the live slot (captured 2 min ago) does not', !s1.find((x) => x.symbol === LIVE), s1);

    console.log('\n=== the same gap at 13:45 does not fire (past 13:30) ===');
    const s2 = await slots.staleSlots(DAY, { now: new Date(at('13:45')) });
    chk('no stale slots after the window closes', s2.length === 0, s2);

    console.log('\n=== the swap decision displaces the stale slot, not the live one ===');
    // A wake-up on a third symbol; neither slot holds a position.
    const decision = await halts.slotSwapDecision('SZTESTSLNEW', DAY, pool);
    chk('the stale slot (2) is displaced, not the live slot (1)', decision.displace === 2 && decision.displaceSymbol === STALE, decision);
    chk('  and it is flagged stale', decision.stale === true, decision);

    console.log('\n=== a stale slot holding a position is protected ===');
    await fx.clearLegs(STALE);
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, posted_at)
       VALUES ($1,$2,1,'BUY','POSTED',158,1000,NULL,now())`, [DAY, STALE]);
    const d2 = await halts.slotSwapDecision('SZTESTSLNEW', DAY, pool);
    chk('a POSTED leg protects even a stale slot → the live slot is taken instead',
        d2.displace === 1 && d2.displaceSymbol === LIVE, d2);
    await fx.clearLegs(STALE);
    console.log('\n=== G-5 · slot count from the scraper, never a literal ===');
    // The scraper's published number wins.
    const twelve = await slots.slotCount(DAY, { client: { depthSymbols: async () => ({ slotCount: 12 }) } });
    chk('slotCount = 12 when the scraper publishes 12', twelve === 12, twelve);
    const five = await slots.slotCount(DAY, { client: { depthSymbols: async () => ({ slotCount: 5 }) } });
    chk('slotCount = 5 when the scraper publishes 5', five === 5, five);
    // Fallback: the scraper unreachable → count of distinct symbols in awsat_stock_depth today.
    const fb = await slots.slotCount(DAY, { client: { depthSymbols: async () => null } });
    chk('unreachable → the depth-capture fallback (2 distinct symbols today), never a literal',
        fb === 2, fb); // LIVE + STALE seeded above
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 4).join(' | '));
  }
  await fx.clearDepthSlots(DAY).catch(() => {});
  for (const s of [LIVE, STALE]) { await fx.clearQuotesRaw(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {}); }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
