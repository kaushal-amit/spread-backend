/**
 * R-29 · the operator's own file (BACKEND_spec §8).
 *   GET /export/:date      the day as JSON (contracts, signals, gates) and as CSV
 *   POST /ai/memory        a fact the operator adds — unconfirmed until confirmed
 *   POST /ai/memory/:id/confirm   flips confirmed_by_user; 404 for an unknown id
 *   GET /settings          reads public.app_config; secrets show only ••••<last4>
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('export');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const { toResponse } = require('../src/api/errors');
const gateStore = require('../src/services/gateStore');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const SYM = 'SZTESTEXP', DAY = kuwaitDay();

(async () => {
  await gateStore.load().catch(() => {});

  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/routes').build());
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { const { status, body } = toResponse(err); res.status(status).json(body); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'no such endpoint', code: 'NOT_FOUND' }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    const cd = r.headers.get('content-disposition') || '';
    let j = null, text = null;
    if (/json/.test(ct)) { try { j = await r.json(); } catch { /* not json */ } }
    else { text = await r.text(); }
    return { status: r.status, body: j, text, ct, cd };
  };

  try {
    // seed: two signals for the day — one scored (was_right set), one not.
    await fx.clearSignals(SYM);
    await fx.signal(SYM, DAY, 'DEPTH_FLIP', 150, true);
    await fx.signal(SYM, DAY, 'PACE_UP', 151, null);

    console.log('\n=== /export/:date as JSON ===');
    const ej = await call('GET', `/export/${DAY}`);
    chk('200 with the date echoed', ej.status === 200 && ej.body?.date === DAY, ej.status);
    chk('signals counted', ej.body?.signals?.count >= 2, ej.body?.signals);
    chk('  and the scored ones separated', ej.body?.signals?.scored >= 1, ej.body?.signals?.scored);
    chk('contracts and summary present', Array.isArray(ej.body?.contracts) && ej.body?.summary != null, Object.keys(ej.body || {}));
    chk('gates counts present or null', 'gates' in (ej.body || {}));

    console.log('\n=== /export/:date?format=csv ===');
    const ec = await call('GET', `/export/${DAY}?format=csv`);
    chk('served as text/csv', /text\/csv/.test(ec.ct), ec.ct);
    chk('  as a download attachment', /attachment/.test(ec.cd) && ec.cd.includes(DAY), ec.cd);
    chk('  with the header row', /^symbol,seq,state,entry,exit,shares,netKd,feesKd,fills/.test(ec.text || ''), (ec.text || '').slice(0, 60));

    console.log('\n=== POST /ai/memory then confirm ===');
    const bad = await call('POST', '/ai/memory', {});
    chk('a fact is required', bad.status === 400 && /fact/.test(JSON.stringify(bad.body)), bad.status);
    const mk = await call('POST', '/ai/memory', { fact: 'SZTESTEXP fades after 11:00', symbol: SYM });
    chk('created unconfirmed', mk.status === 200 && mk.body?.memory?.confirmed_by_user === false, mk.body);
    const id = mk.body?.memory?.id;
    chk('  it does not yet reach the model', await (async () => {
      const { rows } = await pool.query('SELECT confirmed_by_user, still_true FROM spread.ai_memory WHERE id = $1', [id]);
      return rows[0] && rows[0].confirmed_by_user === false && rows[0].still_true === true;
    })());
    const cf = await call('POST', `/ai/memory/${id}/confirm`);
    chk('confirm flips the flag', cf.status === 200 && cf.body?.memory?.confirmed_by_user === true, cf.body);
    const miss = await call('POST', '/ai/memory/2147483000/confirm');
    chk('confirming an unknown id is 404', miss.status === 404, miss.status);

    console.log('\n=== GET /settings masks secrets ===');
    await fx.appConfig('zz_test_secret', 'super-secret-ABCD', true);
    await fx.appConfig('zz_test_plain', 'visible-value', false);
    const st = await call('GET', '/settings');
    chk('200 with a settings object', st.status === 200 && st.body?.settings != null, st.status);
    chk('a secret shows only its last four', st.body?.settings?.zz_test_secret === '••••ABCD', st.body?.settings?.zz_test_secret);
    chk('  and never the whole value', !/super-secret/.test(JSON.stringify(st.body)));
    chk('a non-secret is shown in full', st.body?.settings?.zz_test_plain === 'visible-value', st.body?.settings?.zz_test_plain);
    chk('the anthropic key falls back to the env, masked, tagged (env)',
      typeof st.body?.settings?.anthropic_api_key === 'string'
        ? /••••.*\(env\)/.test(st.body.settings.anthropic_api_key) || st.body.settings.anthropic_api_key.startsWith('••••')
        : st.body?.settings?.anthropic_api_key === null,
      st.body?.settings?.anthropic_api_key);
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }

  await fx.clearSignals(SYM).catch(() => {});
  await pool.query('DELETE FROM spread.ai_memory WHERE symbol = $1', [SYM]).catch(() => {});
  await fx.clearAppConfig('zz_test_').catch(() => {});
  srv.close();
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
