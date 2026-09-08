/**
 * R-24 · the ladder markers, and the phrases they render from.
 *
 * The marker DECISION is computed in depth.ladder (deterministic, over the
 * capture history); the label TEXT comes from spread.kb_phrase, with {n}/{p}
 * substituted server-side. Neither is a model call.
 *
 *   BID     BAIT (young + large), AGED (held 30m+), NOPROT (touch < 20k),
 *           CATCH (aged bid on a round number), SHELF (round, not a catch bid)
 *   OFFER   CEILING (present 75%+ of the session), UNDERCUT (fresh touch below
 *           an aged offer), SHELF (round)
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('ladder');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const depth = require('../src/services/depth');
const phrases = require('../src/services/phrases');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };
const DAY = kuwaitDay();
const events = (row) => (row.markers || []).map((m) => m.event);
const textOf = (row, ev) => (row.markers || []).find((m) => m.event === ev)?.text;

(async () => {
  try {
    await phrases.load().catch(() => {});

    const SYM = 'SZTESTLAD';
    await fx.clearDepth(SYM); await fx.instrument(SYM);
    const now = new Date();
    const mAgo = (m) => new Date(now.getTime() - m * 60000);
    // 38 captures (40m → 3m ago): 158, 150, 140 on the bid; 170, 175 on the offer.
    for (let m = 40; m >= 3; m -= 1) {
      await fx.depthLevels(SYM, mAgo(m), [
        { level: 1, bid: 158, bidQty: 120000, offer: 170, offerQty: 60000 },
        { level: 2, bid: 150, bidQty: 200000, offer: 175, offerQty: 90000 },
        { level: 3, bid: 140, bidQty: 80000, offer: null, offerQty: null },
      ]);
    }
    // the last two captures: a bait bid 159 jumps on top, and a fresh seller 168
    // steps below the aged 170 offer.
    for (const m of [2, 0.2]) {
      await fx.depthLevels(SYM, mAgo(m), [
        { level: 1, bid: 159, bidQty: 900000, offer: 168, offerQty: 50000 },
        { level: 2, bid: 158, bidQty: 120000, offer: 170, offerQty: 60000 },
        { level: 3, bid: 150, bidQty: 200000, offer: 175, offerQty: 90000 },
        { level: 4, bid: 140, bidQty: 80000, offer: null, offerQty: null },
      ]);
    }

    console.log('\n=== bid markers ===');
    const lad = await depth.ladder(SYM, DAY, { now });
    const b159 = lad.bids.find((x) => x.price === 159);
    chk('159 is BAIT (2m old, 900k)', b159 && events(b159).includes('BAIT'), b159);
    chk('  and the label renders "2m old" from kb_phrase', textOf(b159, 'BAIT') === '2m old', textOf(b159, 'BAIT'));
    const b158 = lad.bids.find((x) => x.price === 158);
    chk('158 is AGED (held ~40m)', b158 && events(b158).includes('AGED'), b158);
    chk('  and the label renders "held {n}m" with the age', /^held \d+m$/.test(textOf(b158, 'AGED') || ''), textOf(b158, 'AGED'));
    const b150 = lad.bids.find((x) => x.price === 150);
    chk('150 is CATCH (an aged bid on a round number), not SHELF', b150 && events(b150).includes('CATCH') && !events(b150).includes('SHELF'), b150);
    chk('  CATCH renders "catch bid — price chosen"', textOf(b150, 'CATCH') === 'catch bid — price chosen', textOf(b150, 'CATCH'));

    console.log('\n=== offer markers ===');
    const o170 = lad.offers.find((x) => x.price === 170);
    chk('170 is CEILING (present the whole session) and SHELF (round)', o170 && events(o170).includes('CEILING') && events(o170).includes('SHELF'), o170);
    chk('  CEILING renders "ceiling · {n}% of session"', /^ceiling · \d+% of session$/.test(textOf(o170, 'CEILING') || ''), textOf(o170, 'CEILING'));
    const o168 = lad.offers.find((x) => x.price === 168);
    chk('168 is UNDERCUT (a fresh seller below the aged 170)', o168 && events(o168).includes('UNDERCUT'), o168);
    chk('  UNDERCUT names the price it undercut: "undercut — seller below 170"', textOf(o168, 'UNDERCUT') === 'undercut — seller below 170', textOf(o168, 'UNDERCUT'));
    await fx.clearDepth(SYM); await fx.clearInstruments(SYM);

    console.log('\n=== NOPROT · the touch below no_protection_qty ===');
    const NP = 'SZTESTLADNP';
    await fx.clearDepth(NP); await fx.instrument(NP);
    for (let m = 40; m >= 0; m -= 1) {
      await fx.depthLevels(NP, mAgo(m), [
        { level: 1, bid: 103, bidQty: 10000, offer: 106, offerQty: 40000 },
        { level: 2, bid: 101, bidQty: 60000, offer: null, offerQty: null },
      ]);
    }
    const ladNp = await depth.ladder(NP, DAY, { now });
    const t103 = ladNp.bids.find((x) => x.price === 103);
    chk('the touch 103 (10k) is NOPROT', t103 && events(t103).includes('NOPROT'), t103);
    chk('  NOPROT renders "{n} — nothing beneath" with the qty', textOf(t103, 'NOPROT') === '10,000 — nothing beneath', textOf(t103, 'NOPROT'));
    chk('  a deeper level is NOT marked NOPROT (only the touch)', !events(ladNp.bids.find((x) => x.price === 101) || {}).includes('NOPROT'));
    await fx.clearDepth(NP); await fx.clearInstruments(NP);

    console.log('\n=== SHELF vs CATCH · a round number that is not an aged bid ===');
    const RN = 'SZTESTLADRN';
    await fx.clearDepth(RN); await fx.instrument(RN);
    // 150 appears only in the last two captures — a fresh round-number bid → SHELF, not CATCH.
    for (const m of [2, 0.2]) {
      await fx.depthLevels(RN, mAgo(m), [{ level: 1, bid: 150, bidQty: 50000, offer: 152, offerQty: 30000 }]);
    }
    const ladRn = await depth.ladder(RN, DAY, { now });
    const r150 = ladRn.bids.find((x) => x.price === 150);
    chk('a fresh round-number bid is SHELF, not CATCH', r150 && events(r150).includes('SHELF') && !events(r150).includes('CATCH'), r150);
    await fx.clearDepth(RN); await fx.clearInstruments(RN);

    console.log('\n=== the phrase table is the source, and falls back to the spec ===');
    chk('every marker event has a phrase (table or spec default)',
      ['BAIT', 'AGED', 'CATCH', 'SHELF', 'NOPROT', 'CEILING', 'UNDERCUT'].every((e) => phrases.render(e, { n: 1, p: 1 })), null);
    chk('a phrase absent from the table still renders from the spec default',
      phrases.render('THIN') === 'thin — clears fast', phrases.render('THIN'));
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
