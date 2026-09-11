/**
 * F6 · holdFacts and F7 · fits — pure, no database.
 *
 *   holdFacts assembles the hold block from the bundle: every fact is either
 *   computed with its numbers or {computed:false, reason} — never a zero.
 *   fits is the "Free 720 — MRC fits, KHOT needs 120 more" line: greedy in
 *   board order, an uncomputed minimum is said, not assumed.
 */
const { holdFacts } = require('../src/api/holdFacts');
const { fits } = require('../src/api/sizing');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

console.log('\n=== F6 · holdFacts ===');
const contract = { state: 'holding', shares: 3000, entry: 248, bid: 249, unrealisedKd: 3, quoteAt: '2026-09-10T07:00:00Z',
  targetNormal: 250, targetTrending: 254, breakEvenPrice: 250, stopFils: 246 };
const book = {
  bids: [{ price: 248, qty: 120000, aged: true, markers: [{ event: 'AGED', text: 'held 40m' }] }, { price: 245, qty: 50000, aged: true, markers: [] }],
  offers: [{ price: 251, qty: 12000, markers: [] }, { price: 255, qty: 400000, presencePct: 96, markers: [{ event: 'CEILING', text: 'ceiling · 96% of session' }] }],
};
const t = { no_protection_qty: 20000, exit_depth_max_x: 3 };
const f = holdFacts({ contract, book, sizing: { basis: { offer_qty: 12000 } }, candidate: { metrics: { volSpikeRatio: 1.42 } }, thresholds: t, yourShares: 3000 });
chk('MARK: the bid and the unrealised', f.mark.computed && f.mark.bidFils === 249 && f.mark.unrealisedKd === 3, f.mark);
chk('BID PROTECTED: 120,000 at the touch, over 20,000, an aged level beneath', f.bidProtected.computed && f.bidProtected.protectedNow && f.bidProtected.agedBelow && /120,000 at the touch/.test(f.bidProtected.note), f.bidProtected);
chk('EXIT AT: the targets, break-even and the recorded stop', f.exitAt.computed && f.exitAt.targetNormal === 250 && f.exitAt.stopFils === 246, f.exitAt);
chk('VOLUME: the spike ratio', f.volume.computed && f.volume.ratio === 1.42 && /1\.42×/.test(f.volume.note), f.volume);
chk('CEILING: the marked wall with its presence', f.ceiling.computed && f.ceiling.priceFils === 255 && f.ceiling.qty === 400000 && /96%/.test(f.ceiling.note), f.ceiling);
chk('REFILL: not measured, said', f.refill.computed === false && /not measured/.test(f.refill.reason), f.refill);
chk('EXIT OK: 12,000 offer = 4× your 3,000 ≥ 3× — you are not the level', f.exitOk.computed && f.exitOk.multiple === 4 && f.exitOk.ok === true, f.exitOk);

const thin = holdFacts({ contract, book: { ...book, offers: [{ price: 251, qty: 4000, markers: [] }] }, sizing: null, candidate: null, thresholds: t, yourShares: 3000 });
chk('EXIT OK: 4,000 offer = 1.3× your 3,000 — under 3×, your offer would be the level', thin.exitOk.computed && thin.exitOk.ok === false && /would be the level/.test(thin.exitOk.note), thin.exitOk);
chk('VOLUME with no card: not computed, with the reason', thin.volume.computed === false && /no card/.test(thin.volume.reason), thin.volume);
chk('CEILING with no marked wall: computed, none', thin.ceiling.computed && thin.ceiling.priceFils === null && /no offer wall/.test(thin.ceiling.note), thin.ceiling);

const noProt = holdFacts({ contract: { ...contract, bid: null, unrealisedKd: null }, book: { bids: [{ price: 248, qty: 500, markers: [{ event: 'NOPROT', text: '500 — nothing beneath' }] }], offers: [] }, sizing: null, candidate: null, thresholds: t, yourShares: 3000 });
chk('MARK with no quote today: not computed, marked at entry', noProt.mark.computed === false && /marked at entry/.test(noProt.mark.reason), noProt.mark);
chk('BID PROTECTED on a NOPROT touch: not protected, "nothing beneath"', noProt.bidProtected.computed && noProt.bidProtected.protectedNow === false && /nothing beneath/.test(noProt.bidProtected.note), noProt.bidProtected);
chk('EXIT OK with no offer depth: not computed', noProt.exitOk.computed === false, noProt.exitOk);

const empty = holdFacts({ contract: null, book: null, sizing: null, candidate: null, thresholds: {}, yourShares: null });
chk('nothing known: every fact says why, none is a number', ['mark', 'bidProtected', 'exitAt', 'volume', 'ceiling', 'refill', 'exitOk'].every((k) => empty[k].computed === false && typeof empty[k].reason === 'string'), empty);

console.log('\n=== F7 · fits ===');
const card = (symbol, minKd) => ({ symbol, headroom: { minKd } });
const a = fits([card('MRC', 300), card('KHOT', 500)], 720);
chk('720 free: MRC (300) fits, KHOT (500) needs 80 more', a.items[0].fits === true && a.items[1].fits === false && a.items[1].deficitKd === 80 && a.line === 'Free 720 — MRC fits, KHOT needs 80 more', a);
const b = fits([card('MRC', 300), card('KHOT', 400)], 720);
chk('both fit: all 2 fit, 20 left over', b.line === 'Free 720 — all 2 fit, 20 left over' && b.remainingKd === 20, b);
const c = fits([card('MRC', 300)], 720);
chk('one card: it fits, the rest left over', c.line === 'Free 720 — MRC fits, 420 left over', c);
const d = fits([card('MRC', 300), card('ABAR', null)], 720);
chk('an uncomputed minimum is said, never assumed to fit', d.items[1].computed === false && d.items[1].fits === null && /ABAR minimum not computed/.test(d.line), d);
const e = fits([card('MRC', 900)], 720);
chk('nothing fits: the deficit is named', e.line === 'Free 720 — nothing fits, MRC needs 180 more', e);
chk('no take cards: nothing to fit', fits([], 720).line === 'Free 720 — nothing to fit');
chk('free unknown: said', fits([card('MRC', 300)], null).line === 'free KD not known');

console.log(`\n${p === n ? 'ALL PASS' : 'FAILURES: ' + (n - p)}  (${n} checks)`);
process.exit(p === n ? 0 : 1);
