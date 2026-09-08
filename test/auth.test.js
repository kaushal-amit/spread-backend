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
