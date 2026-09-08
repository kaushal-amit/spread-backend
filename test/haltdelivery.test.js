/**
 * H-D1 · every TRADEABLE resume is DELIVERED, and the delivery is RECORDED.
 * At 11:16 the detector produced a clean TRADEABLE for UPAC and nobody saw it —
 * "was it sent?" must be a query. Provider = Gupshup (Amit, 8 Sep); one operator.
 *
 *   · the Gupshup provider hits api.gupshup.io with the apikey and the line
 *   · a delivery attempt is stamped on the halt_event row (delivered_at / channel)
 *   · with no provider the send is LOGGED and the row records why, delivered_at NULL
 *   · a TRADEABLE row left with all delivery fields NULL is the defect
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('haltdelivery');
const { pool } = require('../src/db');
const halts = require('../src/services/halts');
const whatsapp = require('../src/services/whatsapp');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = kuwaitDay();
const SYM = 'SZTESTHALTD';
const realFetch = global.fetch;

const seedResume = async () => {
  const { rows: [r] } = await pool.query(
    `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, verdict, verdict_detail,
       direction, resume_price_fils, target_fils, stop_fils)
     VALUES ($1,$2,'RESUME', now(), 'TRADEABLE', 'bid 14,000 · you 2,800 = 20%', 'DOWN', 244, 249, 239)
     RETURNING id;`, [DAY, SYM]);
  return r.id;
};
const rowOf = async (id) => (await pool.query(
  'SELECT delivery_channel, delivered_at, delivery_error FROM spread.halt_event WHERE id = $1', [id])).rows[0];

(async () => {
  try {
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [SYM]);

    const res = { id: null, symbol: SYM, resumePriceFils: 244, verdict: 'TRADEABLE', tradeable: true, targetFils: 249, stopFils: 239 };

    console.log('\n=== the one-line alert ===');
    chk('reads "SYM resumed 244 · TRADEABLE · target 249 stop 239"',
      whatsapp.alertText(res) === `${SYM} resumed 244 · TRADEABLE · target 249 stop 239`, whatsapp.alertText(res));

    console.log('\n=== Gupshup provider: right URL, apikey, the line ===');
    const calls = [];
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return {
      ok: true, status: 200, json: async () => ({ status: 'submitted', messageId: 'gs-1' }), text: async () => '' }; };
    process.env.WHATSAPP_PROVIDER = 'gupshup';
    process.env.WHATSAPP_TO = '+96599999999';
    process.env.WHATSAPP_GUPSHUP_APIKEY = 'gskey';
    process.env.WHATSAPP_GUPSHUP_SOURCE = '+96500000000';
    process.env.WHATSAPP_GUPSHUP_APP = 'spreadbot';
    chk('enabled() true once Gupshup is configured', whatsapp.enabled() === true);
    const wr = await whatsapp.sendResume(res);
    chk('hits the Gupshup endpoint', calls.length === 1 && /api\.gupshup\.io\/wa\/api\/v1\/msg$/.test(calls[0].url), calls[0]?.url);
    chk('  with the apikey header', calls[0]?.opts.headers.apikey === 'gskey', calls[0]?.opts.headers);
    chk('  the destination has no leading +', /destination=96599999999/.test(calls[0].opts.body), calls[0].opts.body);
    chk('  and the alert line in the message', /resumed 244 · TRADEABLE/.test(decodeURIComponent(calls[0].opts.body).replace(/\+/g, ' ')), calls[0].opts.body);
    chk('send ok', wr.ok === true && wr.provider === 'gupshup', wr);

    console.log('\n=== the attempt is stamped on the row (H-D1) ===');
    const id1 = await seedResume();
    await halts.recordDelivery(id1, { channel: wr.provider, deliveredAt: new Date(), error: null });
    const r1 = await rowOf(id1);
    chk('delivered_at is set', r1.delivered_at != null, r1);
    chk('channel is gupshup', r1.delivery_channel === 'gupshup', r1);
    chk('no error on success', r1.delivery_error == null, r1);

    console.log('\n=== unconfigured: logged, not silent; the row says why (delivered_at NULL) ===');
    for (const k of ['WHATSAPP_PROVIDER', 'WHATSAPP_GUPSHUP_APIKEY', 'WHATSAPP_GUPSHUP_SOURCE', 'WHATSAPP_GUPSHUP_APP']) delete process.env[k];
    calls.length = 0;
    const wr2 = await whatsapp.sendResume(res);
    chk('no network call when unconfigured', calls.length === 0, calls.length);
    chk('returns WHATSAPP_UNCONFIGURED', wr2.ok === false && wr2.reason === 'WHATSAPP_UNCONFIGURED', wr2);
    const id2 = await seedResume();
    await halts.recordDelivery(id2, { channel: wr2.provider, deliveredAt: null, error: wr2.reason });
    const r2 = await rowOf(id2);
    chk('the row records the console channel', r2.delivery_channel === 'console', r2);
    chk('delivered_at stays NULL (nothing was sent)', r2.delivered_at == null, r2);
    chk('and the reason is on the row', r2.delivery_error === 'WHATSAPP_UNCONFIGURED', r2);

    console.log('\n=== a non-TRADEABLE resume does not push ===');
    const skip = await whatsapp.sendResume({ ...res, tradeable: false, verdict: 'UP HALT — SKIP' });
    chk('NOT_TRADEABLE, no send', skip.ok === false && skip.reason === 'NOT_TRADEABLE', skip);

    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [SYM]);
    console.log(`\n${p}/${n} PASS`);
    if (p !== n) process.exitCode = 1;
  } catch (e) {
    console.error('haltdelivery.test.js FAILED', e);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
    await pool.end();
  }
})();
