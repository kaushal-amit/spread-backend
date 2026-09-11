// ─── WhatsApp alerts for TRADEABLE halt-resumes ────────────────────────────
//
// The halt-resume edge is a ~2-minute window and it halves in the first 60
// seconds (HALT_RESUME_study §8). If you are not already looking at the screen
// when a symbol resumes, a push to your phone is the only way to be in time.
// This service sends ONE line — "SLTB resumed 142 · TRADEABLE · target 147 stop
// 137" — for every TRADEABLE resume the detector computes.
//
// Providers, chosen by WHATSAPP_PROVIDER:
//   · gupshup — Gupshup's WhatsApp API (api.gupshup.io). The chosen provider
//              (Amit, 8 Sep): one operator, one number. Form-POST with an apikey
//              header; a plain text message from an approved source number.
//   · meta   — the WhatsApp Cloud API (graph.facebook.com). The message MUST be
//              a pre-approved template unless the recipient messaged you in the
//              last 24 hours; free-form text outside that window is dropped by
//              Meta. So the template path sends a named template with the alert
//              line as its one body parameter.
//   · twilio — Twilio's WhatsApp API (api.twilio.com). Free-form body works from
//              a Twilio sandbox or an approved sender.
//   · console (default when nothing is configured) — logs the line and returns
//              ok:false, reason:'WHATSAPP_UNCONFIGURED'. NOTHING SILENT: an
//              unconfigured install still leaves a log line for every alert.
//
// Every call is bounded (WHATSAPP_TIMEOUT_MS, default 5 s) and NEVER throws —
// the halt scanner must not be taken down by a phone gateway being slow. A
// failure is RETURNED ({ ok:false, reason }) and logged, and the caller surfaces
// it to the terminal so a missed push is visible, not swallowed.

const log = require('../lib/log');

/** Config is read at CALL time (not module load) so a late `process.env` set —
 *  a test, a reloaded secret — is honoured. `to` is a comma/space list. */
function config() {
  const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase() || null;
  const to = (process.env.WHATSAPP_TO || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return {
    provider,
    to,
    timeoutMs: Number(process.env.WHATSAPP_TIMEOUT_MS || 5000),
    // meta
    metaPhoneId: process.env.WHATSAPP_META_PHONE_ID || null,
    metaToken: process.env.WHATSAPP_META_TOKEN || null,
    metaTemplate: process.env.WHATSAPP_META_TEMPLATE || null, // named approved template
    metaLang: process.env.WHATSAPP_META_LANG || 'en',
    // twilio
    twilioSid: process.env.WHATSAPP_TWILIO_SID || null,
    twilioToken: process.env.WHATSAPP_TWILIO_TOKEN || null,
    twilioFrom: process.env.WHATSAPP_TWILIO_FROM || null, // e.g. whatsapp:+14155238886
    // gupshup
    gupshupApiKey: process.env.WHATSAPP_GUPSHUP_APIKEY || null,
    gupshupSource: process.env.WHATSAPP_GUPSHUP_SOURCE || null, // the approved WA source number
    gupshupApp: process.env.WHATSAPP_GUPSHUP_APP || null,       // the Gupshup app name (src.name)
  };
}

/** Is a real provider configured with at least one recipient? */
function enabled() {
  const c = config();
  if (!c.to.length) return false;
  if (c.provider === 'gupshup') return !!(c.gupshupApiKey && c.gupshupSource && c.gupshupApp);
  if (c.provider === 'meta') return !!(c.metaPhoneId && c.metaToken);
  if (c.provider === 'twilio') return !!(c.twilioSid && c.twilioToken && c.twilioFrom);
  return false;
}

/** The one-line alert from a resume payload (services/halts.js payload()).
 *  "FUTUREKID resumed 142 · TRADEABLE · target 147 stop 137" */
function alertText(res) {
  const price = res.resumePriceFils ?? res.resumePrice;
  // A TRADEABLE resume is the trade line; every reject is ONE line naming the
  // verdict and its reason — "FTI resumed 149 · NOT COMPUTED — no book
  // captured", "SLTB resumed 142 · NO BID — touch bid is 0 …". The phone and
  // the feed carry the same lines.
  if (res.tradeable && res.targetFils != null && res.stopFils != null) {
    return `${res.symbol} resumed ${price} · ${res.verdict} · target ${res.targetFils} stop ${res.stopFils}`;
  }
  const detail = res.verdictDetail ? ` — ${res.verdictDetail}` : '';
  return `${res.symbol} resumed ${price ?? '—'} · ${res.verdict}${detail}`;
}

async function postMeta(c, to, text) {
  const url = `https://graph.facebook.com/v20.0/${c.metaPhoneId}/messages`;
  // A pre-approved template if one is named (the only thing Meta delivers
  // outside a 24-hour customer-service window); otherwise a plain text body,
  // which reaches you only if you messaged the number in the last 24 hours.
  const payload = c.metaTemplate
    ? { messaging_product: 'whatsapp', to, type: 'template',
        template: { name: c.metaTemplate, language: { code: c.metaLang },
          components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.metaToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: c._signal,
  });
  let body = null; try { body = await res.json(); } catch { /* not json */ }
  const id = body && body.messages && body.messages[0] && body.messages[0].id;
  return { ok: res.ok, status: res.status, id: id || null, body };
}

async function postGupshup(c, to, text) {
  // Gupshup enterprise WhatsApp API: form-POST, apikey header, a plain text
  // message from the approved source number. `destination` is the E.164 number
  // without a leading '+', which is what Gupshup expects.
  const url = 'https://api.gupshup.io/wa/api/v1/msg';
  const dest = String(to).replace(/^\+/, '');
  const form = new URLSearchParams({
    channel: 'whatsapp',
    source: String(c.gupshupSource).replace(/^\+/, ''),
    destination: dest,
    'src.name': c.gupshupApp,
    message: JSON.stringify({ type: 'text', text }),
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: c.gupshupApiKey, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: c._signal,
  });
  let body = null; try { body = await res.json(); } catch { /* not json */ }
  // Gupshup returns { status: 'submitted', messageId } on success.
  const id = body && (body.messageId || body.message_id) ? (body.messageId || body.message_id) : null;
  const ok = res.ok && (!body || body.status !== 'error');
  return { ok, status: res.status, id, body };
}

async function postTwilio(c, to, text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.twilioSid}/Messages.json`;
  const form = new URLSearchParams({
    To: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    From: c.twilioFrom.startsWith('whatsapp:') ? c.twilioFrom : `whatsapp:${c.twilioFrom}`,
    Body: text,
  });
  const auth = Buffer.from(`${c.twilioSid}:${c.twilioToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: c._signal,
  });
  let body = null; try { body = await res.json(); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, id: (body && body.sid) || null, body };
}

/**
 * Send `text` to every configured recipient. Returns
 *   { ok, provider, sent, failed, results:[{to, ok, status, id, error}] }
 * ok is true only if EVERY recipient succeeded. Never throws.
 */
async function send(text, { to: toOverride } = {}) {
  const c = config();
  const recipients = toOverride
    ? (Array.isArray(toOverride) ? toOverride : [toOverride])
    : c.to;

  if (!c.provider || c.provider === 'console' || !enabled()) {
    // Unconfigured — but not silent. The line is logged so the operator can see
    // that an alert WOULD have gone out, and stand up a provider.
    log.info('[whatsapp] (unconfigured) would send:', text);
    return { ok: false, provider: c.provider || 'console', sent: 0, failed: 0,
      reason: 'WHATSAPP_UNCONFIGURED', results: [] };
  }
  if (!recipients.length) {
    return { ok: false, provider: c.provider, sent: 0, failed: 0, reason: 'WHATSAPP_NO_RECIPIENTS', results: [] };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  c._signal = ctrl.signal;
  const results = [];
  try {
    for (const to of recipients) {
      try {
        const r = c.provider === 'gupshup' ? await postGupshup(c, to, text)
          : c.provider === 'meta' ? await postMeta(c, to, text)
          : await postTwilio(c, to, text);
        if (!r.ok) log.warn('[whatsapp] send rejected', { to, status: r.status, body: r.body });
        results.push({ to, ok: r.ok, status: r.status, id: r.id, error: r.ok ? null : `HTTP ${r.status}` });
      } catch (e) {
        log.warn('[whatsapp] send failed', { to, err: e.message });
        results.push({ to, ok: false, status: 0, id: null, error: e.message || 'network error' });
      }
    }
  } finally {
    clearTimeout(timer);
    delete c._signal;
  }
  const sent = results.filter((r) => r.ok).length;
  return { ok: sent === recipients.length && sent > 0, provider: c.provider,
    sent, failed: results.length - sent, results };
}

/** EVERY resume is delivered — TRADEABLE as the trade line, every reject
 *  (NO BID, BOOK TOO DEEP, NOT COMPUTED, …) as its one-line reason. A halt the
 *  operator does not hear about is the failure the detector exists to prevent;
 *  the feed and the phone carry the same lines, and only TRADEABLE is AUDIBLE
 *  (socket.js `audible: res.tradeable`). A payload with no verdict at all is
 *  not a resume and is not sent. */
function shouldDeliver(res) {
  return !!res && typeof res.verdict === 'string' && res.verdict.length > 0;
}
async function sendResume(res) {
  if (!shouldDeliver(res)) return { ok: false, reason: 'NO_VERDICT', sent: 0 };
  return send(alertText(res));
}

module.exports = { send, sendResume, shouldDeliver, alertText, enabled, config };
