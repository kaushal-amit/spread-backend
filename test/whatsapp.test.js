/**
 * WhatsApp alerts for TRADEABLE halt-resumes (services/whatsapp.js).
 *   · a TRADEABLE resume produces the one-line alert and posts it to the provider
 *   · a non-TRADEABLE resume sends its one-line reject (only TRADEABLE is audible)
 *   · the Meta and Twilio providers hit the right URL with the right auth/body
 *   · a provider rejection (non-2xx) comes back ok:false, never throws
 *   · a network throw comes back ok:false, never throws
 *   · unconfigured is not silent — it returns WHATSAPP_UNCONFIGURED
 *   · every recipient in WHATSAPP_TO is sent to; ok only if all succeed
 * No DB. global.fetch is stubbed so nothing leaves the box.
 */
const wa = require('../src/services/whatsapp');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const realFetch = global.fetch;
let calls = [];
function stubFetch(impl) {
  calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
}
const okJson = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function clearEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith('WHATSAPP_')) delete process.env[k];
}

(async () => {
  const RESUME = { symbol: 'FUTUREKID', resumePriceFils: 142, verdict: 'TRADEABLE',
    tradeable: true, targetFils: 147, stopFils: 137 };
  const REJECT = { symbol: 'SLOWCO', resumePriceFils: 100, verdict: 'BOOK TOO DEEP',
    tradeable: false, targetFils: 105, stopFils: 95 };

  // ── the alert line ──
  chk('alertText is the one scoped line',
    wa.alertText(RESUME) === 'FUTUREKID resumed 142 · TRADEABLE · target 147 stop 137', wa.alertText(RESUME));
  chk('a non-tradeable line drops the target/stop tail',
    wa.alertText(REJECT) === 'SLOWCO resumed 100 · BOOK TOO DEEP', wa.alertText(REJECT));

  // ── unconfigured is not silent ──
  clearEnv();
  chk('enabled() is false with no config', wa.enabled() === false);
  const un = await wa.send('hello');
  chk('unconfigured send returns WHATSAPP_UNCONFIGURED (not a throw)',
    un.ok === false && un.reason === 'WHATSAPP_UNCONFIGURED', un);

  // ── a non-TRADEABLE resume sends its ONE-LINE reject (10 Sep: every verdict
  //    goes to the phone; only TRADEABLE is audible) ──
  clearEnv();
  process.env.WHATSAPP_PROVIDER = 'twilio';
  process.env.WHATSAPP_TO = '+96599999999';
  process.env.WHATSAPP_TWILIO_SID = 'AC123';
  process.env.WHATSAPP_TWILIO_TOKEN = 'tok';
  process.env.WHATSAPP_TWILIO_FROM = 'whatsapp:+14155238886';
  stubFetch(() => okJson({ sid: 'SM1' }));
  const rejSend = await wa.sendResume(REJECT);
  chk('sendResume on a NON-tradeable resume SENDS the reject line', rejSend.ok === true && calls.length === 1, rejSend);
  chk('  and the line carries the verdict, not a target', /resumed .* · /.test(wa.alertText(REJECT)) && !/target/.test(wa.alertText(REJECT)), wa.alertText(REJECT));
  calls.length = 0;

  // ── Twilio: right URL, basic auth, whatsapp: body ──
  stubFetch(() => okJson({ sid: 'SM42' }));
  const tw = await wa.sendResume(RESUME);
  chk('Twilio send is ok', tw.ok === true && tw.sent === 1, tw);
  chk('  hits the Twilio Messages endpoint for the account', /api\.twilio\.com\/2010-04-01\/Accounts\/AC123\/Messages\.json$/.test(calls[0].url), calls[0].url);
  chk('  with HTTP Basic auth', /^Basic /.test(calls[0].opts.headers.authorization), calls[0].opts.headers.authorization);
  chk('  and the alert line in the Body, To as whatsapp:', /Body=FUTUREKID\+resumed\+142/.test(calls[0].opts.body) && /To=whatsapp/.test(calls[0].opts.body), calls[0].opts.body);

  // ── Meta template path: right URL, bearer, template with one body param ──
  clearEnv();
  process.env.WHATSAPP_PROVIDER = 'meta';
  process.env.WHATSAPP_TO = '96599999999';
  process.env.WHATSAPP_META_PHONE_ID = '55555';
  process.env.WHATSAPP_META_TOKEN = 'metatoken';
  process.env.WHATSAPP_META_TEMPLATE = 'halt_resume';
  stubFetch(() => okJson({ messages: [{ id: 'wamid.1' }] }));
  const mt = await wa.sendResume(RESUME);
  chk('Meta send is ok and carries the message id', mt.ok === true && mt.results[0].id === 'wamid.1', mt);
  chk('  hits graph.facebook.com for the phone id', /graph\.facebook\.com\/v\d+\.0\/55555\/messages$/.test(calls[0].url), calls[0].url);
  chk('  with a Bearer token', calls[0].opts.headers.authorization === 'Bearer metatoken', calls[0].opts.headers.authorization);
  const body = JSON.parse(calls[0].opts.body);
  chk('  as an approved template with the alert as the one body parameter',
    body.type === 'template' && body.template.name === 'halt_resume'
      && body.template.components[0].parameters[0].text === wa.alertText(RESUME), body);

  // ── Meta free-form (no template) path ──
  delete process.env.WHATSAPP_META_TEMPLATE;
  stubFetch(() => okJson({ messages: [{ id: 'wamid.2' }] }));
  await wa.sendResume(RESUME);
  const body2 = JSON.parse(calls[0].opts.body);
  chk('without a template, Meta sends a plain text body', body2.type === 'text' && body2.text.body === wa.alertText(RESUME), body2);

  // ── a provider rejection is ok:false, not a throw ──
  clearEnv();
  process.env.WHATSAPP_PROVIDER = 'twilio';
  process.env.WHATSAPP_TO = '+96599999999';
  process.env.WHATSAPP_TWILIO_SID = 'AC1'; process.env.WHATSAPP_TWILIO_TOKEN = 't'; process.env.WHATSAPP_TWILIO_FROM = '+1';
  stubFetch(() => okJson({ code: 63016, message: 'no template' }, 400));
  const rej = await wa.sendResume(RESUME);
  chk('a 400 from the provider is ok:false with the status, no throw', rej.ok === false && rej.failed === 1 && rej.results[0].error === 'HTTP 400', rej);

  // ── a network throw is caught ──
  stubFetch(() => { throw new Error('ECONNREFUSED'); });
  const netErr = await wa.sendResume(RESUME);
  chk('a network throw is caught → ok:false, error recorded', netErr.ok === false && /ECONNREFUSED/.test(netErr.results[0].error), netErr);

  // ── every recipient is sent to; ok only if all succeed ──
  clearEnv();
  process.env.WHATSAPP_PROVIDER = 'twilio';
  process.env.WHATSAPP_TO = '+9651, +9652, +9653';
  process.env.WHATSAPP_TWILIO_SID = 'AC1'; process.env.WHATSAPP_TWILIO_TOKEN = 't'; process.env.WHATSAPP_TWILIO_FROM = '+1';
  let i = 0;
  stubFetch(() => { i++; return i === 2 ? okJson({ message: 'bad' }, 500) : okJson({ sid: `SM${i}` }); });
  const multi = await wa.sendResume(RESUME);
  chk('all three recipients are attempted', calls.length === 3, calls.length);
  chk('  one failure makes the whole send ok:false, with sent/failed counts', multi.ok === false && multi.sent === 2 && multi.failed === 1, multi);

  global.fetch = realFetch;
  console.log(`\nwhatsapp: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
})();
