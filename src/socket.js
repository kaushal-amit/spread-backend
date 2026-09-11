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
const { BUDGET, ALERT } = require('./config/spread.config');

/*
 * ─── THE SOCKET PLAN (10 Sep) · cadences ─────────────────────────────────────
 *   SNAPSHOT_MS   one spread:snapshot a minute — board, account, budget,
 *                 session, market, contracts, feeds, slots — plus a PARTIAL
 *                 within PARTIAL_DEBOUNCE_MS of any write / halt / wake-up
 *   HEARTBEAT_MS  spread:tick { seq, at } from the TICKER'S OWN LOOP — if the
 *                 ticker wedges on a query, the heartbeat stops too; the client
 *                 declares TICKER DEAD at 3× this
 *   FOCUS_MS      the ONE symbol a socket is looking at, pushed on change
 *   FINAL         one snapshot after the close ({ final: true }) at the data
 *                 window's end + 1 min; then the ticker IDLES (heartbeat only)
 *                 until PRE_OPEN the next session day
 * TICK_MS is kept as the legacy name for SNAPSHOT_MS (the env var an operator
 * may already have set).
 */
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS || process.env.TICK_MS || 60000);
const TICK_MS = SNAPSHOT_MS;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 10000);
const FOCUS_MS = Number(process.env.FOCUS_MS || 2000);
const PARTIAL_DEBOUNCE_MS = Number(process.env.PARTIAL_DEBOUNCE_MS || 5000);
const PRE_OPEN_MINS = 8 * 60 + 45;                 // 08:45 Kuwait — the ticker wakes
const room = (day) => `day:${day}`;
const { bus: changeBus } = require('./lib/events');

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

/*
 * ─── Phase 0 · SCANNER REENTRANCY GUARD + LIVENESS REGISTRY ──────────────────
 *
 * Every scanner below is a setInterval with an async body. If a tick's work
 * outruns its interval — a slow board query, a stalled pool, the SPR-28
 * backfill — the next tick fires while the previous is still in flight and they
 * PILE UP: overlapping queries competing for the same 10-connection pool, a row
 * cursor advanced from two ticks at once, the same halt emitted twice. The guard
 * makes a tick SKIP rather than overlap, and the skip is LOUD — logged with a
 * running count — never a silent stall.
 *
 * It also records each scanner's last SUCCESSFUL completion, so /health (Phase
 * 0(f)) can show that a scanner is not merely alive but actually FINISHING its
 * work: a loop wedged on a hung query looks identical to a healthy idle one
 * until you can watch lastSuccessAt stop advancing. `scannerHealth()` exposes it.
 */
const _scannerHealth = {};
/**
 * lastSuccessAt  the last run that completed WITHOUT throwing
 * lastWorkAt     the last run that did its work (an early return — market
 *                closed, nobody in the room, not the scheduled minute — is
 *                `idle`, and idle must not read as "fresh": a scanner that
 *                returned early every tick since 09:00 looked alive on /health)
 * lastError      the last throw. The scanners used to swallow their own
 *                errors with a warn line, so this was never set and a scanner
 *                failing every tick since boot showed lastSuccessAt advancing.
 *                They rethrow now; this is the one place that logs and records.
 */
function scanner(name, fn) {
  const h = _scannerHealth[name] = { lastSuccessAt: null, lastWorkAt: null, lastError: null, lastErrorAt: null,
    runs: 0, idle: 0, errors: 0, skipped: 0, running: false };
  return async (...args) => {
    if (h.running) {
      h.skipped += 1;
      // Loud, but coalesced: the first overrun and then every 15th, so a
      // persistent stall is unmistakable without flooding the log every tick.
      if (h.skipped === 1 || h.skipped % 15 === 0) {
        log.warn(`[${name}] previous scan still running — skipped ${h.skipped} tick(s); the loop is behind its interval`);
      }
      return;
    }
    if (h.skipped) { log.info(`[${name}] caught up after skipping ${h.skipped} tick(s)`); h.skipped = 0; }
    h.running = true;
    try {
      const r = await fn(...args);
      const now = new Date().toISOString();
      h.lastSuccessAt = now;
      if (r === 'idle') h.idle += 1; else h.lastWorkAt = now;
      h.lastError = null;
      h.runs += 1;
    } catch (e) {
      h.lastError = e && e.message ? e.message : String(e);
      h.lastErrorAt = new Date().toISOString();
      h.errors += 1;
      // Coalesced like the overrun warning: the first, then every 15th.
      if (h.errors === 1 || h.errors % 15 === 0) log.warn(`[${name}] scan failed (${h.errors} so far)`, h.lastError);
    } finally {
      h.running = false;
    }
  };
}
/** Phase 0(f) · per-scanner liveness for /health: lastSuccessAt, runs, skips. */
function scannerHealth() {
  const out = {};
  for (const [k, v] of Object.entries(_scannerHealth)) {
    out[k] = { lastSuccessAt: v.lastSuccessAt, lastWorkAt: v.lastWorkAt, runs: v.runs, idle: v.idle,
      errors: v.errors, skipped: v.skipped, running: v.running, lastError: v.lastError, lastErrorAt: v.lastErrorAt };
  }
  return out;
}

/** Is the market open right now? Every clock display must ask this first.
 *  ONE source — lib/session.js; the literals that lived here are gone. */
const { sessionPhase } = require('./lib/session');

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
    // Which room this socket FOLLOWS: today's, unless it subscribed to a date
    // of its own. The ticker moves every follower of "today" into the new
    // day's room at the 04:00 Kuwait rollover (followDay below) — a socket
    // that stayed connected overnight used to sit in yesterday's room and
    // receive nothing, no update, no halt alert, until a reload.
    socket.data.followsToday = true;
    socket.data.day = day;

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

    /*
     * The socket plan · the ONE symbol this socket is looking at. The focus
     * loop pushes its quote, book and contract marks every FOCUS_MS when
     * something changed — the detail poll is gone. null clears it (TODAY).
     */
    socket.on('spread:focus', ({ symbol } = {}) => {
      socket.data.focus = symbol ? String(symbol).toUpperCase() : null;
      socket.data.focusSig = null;                   // force the first push
    });

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
      // An explicit date is a choice; a subscribe to today keeps following it.
      socket.data.followsToday = d === daily.kuwaitDay();
      socket.data.day = day;
      // A subscribe answers with the whole snapshot (and the legacy board alias).
      const snap = await require('./services/snapshot').snapshot(day, budgetKd, { reason: 'subscribe' });
      socket.emit('spread:snapshot', snap);
      if (snap.board) socket.emit('spread:update', snap.board);
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
   *
   * §0 · EMPTY IS NOT BROKEN. When the screen throws, this used to emit an
   * empty board with no error — the terminal read "0 symbols · live · nothing
   * passes every gate", a quiet market, while the database was down. And with
   * no session budget it passed null through, which rejected every stock
   * "above the 0-fil ceiling for null KD" where REST answers 503 NOT_READY.
   * Now the payload carries `error` + `code` and the buckets stay empty; the
   * client renders BROKEN, never a clean board.
   */
  let boardError = null;
  let screen;
  if (budgetKd == null) {
    boardError = { code: 'NOT_READY', error: 'no session budget is set — set it with PUT /gates {"session-budget": …}' };
    screen = { take: [], oneAway: [], priceWarn: [], leave: [], recommended: [], nearMiss: [], rejected: [], notComputed: [], counts: {}, reach: null };
  } else {
    screen = await require('./api/routes').board(day, budgetKd).catch((e) => {
      log.warn('[socket] screen:', e.message);
      boardError = { code: e.code || 'BOARD_FAILED', error: 'the board could not be computed — see the server log' };
      return { take: [], oneAway: [], priceWarn: [], leave: [], recommended: [], nearMiss: [], rejected: [], notComputed: [], counts: {}, reach: null };
    });
  }
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
    // null when the board computed; { code, error } when it did not. A client
    // that sees this must not render the empty buckets as a quiet market.
    error: boardError,
    // CR-8 · the four verdict buckets + NOT COMPUTED; the three old names ride
    // along for one release (recommended = take, nearMiss = oneAway,
    // rejected = priceWarn + leave). Nothing is removed: the buckets sum to
    // counts.universe or the screen threw UNIVERSE_MISMATCH and `error` says so.
    take: (screen.take || []).map((x) => present.stockCandidate(x, budgetKd)),
    oneAway: (screen.oneAway || []).map((x) => present.stockCandidate(x, budgetKd)),
    priceWarn: (screen.priceWarn || []).map((x) => present.stockCandidate(x, budgetKd)),
    leave: (screen.leave || []).map((x) => present.stockCandidate(x, budgetKd)),
    recommended: (screen.recommended || []).map((x) => present.stockCandidate(x, budgetKd)),
    nearMiss: (screen.nearMiss || []).map((x) => present.stockCandidate(x, budgetKd)),
    rejected: (screen.rejected || []).map((x) => present.stockCandidate(x, budgetKd)),
    // SPR-38 · NOT COMPUTED is its own bucket, never folded into rejected.
    notComputed: (screen.notComputed || []).map((x) => present.stockCandidate(x, budgetKd)),
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
/*
 * SPR-04/05 · THE BANNER IS THE ONLY SOURCE.
 *
 * This used to emit `spread:alert` lines on every breadth-mode change —
 * STOP / CAREFUL / "Trading allowed again". Those transient lines were the
 * "breadth re-arm lines": the banner showed one (and froze at the time it
 * arrived), the feed accumulated the rest, and the two disagreed. Meanwhile the
 * AUTHORITATIVE mode already rides every `spread:update` tick as `stops`
 * (mode, canOpen, reasons) — a value that is always current, not a 14-second
 * transient.
 *
 * So the mode is now shown ONCE, from the tick, by a persistent banner on the
 * client. No re-arm lines. The transition is still LOGGED here (nothing
 * silent), but it is no longer pushed as an alert that can go stale beside the
 * live verdict.
 */
let lastStopKey = null;
function announceStops(_io, day, stops) {
  if (!stops) return;
  const key = `${day}:${stops.mode}:${(stops.reasons || []).join('|')}`;
  if (key === lastStopKey) return;
  const was = lastStopKey;
  lastStopKey = key;
  if (was === null && stops.canOpen) return; // first tick of a normal day: nothing to say
  log.info(`[session] mode → ${stops.mode}${stops.canOpen ? '' : ' (no new positions)'}` +
           ((stops.reasons || []).length ? ` · ${(stops.reasons || []).join(' · ')}` : ''));
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
      title: `${require('./lib/session').get().hardExitClock} — flatten before the close`,
      body: hard.message, at: new Date().toISOString(),
    });
  }
}

/**
 * Move every socket that follows "today" into today's room. Called from the
 * ticker; cheap (one pass over the connected sockets) and a no-op except on
 * the first tick after the 04:00 Kuwait rollover. Returns how many moved.
 */
function followDay(io, day) {
  let moved = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.data || !socket.data.followsToday || socket.data.day === day) continue;
    socket.leave(room(socket.data.day));
    socket.join(room(day));
    socket.data.day = day;
    socket.emit('spread:day', { day });
    moved += 1;
  }
  if (moved) log.info(`[tick] day rolled to ${day} — ${moved} socket(s) moved to the new room`);
  return moved;
}

/*
 * The session-day calendar, once per day: a holiday has no final snapshot and
 * no session, and the ticker idles on it as it does after the close.
 */
const _calDay = { day: null, session: true };
async function isSessionDay(day) {
  if (_calDay.day === day) return _calDay.session;
  const cal = await require('./lib/calendar').sessionDay(day).catch(() => ({ session: true }));
  _calDay.day = day; _calDay.session = cal.session;
  return cal.session;
}

/* The ticker's own clock state — what the heartbeat and /health read. */
const tickerState = { lastSnapshotAt: 0, lastSnapshotSeq: 0, finalDoneFor: null, phase: null, active: false, lastHeartbeatAt: null };

/** In the window the ticker WORKS: 08:45 → the final snapshot, on a session day. */
function tickerWindow(now = new Date()) {
  const p = sessionPhase(now);
  const k = new Date(now.getTime() + 3 * 3600000);
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  const finalAt = require('./lib/session').get().dataWindowEndAt + 1;   // 13:31
  return { phase: p, mins, preOpen: mins < PRE_OPEN_MINS, pastFinal: mins >= finalAt, weekend: p.phase === 'closed' && p.note === 'weekend' };
}

/**
 * The ticker runs every HEARTBEAT_MS. Each run: the heartbeat; then, inside
 * the window, a full snapshot when SNAPSHOT_MS has elapsed; past the window's
 * end, ONE final snapshot; otherwise idle. The heartbeat is emitted from
 * THIS loop on purpose — a wedged snapshot build stops it, which is the point.
 */
function startTicker(io, ms = HEARTBEAT_MS, { now: nowFn = () => new Date(), day: dayFn = () => daily.kuwaitDay() } = {}) {
  const body = scanner('tick', async () => {
    const now = nowFn();
    const day = dayFn();
    followDay(io, day);
    const r = room(day);
    const w = tickerWindow(now);
    const sessionDay = !w.weekend && await isSessionDay(day);
    const active = sessionDay && !w.preOpen && !w.pastFinal;
    tickerState.phase = w.phase.phase; tickerState.active = active;
    tickerState.lastHeartbeatAt = new Date(now).toISOString();
    const snapshotSvc = require('./services/snapshot');
    io.to(r).emit('spread:tick', { seq: snapshotSvc.currentSeq(), at: tickerState.lastHeartbeatAt,
      phase: w.phase.phase, active, final: tickerState.finalDoneFor === day });
    if (!io.sockets.adapter.rooms.get(r)) return 'idle';

    const budgetKd = require('./services/gateStore').sessionBudgetKd();
    if (active) {
      if (now.getTime() - tickerState.lastSnapshotAt < SNAPSHOT_MS) return;  // heartbeat only — still work
      const snap = await snapshotSvc.snapshot(day, budgetKd, { reason: 'minute' });
      tickerState.lastSnapshotAt = now.getTime(); tickerState.lastSnapshotSeq = snap.seq;
      io.to(r).emit('spread:snapshot', snap);
      // spread:update · the legacy board push, for one release.
      if (snap.board && !snap.board.error) io.to(r).emit('spread:update', snap.board);
      const stops = snap.board?.stops;
      if (stops) { announceStops(io, day, stops); announceTimeStops(io, day, stops); }
      // Only while the market is open. A 12:30 flatten alert once fired at
      // 19:55 because nothing asked the clock first.
      if (sessionPhase(now).open) await ruleAlerts(day, io);
      return;
    }
    if (sessionDay && w.pastFinal && tickerState.finalDoneFor !== day) {
      // ONE snapshot after the close: the day as it ended, marked final. Then
      // idle until 08:45 — stats:daily's graded board arrives as a partial.
      const snap = await snapshotSvc.snapshot(day, budgetKd, { final: true, reason: 'final' });
      tickerState.finalDoneFor = day; tickerState.lastSnapshotAt = now.getTime(); tickerState.lastSnapshotSeq = snap.seq;
      io.to(r).emit('spread:snapshot', snap);
      if (snap.board && !snap.board.error) io.to(r).emit('spread:update', snap.board);
      log.info(`[tick] final snapshot for ${day} (seq ${snap.seq}) — idling until 08:45`);
      return;
    }
    return 'idle';
  });
  const t = setInterval(body, ms);
  t.run = body;                                   // tests drive one tick by hand
  return t;
}

/*
 * ─── PARTIAL SNAPSHOTS ON WRITE ─────────────────────────────────────────────
 * A trading write, PUT /gates, a slot swap, a halt, a wake-up announces the
 * sections it touched (lib/events). Within PARTIAL_DEBOUNCE_MS the union of
 * those sections is rebuilt and pushed — the operator sees their own order the
 * moment it is booked; a burst of writes is one push.
 */
function startPartialPusher(io, { debounceMs = PARTIAL_DEBOUNCE_MS } = {}) {
  let pending = new Set(); let reasons = []; let timer = null; let inflight = false;
  const flush = scanner('partial', async () => {
    timer = null;
    if (!pending.size && !reasons.length) return 'idle';
    const parts = pending.size ? [...pending] : undefined;    // empty = everything
    const why = reasons.join(', ');
    pending = new Set(); reasons = [];
    const day = daily.kuwaitDay();
    const r = room(day);
    if (!io.sockets.adapter.rooms.get(r)) return 'idle';
    inflight = true;
    try {
      const snapshotSvc = require('./services/snapshot');
      const snap = await snapshotSvc.snapshot(day, require('./services/gateStore').sessionBudgetKd(), { parts, reason: why });
      io.to(r).emit('spread:snapshot', snap);
      if (snap.board && !snap.board.error) io.to(r).emit('spread:update', snap.board);
      tickerState.lastSnapshotSeq = snap.seq;
    } finally { inflight = false; }
  });
  const onChanged = ({ parts, reason }) => {
    if (!parts || !parts.length) pending = new Set(require('./services/snapshot').PARTS);
    else for (const p of parts) pending.add(p);
    reasons.push(reason);
    if (!timer) timer = setTimeout(() => { Promise.resolve(flush()).catch((e) => log.warn('[partial]', e.message)); }, debounceMs);
  };
  changeBus.on('changed', onChanged);
  const handle = { stop: () => { changeBus.off('changed', onChanged); if (timer) clearTimeout(timer); }, pending: () => [...pending], inflight: () => inflight };
  // setInterval-shaped for index.js's timers list: clearInterval on a plain
  // object is a no-op, so expose stop() and return the handle.
  return handle;
}

/*
 * ─── THE FOCUS LOOP ────────────────────────────────────────────────────────
 * Every FOCUS_MS, for each socket with a focus symbol: the latest quote, the
 * latest book capture and the open contract's marks for THAT symbol — pushed
 * only when something changed (a signature of the three timestamps / the
 * marks). The other 139 symbols cost nothing; the ladder the operator is
 * staring at moves at capture speed.
 */
async function focusPayload(symbol, day, contractsForDay) {
  const positions = require('./api/positions');
  const q = await positions.latestQuote(symbol, day);
  const { rows } = await pool.query(`
    WITH last AS (SELECT max(captured_at) AS at FROM spread.v_depth WHERE symbol = $1 AND trading_date = $2)
    SELECT DISTINCT ON (level) level, bid, bid_qty, offer, offer_qty, captured_at
      FROM spread.v_depth d, last l
     WHERE d.symbol = $1 AND d.trading_date = $2 AND d.captured_at = l.at
     ORDER BY level`, [symbol, day]);
  const book = {
    capturedAt: rows.length ? rows[0].captured_at : null,
    b: rows.filter((x) => x.bid !== null).map((x) => [Number(x.bid), Number(x.bid_qty), null]),
    o: rows.filter((x) => x.offer !== null).map((x) => [Number(x.offer), Number(x.offer_qty), null]),
  };
  const contract = (contractsForDay || []).find((c) => c.symbol === symbol) || null;
  const quote = q ? { last: q.last_price == null ? null : Number(q.last_price), bid: q.bid == null ? null : Number(q.bid),
    bidQty: q.bid_qty == null ? null : Number(q.bid_qty), offer: q.offer == null ? null : Number(q.offer),
    offerQty: q.offer_qty == null ? null : Number(q.offer_qty), at: q.created_at } : null;
  const sig = `${quote?.at ? new Date(quote.at).toISOString() : '-'}|${book.capturedAt ? new Date(book.capturedAt).toISOString() : '-'}|${contract ? JSON.stringify([contract.bid, contract.unrealisedKd, contract.state, contract.shares]) : '-'}`;
  return { payload: { symbol, at: new Date().toISOString(), quote, book, contract }, sig };
}

function startFocusLoop(io, { everyMs = FOCUS_MS, day: dayFn = () => daily.kuwaitDay() } = {}) {
  return setInterval(scanner('focus', async () => {
    const focused = [...io.sockets.sockets.values()].filter((s) => s.data?.focus);
    if (!focused.length) return 'idle';
    const day = dayFn();
    // contracts() once per tick, only when someone is focused.
    const contracts = await require('./api/routes').contracts(day).catch(() => []);
    const cache = new Map();                              // symbol -> { payload, sig }
    for (const s of focused) {
      const sym = s.data.focus;
      if (!cache.has(sym)) cache.set(sym, await focusPayload(sym, day, contracts));
      const { payload, sig } = cache.get(sym);
      if (s.data.focusSig === sig) continue;              // nothing changed — no push
      s.data.focusSig = sig;
      s.emit('spread:focus', payload);
    }
  }), everyMs);
}

/** /health · which loops are silent beyond their limit, IN THE TICKER'S WINDOW. */
function deadLoops({ now = new Date(), force = false } = {}) {
  const w = tickerWindow(new Date(now));
  if (!force && (w.weekend || w.preOpen || w.pastFinal)) return [];
  const t = new Date(now).getTime();
  const out = [];
  const check = (name, limitMs) => {
    const h = _scannerHealth[name];
    if (!h) return;
    const last = h.lastSuccessAt ? new Date(h.lastSuccessAt).getTime() : null;
    // A loop that has never run since boot is not dead at boot: give it one limit.
    const bootAt = _bootAt;
    const ref = last ?? bootAt;
    if (t - ref > limitMs) out.push({ name, silentSec: Math.round((t - ref) / 1000), limitSec: Math.round(limitMs / 1000), lastSuccessAt: h.lastSuccessAt });
  };
  check('tick', 3 * HEARTBEAT_MS);
  check('rowPoller', 5 * Number(process.env.ROW_POLL_MS || 2000));
  return out;
}
const _bootAt = Date.now();

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
  const bookSeen = new Map();                           // symbol -> last captured_at ms pushed
  let seeding = true;

  return setInterval(scanner('rowPoller', async () => {
    const day = daily.kuwaitDay();
    const r = room(day);

    /*
     * F2 · STOP HIT, on the 2 s pass and BEFORE the room gate — the bid
     * printing through a stop is the one thing that must not wait for a
     * browser to be open, nor for the 60 s snapshot. One query over the armed
     * stops; a hit is marked once on the leg, alerted once to the room (if
     * any), sent to the phone regardless, and the contracts/board re-snapshot.
     */
    const sh = await require('./services/stopHit').check(day)
      .catch((e) => { log.warn(`[stopHit] not checked: ${e.message}`); return null; });
    if (sh && sh.hits.length) {
      for (const h of sh.hits) {
        const a = require('./services/stopHit').alertFor(h);
        io.to(r).emit('spread:alert', a);
        log.warn(`[stopHit] ${h.symbol} C${h.seq}: bid ${h.bidFils} through the ${h.stopFils} stop`);
        // The phone carries it too, like a resume: a stop hit the operator
        // does not hear about is the loss this check exists to prevent.
        whatsapp.send(`${a.title}. ${a.body}`).then((wr) => {
          if (!wr.ok) log.warn(`[stopHit] WhatsApp not delivered for ${h.symbol}: ${wr.reason || `${wr.failed} failed`}`);
        });
      }
      require('./lib/events').changed(['contracts', 'board', 'account'], `stop hit ${sh.hits.map((h) => h.symbol).join(',')}`);
    }

    if (!io.sockets.adapter.rooms.get(r)) return 'idle';

    try {
      if (seeding) {
        const { rows } = await pool.query(`
          SELECT (SELECT max(ts) FROM public.symbol_minute) AS minute,
                 (SELECT max(id) FROM public.signal_log)    AS signal,
                 (SELECT max(id) FROM public.position)      AS position,
                 (SELECT max(computed_at) FROM public.market_day) AS market`);
        // A table that is EMPTY at boot seeds null, and every consumer below
        // guards `seen.x !== null` — so that stream never emitted until the
        // next restart. An empty table means "from the beginning": seed the
        // id streams at 0 and the time streams at the epoch.
        Object.assign(seen, {
          minute: rows[0].minute ?? new Date(0),
          signal: rows[0].signal ?? 0,
          position: rows[0].position ?? 0,
          market: rows[0].market ?? new Date(0),
        });
        seeding = false;
        return 'idle';
      }

      /*
       * The socket plan · BOOKS ON CHANGE. The ticker used to push every
       * watched book every 15 s whether or not the sweep had captured anything.
       * Now: the latest captured_at per watched symbol (one query); a symbol
       * whose capture ADVANCED gets its book pushed; the rest get nothing — a
       * tile that stops receiving is a tile whose capture stopped, the truth.
       */
      const watchedNow = [...watchedSymbols()];
      if (watchedNow.length) {
        const { rows: caps } = await pool.query(
          `SELECT symbol, max(captured_at) AS at FROM spread.v_depth
            WHERE symbol = ANY($1) AND trading_date = $2 GROUP BY symbol`, [watchedNow, day]);
        const latest = new Map(caps.map((c) => [c.symbol, new Date(c.at).getTime()]));
        for (const symbol of watchedNow) {
          const at = latest.get(symbol) ?? null;
          const seenAt = bookSeen.get(symbol);
          if (seenAt !== undefined && seenAt === at) continue;   // unchanged — no push
          bookSeen.set(symbol, at);
          const { payload } = await focusPayload(symbol, day, null).catch(() => ({ payload: null }));
          io.to(r).emit('spread:book', { symbol, book: payload ? payload.book : { capturedAt: null, b: [], o: [] } });
        }
        for (const k of [...bookSeen.keys()]) if (!watchedNow.includes(k)) bookSeen.delete(k);
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
  }), everyMs);
}

/**
 * The wake-up scan already worked and nothing ran it. A scan that has to be
 * remembered is a scan that happens on the days you did not need it.
 */
const WAKE_TIMES = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00'];

function startWakeupScanner(io, { times = WAKE_TIMES, everyMs = 60000 } = {}) {
  const fired = new Set();
  return setInterval(scanner('wakeup', async () => {
    try {
      const k = new Date(Date.now() + 3 * 3600000);
      const hhmm = `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
      const day = daily.kuwaitDay();
      const key = `${day} ${hhmm}`;
      if (!times.includes(hhmm) || fired.has(key)) return 'idle';
      fired.add(key);

      const flagged = await live.wakeUpScan(day);
      io.to(room(day)).emit('spread:wakeup', { day, at: hhmm, flagged,
        // Most stocks have barely traded by 09:30 and the ratios are unstable.
        lowConfidence: hhmm === '09:30' });
      if (flagged.length) require('./lib/events').changed(['board', 'slots'], `wake-up ${hhmm}`);
      log.info(`[wakeup] ${hhmm}: ${flagged.length} flagged`);
    } catch (e) { throw e; } // recorded and logged by scanner()
  }), everyMs);
}

/**
 * CR-32. Every minute against the live feed, for the depth watchlist.
 *
 * The window averages 3.3 minutes. Checking every ten minutes caught none of
 * ten opportunities in one session.
 */
function startAlertScanner(io, { everyMs = 60000 } = {}) {
  /*
   * SPR-24 · THE OPEN-WINDOW MAP.
   *
   * `${day}:${symbol}` -> { alertId, audible }. A window is INSERTED once, when
   * it opens, and CLOSED once, when the symbol stops qualifying — at which point
   * closeWindow() stamps window_closed_at and window_seconds. This is what the
   * cooldown could never do: cooldown suppressed re-fires but never recorded a
   * duration, so every window_seconds was NULL. Dedup is the map, not a timer,
   * so a window that closes and genuinely reopens later is a NEW row (correct —
   * the claim under test is 3.3-minute windows, several per session).
   */
  const open = new Map();
  return setInterval(scanner('alert', async () => {
    const phase = sessionPhase();
    if (!phase.open) {
      // The session closed with windows still open — close them at the bell so
      // their duration is recorded rather than left dangling to tomorrow.
      for (const [, o] of open) await alerts.closeWindow(o.alertId).catch(() => {});
      open.clear();
      return 'idle';
    }
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
      const qualifying = new Set();
      for (const { symbol } of rows) {
        const r = await alerts.evaluate(symbol, day, {
          budgetKd: require('./services/gateStore').sessionBudgetKd() }).catch(() => null);
        if (!r?.windowOpen) continue;
        const key = `${day}:${r.symbol}`;
        qualifying.add(key);
        if (open.has(key)) continue;   // same window still open — one row per window
        // A new window. Record it either way; the depth veto (SPR-06/23) only
        // decides whether the PHONE rings.
        const id = await alerts.fire(r, day, {
          suppressed: r.depthVeto, suppressedReason: r.vetoReason });
        open.set(key, { alertId: id, audible: r.audible });
        io.to(room(day)).emit('spread:entryAlert', {
          ...r, alertId: id,
          // AUDIBLE only for a clean window. A vetoed one goes to the feed
          // marked held, never to the phone.
          audible: r.audible ? ALERT.audible : false,
          suppressed: r.depthVeto, suppressedReason: r.vetoReason });
        log.info(r.audible
          ? `[alert] ${r.symbol} — spread ${r.spreadFils}, fill ~${r.estFillMins}m`
          : `[alert] ${r.symbol} — window open but ${r.vetoReason}`);
      }
      // Any window we were tracking that no longer qualifies has CLOSED.
      for (const [key, o] of open) {
        if (qualifying.has(key)) continue;
        await alerts.closeWindow(o.alertId).catch(() => {});
        open.delete(key);
        io.to(room(day)).emit('spread:entryAlertClosed', { alertId: o.alertId });
      }
    } catch (e) { throw e; } // recorded and logged by scanner()
  }), everyMs);
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
  let sessionsDay = null;
  return setInterval(scanner('halt', async () => {
    const phase = sessionPhase();
    if (!phase.open) return 'idle';
    const day = daily.kuwaitDay();
    // The map is a cache of TODAY's table. Carried across the day rollover, a
    // symbol left in CB Auction at yesterday's close read as a RESUME on the
    // first tick of the next session — a halt that never happened, with a
    // verdict. New day, empty map, re-seeded from the table (G-7).
    if (sessionsDay !== day) { sessions.clear(); seeded = false; sessionsDay = day; }
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
        require('./lib/events').changed(['board', 'slots'], `resume ${res.symbol}`);
        log.info(`[halt] ${res.symbol} resumed ${res.resumePrice} — ${res.verdict}`);
        // H-D1 · THE DELIVERY PATH. Every TRADEABLE resume attempts delivery
        // within this scan and the attempt is RECORDED on the halt_event row, so
        // "was UPAC sent?" is a query. Attempted whether or not a provider is
        // configured: with none, send() logs the exact line it WOULD have sent
        // and the row records channel 'console' with the reason — nothing silent.
        // Bounded and never throwing; a real failure raises to the terminal.
        // EVERY resume goes to the phone — TRADEABLE as the trade, every reject
        // as its one-line reason. Only TRADEABLE is audible (above).
        if (whatsapp.shouldDeliver(res)) {
          whatsapp.sendResume(res).then(async (wr) => {
            const channel = wr.provider || 'console';
            const err = wr.ok ? null
              : (wr.reason || (wr.results || []).map((x) => x.error).filter(Boolean).join('; ') || 'send failed');
            await halts.recordDelivery(res.id, {
              channel, deliveredAt: wr.ok ? new Date() : null, error: err,
            }).catch((e) => log.warn('[halt] delivery stamp failed', e.message));
            if (wr.ok) {
              log.info(`[halt] delivered ${res.symbol} via ${channel} (${wr.sent} recipient${wr.sent === 1 ? '' : 's'})`);
            } else {
              log.warn(`[halt] ${res.symbol} NOT delivered (${channel}): ${err}`);
              io.to(roomId).emit('spread:whatsappFailed', {
                symbol: res.symbol, reason: err, channel,
                text: wr.reason === 'WHATSAPP_UNCONFIGURED'
                  ? `no WhatsApp provider configured — logged, not sent: ${whatsapp.alertText(res)}`
                  : `WhatsApp push for ${res.symbol} did not go out — check the gateway`,
              });
            }
          }).catch((e) => log.warn('[halt] delivery error', e.message));
        }
      }
      // A4 · a slot whose depth capture has gone stale (>10 min) during the
      // session — the tile reads "stale — last capture 09:04". A report, not a
      // block: the swap decision will displace it first when a wake-up fires.
      const stale = await require('./services/slots').staleSlots(day, {}).catch(() => []);
      for (const s of stale) {
        io.to(roomId).emit('spread:slotStale', { slot: s.slot, symbol: s.symbol, lastCaptureAt: s.lastCaptureAt });
      }
    } catch (e) { throw e; } // recorded and logged by scanner()
  }), everyMs);
}

/*
 * ─── SPR-27/30 · THE FEED-SILENCE SCANNER ───────────────────────────────────
 *
 * A capture feed that stops posting is invisible unless something is looking:
 * the orders feed was silent for six sessions and nothing raised it. Every two
 * minutes this reads the scraper's heartbeat roster, raises a data_alarm for
 * any silent/absent feed (deduped once per feed per day), and pushes the roster
 * as `spread:feedHealth` so the header updates live. Runs only while the market
 * is open; where the heartbeat table is absent it is a no-op, never a crash.
 */
function startFeedHealthScanner(io, { everyMs = 120000 } = {}) {
  const feedHealth = require('./services/feedHealth');
  return setInterval(scanner('feedHealth', async () => {
    if (!sessionPhase().open) return 'idle';
    const day = daily.kuwaitDay();
    try {
      const r = await feedHealth.check(day);
      if (r.available) io.to(room(day)).emit('spread:feedHealth', await feedHealth.roster());
    } catch (e) { throw e; } // recorded and logged by scanner()
  }), everyMs);
}

module.exports = { registerHandlers, startTicker, startWakeupScanner, startAlertScanner, followDay,
  ruleAlerts, sessionPhase, view, watchedSymbols, watchedBySocket, startRowPoller, announceStops,
  startHaltScanner, startFeedHealthScanner, scannerHealth, scanner,
  startPartialPusher, startFocusLoop, focusPayload, deadLoops, tickerWindow, tickerState,
  SNAPSHOT_MS, HEARTBEAT_MS, FOCUS_MS, PARTIAL_DEBOUNCE_MS };
