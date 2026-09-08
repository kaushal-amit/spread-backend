'use strict';
const log = require('./lib/log');
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
const halts = require('./services/halts');
const whatsapp = require('./services/whatsapp');
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
    let budgetKd = require('./services/gateStore').sessionBudgetKd();
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
      // S-08 · validated like the REST params. A bad payload is answered, not
      // passed to Postgres; and a subscribe costs a board, so it is throttled.
      let d, b;
      try {
        const { dayParam, budgetParam } = require('./api/params');
        d = dayParam(date);
        b = budgetParam(budget, budgetKd);
      } catch (e) {
        return socket.emit('spread:error', { code: 'BAD_REQUEST', error: e.message });
      }
      const now = Date.now();
      if (socket.data.lastSubscribe && now - socket.data.lastSubscribe < 2000) {
        return socket.emit('spread:error', { code: 'RATE_LIMITED', error: 'one subscribe every 2 seconds' });
      }
      socket.data.lastSubscribe = now;
      socket.leave(room(day));
      day = d; budgetKd = b;
      socket.join(room(day));
      socket.emit('spread:update', await view(day, budgetKd));
    });





    /* Every order check, before the order form accepts anything. */
  });
}

async function view(day, budgetKd) {
  /*
   * B-01 · THE SAME BOARD THE REST ROUTES SERVE.
   *
   * This called screening.screen() directly with the FILE gates, so after any
   * PUT /gates the socket and the REST routes disagreed about which stocks
   * passed. routes.board() applies the stored overrides and caches for one
   * tick; both paths now read it.
   */
  const screen = await require('./api/routes').board(day, budgetKd).catch((e) => {
    log.warn('[socket] screen:', e.message);
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
    // R-19 / R-20 · travels with every tick so the board's state line and the
    // detail page's buttons read the same verdict the trading routes enforce.
    stops: await require('./services/stops').evaluate(day).catch((e) => ({ error: e.message, canOpen: false, mode: 'unknown', reasons: [`stops not computed: ${e.message}`] })),
  };
}

/*
 * A stop is announced ONCE when it comes into force, and once when it lifts.
 * The tick re-evaluates every 15 s; the feed must not.
 */
let lastStopKey = null;
function announceStops(io, day, stops) {
  if (!stops) return;
  const key = `${day}:${stops.mode}:${(stops.reasons || []).join('|')}`;
  if (key === lastStopKey) return;
  const was = lastStopKey;
  lastStopKey = key;
  if (was === null && stops.canOpen) return; // first tick of a normal day: nothing to say
  const r = room(day);
  if (!stops.canOpen) {
    io.to(r).emit('spread:alert', {
      kind: 'session_stop', level: 'danger',
      title: stops.mode === 'cooloff' ? 'NO RE-ENTRY — 30 minutes after a loss' : stops.mode === 'careful' ? 'CAREFUL' : 'STOP — the day is over for new positions',
      body: (stops.reasons || []).join(' · '), at: new Date().toISOString(),
    });
  } else if (stops.mode === 'careful') {
    io.to(r).emit('spread:alert', {
      kind: 'session_careful', level: 'warning',
      title: 'CAREFUL — one position, take 2 fils',
      body: stops.market?.reason || '', at: new Date().toISOString(),
    });
  } else {
    io.to(r).emit('spread:alert', {
      kind: 'session_stop_lifted', level: 'info',
      title: 'Trading allowed again', body: stops.market?.reason || 'the stop no longer applies', at: new Date().toISOString(),
    });
  }
}

/*
 * R-21 · the 20-minute time stop. Announced once per open position (symbol+seq)
 * when it first crosses the clock with no favourable print; forgotten when the
 * position closes so a later contract can announce again. hit-bid is the action
 * — there is no auto-sell.
 */
const announcedTimeStops = new Set();
function announceTimeStops(io, day, stops) {
  if (!stops || !Array.isArray(stops.timeStops)) return;
  const r = room(day);
  const live = new Set();
  for (const ts of stops.timeStops) {
    const key = `${day}:${ts.symbol}:${ts.seq}`;
    live.add(key);
    if (announcedTimeStops.has(key)) continue;
    announcedTimeStops.add(key);
    io.to(r).emit('spread:timeStop', { symbol: ts.symbol, seq: ts.seq, minutesHeld: ts.minutesHeld, bid: ts.bid, at: new Date().toISOString() });
    io.to(r).emit('spread:alert', {
      kind: 'time_stop', level: 'warning', symbol: ts.symbol,
      title: `TIME STOP — ${ts.symbol} held ${ts.minutesHeld} min with no move`,
      body: `Not printed above ${ts.entry} in ${ts.minutesHeld} minutes. Close it at the bid${ts.bid != null ? ` (${ts.bid})` : ''} — capital in a frozen book blocks the next setup, and the losses come from waiting.`,
      at: new Date().toISOString(),
    });
  }
  for (const k of [...announcedTimeStops]) if (!live.has(k)) announcedTimeStops.delete(k);
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
let lastNotComputed = { key: '', at: 0 };
let lastStale = '';
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
    }
  }

  // E5 — every POSTED leg, from order_leg itself, against today's quote only
  // (alerts.stranded). A symbol without a quote is reported, not guessed.
  const e5 = await alerts.stranded(day).catch((e) => ({ alerts: [], notComputed: [], stale: [], error: e.message }));
  for (const a of e5.alerts) io.to(r).emit('spread:stranded', a);
  // A POSTED leg from an earlier session that was never resolved: said once
  // per day, so it gets resolved rather than judged.
  const staleKey = `${day}:${(e5.stale || []).map((x) => x.legId).join(',')}`;
  if ((e5.stale || []).length && staleKey !== lastStale) {
    lastStale = staleKey;
    io.to(r).emit('spread:alert', {
      kind: 'stale_posted', level: 'warning',
      title: `${e5.stale.length} resting order${e5.stale.length === 1 ? '' : 's'} from an earlier session never resolved`,
      body: e5.stale.map((x) => `${x.symbol} ${x.side} ${x.priceFils} (leg ${x.legId}, posted ${x.postedDay})`).join(', ')
        + ' — resolve each as CANCELLED or FILLED; until then it is not judged by E5',
      at: new Date().toISOString(),
    });
  }
  // Once per ten minutes per set of symbols, not every tick.
  const ncKey = e5.notComputed.join(',');
  if (e5.notComputed.length && (ncKey !== lastNotComputed.key || Date.now() - lastNotComputed.at > 600000)) {
    lastNotComputed = { key: ncKey, at: Date.now() };
    io.to(r).emit('spread:alert', {
      kind: 'stranded_not_computed', level: 'warning',
      title: `${e5.notComputed.length} resting order${e5.notComputed.length === 1 ? '' : 's'} not checked`,
      body: `no quote today for ${e5.notComputed.join(', ')} — the E5 check cannot run`,
      at: new Date().toISOString(),
    });
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
      const v = await view(day, require('./services/gateStore').sessionBudgetKd());
      io.to(r).emit('spread:update', v);
      announceStops(io, day, v.stops);
      announceTimeStops(io, day, v.stops);

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
    } catch (e) { log.warn('[tick]', e.message); }
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
      // C-02 · watchedSymbols() is a Set: `.length` was undefined, so this
      // branch never ran and spread:minute was never emitted. ANY($2) needs
      // an array as well.
      const watched = [...watchedSymbols()];
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
      log.warn('[poll]', e.message);
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
      log.info(`[wakeup] ${hhmm}: ${flagged.length} flagged`);
    } catch (e) { log.warn('[wakeup]', e.message); }
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
        const r = await alerts.evaluate(symbol, day, {
          budgetKd: require('./services/gateStore').sessionBudgetKd() }).catch(() => null);
        if (r?.fire) {
          const id = await alerts.fire(r, day);
          // AUDIBLE. A silent alert for a 3-minute window is not an alert.
          io.to(room(day)).emit('spread:entryAlert', { ...r, alertId: id, audible: ALERT.audible });
          log.info(`[alert] ${symbol} — spread ${r.spreadFils}, fill ~${r.estFillMins}m`);
        }
      }
    } catch (e) { log.warn('[alert]', e.message); }
  }, everyMs);
}

/**
 * ─── THE HALT-RESUME DETECTOR (FLOW 6.7) ────────────────────────────────────
 *
 * Every `halt_poll_secs` (20 by default — the window is ~2 minutes and the
 * edge halves in the first 60 seconds), the latest capture across ALL symbols.
 * A Trading → CB Auction transition is a HALT (direction fixed from the price
 * five minutes prior, the symbol requested into a depth slot); CB Auction →
 * Trading is a RESUME, pushed as `spread:halt` with the verdict already
 * computed. The session map is held here, seeded on the first tick so a restart
 * never replays a session as halts.
 */
function startHaltScanner(io, { everyMs = 20000 } = {}) {
  const sessions = new Map();
  let seeded = false;
  return setInterval(async () => {
    const phase = sessionPhase();
    if (!phase.open) return;
    const day = daily.kuwaitDay();
    try {
      const budgetKd = require('./services/gateStore').sessionBudgetKd();
      // G-7 · on the first tick after a (re)start, rebuild the session map from
      // today's halt_event rows so a logged halt is not re-fired and a resume
      // during the downtime is caught — memory is a cache of the table.
      if (!seeded) { await halts.recoverState(day, sessions).catch(() => {}); seeded = true; }
      const r = await halts.poll(day, { budgetKd, seed: sessions.size === 0 }, sessions);
      if (r.seeded) return;
      const roomId = room(day);
      for (const h of r.halts) {
        // The halt itself, and the slot request — the ladder is needed before
        // the resume, or there is no size and no stop.
        io.to(roomId).emit('spread:halt', { phase: 'HALT', ...h });
        // G-1 · the swap was already APPLIED (or refused) by the poll; the socket
        // event now carries the OUTCOME, and the feed line goes hot on a failure.
        const o = h.slotOutcome || { applied: false, reason: 'no slot decision' };
        io.to(roomId).emit('spread:slotRequest', {
          day, forHalt: h.symbol,
          applied: o.applied, slot: o.slot ?? (h.slotRequest ? h.slotRequest.displace : null),
          replaced: o.replaced ?? (h.slotRequest ? h.slotRequest.displaceSymbol : null),
          reason: o.reason ?? (h.slotRequest ? h.slotRequest.reason : null),
          hot: !o.applied,
          text: o.applied
            ? `${h.symbol} → slot ${o.slot} (replaced ${o.replaced})`
            : `${h.symbol}: slot NOT applied — ${o.reason}`,
        });
        log.info(`[halt] ${h.symbol} halted ${h.direction || '?'} — ` +
          (o.applied ? `slot ${o.slot} applied (drop ${o.replaced})` : `slot NOT applied: ${o.reason}`));
      }
      for (const res of r.resumes) {
        // THE ALERT. The verdict is already computed — two minutes is the trade.
        io.to(roomId).emit('spread:halt', { phase: 'RESUME', audible: res.tradeable, ...res });
        log.info(`[halt] ${res.symbol} resumed ${res.resumePrice} — ${res.verdict}`);
        // The phone push. Only TRADEABLE resumes go to WhatsApp — the window is
        // ~2 minutes and you cannot be watching every symbol. Bounded and never
        // throwing; a failed push is surfaced to the terminal, not swallowed.
        if (res.tradeable && whatsapp.enabled()) {
          whatsapp.sendResume(res).then((wr) => {
            if (!wr.ok) {
              log.warn(`[halt] WhatsApp push failed for ${res.symbol}: ${wr.reason || (wr.results || []).map((x) => x.error).join('; ')}`);
              io.to(roomId).emit('spread:whatsappFailed', {
                symbol: res.symbol, reason: wr.reason || 'send failed',
                text: `WhatsApp push for ${res.symbol} did not go out — check the gateway`,
              });
            } else {
              log.info(`[halt] WhatsApp push sent for ${res.symbol} (${wr.sent} recipient${wr.sent === 1 ? '' : 's'})`);
            }
          }).catch((e) => log.warn('[halt] WhatsApp push error', e.message));
        }
      }
      // A4 · a slot whose depth capture has gone stale (>10 min) during the
      // session — the tile reads "stale — last capture 09:04". A report, not a
      // block: the swap decision will displace it first when a wake-up fires.
      const stale = await require('./services/slots').staleSlots(day, {}).catch(() => []);
      for (const s of stale) {
        io.to(roomId).emit('spread:slotStale', { slot: s.slot, symbol: s.symbol, lastCaptureAt: s.lastCaptureAt });
      }
    } catch (e) { log.warn('[halt]', e.message); }
  }, everyMs);
}

module.exports = { registerHandlers, startTicker, startWakeupScanner, startAlertScanner,
  ruleAlerts, sessionPhase, view, watchedSymbols, watchedBySocket, startRowPoller, announceStops,
  startHaltScanner };
