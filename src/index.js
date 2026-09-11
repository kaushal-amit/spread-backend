'use strict';
const log = require('./lib/log');
require('dotenv').config();

/*
 * Step 2 · the production check runs FIRST — before the pool is created,
 * before a migration is attempted. It used to run after migrate() and ping(),
 * so a production box with a bad DATABASE_URL died with a connection error and
 * the missing token was never mentioned. Exit 1 with the reason, nothing else.
 */
if (!require('./api/auth').assertProductionConfig()) process.exit(1);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { pool, ping } = require('./db');
const { migrate } = require('./db/migrate');
const daily = require('./jobs/daily');
const { toResponse } = require('./api/errors');

const { registerHandlers, startTicker, startWakeupScanner, startAlertScanner,
  startRowPoller, startHaltScanner, startFeedHealthScanner, scanner } = require('./socket');
const { startDailyStatsScheduler, startM45Scheduler } = require('./jobs/schedule');

const PORT = Number(process.env.PORT || 4000);
const app = express();

/*
 * Phase 0(d) · trust the reverse proxy, EXPLICITLY.
 *
 * auth.js decides "is this request local?" from req.ip and refuses a remote
 * write when no token is set. Behind nginx every request arrives from the proxy,
 * so without this Express reports the proxy's address as req.ip — a remote
 * caller could read as loopback (the proxy sits on 127.0.0.1) and slip past the
 * loopback-only rule, or a real client IP is lost from every log. Set via
 * TRUST_PROXY so the operator states the topology rather than the code guessing:
 * 'loopback' (nginx on the same host, the common case), a hop count, an IP list,
 * or false. Default false — unchanged behaviour when unset, and in production
 * assertProductionConfig already forces a token, so a misread cannot open a
 * write there regardless.
 */
function parseTrustProxy(raw) {
  if (raw == null || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);      // a hop count
  return raw;                                       // 'loopback' | 'uniquelocal' | an IP/subnet CSV
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

app.use(express.json());

// The Vite dev server runs on :3000 and the API on :4000. In production the
// SPA is served from the same origin and this is a no-op.
const CORS_ORIGIN = process.env.CORS_ORIGIN || null;
app.use((req, res, next) => {
  // Only the configured origin is reflected. With none configured, no CORS
  // header at all: a browser on another origin gets nothing, and same-origin
  // (the Vite proxy, a reverse proxy) needs none.
  if (CORS_ORIGIN && CORS_ORIGIN !== '*') {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Vary', 'Origin');
  }
  // Authorization must pass, or a token can never reach the API.
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Spread-Token');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/*
 * Every route the frontend needs, in one router.
 *
 * The frontend's service interfaces are the spec — one endpoint per method,
 * returning exactly the type in its `src/types/`. Nothing is renamed on the
 * client, because a translation layer in the browser is one more place to get a
 * name wrong and a mismatched name is a silent `undefined` rather than an error.
 */
// A shared secret on every write. Reads stay open when no token is configured,
// so localhost is unchanged; set SPREAD_API_TOKEN before a public hostname.
app.use('/api', require('./api/auth').middleware);
app.use('/api', require('./api/routes').build());

/**
 * The DATED routes, mounted separately.
 *
 * They import nothing from the live side — not board(), not the screening
 * pipeline, not the gate config — so a review route cannot compute a
 * recommendation for a day that is over, or trigger a live action from a
 * read-only screen. The split is structural, not a convention.
 */
app.use('/api/review', require('./api/review').build());
app.use('/api', require('./api/sizing').build());

// Diagnostics — the checks that were needed and did not exist (api/diag.js).
app.use('/api/diag', require('./api/diag').build());

// The last line of defence for a handler that is not wrapped: a typed
// response instead of Express's HTML 500 page, and the process stays up.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const { status, body } = toResponse(err);
  if (status >= 500) log.error('[api] unhandled:', err.message);
  res.status(status).json(body);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'no such endpoint', code: 'NOT_FOUND' }));

/*
 * A rejection that escapes every handler above is logged and survived. It is
 * NOT swallowed silently — the message names it — but a trading terminal that
 * exits on a bad query string is worse than one that logs and carries on.
 */
process.on('unhandledRejection', (e) => {
  log.error('[process] unhandled rejection:', e && e.stack ? e.stack : e);
});

/*
 * Phase 0(c) · an uncaught EXCEPTION is not the same as a rejection.
 *
 * A rejection above is logged and survived — a bad query string must not kill
 * the terminal. An uncaughtException is different: after one, V8's own docs say
 * the process is in an undefined state, and carrying on risks a half-mutated
 * position or a corrupt in-memory session map — worse than a restart. So log it
 * LOUDLY and exit non-zero, letting the supervisor (pm2, Phase 0(g), or
 * systemd) restart clean. Loud + supervised restart beats limping on in an
 * unknown state. The shutdown path is deliberately NOT reused here: it awaits
 * the pool and sockets, and that state may be exactly what is corrupt.
 */
process.on('uncaughtException', (e) => {
  log.error('[process] UNCAUGHT EXCEPTION — exiting for a clean restart:', e && e.stack ? e.stack : e);
  process.exit(1);
});

const server = http.createServer(app);

/*
 * Phase 0(c) · a listen error must be fatal and NAMED, not swallowed.
 *
 * EADDRINUSE (a stale instance still holding :4000) and EACCES (a privileged
 * port) fire here, off the callback path, so without this handler the process
 * either crashes with a bare stack or — worse — appears to boot while never
 * actually listening. Say which, then exit 1 so the supervisor retries rather
 * than leaving a dead port that every health check silently fails.
 */
server.on('error', (e) => {
  log.error(`[boot] server failed to listen on ${PORT}: ${e.code || ''} ${e.message}`);
  process.exit(1);
});
const io = new Server(server, {
  cors: CORS_ORIGIN && CORS_ORIGIN !== '*' ? { origin: CORS_ORIGIN } : {},
});
// Phase 3 · the socket carries the same secret as the API.
io.use(require('./api/auth').socketMiddleware);
registerHandlers(io);

const timers = []; // interval handles, cleared on shutdown

(async () => {
  try {
    const m = await migrate();
    log.info(`[boot] migrations: ${m.applied.length} applied, ${m.skipped.length} skipped` +
                (m.drift.length ? `, DRIFT ${m.drift.join(', ')}` : ''));
    if (m.drift.length) {
      log.warn('[boot] the database does not match the repository. Add a new migration ' +
                   'rather than editing an applied one.');
    }
    await ping();

    /*
     * Load the stored gate overrides BEFORE serving. Reading the file meant a
     * saved edit appeared to take effect and changed nothing — the worst
     * outcome, because the operator then trusts a board that does not reflect
     * the setting.
     */
    /*
     * R-36 · the ONE threshold store. Loaded once, here, into a frozen object;
     * a missing key aborts boot NAMING it rather than defaulting silently at
     * request time (BACKEND_spec §1.1). gateStore.effective() reads this object.
     */
    const th = await require('./config/thresholds').load();
    log.info(`[boot] kb_threshold: ${Object.keys(th).length} numbers loaded`);

    const clocks = await require('./lib/session').load();
    log.info(`[boot] session clocks: step-down ${clocks.stepDownAt / 60 | 0}:${String(clocks.stepDownAt % 60).padStart(2, '0')}, hard exit ${clocks.hardExitAt / 60 | 0}:${String(clocks.hardExitAt % 60).padStart(2, '0')}, flat by ${clocks.flatByAt / 60 | 0}:${String(clocks.flatByAt % 60).padStart(2, '0')} (${clocks.loadedFrom})`);
    const g = await require('./services/gateStore').load();
    log.info(`[boot] gate config version ${g.version}` +
                (Object.keys(g.overrides).length ? ` (${Object.keys(g.overrides).length} overrides)` : ' (defaults)'));

    // R-24 · the ladder's short labels, editable in spread.kb_phrase without a
    // deploy. Cached at boot; render() falls back to the spec defaults if a row
    // is absent, so a marker is never blank.
    const ph = await require('./services/phrases').load();
    log.info(`[boot] ladder phrases: ${Object.keys(ph).length} loaded`);

    /*
     * SPR-25 · the halt-swap path is only as alive as SCRAPER_INGEST_URL. Unset,
     * every halt swap dies as a slot_refused_reason nobody reads until a halt
     * happens. Say it LOUDLY at boot and raise a data_alarm so /health and the
     * diag feed carry it now — the loud failure, not the silent value.
     */
    if (!require('./services/scraperClient').configured) {
      log.warn('[boot] SCRAPER_INGEST_URL is UNSET — halt slot swaps cannot reach the scraper; ' +
               'set it (e.g. http://127.0.0.1:8080/ingest) or every halt records SCRAPER_URL_UNSET');
      await pool.query(
        `INSERT INTO spread.data_alarm (trading_day, table_name, alarm, detail)
         VALUES (CURRENT_DATE, 'config', 'SCRAPER_URL_UNSET', $1)
         ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                      COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
        [JSON.stringify({ env: 'SCRAPER_INGEST_URL',
          note: 'unset — the halt-resume slot swap has no endpoint to call; every swap records SCRAPER_URL_UNSET' })])
        .catch((e) => log.warn('[boot] scraper-url alarm', e.message));
    }

    server.listen(PORT, () => log.info(`[boot] SPREAD listening on ${PORT}`, { port: PORT }));
    timers.push(startTicker(io));
    timers.push(startWakeupScanner(io));
    // Pushes the ROW, every two seconds. The scraper writes symbol_minute,
    // signal_log, position and market_day in another process, and this backend
    // has no trigger on them — LISTEN/NOTIFY would need one in public.*, which
    // is a write to the scraper's schema and lint-forbidden.
    timers.push(startRowPoller(io));
    timers.push(startAlertScanner(io));
    // FLOW 6.7 · the halt-resume detector: every 20s, session transitions across
    // all symbols; a down-halt resume is pushed as spread:halt with the verdict
    // already computed (the window is ~2 minutes).
    timers.push(startHaltScanner(io));
    // SPR-27/30 · raise a data_alarm and push the roster when a capture feed
    // (orders above all) goes silent or absent — the six-session blind spot.
    timers.push(startFeedHealthScanner(io));
    // SPR-28 · the 13:45 stats + fee-reconcile slot that never existed —
    // spread.symbol_day_stats had 0 rows on every session because nothing ran
    // the job. Guarded by the same reentrancy wrapper as the scanners (so a slow
    // runDaily cannot overlap and /health sees its lastSuccessAt). Boot catch-up
    // for today and the historical backfill run in the background inside start().
    timers.push(startDailyStatsScheduler({ guard: scanner }));
    timers.push(startM45Scheduler({ guard: scanner }));
    // 1 Oct 2026 · the band ceiling must be re-derived when the settlement fee
    // goes. Checked at boot and then daily: a WARN and a data_alarm until a
    // band-ceiling value is saved on/after the date.
    timers.push(require('./jobs/schedule').startCeilingCheck({ guard: scanner,
      current: () => require('./services/gateStore').effective().GATES.ceilingCommissionKd }));
  } catch (e) {
    log.error('[boot] failed:', e.message);
    process.exit(1);
  }
})();

/*
 * 3.7 · graceful shutdown. SIGTERM is what systemd, Docker and a deploy send;
 * it used to be the default handler — the process died mid-query with the
 * pool open and a socket half-written. Now: stop the timers so nothing new
 * starts, close the socket server and the HTTP listener, drain the pool,
 * exit 0. A hard deadline of 5 s, then exit 1 — a shutdown that hangs is
 * worse than one that is abrupt, because the supervisor waits on it.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('[shutdown] signal received', { signal });
  const deadline = setTimeout(() => { log.error('[shutdown] deadline passed, exiting 1'); process.exit(1); }, 5000);
  deadline.unref();
  try {
    for (const t of timers) if (t) clearInterval(t);
    await new Promise((r) => io.close(() => r()));
    await new Promise((r) => server.close(() => r()));
    await pool.end();
    log.info('[shutdown] clean');
    process.exit(0);
  } catch (e) {
    log.error('[shutdown] failed', e);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
