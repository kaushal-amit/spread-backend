/**
 * SPR-07/08 · the feed replays from what was recorded.
 * SPR-27/30 · a silent/absent capture feed is raised and shown, not invisible.
 *
 *   GET /api/feed        entry_alert (fired + held) and halt resumes, newest first
 *   feedHealth.roster    ok / silent / absent per EXPECTED script
 *   feedHealth.check     raises a data_alarm for a silent feed
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('feed');
const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const feedHealth = require('../src/services/feedHealth');
const { toResponse } = require('../src/api/errors');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const DAY = kuwaitDay();
const SYM = 'SZTESTFEED';

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/routes').build());
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { const { status, body } = toResponse(err); res.status(status).json(body); });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, json: await r.json() }; };

  try {
    await fx.instrument(SYM);
    await pool.query('DELETE FROM spread.entry_alert WHERE symbol = $1', [SYM]);
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [SYM]);

    // A fired entry, then a held (depth-vetoed) one, then a halt resume.
    await pool.query(
      `INSERT INTO spread.entry_alert (trading_day, symbol, fired_at, spread_fils, bid_fils, offer_fils,
         offer_shares, my_shares, est_fill_mins, depth_signal, suppressed, window_seconds)
       VALUES ($1,$2, now() - interval '5 minutes', 3, 240, 243, 5000, 4000, 2, 'BUY', false, 120);`, [DAY, SYM]);
    await pool.query(
      `INSERT INTO spread.entry_alert (trading_day, symbol, fired_at, spread_fils, bid_fils, offer_fils,
         depth_signal, suppressed, suppressed_reason)
       VALUES ($1,$2, now() - interval '3 minutes', 3, 241, 244, 'SELL', true, 'held off the phone — depth SELL');`, [DAY, SYM]);
    await pool.query(
      `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, resume_price_fils, verdict, verdict_detail)
       VALUES ($1,$2,'RESUME', now() - interval '1 minute', 142, 'TRADEABLE', 'target 147 stop 137');`, [DAY, SYM]);

    console.log('\n=== SPR-07/08 · /feed replays entry_alert + halt resumes ===');
    const f = await get(`/feed?date=${DAY}`);
    const mine = f.json.filter((e) => e.symbol === SYM);
    chk('endpoint returns 200', f.status === 200, f.status);
    chk('the fired entry is present', mine.some((e) => e.kind === 'entry' && /SPREAD 3/.test(e.title)), mine);
    chk('the held entry is present and marked held', mine.some((e) => e.kind === 'entry' && /HELD/.test(e.title) && /depth SELL/.test(e.body)), mine);
    chk('the halt resume is present with its verdict', mine.some((e) => e.kind === 'halt' && /TRADEABLE/.test(e.title)), mine);
    chk('newest first (halt before the 5-min-old entry)', (() => {
      const ts = mine.map((e) => new Date(e.at).getTime());
      return ts.every((v, i) => i === 0 || ts[i - 1] >= v);
    })(), mine.map((e) => e.at));

    console.log('\n=== SPR-27/30 · feedHealth roster: ok / silent / absent ===');
    await fx.heartbeatTable();
    await fx.clearHeartbeats();
    await fx.heartbeat('orders', { secondsAgo: 4000, rowsSeen: 0 });   // silent
    await fx.heartbeat('depth', { secondsAgo: 5, rowsSeen: 42 });      // ok
    // quotes + market-summary never check in → absent
    const ros = await feedHealth.roster({ maxAgeSec: 300, inSession: false }); // liveness only — the in-session rules are proven below
    const st = Object.fromEntries(ros.scripts.map((s) => [s.script, s.status]));
    chk('table present → available', ros.available === true, ros);
    chk('orders is silent', st.orders === 'silent', st);
    chk('depth is ok', st.depth === 'ok', st);
    chk('quotes is absent (never checked in)', st.quotes === 'absent', st);

    console.log('\n=== H9 · a check-in is not a delivery: degraded ===');
    const F = (r, o) => feedHealth.feedStatus(r, { maxAgeSec: 300, inSession: true, ...o }).status;
    chk('feedStatus mirrors the scraper: absent / silent / ok',
      F(null) === 'absent' && F({ silent_sec: 900, rows_seen: 5 }) === 'silent'
      && F({ silent_sec: 10, rows_seen: 5, submission_sec: 20, has_submission_clock: true }) === 'ok');
    chk('a problem string → degraded, any hour',
      F({ silent_sec: 10, rows_seen: 5, submission_sec: 20, has_submission_clock: true, problem: 'no grid' }) === 'degraded'
      && F({ silent_sec: 10, rows_seen: 5, problem: 'no grid' }, { inSession: false }) === 'degraded');
    chk('0 rows in the session → degraded; outside → ok',
      F({ silent_sec: 10, rows_seen: 0, submission_sec: 20, has_submission_clock: true }) === 'degraded'
      && F({ silent_sec: 10, rows_seen: 0, submission_sec: 20, has_submission_clock: true }, { inSession: false }) === 'ok');
    chk('checking in but nothing accepted → degraded (the failing-POST case that read ok)',
      F({ silent_sec: 10, rows_seen: 40, submission_sec: 1200, has_submission_clock: true }) === 'degraded'
      && F({ silent_sec: 10, rows_seen: 40, submission_sec: null, has_submission_clock: true }) === 'degraded');
    chk('a pre-040 row (no submission clock) is judged on the check-in only',
      F({ silent_sec: 10, rows_seen: 40, submission_sec: null, has_submission_clock: false }) === 'ok');
    await fx.heartbeat('depth', { secondsAgo: 5, rowsSeen: 42, problem: 'panel cannot find the ladder' });
    const ros2 = await feedHealth.roster({ maxAgeSec: 300, inSession: true });
    const d2 = ros2.scripts.find((s) => s.script === 'depth');
    chk('roster: a fresh check-in with a problem is degraded, with the reason', d2.status === 'degraded' && /ladder/.test(d2.reason), d2);
    chk('inSessionNow: Thu 10:00 Kuwait yes; Fri 10:00 no; Thu 14:00 no',
      feedHealth.inSessionNow(new Date('2026-09-10T07:00:00Z')) === true
      && feedHealth.inSessionNow(new Date('2026-09-11T07:00:00Z')) === false
      && feedHealth.inSessionNow(new Date('2026-09-10T11:00:00Z')) === false);

    console.log('\n=== SPR-27 · check() raises a data_alarm for the silent orders feed ===');
    await pool.query("DELETE FROM spread.data_alarm WHERE table_name = 'client_heartbeat'");
    const res = await feedHealth.check(DAY, { maxAgeSec: 300 });
    chk('check reports the bad feeds', res.available && res.raised.some((s) => s.script === 'orders'), res);
    const { rows: [al] } = await pool.query(
      "SELECT count(*)::int AS c FROM spread.data_alarm WHERE table_name = 'client_heartbeat' AND column_name = 'orders' AND alarm = 'FEED_SILENT' AND resolved_at IS NULL");
    chk('a FEED_SILENT alarm exists for orders', al.c === 1, al);
    // Idempotent: a second check does not pile up rows (open-once index).
    await feedHealth.check(DAY, { maxAgeSec: 300 });
    const { rows: [al2] } = await pool.query(
      "SELECT count(*)::int AS c FROM spread.data_alarm WHERE table_name = 'client_heartbeat' AND column_name = 'orders' AND alarm = 'FEED_SILENT' AND resolved_at IS NULL");
    chk('still one alarm after a second check', al2.c === 1, al2);

    await pool.query('DELETE FROM spread.entry_alert WHERE symbol = $1', [SYM]);
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [SYM]);
    await pool.query("DELETE FROM spread.data_alarm WHERE table_name = 'client_heartbeat'");
    await fx.clearHeartbeats();

    console.log(`\n${p}/${n} PASS`);
    if (p !== n) process.exitCode = 1;
  } catch (e) {
    console.error('feed.test.js FAILED', e);
    process.exitCode = 1;
  } finally {
    srv.close();
    await pool.end();
  }
})();
