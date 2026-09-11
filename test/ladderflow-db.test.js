/**
 * F8 · the flow markers and banners on the live ladder (depth.ladder over
 * real Postgres): PLACED / PULLED / TRADED / RELOCATED / PARKED / WALKDOWN on
 * the rows, DOUBLE WALL (from symbol_minute.is_frozen, the last rows, recent)
 * and CLOSING BID (an observation, from the previous session's closing
 * capture after 12:30) on the book, and their arrival on GET /orderbook via
 * routes.orderBookFor. SZTESTFLW* symbols.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('ladderflow-db');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const depth = require('../src/services/depth');
const phrases = require('../src/services/phrases');
const { toResponse } = require('../src/api/errors');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };
const DAY = kuwaitDay();
const SYM = 'SZTESTFLW';
const events = (row) => (row.markers || []).map((m) => m.event);
const textOf = (row, ev) => (row.markers || []).find((m) => m.event === ev)?.text;

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/routes').build());
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { const { status, body } = toResponse(err); res.status(status).json(body); });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const get = async (path) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${path}`); return { status: r.status, body: await r.json() }; };
  const clean = async () => { await fx.clearDepth(SYM); await fx.clearQuotes(SYM); await fx.clearSymbolMinute(SYM); };
  try {
    await phrases.load().catch(() => {});
    await clean(); await fx.instrument(SYM);
    const now = new Date();
    const mAgo = (m) => new Date(now.getTime() - m * 60000);
    // The previous session's CLOSING capture: 12:40 Kuwait (09:40 UTC) yesterday,
    // 224 × 1,827,769 on the touch. (An earlier capture that day would not count
    // as a closing one — the observation needs a capture after hard_exit.)
    const yDay = require('../src/jobs/daily').kuwaitDay(new Date(now.getTime() - 24 * 3600000));
    await fx.depthLevels(SYM, new Date(`${yDay}T09:40:00Z`), [{ level: 1, bid: 224, bidQty: 1827769, offer: 226, offerQty: 30000 }]);

    // Today: 20 captures. The bid 200 × 155,000 sits unchanged (PARKED);
    // 224 shows 20,000 at the first capture (PHANTOM). The touch offer walks
    // down 239 → 228 → 226 → 225 over the last captures with nothing traded.
    // Volume: 0 all session (nothing trades), so every change is size that
    // moved, not size that traded.
    const offerAt = (i) => (i < 12 ? 239 : i < 15 ? 228 : i < 18 ? 226 : 225);
    for (let i = 0; i < 20; i++) {
      const m = 40 - i * 2;
      const levels = [
        { level: 1, bid: i === 0 ? 224 : 210, bidQty: i === 0 ? 20000 : (i === 19 ? 100000 : 30000), offer: offerAt(i), offerQty: 40000 },
        { level: 2, bid: 200, bidQty: 155000, offer: 245, offerQty: 60000 },
        { level: 3, bid: i === 19 ? 195 : 197, bidQty: 50000, offer: 250, offerQty: 20000 },
      ];
      await fx.depthLevels(SYM, mAgo(m), levels);
      // A quote on each side of every capture (the bracket needs both); nothing
      // trades all session — every change is size that moved.
      await fx.quote(SYM, { day: DAY, at: mAgo(m + 0.5), last: 225, bid: levels[0].bid, offer: offerAt(i), volume: 0, trades: 0 });
    }
    await fx.quote(SYM, { day: DAY, at: mAgo(0.3), last: 225, bid: 210, offer: 225, volume: 0, trades: 0 });
    // The scraper's own frozen verdict: its last rows, within two minutes of the capture.
    await fx.symbolMinute(SYM, { day: DAY, at: mAgo(1.5), isFrozen: true, bidQty: 100000, offerQty: 40000 });
    await fx.symbolMinute(SYM, { day: DAY, at: mAgo(1), isFrozen: true, bidQty: 100000, offerQty: 40000 });

    console.log('\n=== the rows ===');
    const lad = await depth.ladder(SYM, DAY, { now });
    const b210 = lad.bids.find((x) => x.price === 210);
    chk('210: +70,000 with nothing traded → PLACED', b210 && events(b210).includes('PLACED') && textOf(b210, 'PLACED') === '+70,000, nothing traded', b210);
    const b200 = lad.bids.find((x) => x.price === 200);
    chk('200 × 155,000 unchanged all session → PARKED, 0 changes', b200 && events(b200).includes('PARKED') && textOf(b200, 'PARKED') === 'parked, 0 changes', b200);
    const b195 = lad.bids.find((x) => x.price === 195);
    chk('197 → 195, same 50,000, nothing traded → RELOCATED "50,000 moved from 197"', b195 && events(b195).includes('RELOCATED') && textOf(b195, 'RELOCATED') === '50,000 moved from 197', b195);
    const o225 = lad.offers.find((x) => x.price === 225);
    chk('the touch offer 225 after 239→228→226→225 untraded → WALKDOWN step 3', o225 && events(o225).includes('WALKDOWN') && textOf(o225, 'WALKDOWN') === 'walk-down, step 3', o225);
    chk('the bracket between the last two captures is {0,0}', lad.traded && lad.traded.max === 0 && lad.volumeDelta === 0, lad.traded);
    chk('no flow notes (nothing vanished unexplained)', Array.isArray(lad.flowNotes) && lad.flowNotes.length === 0, lad.flowNotes);

    console.log('\n=== the banners ===');
    const types = (lad.banners || []).map((b) => b.type);
    chk('DOUBLE WALL from symbol_minute.is_frozen (two frozen rows, recent)', types.includes('DOUBLE WALL'), lad.banners);
    chk('CLOSING BID: 1,827,769 at yesterday\'s close, 20,000 at the first capture, nothing traded — an observation', types.includes('CLOSING BID') && /1,827,769 bid at 224 at .*'s close/.test(lad.banners.find((b) => b.type === 'CLOSING BID').text), lad.banners);

    console.log('\n=== on the wire ===');
    const ob = await get(`/orderbook/${SYM}?date=${DAY}`);
    chk('GET /orderbook carries banners, flowNotes, traded and volumeDelta', ob.status === 200 && Array.isArray(ob.body.banners) && ob.body.banners.length === 2 && Array.isArray(ob.body.flowNotes) && ob.body.volumeDelta === 0 && ob.body.traded && ob.body.traded.max === 0, ob.body && { banners: ob.body.banners, vd: ob.body.volumeDelta, tr: ob.body.traded });
    const wire210 = ob.body.bids.find((l) => Number(l.price) === 210);
    chk('  and the PLACED marker on the 210 row', wire210 && (wire210.markers || []).some((m) => m.event === 'PLACED'), wire210);

    console.log('\n=== a trade explains the fall ===');
    // Readings strictly INSIDE the next capture pair say 60,000 certainly
    // traded; 210 falls by 60,000 → TRADED, not PULLED.
    await fx.quote(SYM, { day: DAY, at: mAgo(0.2), last: 210, bid: 210, offer: 225, volume: 60000, trades: 9 });
    await fx.depthLevels(SYM, mAgo(0.1), [
      { level: 1, bid: 210, bidQty: 40000, offer: 225, offerQty: 40000 },
      { level: 2, bid: 200, bidQty: 155000, offer: 245, offerQty: 60000 },
      { level: 3, bid: 195, bidQty: 50000, offer: 250, offerQty: 20000 },
    ]);
    await fx.quote(SYM, { day: DAY, at: mAgo(0.05), last: 210, bid: 210, offer: 225, volume: 60000, trades: 9 });
    const lad2 = await depth.ladder(SYM, DAY, { now });
    const t210 = lad2.bids.find((x) => x.price === 210);
    chk('210: −60,000 with 60,000 certainly traded → TRADED', t210 && events(t210).includes('TRADED') && textOf(t210, 'TRADED') === '60,000 traded', t210);
    // The walk (239→228→226→225) happened untraded; a trade AFTER it, with the
    // touch still 225, does not unmake it.
    chk('  the walk-down stands — the trade came after the last step', events(lad2.offers.find((x) => x.price === 225)).includes('WALKDOWN'), lad2.offers[0]);

    console.log('\n=== no volume series → no flow marker ===');
    await fx.clearQuotes(SYM);
    const lad3 = await depth.ladder(SYM, DAY, { now });
    chk('without quotes the falls are not judged (no PULLED / TRADED / RELOCATED), the age markers still render', lad3.traded === null && lad3.volumeDelta === null
      && !lad3.bids.some((b) => events(b).some((e) => ['PULLED', 'TRADED', 'RELOCATED'].includes(e)))
      && lad3.bids.some((b) => events(b).includes('AGED') || events(b).includes('PARKED')), lad3.bids.map((b) => [b.price, events(b)]));
    chk('  and no CLOSING BID line either', !(lad3.banners || []).some((b) => b.type === 'CLOSING BID'), lad3.banners);
  } catch (e) {
    chk('the suite ran without throwing', false, `${e.message} | ${e.stack.split('\n').slice(1, 3).join(' | ')}`);
  } finally {
    await clean().catch(() => {});
    srv.close();
    await pool.end();
  }
  console.log(`\n${p === n ? 'ALL PASS' : 'FAILURES: ' + (n - p)}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
