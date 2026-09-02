'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { pool, ping } = require('./db');
const { migrate } = require('./db/migrate');
const daily = require('./jobs/daily');
const screening = require('./services/screening');
const live = require('./services/live');
const depth = require('./services/depth');
const alerts = require('./services/alerts');
const claude = require('./services/ai/claude');
const registry = require('./services/ai/registry');
const { BUDGET, ALERT } = require('./config/spread.config');
const { registerHandlers, startTicker, startWakeupScanner, startAlertScanner,
  startRowPoller } = require('./socket');

const PORT = Number(process.env.PORT || 4000);
const app = express();
app.use(express.json());

// The Vite dev server runs on :3000 and the API on :4000. In production the
// SPA is served from the same origin and this is a no-op.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
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

// Diagnostics — the checks that were needed and did not exist.
app.get('/api/diag/alarms', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM spread.data_alarm WHERE resolved_at IS NULL
      ORDER BY raised_at DESC LIMIT 100;`);
  res.json(rows);
});

app.get('/api/diag/coverage', async (req, res) => {
  const day = req.query.date || daily.kuwaitDay();
  const { rows } = await pool.query(
    'SELECT * FROM spread.market_day WHERE trading_day = $1;', [day]);
  res.json(rows[0] || { note: 'no market_day row — the job has not run for this date' });
});

app.get('/api/diag/depth/:symbol', async (req, res) => {
  res.json(await depth.validate(req.params.symbol, req.query.date || daily.kuwaitDay()));
});

app.get('/api/diag/tools', (_req, res) => res.json({
  tools: registry.assertReady(), recent: registry.recentCalls(20),
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
registerHandlers(io);

(async () => {
  try {
    const m = await migrate();
    console.log(`[boot] migrations: ${m.applied.length} applied, ${m.skipped.length} skipped` +
                (m.drift.length ? `, DRIFT ${m.drift.join(', ')}` : ''));
    if (m.drift.length) {
      console.warn('[boot] the database does not match the repository. Add a new migration ' +
                   'rather than editing an applied one.');
    }
    await ping();

    /*
     * Load the stored gate overrides BEFORE serving. Reading the file meant a
     * saved edit appeared to take effect and changed nothing — the worst
     * outcome, because the operator then trusts a board that does not reflect
     * the setting.
     */
    const g = await require('./services/gateStore').load();
    console.log(`[boot] gate config version ${g.version}` +
                (Object.keys(g.overrides).length ? ` (${Object.keys(g.overrides).length} overrides)` : ' (defaults)'));

    require('./api/auth').warnIfOpen();

    server.listen(PORT, () => console.log(`[boot] SPREAD listening on ${PORT}`));
    startTicker(io);
    startWakeupScanner(io);
    // Pushes the ROW, every two seconds. The scraper writes symbol_minute,
    // signal_log, position and market_day in another process, and this backend
    // has no trigger on them — LISTEN/NOTIFY would need one in public.*, which
    // is a write to the scraper's schema and lint-forbidden.
    startRowPoller(io);
    startAlertScanner(io);
  } catch (e) {
    console.error('[boot] failed:', e.message);
    process.exit(1);
  }
})();
