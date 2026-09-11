/**
 * An unset token used to let every write through from ANY host — no error, and
 * behaviour that looks correct until the service has a public hostname.
 */
const express = require('express');
const http = require('http');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const build = (token) => {
  delete require.cache[require.resolve('../src/api/auth')];
  if (token) process.env.SPREAD_API_TOKEN = token; else delete process.env.SPREAD_API_TOKEN;
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/auth').middleware);
  app.get('/api/read', (_q, r) => r.json({ ok: true }));
  app.post('/api/write', (_q, r) => r.json({ ok: true }));
  return http.createServer(app);
};

const call = (srv, method, headers = {}) =>
  fetch(`http://127.0.0.1:${srv.address().port}/api/${method === 'GET' ? 'read' : 'write'}`,
    { method, headers }).then((r) => r.status);

(async () => {
  // ── no token: loopback writes pass, remote ones do not ──
  let srv = build(null);
  await new Promise((r) => srv.listen(0, r));
  chk('no token · a loopback READ passes', await call(srv, 'GET') === 200);
  chk('no token · a loopback WRITE passes', await call(srv, 'POST') === 200);
  // A forwarded header means the request came through a proxy — remote by
  // definition, and the header itself cannot be trusted as proof of origin.
  chk('no token · a FORWARDED write is refused',
      await call(srv, 'POST', { 'x-forwarded-for': '203.0.113.9' }) === 401);
  chk('no token · a FORWARDED read is refused as well',
      await call(srv, 'GET', { 'x-forwarded-for': '203.0.113.9' }) === 401);
  // /health stays open for the load balancer.
  {
    const st = await fetch(`http://127.0.0.1:${srv.address().port}/api/health`,
      { headers: { 'x-forwarded-for': '203.0.113.9' } }).then((r) => r.status);
    chk('no token · /health is open (404 here: no handler in this harness, but not 401)', st !== 401, st);
  }
  srv.close();

  // ── behind a proxy (TRUST_PROXY set): NOTHING is loopback, even without XFF ──
  // nginx → 127.0.0.1:4000 without proxy_set_header X-Forwarded-For made every
  // internet request look local, and with the token unset every read and
  // trading write was open. The topology is stated, not inferred.
  {
    process.env.TRUST_PROXY = '1';
    srv = build(null);
    await new Promise((r) => srv.listen(0, r));
    chk('behind proxy, no token · a loopback-looking WRITE without XFF is refused',
        await call(srv, 'POST') === 401);
    chk('behind proxy, no token · a loopback-looking READ without XFF is refused',
        await call(srv, 'GET') === 401);
    srv.close();
    delete process.env.TRUST_PROXY;
  }

  // ── the token floor ──
  {
    delete require.cache[require.resolve('../src/api/auth')];
    process.env.SPREAD_API_TOKEN = 'short8ch';
    const auth = require('../src/api/auth');
    const lines = [];
    const fake = { error: (m) => lines.push(m), warn: (m) => lines.push(m) };
    chk('production · an 8-character token refuses to start, naming the length and the floor',
        auth.assertProductionConfig({ env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://t' }, log: fake }) === false
        && /8 characters — use at least 24/.test(lines.join('\n')), lines);
    lines.length = 0;
    chk('development · the same token boots with a warning',
        auth.assertProductionConfig({ env: { NODE_ENV: 'development', CORS_ORIGIN: 'https://t' }, log: fake }) === true
        && /8 characters/.test(lines.join('\n')));
    lines.length = 0;
    delete require.cache[require.resolve('../src/api/auth')];
    process.env.SPREAD_API_TOKEN = 'x'.repeat(24);
    const D3 = { FIREBASE_PROJECT_ID: 'jk-test', SPREAD_ALLOWED_UIDS: 'uid-amit' };
    chk('production · 24 characters is the floor and boots',
        require('../src/api/auth').assertProductionConfig({ env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://t', ...D3 }, log: fake }) === true, lines);
    lines.length = 0;
    chk('production · no FIREBASE_PROJECT_ID refuses to start, naming it',
        require('../src/api/auth').assertProductionConfig({ env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://t', SPREAD_ALLOWED_UIDS: 'u' }, log: fake }) === false
        && /FIREBASE_PROJECT_ID/.test(lines.join('\n')), lines);
    lines.length = 0;
    chk('production · an empty SPREAD_ALLOWED_UIDS refuses to start, naming it',
        require('../src/api/auth').assertProductionConfig({ env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://t', FIREBASE_PROJECT_ID: 'x' }, log: fake }) === false
        && /SPREAD_ALLOWED_UIDS/.test(lines.join('\n')), lines);
    delete process.env.SPREAD_API_TOKEN;
  }

  // ── D3 · a sign-in (Firebase ID token) beside the service token ──
  console.log('\n=== D3 · service token OR a signed-in, allowlisted user ===');
  {
    delete require.cache[require.resolve('../src/api/auth')];
    process.env.SPREAD_API_TOKEN = 'service-token-of-24-chars!';
    process.env.SPREAD_ALLOWED_UIDS = 'uid-amit, uid-spare';
    const auth = require('../src/api/auth');
    const nowS = () => Math.floor(Date.now() / 1000);
    // The verifier is injected: no network, no Google keys. A "token" is
    // a.b.c where b names the outcome.
    let verifies = 0;
    auth.setVerifier({ verify: async (t) => {
      verifies++;
      const [, kind] = String(t).split('.');
      if (kind === 'expired') { const e = new Error('expired'); e.code = 'TOKEN_EXPIRED'; throw e; }
      if (kind === 'garbage') { const e = new Error('bad'); e.code = 'BAD_TOKEN'; throw e; }
      if (kind === 'stranger') return { uid: 'uid-stranger', email: 'x@y.z', exp: nowS() + 3600 };
      if (kind === 'short') return { uid: 'uid-amit', email: 'amit@x', exp: nowS() + 1 };
      return { uid: 'uid-amit', email: 'amit@x', exp: nowS() + 3600 };
    } });
    const code = (p) => p.then(() => null, (e) => e.code);
    chk('the service token → service', (await auth.authenticate('service-token-of-24-chars!')).kind === 'service');
    chk('  from a remote address too (server-to-server, any address)', (await auth.authenticate('service-token-of-24-chars!', { local: false })).kind === 'service');
    const u = await auth.authenticate('h.ok.s');
    chk('a valid ID token with a listed uid → user, with uid/email/exp', u.kind === 'user' && u.uid === 'uid-amit' && u.email === 'amit@x' && u.exp > nowS(), u);
    await auth.authenticate('h.ok.s');
    chk('  the same token is verified ONCE (cached until exp)', verifies === 1, verifies);
    chk('an unlisted uid → UID_NOT_ALLOWED', await code(auth.authenticate('h.stranger.s')) === 'UID_NOT_ALLOWED');
    chk('  and it is a 403, not a 401', await auth.authenticate('h.stranger.s').catch((e) => e.status) === 403);
    chk('an expired token → TOKEN_EXPIRED', await code(auth.authenticate('h.expired.s')) === 'TOKEN_EXPIRED');
    chk('garbage → BAD_TOKEN', await code(auth.authenticate('h.garbage.s')) === 'BAD_TOKEN');
    chk('a non-JWT string that is not the service token → BAD_TOKEN without asking the verifier',
        await code(auth.authenticate('not-a-jwt')) === 'BAD_TOKEN' && verifies === 5, verifies);
    chk('nothing → NO_TOKEN', await code(auth.authenticate(null)) === 'NO_TOKEN');
    // the cache honours exp: a 1-second token verifies again after it lapses
    verifies = 0;
    await auth.authenticate('h.short.s');
    await new Promise((r) => setTimeout(r, 1200));
    await auth.authenticate('h.short.s').catch(() => {});
    chk('a cached token is re-verified once its exp has passed', verifies === 2, verifies);

    // over HTTP: the codes reach the body as `reason`
    const app = express();
    app.use('/api', auth.middleware);
    app.get('/api/read', (q, r) => r.json({ auth: q.auth }));
    const srv2 = http.createServer(app);
    await new Promise((r) => srv2.listen(0, r));
    const get = (h) => fetch(`http://127.0.0.1:${srv2.address().port}/api/read`, { headers: { 'x-forwarded-for': '203.0.113.9', ...h } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const ok = await get({ authorization: 'Bearer h.ok.s' });
    chk('HTTP · a signed-in user passes and req.auth names the uid', ok.status === 200 && ok.body.auth.kind === 'user' && ok.body.auth.uid === 'uid-amit', ok);
    const st = await get({ authorization: 'Bearer h.stranger.s' });
    chk('HTTP · a stranger gets 403 FORBIDDEN / reason UID_NOT_ALLOWED with the email in the sentence',
        st.status === 403 && st.body.code === 'FORBIDDEN' && st.body.reason === 'UID_NOT_ALLOWED' && /x@y\.z/.test(st.body.error), st);
    const ex = await get({ authorization: 'Bearer h.expired.s' });
    chk('HTTP · expired → 401 with reason TOKEN_EXPIRED (the SPA refreshes and retries once)', ex.status === 401 && ex.body.reason === 'TOKEN_EXPIRED', ex);
    const svc = await get({ authorization: 'Bearer service-token-of-24-chars!' });
    chk('HTTP · the service token still passes, as service', svc.status === 200 && svc.body.auth.kind === 'service', svc);
    srv2.close();

    // the socket: a user socket is disconnected at exp with spread:reauth first
    const fakeSocket = (token) => {
      const s = { handshake: { auth: { token }, address: '203.0.113.9', headers: {} }, data: {}, emitted: [], disconnected: false, handlers: {},
        emit: (ev, arg) => s.emitted.push([ev, arg]), disconnect: () => { s.disconnected = true; (s.handlers.disconnect || []).forEach((h) => h()); },
        on: (ev, h) => { (s.handlers[ev] ||= []).push(h); } };
      return s;
    };
    const sShort = fakeSocket('h.short.s');
    const nextErr = await new Promise((r) => auth.socketMiddleware(sShort, r));
    chk('socket · a signed-in user connects and socket.data.auth names the uid', !nextErr && sShort.data.auth.uid === 'uid-amit', nextErr && nextErr.message);
    await new Promise((r) => setTimeout(r, 1300));
    chk('socket · at exp the server emits spread:reauth and disconnects',
        sShort.disconnected && sShort.emitted.some(([ev, a]) => ev === 'spread:reauth' && a.reason === 'TOKEN_EXPIRED'), sShort.emitted);
    const sSvc = fakeSocket('service-token-of-24-chars!');
    const e2 = await new Promise((r) => auth.socketMiddleware(sSvc, r));
    chk('socket · a service socket connects with no exp timer', !e2 && sSvc.data.auth.kind === 'service');
    const sBad = fakeSocket('h.stranger.s');
    const e3 = await new Promise((r) => auth.socketMiddleware(sBad, r));
    chk('socket · a stranger is refused with FORBIDDEN / UID_NOT_ALLOWED', e3 && e3.data.code === 'FORBIDDEN' && e3.data.reason === 'UID_NOT_ALLOWED', e3 && e3.data);
    auth.setVerifier(null);
    delete process.env.SPREAD_API_TOKEN; delete process.env.SPREAD_ALLOWED_UIDS;
  }

  // ── with a token: READS need it too (Phase 3) — the account is the sensitive surface ──
  srv = build('sekrit');
  await new Promise((r) => srv.listen(0, r));
  chk('token set · a READ without it is refused', await call(srv, 'GET') === 401);
  chk('token set · a READ with it passes', await call(srv, 'GET', { authorization: 'Bearer sekrit' }) === 200);
  chk('token set · a token of the wrong LENGTH is refused, not thrown',
      await call(srv, 'GET', { authorization: 'Bearer sekrit-but-longer' }) === 401);
  chk('token set · a WRITE without it is refused', await call(srv, 'POST') === 401);
  chk('token set · a WRITE with it passes',
      await call(srv, 'POST', { authorization: 'Bearer sekrit' }) === 200);
  chk('token set · the wrong token is refused',
      await call(srv, 'POST', { authorization: 'Bearer wrong' }) === 401);
  chk('token set · x-spread-token works too',
      await call(srv, 'POST', { 'x-spread-token': 'sekrit' }) === 200);
  srv.close();

  /*
   * ── Step 2 · THE FOUR PROOFS, against the REAL server ──────────────────
   *
   * The harness above mounts the middleware on a stub router. These four boot
   * src/index.js as a child process — the real routes, the real socket — and
   * ask it what a curl would. They need a database because the server
   * migrates and pings on boot, so they run only when DATABASE_URL names a
   * *_test database (the same rule as every DB suite) and are SKIPPED, loudly,
   * otherwise. The production-refusal proof needs no database and always runs.
   */
  const { spawn } = require('child_process');
  const path = require('path');
  const { dbName } = require('./dbguard');
  const ROOT = path.join(__dirname, '..');
  const baseEnv = { ...process.env };
  delete baseEnv.SPREAD_API_TOKEN; delete baseEnv.NODE_ENV; delete baseEnv.CORS_ORIGIN;

  console.log('\n=== NODE_ENV=production without a token refuses to start ===');
  {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['src/index.js'], {
        cwd: ROOT, env: { ...baseEnv, NODE_ENV: 'production', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' } });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => resolve({ code, err }));
      setTimeout(() => { c.kill('SIGKILL'); resolve({ code: 'timeout', err }); }, 8000);
    });
    chk('exits non-zero', r.code === 1, r.code);
    chk('names SPREAD_API_TOKEN', /SPREAD_API_TOKEN/.test(r.err), r.err.slice(0, 200));
    chk('names CORS_ORIGIN', /CORS_ORIGIN/.test(r.err));
    chk('and never reached the database (the URL above cannot connect)', !/ECONNREFUSED|connect/.test(r.err), r.err.slice(0, 200));
  }

  const testDb = process.env.DATABASE_URL && /_test$/i.test(dbName(process.env.DATABASE_URL));
  if (!testDb) {
    console.log('\n=== the real server: /api/account, /api/health, the socket ===\n  SKIP  needs DATABASE_URL naming a *_test database (the server migrates on boot)');
  } else {
    console.log('\n=== the real server: /api/account, /api/health, the socket ===');
    const TOKEN = 'step2-proof-' + Math.random().toString(36).slice(2);
    const PORT = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT, env: { ...baseEnv, SPREAD_API_TOKEN: TOKEN, CORS_ORIGIN: 'http://terminal.test', PORT: String(PORT) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const up = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (/listening on/.test(out)) return resolve(true);
        if (child.exitCode !== null || Date.now() - t0 > 20000) return resolve(false);
        setTimeout(poll, 100);
      };
      poll();
    });
    chk('the server booted against the test database', up, out.slice(-300));
    if (up) {
      const base = `http://127.0.0.1:${PORT}`;
      const H = { 'x-forwarded-for': '203.0.113.9' }; // through a proxy: remote
      const r1 = await fetch(`${base}/api/account`, { headers: H });
      chk('curl /api/account without the token → 401', r1.status === 401, r1.status);
      const b1 = await r1.json();
      chk('  and the body says so', b1.code === 'UNAUTHORISED', b1);
      const r2 = await fetch(`${base}/api/account`, { headers: { ...H, authorization: `Bearer ${TOKEN}` } });
      chk('curl /api/account with the token → JSON', r2.status === 200 && /json/.test(r2.headers.get('content-type') || ''), r2.status);
      const b2 = await r2.json();
      chk('  with the account fields', 'equityKd' in b2 && 'buyingPowerKd' in b2, Object.keys(b2));
      const r3 = await fetch(`${base}/api/health`, { headers: H });
      chk('/api/health is open without a token', r3.status !== 401, r3.status);
      chk('  and says nothing about the account', !/equityKd|buyingPower/.test(await r3.text()));

      const { io } = require('socket.io-client');
      const tryConnect = (auth) => new Promise((resolve) => {
        const s = io(base, { auth, transports: ['websocket'], reconnection: false, timeout: 5000,
          extraHeaders: H });
        const done = (v) => { s.close(); resolve(v); };
        s.on('connect', () => done({ ok: true }));
        s.on('connect_error', (e) => done({ ok: false, message: e.message, code: e.data?.code }));
        setTimeout(() => done({ ok: false, message: 'timeout' }), 6000);
      });
      const good = await tryConnect({ token: TOKEN });
      chk('io({auth:{token}}) connects', good.ok, good);
      const bad = await tryConnect({});
      chk('io() without the token is rejected', !bad.ok && bad.code === 'UNAUTHORISED', bad);
      const wrong = await tryConnect({ token: 'wrong' });
      chk('io() with the wrong token is rejected', !wrong.ok, wrong);
    }
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); });
  }

  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
