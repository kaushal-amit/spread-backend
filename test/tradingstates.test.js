/**
 * trading-states · F1 partial fill, F2 stop hit, F3/F4 size band + override,
 * F5 Trading at Last — the HTTP surface over Postgres.
 *
 *   F3  a POSTED BUY under the floor        409 OUTSIDE_SIZE_BAND
 *       override without a reason           400
 *       override with a reason              200, is_override, [override] note
 *   F4  a card that is not TAKE             409 NOT_TAKE, overridable the same way
 *       a structural card                   409 REFUSED, no override
 *   F1  resolve FILLED 1,200 of 2,000       partial, rest POSTED, contract 1,200 held + 800 resting
 *       a second POSTED BUY                 409 (one open position)
 *       resolve-rest FILLED 500             filled 1,700, two executions, two BUY cash rows
 *       resolve-rest FILLED (the rest)      whole; rest FILLED
 *       a partial SELL, then hit-bid        409 until the rest is cancelled
 *   F2  the stop is recorded at the fill    stop_fils = aged shelf − 1
 *       a bid through it                    stopHit.check marks once, alerts once
 *   F5  13:15 Kuwait is `tal`               canClose, not open
 *       hit-bid in TAL                      at the auction price, venue AUCTION, flat-by does not refuse
 *
 * SZTESTTS* symbols on a schema-only kse_test. The board is stubbed per case.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('tradingstates');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const { toResponse } = require('../src/api/errors');
const gateStore = require('../src/services/gateStore');
const socket = require('../src/socket');
const routes = require('../src/api/routes');
const stopHit = require('../src/services/stopHit');
const session = require('../src/lib/session');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const A = 'SZTESTTSA', B = 'SZTESTTSB', C = 'SZTESTTSC', DAY = kuwaitDay();
// 10:00 Kuwait: before the flat-by clock, so the stops do not refuse.
process.env.SPREAD_TEST_NOW = `${DAY}T07:00:00Z`;

/** The board, stubbed: what the card for a symbol says. */
const stubBoard = (cards) => {
  routes.board = async () => ({
    take: cards.filter((c) => c.bucket === 'TAKE'), oneAway: cards.filter((c) => c.bucket === 'ONE_AWAY'),
    priceWarn: [], leave: cards.filter((c) => c.bucket === 'LEAVE'), notComputed: [],
  });
};

(async () => {
  const realBoard = routes.board;
  const realPhase = socket.sessionPhase;
  await gateStore.load().catch(() => {});
  if (gateStore.sessionBudgetKd() == null) await gateStore.save({ 'session-budget': 790 }, { changedBy: 'tradingstates.test' });
  const app = express();
  app.use(express.json());
  app.use('/api', routes.build());
  app.use('/api', require('../src/api/sizing').build());
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { const { status, body } = toResponse(err); res.status(status).json(body); });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (path) => (await fetch(base + path)).json();
  const legs = (sym) => pool.query('SELECT * FROM spread.order_leg WHERE symbol = $1 ORDER BY id', [sym]).then((r) => r.rows);
  const cash = (legId) => pool.query('SELECT kind, amount_kd FROM spread.cash_movement WHERE order_leg_id = $1 ORDER BY id', [legId]).then((r) => r.rows);

  const clean = async () => {
    for (const s of [A, B, C]) {
      await fx.clearLegs(s); await fx.clearQuotes(s); await fx.clearDepth(s);
      await pool.query('DELETE FROM spread.claim WHERE symbol = $1', [s]);
      await pool.query('DELETE FROM spread.event_log WHERE symbol = $1', [s]);
    }
  };
  // Forty minutes of the same book: 200 × 30,000 on the touch (aged), 195 ×
  // 40,000 beneath (the shelf the stop sits under), offers 201 × 30,000.
  const seedBook = async (sym) => {
    const now = new Date();
    for (let m = 40; m >= 0; m -= 1) {
      const at = new Date(now.getTime() - m * 60000);
      await fx.depthLevels(sym, at, [
        { level: 1, bid: 200, bidQty: 30000, offer: 201, offerQty: 30000 },
        { level: 2, bid: 195, bidQty: 40000, offer: 202, offerQty: 20000 },
        { level: 3, bid: 190, bidQty: 50000, offer: 203, offerQty: 20000 },
      ]);
    }
    await fx.quote(sym, { day: DAY, at: now.toISOString(), last: 200, bid: 200, bidQty: 30000, offer: 201, offerQty: 30000 });
  };

  try {
    await clean();
    await fx.instrument(A); await fx.instrument(B); await fx.instrument(C);
    await seedBook(A);
    socket.sessionPhase = () => ({ open: true, canClose: true, tal: false, phase: 'peak', clocks: session.get() });
    const sz = await get(`/sizing/${A}`);
    chk('the band is computed for A', sz.reachable && sz.floor_kd > 0 && sz.ceiling_kd >= sz.floor_kd, sz);

    console.log('\n=== F3 · the size band at POST BID ===');
    stubBoard([{ symbol: A, bucket: 'TAKE', failed: [], structural: false }]);
    const small = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: 100 });
    chk('20 KD under the floor is refused as OUTSIDE_SIZE_BAND', small.status === 409 && small.body.code === 'OUTSIDE_SIZE_BAND', small.body);
    chk('  naming the floor', /under the \d+ KD floor/.test(small.body.error || ''), small.body.error);
    const noReason = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: 100, override: true });
    chk('an override without a reason is 400', noReason.status === 400 && /reason/.test(noReason.body.error || ''), noReason.body);
    const big = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: 100000 });
    chk('20,000 KD over the ceiling is refused too', big.status === 409 && big.body.code === 'OUTSIDE_SIZE_BAND' && /ceiling/.test(big.body.error), big.body);
    const inside = Math.floor((sz.suggested_kd * 1000) / 200 / 100) * 100;
    chk('  no leg was written by a refusal', (await legs(A)).length === 0);

    console.log('\n=== F4 · the card must be TAKE ===');
    stubBoard([{ symbol: A, bucket: 'ONE_AWAY', failed: ['profit floor'], structural: false }]);
    const notTake = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: inside });
    chk('a ONE AWAY card is refused as NOT_TAKE', notTake.status === 409 && notTake.body.code === 'NOT_TAKE', notTake.body);
    chk('  naming the failing gate', /profit floor/.test(notTake.body.error || ''), notTake.body.error);
    stubBoard([{ symbol: A, bucket: 'LEAVE', failed: ['price band'], structural: true, structuralReason: 'OUT_OF_REACH' }]);
    const structural = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: inside, override: true, overrideReason: 'trying' });
    chk('a structural card is REFUSED even with an override', structural.status === 409 && structural.body.code === 'REFUSED' && /no override/.test(structural.body.detail || ''), structural.body);
    routes.board = async () => { throw new Error('screen exploded'); };
    const noBoard = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: inside });
    chk('a board that did not compute is BOARD_NOT_COMPUTED, not a pass', noBoard.status === 409 && noBoard.body.code === 'BOARD_NOT_COMPUTED', noBoard.body);
    stubBoard([{ symbol: A, bucket: 'ONE_AWAY', failed: ['profit floor'], structural: false }]);
    const taken = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: inside, override: true, overrideReason: 'the floor is one fil away and the book is clean' });
    chk('TAKE IT ANYWAY with a reason posts', taken.status === 200 && taken.body.ok && taken.body.override?.reason, taken.body);
    let [buy] = await legs(A);
    chk('  the leg carries is_override and the reason', buy && buy.is_override === true && /the floor is one fil away/.test(buy.override_reason || ''), buy);
    chk('  and the note names what was overridden', /\[override\].*card ONE_AWAY \(profit floor\)/.test(buy.note || ''), buy.note);

    console.log('\n=== F1 · PART FILLED ===');
    const part = await post('/trading/resolve', { legId: buy.id, status: 'FILLED', filledShares: 1200 });
    chk('1,200 of the bid fills', part.status === 200 && part.body.partial && part.body.partial.filled === 1200 && part.body.partial.resting === inside - 1200, part.body);
    chk('  the reply says the rest is resting', /still resting/.test(part.body.note || ''), part.body.note);
    [buy] = await legs(A);
    chk('  the leg is FILLED with rest POSTED', buy.status === 'FILLED' && buy.rest_status === 'POSTED' && Number(buy.filled_shares) === 1200 && Number(buy.shares) === inside, buy);
    let cs = await get(`/trading/contracts?date=${DAY}`);
    let ca = cs.find((c) => c.symbol === A);
    chk('  the contract holds 1,200 with the rest resting', ca && ca.shares === 1200 && ca.restingBuyShares === inside - 1200, ca);
    chk('  the contract leg shows restStatus POSTED and the resting shares', ca.legs[0].restStatus === 'POSTED' && ca.legs[0].restingShares === inside - 1200, ca.legs[0]);
    const second = await post('/trading/record', { symbol: A, side: 'BUY', status: 'POSTED', priceFils: 200, shares: inside });
    chk('a second POSTED BUY is refused — one open position', second.status === 409 && /already has an open position/.test(second.body.error), second.body);
    const bad = await post('/trading/resolve', { legId: buy.id, status: 'FILLED' });
    chk('/resolve on the filled leg is refused (it is settled)', bad.status === 409, bad.body);
    const rest1 = await post('/trading/resolve-rest', { legId: buy.id, status: 'FILLED', filledShares: 500 });
    chk('the rest fills 500 more', rest1.status === 200 && rest1.body.rest.filled === 500 && rest1.body.rest.resting === inside - 1700, rest1.body);
    [buy] = await legs(A);
    chk('  filled_shares 1,700, still POSTED rest, two executions', Number(buy.filled_shares) === 1700 && buy.rest_status === 'POSTED' && Number(buy.executions) === 2, buy);
    const feeAfter1 = Number(buy.commission_kd);
    const rows = await cash(buy.id);
    chk('  two BUY cash rows and two FEE rows on the one leg', rows.filter((r) => r.kind === 'BUY').length === 2 && rows.filter((r) => r.kind === 'FEE').length === 2, rows);
    const tooMany = await post('/trading/resolve-rest', { legId: buy.id, status: 'FILLED', filledShares: inside });
    chk('more than the rest is 400', tooMany.status === 400, tooMany.body);
    const rest2 = await post('/trading/resolve-rest', { legId: buy.id, status: 'FILLED' });
    chk('the rest of the rest fills', rest2.status === 200 && rest2.body.rest.resting === 0, rest2.body);
    [buy] = await legs(A);
    chk('  whole: filled = shares, rest FILLED, three executions, the fee grew', Number(buy.filled_shares) === inside && buy.rest_status === 'FILLED' && Number(buy.executions) === 3 && Number(buy.commission_kd) > feeAfter1, buy);
    const again = await post('/trading/resolve-rest', { legId: buy.id, status: 'FILLED' });
    chk('resolve-rest on a whole leg is refused', again.status === 409, again.body);
    cs = await get(`/trading/contracts?date=${DAY}`);
    ca = cs.find((c) => c.symbol === A);
    chk('  the contract holds all of it, nothing resting', ca.shares === inside && ca.restingBuyShares === 0, ca);

    console.log('\n=== F2 · the stop is recorded at the fill and watched ===');
    // The touch (200) has held 40 minutes: it IS the nearest aged shelf at or
    // below the 200 entry, so the stop is one fil under it — 199, not under the
    // deeper 195. A stop under a deeper shelf would be a wider loss than the rule.
    chk('the fill reply carries the stop', part.body.stop && part.body.stop.stopFils === 199, part.body.stop);
    chk('  one fil under the aged 200 touch, on the leg', Number(buy.stop_fils) === 199 && buy.stop_hit_at == null, buy);
    chk('  the contract shows it', ca.stopFils === 199 && ca.stopHitAt === null, ca);
    const det = await get(`/stocks/${A}/detail?date=${DAY}`);
    chk('  the detail stop is the recorded one, fixed at the fill', det.stop && det.stop.stopFils === 199 && det.stop.fixedAtFill === true, det.stop);
    // F6 · the hold facts ride on the bundle: the mark from the contract, the
    // protection from the ladder, the exit depth from the offer (30,000 vs 7,500 = 4× — over 3×, a warning).
    chk('  holdFacts: mark, bid protected, exit depth — from what the bundle already carries', det.holdFacts && det.holdFacts.mark.computed && det.holdFacts.mark.bidFils === 200
      && det.holdFacts.bidProtected.computed && det.holdFacts.bidProtected.protectedNow === true
      && det.holdFacts.exitOk.computed && det.holdFacts.exitOk.ok === false && det.holdFacts.exitOk.multiple === 4 && det.holdFacts.refill.computed === false, det.holdFacts);
    let sh = await stopHit.check(DAY);
    chk('bid 200 above the stop: no hit', sh.hits.length === 0, sh);
    await fx.quote(A, { day: DAY, at: new Date(Date.now() + 1000).toISOString(), last: 199, bid: 199, offer: 200 });
    sh = await stopHit.check(DAY);
    chk('bid 199 at the stop: ONE hit', sh.hits.length === 1 && sh.hits[0].symbol === A && sh.hits[0].bidFils === 199 && sh.hits[0].stopFils === 199, sh);
    const al = stopHit.alertFor(sh.hits[0]);
    chk('  the alert is a danger, audible, named STOP HIT', al.kind === 'stop_hit' && al.level === 'danger' && al.audible && /STOP HIT/.test(al.title), al);
    sh = await stopHit.check(DAY);
    chk('  said once — the second pass is silent', sh.hits.length === 0, sh);
    [buy] = await legs(A);
    chk('  stop_hit_at is set and the note says which bid did it', buy.stop_hit_at != null && /STOP HIT: bid 199/.test(buy.note), buy.note);
    cs = await get(`/trading/contracts?date=${DAY}`);
    ca = cs.find((c) => c.symbol === A);
    chk('  the contract carries stopHitAt', typeof ca.stopHitAt === 'string', ca);
    const ords = await get(`/orders?from=${DAY}&to=${DAY}`);
    const oc = ords.contracts.find((c) => c.symbol === A);
    chk('/orders flags OVERRIDE and STOP_HIT and counts them', oc && oc.flags.some((f) => f.flag === 'OVERRIDE') && oc.flags.some((f) => f.flag === 'STOP_HIT') && ords.summary.overrides >= 1 && ords.summary.stopsHit >= 1, { flags: oc?.flags, summary: ords.summary });

    console.log('\n=== F1 · a partial SELL blocks hit-bid until its rest is resolved ===');
    const sellPost = await post('/trading/record', { symbol: A, side: 'SELL', status: 'POSTED', priceFils: 203, shares: inside });
    chk('the offer is posted', sellPost.status === 200, sellPost.body);
    const sellLeg = (await legs(A)).find((l) => l.side === 'SELL');
    const sellPart = await post('/trading/resolve', { legId: sellLeg.id, status: 'FILLED', filledShares: 1500 });
    chk('1,500 of the offer fills; the rest rests', sellPart.status === 200 && sellPart.body.partial?.resting === inside - 1500, sellPart.body);
    const hitBlocked = await post('/trading/hit-bid', { symbol: A });
    chk('hit-bid is refused while the rest of the offer is resting', hitBlocked.status === 409 && /resolve-rest/.test(hitBlocked.body.detail || ''), hitBlocked.body);
    const cancelRest = await post('/trading/resolve-rest', { legId: sellLeg.id, status: 'CANCELLED' });
    chk('the rest is cancelled; the fill stands', cancelRest.status === 200 && cancelRest.body.rest.cancelled === inside - 1500, cancelRest.body);
    const hit = await post('/trading/hit-bid', { symbol: A });
    chk('hit-bid then sells what is still held at the bid', hit.status === 200 && hit.body.venue === 'MARKET', hit.body);
    cs = await get(`/trading/contracts?date=${DAY}`);
    chk('  A is flat', !cs.find((c) => c.symbol === A), cs);
    // cancel-and-hit on the queued rest: a second contract in B.
    await seedBook(B);
    stubBoard([{ symbol: B, bucket: 'TAKE', failed: [], structural: false }]);
    const bBuy = await post('/trading/record', { symbol: B, side: 'BUY', status: 'FILLED', priceFils: 200, shares: inside });
    chk('B fills whole (a fact, no band refusal)', bBuy.status === 200 && bBuy.body.partial === null && bBuy.body.stop?.stopFils === 199, bBuy.body);
    const bSell = await post('/trading/record', { symbol: B, side: 'SELL', status: 'POSTED', priceFils: 203, shares: inside });
    const bSellLeg = (await legs(B)).find((l) => l.side === 'SELL');
    await post('/trading/resolve', { legId: bSellLeg.id, status: 'FILLED', filledShares: 700 });
    const cah = await post('/trading/cancel-and-hit', { symbol: B });
    chk('cancel-and-hit cancels the queued rest and hits the bid in one write', cah.status === 200 && cah.body.cancelled?.rest === true && cah.body.cancelled.shares === inside - 700, cah.body);
    const bLegs = await legs(B);
    chk('  the partial sell keeps its fill, rest CANCELLED', bLegs.find((l) => l.id === bSellLeg.id).rest_status === 'CANCELLED' && Number(bLegs.find((l) => l.id === bSellLeg.id).filled_shares) === 700, bLegs);
    chk('  B is flat', !(await get(`/trading/contracts?date=${DAY}`)).find((c) => c.symbol === B));
    chk('B posted', bSell.status === 200);

    console.log('\n=== review fixes · a BUY rest after flat, a rest on a closed contract, a CARRIED partial, an empty bid ===');
    await seedBook(C);
    stubBoard([{ symbol: C, bucket: 'TAKE', failed: [], structural: false }]);
    const cPost = await post('/trading/record', { symbol: C, side: 'BUY', status: 'POSTED', priceFils: 200, shares: inside });
    chk('C: bid posted', cPost.status === 200, cPost.body);
    const cLeg = (await legs(C))[0];
    await post('/trading/resolve', { legId: cLeg.id, status: 'FILLED', filledShares: 1000 });
    const hitWithRest = await post('/trading/hit-bid', { symbol: C });
    chk('hit-bid is refused while the BID\'s rest is still queued — a rest that fills after you are flat re-opens the contract', hitWithRest.status === 409 && /still resting/.test(hitWithRest.body.error) && /resolve-rest/.test(hitWithRest.body.detail), hitWithRest.body);
    const cahWithRest = await post('/trading/cancel-and-hit', { symbol: C });
    chk('  cancel-and-hit too, before anything is cancelled', cahWithRest.status === 409 && /still resting/.test(cahWithRest.body.error), cahWithRest.body);
    await post('/trading/resolve-rest', { legId: cLeg.id, status: 'CANCELLED' });
    const cSell = await post('/trading/record', { symbol: C, side: 'SELL', status: 'POSTED', priceFils: 203, shares: 1000 });
    const cSellLeg = (await legs(C)).find((l) => l.side === 'SELL');
    await post('/trading/resolve', { legId: cSellLeg.id, status: 'FILLED', filledShares: 400 });
    // close the contract flat with a direct sell of what is held, leaving the offer's rest queued
    const cFlat = await post('/trading/record', { symbol: C, side: 'SELL', status: 'FILLED', priceFils: 202, shares: 600 });
    chk('  C is sold flat by a direct sell while the offer\'s rest is still queued', cFlat.status === 200 && cSell.status === 200, cFlat.body);
    chk('  C is flat', !(await get(`/trading/contracts?date=${DAY}`)).find((c) => c.symbol === C));
    const cBuy2 = await post('/trading/record', { symbol: C, side: 'BUY', status: 'FILLED', priceFils: 200, shares: inside });
    chk('a second contract opens in C', cBuy2.status === 200, cBuy2.body);
    const orphan = await post('/trading/resolve-rest', { legId: cSellLeg.id, status: 'FILLED' });
    chk('the closed contract\'s sell rest cannot fill against the new contract', orphan.status === 409 && /belongs to contract 1/.test(orphan.body.error), orphan.body);
    const orphanCancel = await post('/trading/resolve-rest', { legId: cSellLeg.id, status: 'CANCELLED' });
    chk('  it can be cancelled', orphanCancel.status === 200, orphanCancel.body);
    const cSell2 = await post('/trading/record', { symbol: C, side: 'SELL', status: 'FILLED', priceFils: 203, shares: inside });
    chk('  and the second contract closes cleanly', cSell2.status === 200 && !(await get(`/trading/contracts?date=${DAY}`)).find((c) => c.symbol === C), cSell2.body);
    // a CARRIED partial has no rest (the day order expired with the session)
    const carried = await post('/trading/record', { symbol: C, side: 'BUY', status: 'CARRIED', priceFils: 200, shares: inside, filledShares: 500 });
    chk('a CARRIED partial is a fact with NO resting rest (rest_status null) — not a constraint error', carried.status === 200 && carried.body.partial === null
      && (await legs(C)).some((l) => l.status === 'CARRIED' && l.rest_status == null && Number(l.filled_shares) === 500), carried.body);
    // an empty bid side is not a print through the stop
    await fx.quote(C, { day: DAY, at: new Date(Date.now() + 3000).toISOString(), last: 200, bid: 0, offer: 201 });
    const shZero = await stopHit.check(DAY);
    chk('bid 0 (a halt / CB auction): not a hit — not computed', shZero.hits.length === 0 && shZero.notComputed.includes(C), shZero);
    await post('/trading/record', { symbol: C, side: 'SELL', status: 'FILLED', priceFils: 203, shares: 500 });

    console.log('\n=== F5 · Trading at Last ===');
    const at = (hhmm) => new Date(`${DAY}T${String(Math.floor(hhmm / 100) - 3).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}:00Z`);
    const p1305 = session.sessionPhase(at(1305)), p1312 = session.sessionPhase(at(1312)), p1315 = session.sessionPhase(at(1315)), p1100 = session.sessionPhase(at(1100));
    chk('13:05 is closed (the auction), TAL named in the note', p1305.phase === 'closed' && !p1305.canClose && /Trading at Last/.test(p1305.note), p1305);
    chk('13:12 is tal: not open, canClose', p1312.phase === 'tal' && p1312.open === false && p1312.canClose === true && p1312.tal === true, p1312);
    chk('13:15 (Close-Of-Day) is over — not a closing venue', p1315.phase === 'closed' && !p1315.tal && !p1315.canClose, p1315);
    chk('11:00 is open and canClose', p1100.open && p1100.canClose && !p1100.tal, p1100);
    chk('the presenter passes tal and canClose through', require('../src/api/present').sessionInfo(p1312, 0).phase === 'tal' && require('../src/api/present').sessionInfo(p1312, 0).canClose === true);
    // A position in B again, then the clock moves to TAL (past the flat-by).
    const bBuy2 = await post('/trading/record', { symbol: B, side: 'BUY', status: 'FILLED', priceFils: 200, shares: inside });
    chk('B is long again', bBuy2.status === 200, bBuy2.body);
    process.env.SPREAD_TEST_NOW = `${DAY}T10:12:00Z`; // 13:12 Kuwait
    socket.sessionPhase = () => ({ open: false, canClose: false, tal: false, phase: 'closed', clocks: session.get() });
    const closedHit = await post('/trading/hit-bid', { symbol: B });
    chk('closed (not TAL): refused', closedHit.status === 409 && /closed/.test(closedHit.body.error), closedHit.body);
    socket.sessionPhase = () => ({ open: false, canClose: true, tal: true, phase: 'tal', clocks: session.get() });
    // A Close-Of-Day print is NOT read: with only that captured there is nothing to close at.
    await fx.quote(B, { day: DAY, at: new Date(Date.now() + 1500).toISOString(), session: 'Close-Of-Day', last: 196, bid: 195, offer: 197 });
    const codOnly = await post('/trading/hit-bid', { symbol: B });
    chk('with only a Close-Of-Day print, TAL has nothing to close at (404, not a price from the wrong label)', codOnly.status === 404 && /Trading-at-Last print/.test(codOnly.body.error), codOnly.body);
    await fx.quote(B, { day: DAY, at: new Date(Date.now() + 2000).toISOString(), session: 'Trading at Last', last: 198, bid: 197, offer: 199 });
    const talHit = await post('/trading/hit-bid', { symbol: B });
    chk('in TAL the close is at the auction price (last 198), venue AUCTION, past the flat-by', talHit.status === 200 && talHit.body.venue === 'AUCTION' && /at 198/.test(talHit.body.note), talHit.body);
    const talLeg = (await legs(B)).filter((l) => l.side === 'SELL').pop();
    chk('  the leg records AUCTION at 198', talLeg.exit_venue === 'AUCTION' && Number(talLeg.price_fils) === 198, talLeg);
    chk('  B is flat', !(await get(`/trading/contracts?date=${DAY}`)).find((c) => c.symbol === B));
  } catch (e) {
    chk('the suite ran without throwing', false, `${e.message} | ${e.stack.split('\n').slice(1, 3).join(' | ')}`);
  } finally {
    routes.board = realBoard;
    socket.sessionPhase = realPhase;
    delete process.env.SPREAD_TEST_NOW;
    await clean().catch(() => {});
    srv.close();
    await pool.end();
  }
  console.log(`\n${p === n ? 'ALL PASS' : 'FAILURES: ' + (n - p)}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
