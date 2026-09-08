/**
 * Step 3.7 / S-06 · operability.
 *
 *   the logger        one JSON line per event, with a level; LOG_LEVEL filters
 *   /api/health       quoteAgeSec, latestStatsDay, session; 503 when the
 *                     session is open and no quote has landed for 5 minutes
 *   SIGTERM           the real server exits 0 within 5 s, cleanly
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('ops');
const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const present = require('../src/api/present');
const socket = require('../src/socket');
const log = require('../src/lib/log');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    console.log('\n=== the logger ===');
    const lines = [];
    log._sink((line) => lines.push(line));
    const fmt = process.env.LOG_FORMAT, lvl = process.env.LOG_LEVEL;
    process.env.LOG_FORMAT = 'json'; process.env.LOG_LEVEL = 'info';
    log.debug('hidden'); log.info('booted', { port: 4000 }); log.warn('careful', new Error('boom'));
    process.env.LOG_LEVEL = 'error'; log.warn('filtered'); log.error('bad', { code: 'X' });
    if (fmt === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = fmt;
    if (lvl === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = lvl;
    log._sink(null);
    const recs = lines.map((l) => JSON.parse(l));
    chk('every line is JSON with t, level and msg', recs.every((r) => r.t && r.level && r.msg), lines);
    chk('debug is dropped at info', !recs.some((r) => r.msg === 'hidden'));
    chk('fields travel', recs.find((r) => r.msg === 'booted')?.port === 4000);
    chk('an Error becomes err', recs.find((r) => r.msg === 'careful')?.err === 'boom');
    chk('LOG_LEVEL=error drops warn', !recs.some((r) => r.msg === 'filtered') && recs.some((r) => r.msg === 'bad' && r.level === 'error'));

    console.log('\n=== health · the rule ===');
    const now = '2026-09-03T07:00:00Z';
    const fresh = present.health({ now, latestQuoteAt: '2026-09-03T06:59:30Z', latestStatsDay: '2026-09-02', session: { open: true, phase: 'peak' } });
    chk('fresh during the session → ok, quoteAgeSec 30', fresh.status === 'ok' && fresh.quoteAgeSec === 30, fresh);
    chk('latestStatsDay is a day', fresh.latestStatsDay === '2026-09-02', fresh.latestStatsDay);
    const stale = present.health({ now, latestQuoteAt: '2026-09-03T06:54:00Z', latestStatsDay: null, session: { open: true, phase: 'peak' } });
    chk('6 minutes old during the session → stale', stale.status === 'stale' && /scraper/.test(stale.note), stale);
    const closed = present.health({ now, latestQuoteAt: '2026-09-02T10:00:00Z', latestStatsDay: null, session: { open: false, phase: 'closed' } });
    chk('a day old while closed → ok (nothing should be writing)', closed.status === 'ok', closed);
    const never = present.health({ now, latestQuoteAt: null, latestStatsDay: null, session: { open: true, phase: 'open' } });
    chk('no quote ever, session open → stale with quoteAgeSec null', never.status === 'stale' && never.quoteAgeSec === null, never);

    console.log('\n=== health · the route ===');
    const app = express();
    app.use('/api', require('../src/api/routes').build());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}/api/health`;
    await fx.clearQuotes('SZTESTHLT'); await fx.instrument('SZTESTHLT');
    await fx.quote('SZTESTHLT', { day: fx.TEST_DAY, at: new Date().toISOString(), last: 1, bid: 1, offer: 2 });
    const realPhase = socket.sessionPhase;
    socket.sessionPhase = () => ({ open: true, phase: 'peak' });
    const r1 = await fetch(url); const b1 = await r1.json();
    chk('200 with a fresh quote', r1.status === 200 && b1.status === 'ok', [r1.status, b1]);
    chk('body has quoteAgeSec and latestStatsDay', 'quoteAgeSec' in b1 && 'latestStatsDay' in b1 && typeof b1.quoteAgeSec === 'number', Object.keys(b1));
    chk('and the session phase', b1.session.phase === 'peak');
    chk('and nothing about the account', !/equity|buyingPower|cash/i.test(JSON.stringify(b1)));
    await fx.clearQuotes('SZTESTHLT');
    // The newest quote in the database is now whatever else is there — on a
    // schema-only kse_test, nothing. Either way it is older than 5 minutes.
    const { rows: [q] } = await pool.query("SELECT max(created_at) AS at FROM public.awsat_market_quotes WHERE created_at > now() - interval '5 minutes'");
    if (!q.at) {
      const r2 = await fetch(url); const b2 = await r2.json();
      chk('503 stale when the session is open and no quote is recent', r2.status === 503 && b2.status === 'stale', [r2.status, b2.status]);
    } else {
      chk('(a live quote is present in this database; the stale path is covered by the pure check above)', true);
    }
    socket.sessionPhase = () => ({ open: false, phase: 'closed' });
    const r3 = await fetch(url);
    chk('200 while closed', r3.status === 200, r3.status);
    socket.sessionPhase = realPhase;
    await fx.clearInstruments('SZTESTHLT');
    srv.close();

    console.log('\n=== SIGTERM · the real server exits 0 within 5 s ===');
    const ROOT = path.join(__dirname, '..');
    const PORT = 20000 + Math.floor(Math.random() * 20000);
    const env = { ...process.env, PORT: String(PORT), LOG_FORMAT: 'json' };
    delete env.NODE_ENV; delete env.SPREAD_API_TOKEN;
    const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const up = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (/listening on/.test(out)) return resolve(true);
        if (child.exitCode !== null || Date.now() - t0 > 20000) return resolve(false);
        setTimeout(poll, 100);
      };
      poll();
    });
    chk('booted', up, out.slice(-300));
    chk('boot lines are JSON', out.trim().split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), out.slice(0, 200));
    const t0 = Date.now();
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c));
      setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 8000);
    });
    const ms = Date.now() - t0;
    chk('exit code 0', code === 0, code);
    chk('within 5 s', ms < 5000, ms);
    chk('and it said so', /"\[shutdown\] clean"/.test(out), out.slice(-300));
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
