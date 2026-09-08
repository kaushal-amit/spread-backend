/**
 * Step 3.2 / B-06 · E5 stranded orders are evaluated from order_leg, and a
 * quote is never fabricated.
 *
 *   a POSTED BUY with the bid now above it            -> spread:stranded
 *   a POSTED BUY at the bid                            -> nothing
 *   a POSTED BUY for a symbol with no quote today      -> nothing, notComputed
 *
 * The first case is the one contracts() could never see: there is no filled
 * buy, so there is no contract, so there was no check. 29 July, -44.94 KD.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('stranded');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const alerts = require('../src/services/alerts');
const { ruleAlerts } = require('../src/socket');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = kuwaitDay();
const BELOW = 'SZTESTE5LOW', ATBID = 'SZTESTE5AT', NOQ = 'SZTESTE5NOQ';

(async () => {
  try {
    for (const s of [BELOW, ATBID, NOQ]) { await fx.clearLegs(s); await fx.clearQuotes(s); await fx.instrument(s); }
    const at = new Date().toISOString();
    // The book moved: bid 240 now, the order rests at 238.
    await fx.quote(BELOW, { day: DAY, at, last: 240, bid: 240, offer: 241 });
    await fx.quote(ATBID, { day: DAY, at, last: 238, bid: 238, offer: 239 });
    for (const [sym, px] of [[BELOW, 238], [ATBID, 238], [NOQ, 238]]) {
      await pool.query(
        `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, posted_at)
         VALUES ($1, $2, 1, 'BUY', 'POSTED', $3, 1000, now() - interval '6 minutes')`, [DAY, sym, px]);
    }

    console.log('\n=== E5 from order_leg, not from contracts() ===');
    const r = await alerts.stranded(DAY);
    const low = r.alerts.find((a) => a.symbol === BELOW);
    chk('a POSTED BUY below the bid is stranded', !!low, r.alerts.map((a) => a.symbol));
    chk('  coded BELOW_BID, 2 levels', low && low.code === 'BELOW_BID' && /2 levels/.test(low.message), low);
    chk('  with the quote it was judged against, not a number from the leg', low && low.bidFils === 240 && low.offerFils === 241, low);
    chk('a POSTED BUY at the bid is not', !r.alerts.some((a) => a.symbol === ATBID));
    chk('a symbol with no quote today fires NOTHING', !r.alerts.some((a) => a.symbol === NOQ));
    chk('  and is counted in notComputed', r.notComputed.includes(NOQ), r.notComputed);
    chk('  alone', !r.notComputed.includes(BELOW) && !r.notComputed.includes(ATBID), r.notComputed);

    console.log('\n=== and the tick emits it ===');
    const emitted = [];
    const io = { to: () => ({ emit: (ev, payload) => emitted.push({ ev, payload }) }) };
    await ruleAlerts(DAY, io);
    chk('spread:stranded for the stranded leg',
        emitted.some((e) => e.ev === 'spread:stranded' && e.payload.symbol === BELOW), emitted.map((e) => [e.ev, e.payload.symbol]));
    chk('none for the symbol without a quote', !emitted.some((e) => e.ev === 'spread:stranded' && e.payload.symbol === NOQ));
    chk('the not-computed symbol is announced, once',
        emitted.filter((e) => e.ev === 'spread:alert' && e.payload.kind === 'stranded_not_computed').length === 1
          && emitted.some((e) => e.payload.kind === 'stranded_not_computed' && e.payload.body.includes(NOQ)));

    // R-03 · a POSTED leg from an earlier session, never resolved, is not
    // judged and is reported once as stale; a resting SELL on an OPEN contract
    // from an earlier day still is.
    console.log('\n=== a leg from an earlier session is stale, not stranded ===');
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, posted_at)
       VALUES ('2001-01-08', $1, 7, 'BUY', 'POSTED', 230, 1000, '2001-01-08T06:30:00Z')`, [BELOW]);
    const r3 = await alerts.stranded(DAY);
    chk('the old leg is in stale', r3.stale.some((x) => x.symbol === BELOW && x.postedDay === '2001-01-08'), r3.stale);
    chk('  and not in alerts', !r3.alerts.some((a) => a.symbol === BELOW && a.priceFils === 230));
    chk("  today's leg on the same symbol is still judged", r3.alerts.some((a) => a.symbol === BELOW && a.priceFils === 238));
    const emitted2 = [];
    await ruleAlerts(DAY, { to: () => ({ emit: (ev, payload) => emitted2.push({ ev, payload }) }) });
    chk('the tick announces the stale leg once', emitted2.filter((e) => e.payload?.kind === 'stale_posted').length === 1, emitted2.map((e) => e.payload?.kind));
    const emitted3 = [];
    await ruleAlerts(DAY, { to: () => ({ emit: (ev, payload) => emitted3.push({ ev, payload }) }) });
    chk('  and not on the next tick', emitted3.filter((e) => e.payload?.kind === 'stale_posted').length === 0);
    // An open contract from an earlier day: its resting SELL is live.
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, posted_at, resolved_at)
       VALUES ('2001-01-08', $1, 9, 'BUY', 'FILLED', 236, 1000, 1000, '2001-01-08T06:30:00Z', '2001-01-08T06:31:00Z'),
              ('2001-01-08', $1, 9, 'SELL', 'POSTED', 245, 1000, NULL, '2001-01-08T07:00:00Z', NULL)`, [ATBID]);
    const r4 = await alerts.stranded(DAY);
    chk('a resting SELL on an open contract from an earlier day is judged (above the offer → stranded)',
        r4.alerts.some((a) => a.symbol === ATBID && a.side === 'SELL' && a.code === 'ABOVE_OFFER'), r4.alerts.filter((a) => a.symbol === ATBID));
    chk('  not stale', !r4.stale.some((x) => x.symbol === ATBID));

    // Yesterday's quote is not today's: a stale row must not judge the order.
    console.log('\n=== a quote from another day does not count ===');
    await fx.clearQuotes(NOQ);
    await fx.quote(NOQ, { day: '2001-01-08', at: '2001-01-08T07:00:00Z', last: 250, bid: 250, offer: 251 });
    const r2 = await alerts.stranded(DAY);
    chk('still notComputed', r2.notComputed.includes(NOQ) && !r2.alerts.some((a) => a.symbol === NOQ), r2);
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }
  for (const s of [BELOW, ATBID, NOQ]) {
    await fx.clearLegs(s).catch(() => {}); await fx.clearQuotes(s).catch(() => {}); await fx.clearInstruments(s).catch(() => {});
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
