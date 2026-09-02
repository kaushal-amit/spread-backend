'use strict';
/**
 * ============================================================================
 *  socket.js — the live surface
 * ============================================================================
 * Emits against the frontend's type contract. Field names match `src/types/`
 * exactly — no translation layer, because a translation layer is one more
 * place to get a name wrong.
 * ============================================================================
 */

const { pool } = require('./db');
const daily = require('./jobs/daily');
const screening = require('./services/screening');
const live = require('./services/live');
const depth = require('./services/depth');
const alerts = require('./services/alerts');
const claude = require('./services/ai/claude');
const rules = require('./lib/orderRules');
const pricing = require('./lib/pricing');
const { BUDGET, ALERT, SESSION, EXIT } = require('./config/spread.config');

const TICK_MS = Number(process.env.TICK_MS || 15000);
const room = (day) => `day:${day}`;

/*
 * Which symbols have a book on screen.
 *
 * PER SOCKET, not module-level. A shared Set was never cleaned on disconnect,
 * so it only ever grew — one client opening a detail page kept that symbol
 * being pushed to every other client for the life of the process.
 *
 * Emitting for all 142 would invalidate caches nobody is reading; emitting for
 * none was the bug this replaces.
 */
const watchedBySocket = new Map();

/** The union across live sockets. Recomputed rather than accumulated. */
function watchedSymbols() {
  const all = new Set();
  for (const set of watchedBySocket.values()) for (const s of set) all.add(s);
  return all;
}

/** Is the market open right now? Every clock display must ask this first. */
function sessionPhase(now = new Date()) {
  const k = new Date(now.getTime() + SESSION.timezoneOffsetHours * 3600000);
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  const dow = k.getUTCDay();
  if (dow === 5 || dow === 6) return { open: false, phase: 'closed', note: 'weekend' };
  if (mins < 540) return { open: false, phase: 'pre_open', note: 'opens at 09:00' };
  if (mins < 600) return { open: true, phase: 'open', note: 'first hour — widest spreads' };
  if (mins < 660) return { open: true, phase: 'peak', note: 'peak hour' };
  if (mins < 720) return { open: true, phase: 'step_down', note: 'past the step-down' };
  if (mins < 780) return { open: true, phase: 'late', note: 'last hour — drift is negative' };
  return { open: false, phase: 'closed', note: 'session over' };
}

function registerHandlers(io) {
  /*
   * I-04 · eight ack-based handlers removed.
   *
   * `spread:filltime`, `depth`, `alive`, `tinyAt`, `checkSell`, `checkBuy`,
   * `checkStranded` and `ask` were registered here and never emitted by the
   * client, which uses the REST endpoints instead.
   *
   * Two implementations of the same rule check is the condition that inverted
   * the gate answer three times in this system's history — a second one
   * appearing later, not both written at once. One path, over REST.
   */
  io.on('connection', (socket) => {
    let day = daily.kuwaitDay();
    let budgetKd = BUDGET.slotKd;
    socket.join(room(day));

    /* The detail panel tells us which book it is showing. */
    watchedBySocket.set(socket.id, new Set());

    socket.on('spread:watch', ({ symbol } = {}) => {
      if (symbol) watchedBySocket.get(socket.id)?.add(String(symbol).toUpperCase());
    });
    socket.on('spread:unwatch', ({ symbol } = {}) => {
      if (symbol) watchedBySocket.get(socket.id)?.delete(String(symbol).toUpperCase());
    });
    // Without this the set grows forever and a closed tab keeps its symbol
    // being pushed to everyone else.
    socket.on('disconnect', () => watchedBySocket.delete(socket.id));

    socket.on('spread:subscribe', async ({ date, budget } = {}) => {
      socket.leave(room(day));
      day = date || daily.kuwaitDay();
      if (budget) budgetKd = Number(budget);
      socket.join(room(day));
      socket.emit('spread:update', await view(day, budgetKd));
    });





    /* Every order check, before the order form accepts anything. */
  });
}

async function view(day, budgetKd) {
  const screen = await screening.screen(day, budgetKd).catch((e) => {
    console.warn('[socket] screen:', e.message);
    return { recommended: [], nearMiss: [], rejected: [], counts: {}, reach: null };
  });
  const { rows: [cov] } = await pool.query(
    'SELECT * FROM spread.market_day WHERE trading_day = $1;', [day]).catch(() => ({ rows: [] }));

  /*
   * The SAME presenter the REST routes use. If the socket shaped rows itself
   * the two paths would drift, and a field present over one and absent over the
   * other is a silent `undefined` rather than an error.
   */
  const present = require('./api/present');
  return {
    tradingDay: day, budgetKd,
    recommended: screen.recommended.map((x) => present.stockCandidate(x, budgetKd)),
    nearMiss: screen.nearMiss.map((x) => present.stockCandidate(x, budgetKd)),
    rejected: screen.rejected.map((x) => present.stockCandidate(x, budgetKd)),
    counts: screen.counts,
    reach: screen.reach,
    session: sessionPhase(),
    coverage: cov || null,
  };
}

/*
 * The order-rule alerts the frontend listens for.
 *
 * These are TIME-BASED, so they belong on the tick rather than on a form. Both
 * were the most expensive silences in the record:
 *
 *   an order correct when placed, one level below the bid five minutes later,
 *   and nothing noticed for nineteen minutes                       -44.94 KD
 *
 *   a position up 11.40, the exit named twice, and the sell never posted
 *   while the price was there                                          -31 KD
 */
async function ruleAlerts(day, io) {
  const r = room(day);
  const routes = require('./api/routes');
  const contracts = await routes.contracts(day).catch(() => []);

  for (const c of contracts) {
    if (c.state === 'holding' || c.state === 'carried') {
      const hasSell = (c.legs || []).some((l) => l.side === 'SELL' && l.status === 'POSTED');
      const filled = (c.legs || []).find((l) => l.side === 'BUY' && l.status === 'FILLED');
      if (!hasSell && filled?.time) {
        const chk = rules.checkSellPosted({ buyFilledAt: filled.time });
        if (!chk.ok && chk.code === 'NOT_POSTED') {
          io.to(r).emit('spread:alert', {
            kind: 'sell_not_posted', symbol: c.symbol,
            level: chk.severity === 'danger' ? 'danger' : 'warning',
            title: `${c.symbol} filled with no sell posted`,
            body: chk.message, at: new Date().toISOString(),
          });
        }
      }

      // E5. The order obeyed every placement rule when it was placed; the
      // market moved and left it behind.
      for (const l of c.legs || []) {
        if (l.status !== 'POSTED') continue;
        const st = rules.checkStranded({
          side: l.side, orderPriceFils: l.price,
          bidFils: c.bid, offerFils: c.offer,
        });
        if (st.stranded) {
          io.to(r).emit('spread:stranded', {
            symbol: c.symbol, legId: l.id, message: st.message, options: st.options,
          });
        }
      }
    }
  }

  const hard = rules.checkHardExit({ hasPosition: contracts.some((c) => c.state !== 'picked') });
  if (hard.due) {
    io.to(r).emit('spread:alert', {
      kind: 'hard_exit', level: 'danger',
      title: `${EXIT.hardExitAtClock} — flatten before the close`,
      body: hard.message, at: new Date().toISOString(),
    });
  }
}

function startTicker(io, ms = TICK_MS) {
  return setInterval(async () => {
    const day = daily.kuwaitDay();
    const r = room(day);
    if (!io.sockets.adapter.rooms.get(r)) return;
    try {
      io.to(r).emit('spread:update', await view(day, BUDGET.slotKd));

      /*
       * B-02 · the order book never refreshed.
       *
       * `spread:book` was the only invalidator and nothing emitted it, while
       * `spread:update` did not touch the order-book key and staleTime was two
       * minutes. The DOM showed the first-load snapshot indefinitely — on the
       * one panel where a bid thinning from 41,000 to 5,000 is the whole signal.
       */
      /**
       * The BOOK travels, not just the symbol.
       *
       * This emitted { symbol } alone — a refetch signal, which the front-end
       * contract forbids: "the changed row is pushed, not a signal to refetch.
       * A refetch defeats in-place updating."
       *
       * ADDITIVE, deliberately: `symbol` stays, so a consumer that refetches on
       * it keeps working, and a new one reads `book` and stops refetching. Drop
       * `symbol` once nothing uses the refetch path.
       */
      for (const symbol of watchedSymbols()) {
        let book = null;
        try {
          const { rows } = await pool.query(`
            WITH last AS (
              SELECT max(captured_at) AS at FROM spread.v_depth
               WHERE symbol = $1 AND trading_date = $2
            )
            SELECT DISTINCT ON (level) level, bid, bid_qty, offer, offer_qty, captured_at
              FROM spread.v_depth d, last l
             WHERE d.symbol = $1 AND d.trading_date = $2 AND d.captured_at = l.at
             ORDER BY level`, [symbol, day]);
          book = {
            capturedAt: rows.length ? rows[0].captured_at : null,
            // BookLevel = [price, qty, orders|null]. The third is the order
            // COUNT, which the broker feed does not carry.
            b: rows.filter((x) => x.bid !== null).map((x) => [Number(x.bid), Number(x.bid_qty), null]),
            o: rows.filter((x) => x.offer !== null).map((x) => [Number(x.offer), Number(x.offer_qty), null]),
          };
        } catch (e) { /* an empty book is the normal case for 123 of 142 */ }
        io.to(r).emit('spread:book', { symbol, book });
      }
      // Only while the market is open. A 12:30 flatten alert once fired at
      // 19:55 because nothing asked the clock first.
      if (sessionPhase().open) await ruleAlerts(day, io);
    } catch (e) { console.warn('[tick]', e.message); }
  }, ms);
}

/**
 * ─── THE ROW POLLER ────────────────────────────────────────────────────────
 *
 * symbol_minute, signal_log, position and market_day are written by the
 * SCRAPER, in a different process. This backend has no trigger on them.
 *
 * LISTEN/NOTIFY would be true push and needs a trigger in public.* — which is
 * a write to the scraper's schema, and that boundary is lint-enforced. So:
 * poll, every two seconds.
 *
 * Two seconds is not a compromise here. symbol_minute writes once a minute and
 * depth sweeps every fifteen seconds; nothing moves faster than the poll.
 * Revisit NOTIFY if latency ever matters. It does not yet.
 *
 * THE ROW IS PUSHED, NOT A SIGNAL TO REFETCH.
 */
const POLL_MS = Number(process.env.ROW_POLL_MS || 2000);

function startRowPoller(io, { everyMs = POLL_MS } = {}) {
  // Where each stream was last read. Seeded on the first tick from the table's
  // own maximum, so a restart does not replay a whole session into a socket.
  const seen = { minute: null, signal: null, position: null, market: null };
  let seeding = true;

  return setInterval(async () => {
    const day = daily.kuwaitDay();
    const r = room(day);
    if (!io.sockets.adapter.rooms.get(r)) return;

    try {
      if (seeding) {
        const { rows } = await pool.query(`
          SELECT (SELECT max(ts) FROM public.symbol_minute) AS minute,
                 (SELECT max(id) FROM public.signal_log)    AS signal,
                 (SELECT max(id) FROM public.position)      AS position,
                 (SELECT max(computed_at) FROM public.market_day) AS market`);
        Object.assign(seen, rows[0]);
        seeding = false;
        return;
      }

      // symbol_minute -> only the sockets watching that symbol. A trader with
      // one stock open does not need 140 rows a minute.
      const watched = watchedSymbols();
      if (watched.length && seen.minute !== null) {
        // symbol_minute has NO id column — it is keyed on (symbol, ts). The
        // cursor is a timestamp.
        const { rows } = await pool.query(
          `SELECT * FROM public.symbol_minute
            WHERE ts > $1 AND symbol = ANY($2) ORDER BY ts LIMIT 200`,
          [seen.minute, watched]);
        for (const row of rows) io.to(r).emit('spread:minute', row);
        if (rows.length) seen.minute = rows[rows.length - 1].ts;
      }
      // Advance past rows for unwatched symbols, or the cursor never moves and
      // every tick rescans the same range.
      const { rows: top } = await pool.query('SELECT max(ts) AS ts FROM public.symbol_minute');
      if (top[0].ts !== null && (!seen.minute || top[0].ts > seen.minute)) seen.minute = top[0].ts;

      if (seen.signal !== null) {
        const { rows } = await pool.query(
          'SELECT * FROM public.signal_log WHERE id > $1 ORDER BY id LIMIT 100', [seen.signal]);
        for (const row of rows) io.to(r).emit('spread:signal', row);
        if (rows.length) seen.signal = rows[rows.length - 1].id;
      }

      if (seen.position !== null) {
        const { rows } = await pool.query(
          'SELECT * FROM public.position WHERE id > $1 ORDER BY id LIMIT 50', [seen.position]);
        for (const row of rows) io.to(r).emit('spread:position', row);
        if (rows.length) seen.position = rows[rows.length - 1].id;
      }

      const { rows: md } = await pool.query(
        `SELECT * FROM public.market_day
          WHERE computed_at > COALESCE($1, computed_at - interval '1 second')
          ORDER BY computed_at LIMIT 5`, [seen.market]);
      for (const row of md) io.to(r).emit('spread:market', row);
      if (md.length) seen.market = md[md.length - 1].computed_at;
    } catch (e) {
      console.warn('[poll]', e.message);
    }
  }, everyMs);
}

/**
 * The wake-up scan already worked and nothing ran it. A scan that has to be
 * remembered is a scan that happens on the days you did not need it.
 */
const WAKE_TIMES = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00'];

function startWakeupScanner(io, { times = WAKE_TIMES, everyMs = 60000 } = {}) {
  const fired = new Set();
  return setInterval(async () => {
    try {
      const k = new Date(Date.now() + 3 * 3600000);
      const hhmm = `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
      const day = daily.kuwaitDay();
      const key = `${day} ${hhmm}`;
      if (!times.includes(hhmm) || fired.has(key)) return;
      fired.add(key);

      const flagged = await live.wakeUpScan(day);
      io.to(room(day)).emit('spread:wakeup', { day, at: hhmm, flagged,
        // Most stocks have barely traded by 09:30 and the ratios are unstable.
        lowConfidence: hhmm === '09:30' });
      console.log(`[wakeup] ${hhmm}: ${flagged.length} flagged`);
    } catch (e) { console.warn('[wakeup]', e.message); }
  }, everyMs);
}

/**
 * CR-32. Every minute against the live feed, for the depth watchlist.
 *
 * The window averages 3.3 minutes. Checking every ten minutes caught none of
 * ten opportunities in one session.
 */
function startAlertScanner(io, { everyMs = 60000 } = {}) {
  return setInterval(async () => {
    const phase = sessionPhase();
    if (!phase.open) return;
    const day = daily.kuwaitDay();
    try {
      const { rows } = await pool.query(
        /**
         * ─── A BEHAVIOUR CHANGE, NOT A CLEANUP ──────────────────────────────
         *
         * This read spread.depth_watchlist, which has ALWAYS BEEN EMPTY. The
         * scraper writes public.depth_watchlist — 8 slots today — and serves
         * them from /ingest/depth-symbols.
         *
         * So the wake-up scanner has been reading nothing and reporting no
         * wake-ups, which is indistinguishable from a quiet morning. Nothing
         * errored.
         *
         * EXPECT ALERTS THAT HAVE NEVER FIRED BEFORE. If wake-ups start
         * appearing tomorrow, this is why — the scanner was inert, not silent.
         *
         * public.* is READ here, never written; the lint rule is intact.
         */
        `SELECT symbol FROM public.depth_watchlist
          WHERE trading_date = $1 AND released_at IS NULL
          ORDER BY slot_no;`, [day]);
      for (const { symbol } of rows) {
        const r = await alerts.evaluate(symbol, day).catch(() => null);
        if (r?.fire) {
          const id = await alerts.fire(r, day);
          // AUDIBLE. A silent alert for a 3-minute window is not an alert.
          io.to(room(day)).emit('spread:entryAlert', { ...r, alertId: id, audible: ALERT.audible });
          console.log(`[alert] ${symbol} — spread ${r.spreadFils}, fill ~${r.estFillMins}m`);
        }
      }
    } catch (e) { console.warn('[alert]', e.message); }
  }, everyMs);
}

module.exports = { registerHandlers, startTicker, startWakeupScanner, startAlertScanner,
  ruleAlerts, sessionPhase, view, watchedSymbols, watchedBySocket, startRowPoller };
