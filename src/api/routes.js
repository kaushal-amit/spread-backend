'use strict';
/**
 * ============================================================================
 *  api/routes.js — one endpoint per frontend service method
 * ============================================================================
 * The frontend's `src/services/api/*.service.ts` interfaces are the spec. Each
 * method there gets exactly one route here, returning exactly the type in
 * `src/types/`.
 *
 * Nothing is renamed on the client. A translation layer in the browser is one
 * more place to get a name wrong, and a mismatched name is a silent `undefined`
 * rather than an error.
 * ============================================================================
 */

const express = require('express');
const { pool } = require('../db');
const { toDay } = require('../lib/day');
const daily = require('../jobs/daily');
const screening = require('../services/screening');
const live = require('../services/live');
const depth = require('../services/depth');
const claude = require('../services/ai/claude');
const rules = require('../lib/orderRules');
const pricing = require('../lib/pricing');
const present = require('./present');
const history = require('./history');
const gateStore = require('../services/gateStore');
const COMMISSION = require('../lib/commission');
const { wrap, refused, notFound, badRequest, notReady } = require('./errors');
const { dayParam, symbolParam, budgetParam, limitParam, intParam } = require('./params');
const positions = require('./positions');
const { SESSION, QUALITY } = require('../config/spread.config');

// Kuwait WALL CLOCK, for hour-of-day only. The session DAY is never derived
// from this: that is spread.kuwait_day() (019), which rolls at 04:00.
const K = "AT TIME ZONE 'Asia/Kuwait'";

/*
 * "Open", "contracts", "account" and "P&L" live in api/positions.js — ONE
 * quantity-aware definition on ONE contract key. They were here, and the
 * three copies of the open-position predicate that grew around them are the
 * bugs listed at the top of that file. Re-exported below so socket.js and the
 * tests keep their import.
 */
const { OPEN_BUY, pnlSummary, contracts, accountSummary } = positions;

/**
 * The board, cached for the length of one tick.
 *
 * Six frontend hooks ask for slices of the same screen. Recomputing it per
 * request would run the funnel six times over identical data.
 */
const CACHE_MS = 5000;
// R-16 · a per-key cache AND in-flight promise dedupe. The single-entry cache
// only helped SEQUENTIAL reads of the same key; six CONCURRENT cold /api/stocks
// each missed it and ran the funnel six times over identical data. Now a run in
// progress for a key is shared, so the funnel runs once per (day, budget,
// version), whether the six arrive together or one after another.
const boardCache = new Map();     // key -> { at, value }
const boardInflight = new Map();  // key -> Promise<value>
let boardRuns = 0;                // the funnel-run counter the concurrency test asserts on
const log = require('../lib/log');

/**
 * SPR-01 · the day the board SCREENS on.
 *
 * spread.symbol_day is computed at 13:30 after the close, so during a live
 * session TODAY has no row yet — and the board defaulted to kuwaitDay(), so it
 * screened an empty day and returned zero symbols while 133 traded. The screen
 * is meant to run on the latest COMPLETED session's stats joined with today's
 * live quotes (the LATERAL already pulls the live touch), which is exactly what
 * screening on yesterday's symbol_day row does.
 *
 * Rule: if the requested day has rows, use it (an explicit review date, or today
 * after 13:30). Otherwise fall back to the latest symbol_day on or before it.
 * A day with no data anywhere returns unchanged — an empty board then means no
 * data, not the wrong day, and the log line says which.
 */
async function resolveScreenDay(day) {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM spread.symbol_day WHERE trading_day = $1::date) AS asked_n,
            (SELECT max(trading_day)::text FROM spread.symbol_day WHERE trading_day <= $1::date) AS latest`,
    [day]);
  if (Number(rows[0].asked_n) > 0) return day;
  return rows[0].latest || day;
}

async function board(day, budgetKd) {
  const cfg = gateStore.effective();
  // SPR-01 · screen the latest COMPLETED session when the asked day has no row
  // yet (today, mid-session). Keyed and cached on the RESOLVED day.
  const screenDay = await resolveScreenDay(day);
  // Keyed on the gate VERSION too, so an edit takes effect on the next read
  // rather than after the cache happens to expire.
  const key = `${screenDay}:${budgetKd}:${gateStore.meta().version}`;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const flying = boardInflight.get(key);
  if (flying) return flying; // a run is already under way for this key — share it
  const promise = (async () => {
    boardRuns += 1;
    // R-01 · TARGETS travels with GATES. Passing only GATES meant the target
    // capture toggles were stored, never read, and reset on reload.
    const value = await screening.screen(screenDay, budgetKd,
      { cfg: cfg.GATES, targets: cfg.TARGETS, direction: cfg.DIRECTION, quality: cfg.QUALITY });
    // SPR-01 · the log that tells "wrong day asked" from "every symbol failed a
    // gate" apart: what was asked, what was screened, and how many came back.
    log.info(`[board] asked ${day} → screened ${screenDay} · ${value?.counts?.all ?? 0} symbols `
      + `(${value?.counts?.recommended ?? 0} rec / ${value?.counts?.nearMiss ?? 0} near / ${value?.counts?.rejected ?? 0} rej)`);
    boardCache.set(key, { at: Date.now(), value });
    return value;
  })();
  boardInflight.set(key, promise);
  try { return await promise; } finally { boardInflight.delete(key); }
}
const invalidate = () => { boardCache.clear(); };
/** R-16 · the number of funnel runs since boot, for the concurrency test. */
board.runs = () => boardRuns;

/**
 * 6.4 · a keyset cursor, "<iso-timestamp>|<id>", from a previous page's `next`
 * header. Returns { at, id } or null; a malformed cursor is a 400, never a 500.
 */
function parseCursor(raw, label = 'cursor') {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  const bar = s.lastIndexOf('|');
  if (bar < 0) throw badRequest(`${label} must be "<timestamp>|<id>"`, `got "${s}"`);
  const at = new Date(s.slice(0, bar));
  const id = Number(s.slice(bar + 1));
  if (Number.isNaN(at.getTime()) || !Number.isInteger(id)) throw badRequest(`${label} is malformed`, `got "${s}"`);
  return { at: new Date(at).toISOString(), id };
}

function build() {
  const r = express.Router();
  // S-08 · validated once. A bad date is a 400 here, not a 22007 from
  // Postgres reported as a 500, and never a string compared against a day.
  const day = (req) => dayParam(req.query.date ?? req.body?.date);
  // A2 · the budget the operator SET (gate store), never the file constant. An
  // explicit ?budgetKd wins (a what-if); otherwise the session budget, and its
  // absence is a 503 NOT_READY, never a silent default.
  const budget = (req) =>
    budgetParam(req.query.budgetKd ?? req.body?.budgetKd, () => {
      const b = gateStore.sessionBudgetKd();
      if (b == null) throw notReady('no session budget is set', 'set it with PUT /gates {"session-budget": 2000}');
      return b;
    });
  /*
   * N-15 · every handler reports through the typed explainer.
   *
   * `500 {error}` made a missing table indistinguishable from a bad request,
   * and the client's retry policy could not make a sensible decision about
   * either. `wrap` turns a thrown ApiError into its status and a Postgres code
   * into 503 SCHEMA_MISSING or DB_DOWN.
   */
  const fail = (res) => (e) => {
    const { status, body } = require('./errors').toResponse(e);
    res.status(status).json(body);
  };

  // ---- health -----------------------------------------------------------
  /*
   * 3.7 · health says whether the DATA is alive, not only the process.
   *
   *   quoteAgeSec     seconds since the newest awsat_market_quotes row
   *   latestStatsDay  the newest spread.symbol_day_stats day (the bridge)
   *   session         the phase the server believes it is in
   *
   * 503 `stale` when the session is open and no quote has landed for five
   * minutes: the scraper is down and every board number is old. Open without
   * a token, and says nothing about the account.
   */
  r.get('/health', async (_req, res) => {
    try {
      // R-07 · the bridge table is dropped once the scraper fills the gate
      // columns; health must not die with it. The latest stats day is the
      // newest day the VIEW can answer from either side.
      const { rows: [t] } = await pool.query(
        `SELECT now() AS t,
                (SELECT max(created_at) FROM public.awsat_market_quotes) AS latest_quote_at,
                (SELECT max(trading_day) FROM spread.symbol_day WHERE gate_stats_source IS NOT NULL) AS latest_stats_day,
                (SELECT gate_stats_source FROM spread.symbol_day WHERE gate_stats_source IS NOT NULL
                  ORDER BY trading_day DESC LIMIT 1) AS stats_source`);
      const session = require('../socket').sessionPhase();
      // A4 · the stale-slot count is a report, not a 503 trigger (that stays the
      // quote-age rule below). Best-effort — a failure here never fails health.
      const staleSlots = await require('../services/slots').staleSlots(daily.kuwaitDay(), { now: t.t })
        .then((s) => s.length).catch(() => null);
      const body = present.health({ now: t.t, latestQuoteAt: t.latest_quote_at, latestStatsDay: t.latest_stats_day, statsSource: t.stats_source, session, staleSlots });
      // SPR-25 · the halt-swap endpoint's liveness, visible before a halt needs
      // it. Unset is not a 503 (the terminal still works) but it is SHOWN.
      const scraperConfigured = require('../services/scraperClient').configured;
      body.scraperIngest = scraperConfigured ? 'configured' : 'SCRAPER_URL_UNSET — halt slot swaps cannot reach the scraper';
      // SPR-30 · which capture feeds are actually arriving, so the header need
      // never render a zero as data. Best-effort; a failure never fails health.
      body.feeds = await require('../services/feedHealth').roster().catch(() => ({ available: false, scripts: [] }));
      res.status(body.status === 'stale' ? 503 : 200).json(body);
    } catch (e) { res.status(503).json({ status: 'down', code: 'DB_DOWN', error: 'the database is not reachable' }); }
  });

  /*
   * ─── /feed · THE FEED REPLAYS FROM WHAT WAS RECORDED (SPR-07/08) ──────────
   *
   * The feed was live-socket-only and in-memory: on a reload it showed the boot
   * line and nothing else, and the 76 entry_alert rows the server had recorded
   * never appeared. This returns TODAY's recorded, feed-worthy events —
   * entry-window alerts (SPR-07) and halt resumes — so the client seeds the feed
   * on mount and history survives a reload (SPR-08).
   *
   * A suppressed entry (the depth veto, SPR-06/23) is INCLUDED and marked held —
   * it belongs in the feed, off the phone. Newest first, to match the live feed.
   */
  r.get('/feed', async (req, res) => {
    try {
      const d = day(req);
      const { rows: entries } = await pool.query(
        `SELECT id, symbol, fired_at AS at, spread_fils, bid_fils, offer_fils,
                offer_shares, my_shares, est_fill_mins, depth_signal,
                suppressed, suppressed_reason, window_seconds
           FROM spread.entry_alert
          WHERE trading_day = $1 ORDER BY fired_at DESC LIMIT 200;`, [d]);
      const { rows: halts } = await pool.query(
        `SELECT id, symbol, detected_at AS at, resume_price_fils, verdict, verdict_detail
           FROM spread.halt_event
          WHERE trading_day = $1 AND kind = 'RESUME' ORDER BY detected_at DESC LIMIT 200;`, [d]);

      const fmtShares = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));
      const events = [
        ...entries.map((e) => ({
          id: `ea-${e.id}`, kind: 'entry', symbol: e.symbol, at: e.at,
          level: e.suppressed ? 'info' : 'hot',
          title: e.suppressed
            ? `ENTRY HELD · ${e.symbol} · depth ${e.depth_signal || '—'}`
            : `ENTRY · SPREAD ${e.spread_fils}`,
          body: e.suppressed
            ? (e.suppressed_reason || `held off the phone — depth ${e.depth_signal}`)
            : `Bid ${e.bid_fils} / offer ${e.offer_fils}. Offer ${fmtShares(e.offer_shares)} against your ` +
              `${fmtShares(e.my_shares)}; fill ~${e.est_fill_mins == null ? '?' : e.est_fill_mins} min.` +
              (e.window_seconds != null ? ` Window lasted ${e.window_seconds}s.` : ''),
        })),
        ...halts.map((h) => ({
          id: `he-${h.id}`, kind: 'halt', symbol: h.symbol, at: h.at,
          level: h.verdict === 'TRADEABLE' ? 'hot' : 'info',
          title: `${h.symbol} resumed ${h.resume_price_fils ?? ''} — ${h.verdict || ''}`.trim(),
          body: h.verdict_detail || '',
        })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 200);

      res.json(events);
    } catch (e) { fail(res)(e); }
  });

  /*
   * SPR-30 · /feeds — the capture-feed roster for an honest header. Each
   * EXPECTED script is ok / silent / absent, so the header can say "orders feed
   * silent since 09:14" instead of a fabricated FLAT. `available:false` means
   * the heartbeat table is not present here — the header shows "unknown", not
   * "ok".
   */
  r.get('/feeds', async (_req, res) => {
    try { res.json(await require('../services/feedHealth').roster()); }
    catch (e) { fail(res)(e); }
  });

  // ---- stocks · IStockService ------------------------------------------
  const section = (name) => async (req, res) => {
    try {
      const b = await board(day(req), budget(req));
      res.json((b[name] || []).map((x) => present.stockCandidate(x, budget(req))));
    } catch (e) { fail(res)(e); }
  };
  r.get('/stocks/recommended', section('recommended'));
  r.get('/stocks/near-miss', section('nearMiss'));
  r.get('/stocks/rejected', section('rejected'));

  // EVERY symbol. `passed` is a property of a row, not a reason to omit it —
  // filters once hid three of the four best candidates and nobody could see it.
  r.get('/stocks', async (req, res) => {
    try {
      const b = await board(day(req), budget(req));
      res.json([...b.recommended, ...b.nearMiss, ...b.rejected, ...(b.notComputed || [])]
        .map((x) => present.stockCandidate(x, budget(req))));
    } catch (e) { fail(res)(e); }
  });

  r.get('/stocks/:symbol', async (req, res) => {
    try {
      const sym = symbolParam(req.params.symbol);
      const b = await board(day(req), budget(req));
      const hit = [...b.recommended, ...b.nearMiss, ...b.rejected, ...(b.notComputed || [])]
        .find((x) => x.symbol.toUpperCase() === sym);
      res.json(hit ? present.stockCandidate(hit, budget(req)) : null);
    } catch (e) { fail(res)(e); }
  });

  r.post('/stocks/:symbol/override', wrap(async (req, res) => {
    const d = day(req);
    const sym = symbolParam(req.params.symbol);
    {
      const b = await board(d, budget(req));
      const hit = [...b.nearMiss, ...b.rejected].find((x) => x.symbol.toUpperCase() === sym);
      if (!hit) return res.status(404).json({ error: 'not on the board' });

      // A structural failure is ARITHMETIC, not judgement. There is no market
      // condition under which a 0.1-fil tick wins, so the button only ever
      // loses money and the server refuses rather than the UI hiding it.
      if (hit.structural) {
        return res.status(409).json({
          error: 'cannot override a structural gate',
          detail: hit.reasons[0],
        });
      }

      await pool.query(
        `INSERT INTO spread.override_log
           (trading_day, symbol, verdict_at_override, gates_overridden, reason)
         VALUES ($1,$2,$3,$4,$5);`,
        [d, hit.symbol, hit.passed ? 'TRADABLE' : 'NOT_RECOMMENDED',
         hit.failed, req.body?.note || null]);

      invalidate();
      const out = present.stockCandidate(hit, budget(req));
      res.json({ ...out, overrideLogged: true, overrideNote: req.body?.note });
    }
  }));

  // ---- order book ------------------------------------------------------
  /** The book for one symbol on one day, or null when it has no quote today. */
  async function orderBookFor(sym, d) {
      // B-11 · today's quote, or none. Thursday's close is not Saturday's book.
      const q = await positions.latestQuote(sym, d);
      if (!q) return null;

      // The day row may legitimately not exist before the 13:30 job runs, so
      // an empty result is fine — a thrown error is not.
      const { rows: [dayRow] } = await pool.query(
        `SELECT high_fils, low_fils FROM spread.symbol_day
          WHERE symbol = $1 AND trading_day = $2;`, [sym, d]);

      // The ladder. Ten levels are captured and no screen has shown more than
      // one — a 42,400 bid with 10,000 behind it is a different book from one
      // with 500,000 behind it.
      const { rows: ladder } = await pool.query(
        /**
         * spread.v_depth, NOT spread.depth.
         *
         * spread.depth held zero rows for its whole life and was dropped as an
         * empty duplicate — so this returned an EMPTY LADDER on every request
         * for months, with no error, and then began throwing. Found by the
         * read check, ten seconds after that check existed.
         *
         * The view reads public.awsat_stock_depth, which holds 194,575 rows,
         * and dedupes on (symbol, level, captured_at) so a server and client
         * write do not double-count.
         *
         * Grouped by captured_at rather than capture_id: the underlying table
         * has no capture_id, and the instant IS what groups ten levels into
         * one snapshot.
         */
        `SELECT level, bid, bid_qty, offer, offer_qty
           FROM spread.v_depth
          WHERE symbol = $1 AND trading_date = $2
            AND captured_at = (SELECT max(captured_at) FROM spread.v_depth
                                WHERE symbol = $1 AND trading_date = $2)
          ORDER BY level;`, [sym, d])/* a DB failure must not become an empty list — see errors.js */;

      const levels = [];
      for (const l of ladder) {
        if (l.bid != null) levels.push({ side: 'bid', price: l.bid, qty: l.bid_qty });
        if (l.offer != null) levels.push({ side: 'offer', price: l.offer, qty: l.offer_qty });
      }
      const book = present.orderBook({ symbol: sym, ...q, ...dayRow }, levels);
      // R-24 · annotate each ladder row with its deterministic markers. Computed
      // in depth.ladder (never a model call); a failure here leaves markers empty
      // rather than blanking the book — the ladder must still render.
      try {
        const marks = await depth.ladder(sym, d, { now: new Date() });
        const byPrice = (list) => new Map((list || []).map((x) => [Number(x.price), x]));
        const bm = byPrice(marks.bids);
        const om = byPrice(marks.offers);
        for (const lvl of book.bids) { const m = bm.get(Number(lvl.price)); if (m) { lvl.markers = m.markers; lvl.ageMins = m.ageMins; lvl.aged = m.aged; } }
        for (const lvl of book.offers) { const m = om.get(Number(lvl.price)); if (m) { lvl.markers = m.markers; lvl.ageMins = m.ageMins; lvl.presencePct = m.presencePct; } }
        book.laddersCapturedAt = marks.capturedAt;
      } catch { /* markers are additive — the book renders without them */ }
      return book;
  }

  r.get('/orderbook/:symbol', wrap(async (req, res) => {
    const sym = symbolParam(req.params.symbol);
    const book = await orderBookFor(sym, day(req));
    if (!book) throw notFound(`no quote for ${sym} on ${day(req)}`);
    res.json(book);
  }));

  /*
   * Phase 2b · THE DETAIL PAGE IN ONE CALL.
   *
   * The card, the book, the sizing, the fill-time estimate, the depth signal,
   * the open contract and today's legs for one symbol. Five round-trips from
   * the browser became one, and — more to the point — every figure the page
   * shows comes from here, so the page has nothing to compute.
   */
  r.get('/stocks/:symbol/detail', wrap(async (req, res) => {
    const sym = symbolParam(req.params.symbol);
    const d = day(req);
    const bkd = budget(req);
    const b = await board(d, bkd);
    const hit = [...b.recommended, ...b.nearMiss, ...b.rejected, ...(b.notComputed || [])].find((x) => x.symbol === sym);
    const [book, sizing, fill, depthSig, contractsAll, legsRows, lastMove] = await Promise.all([
      orderBookFor(sym, d),
      require('./sizing').sizingFor(sym).catch((e) => ({ error: e.message, code: e.code || 'SIZING' })),
      live.fillTime(sym, { budgetKd: bkd }).catch((e) => ({ error: e.message })),
      depth.signalFor(sym, d).catch((e) => ({ error: e.message })),
      contracts(d),
      pool.query(
        `SELECT * FROM spread.order_leg WHERE symbol = $1 AND trading_day = $2 ORDER BY posted_at, id;`,
        [sym, d]).then((r2) => r2.rows),
      // R-26 · the last price move and whether a print under 100 shares carried it.
      depth.lastMove(sym, d).catch(() => null),
    ]);
    const contract = contractsAll.find((c) => c.symbol === sym) || null;
    // R-22 · the stop, one fil below the nearest aged shelf. The entry it
    // protects is the open position's entry, else the suggested/touch entry so
    // WATCH shows where the stop would sit before the buy.
    const stopEntry = contract && contract.entry != null ? Number(contract.entry)
      : (hit && hit.bidFils != null ? Number(hit.bidFils) : (book && book.bid ? Number(book.bid) : null));
    const stop = stopEntry != null
      ? await depth.stopFor(sym, d, stopEntry, { now: new Date() }).catch((e) => ({ error: e.message, stopFils: null }))
      : { stopFils: null, reason: 'no entry price to place a stop under yet' };
    // Today's closed contracts for the symbol — the DONE state needs the P&L.
    const bySeq = new Map();
    for (const l of legsRows) {
      if (!bySeq.has(l.contract_seq)) bySeq.set(l.contract_seq, []);
      bySeq.get(l.contract_seq).push(l);
    }
    const closed = [];
    for (const [seq, legs] of bySeq) {
      const buys = legs.filter((l) => l.side === 'BUY' && ['FILLED', 'CARRIED'].includes(l.status));
      const sells = legs.filter((l) => l.side === 'SELL' && l.status === 'FILLED');
      const bought = buys.reduce((a, l) => a + Number(l.filled_shares || l.shares), 0);
      const sold = sells.reduce((a, l) => a + Number(l.filled_shares || l.shares), 0);
      if (bought > 0 && sold >= bought) {
        const gross = sells.reduce((a, l) => a + Number(l.price_fils) * Number(l.filled_shares || l.shares) / 1000, 0)
          - buys.reduce((a, l) => a + Number(l.price_fils) * Number(l.filled_shares || l.shares) / 1000, 0);
        const fees = legs.reduce((a, l) => a + Number(l.commission_kd || 0), 0);
        closed.push({ seq: Number(seq), entry: Number(buys[0].price_fils), exit: Number(sells[sells.length - 1].price_fils),
          shares: bought, netKd: Number((gross - fees).toFixed(3)), feesKd: Number(fees.toFixed(3)) });
      }
    }
    res.json({
      symbol: sym, tradingDay: d, budgetKd: bkd,
      candidate: hit ? present.stockCandidate(hit, bkd) : null,
      orderBook: book,
      sizing, fillTime: fill, depthSignal: depthSig,
      lastMove,
      // R-11 · the capture interval, so the ladder's stale threshold is the
      // server's (3 × this), not a client constant that drifts from the scraper.
      captureIntervalSecs: QUALITY.captureIntervalSecs,
      stop,
      // R-06 · % of each bid level the suggested position would be, computed
      // here from the server's lot-rounded suggested_shares — the browser
      // annotates the ladder, it does not compute the gate.
      yourShares: sizing && !sizing.error ? (sizing.suggested_shares ?? null) : null,
      contract,
      legs: legsRows.map((l) => ({
        id: Number(l.id), seq: Number(l.contract_seq), side: l.side, status: l.status,
        price: Number(l.price_fils), shares: Number(l.shares), filledShares: l.filled_shares == null ? null : Number(l.filled_shares),
        commissionKd: l.commission_kd == null ? null : Number(l.commission_kd),
        postedAt: l.posted_at ? new Date(l.posted_at).toISOString() : null,
        resolvedAt: l.resolved_at ? new Date(l.resolved_at).toISOString() : null,
        note: l.note || '', exitVenue: l.exit_venue || null,
      })),
      closedToday: closed,
      session: require('../socket').sessionPhase(),
    });
  }));

  // ---- trading · ITradingService ---------------------------------------
  r.get('/trading/contracts', async (req, res) => {
    try { res.json(await contracts(day(req))); } catch (e) { fail(res)(e); }
  });

  // The five writes that move a position or cash: api/trading_routes.js.
  require('./trading_routes').mount(r);

  // ---- account and ledger · ILedgerService ------------------------------
  r.get('/account', async (req, res) => {
    const d = day(req);
    try {
      const [a, pnl] = await Promise.all([accountSummary(d), pnlSummary(d)]);
      res.json(present.accountState(a, pnl));
    } catch (e) { fail(res)(e); }
  });

  // R-15 (decided) · from/to filter on trading_day; the rows sort on (at, id).
  // The running balance is the account's balance AS OF each row — the window
  // function sums over EVERY movement up to it, then the from/to window (and the
  // 6.4 cursor) cut the page afterwards. So a page cut by trading_day can carry a
  // balance that includes movements booked late for an earlier day (trading_day
  // before their `at`): the balance is correct in time order, and the cut is by
  // day. That is the intended behaviour, not a leak — documented here so it is a
  // decision, not an accident.
  r.get('/ledger', wrap(async (req, res) => {
    const from = dayParam(req.query.from, null), to = dayParam(req.query.to, null);
    const limit = limitParam(req.query.limit, { fallback: 500, max: 500 });
    // 6.4 · cursor pagination, older than the last row of the previous page.
    // "at|id" from the `next` header; the balance stays the account's (R-15) —
    // the window function runs over every movement before the cut.
    const cur = parseCursor(req.query.cursor, 'ledger');
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT c.*, l.symbol,
                sum(c.amount_kd) OVER (ORDER BY c.at, c.id) AS balance_kd
           FROM spread.cash_movement c
           LEFT JOIN spread.order_leg l ON l.id = c.order_leg_id) x
        WHERE ($1::date IS NULL OR trading_day >= $1)
          AND ($2::date IS NULL OR trading_day <= $2)
          AND ($4::timestamptz IS NULL OR (at, id) < ($4::timestamptz, $5::bigint))
        ORDER BY at DESC, id DESC LIMIT $3;`, [from, to, limit, cur?.at ?? null, cur?.id ?? null]);
    // The oldest row of this page (rows are DESC) is where the next page starts.
    if (rows.length === limit && rows.length) {
      const last = rows[rows.length - 1];
      res.set('next', `${new Date(last.at).toISOString()}|${last.id}`);
    }
    res.json(rows.reverse().map(present.ledgerEntry));
  }));

  r.post('/ledger', wrap(async (req, res) => {
    const d = day(req);
    {
      const { kind, amountKd, note } = req.body || {};
      const amt = Number(amountKd);

      // I-06 · `kind` was unchecked, so an arbitrary string could be written
      // into a column the whole account balance is summed from.
      const KINDS = ['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT'];
      if (!KINDS.includes(kind)) {
        throw badRequest(`kind must be one of ${KINDS.join(', ')}`,
          'BUY, SELL and FEE rows are written by the trading path, not by hand');
      }
      if (!(amt > 0)) throw badRequest('amount must be positive');
      if (!Number.isFinite(amt) || amt > 1e9) throw badRequest('amount is out of range');

      if (kind === 'WITHDRAWAL') {
        // EQUITY IS NOT BUYING POWER. Refusing has to name both numbers —
        // "insufficient funds" against a four-figure account reads like a bug.
        const a = await accountSummary(d);
        const available = Number(a.settledKd);
        if (amt > available) {
          return res.status(409).json({
            error: `only ${available.toFixed(2)} KD is available`,
            detail: `equity is ${(Number(a.cashKd) + Number(a.marketKd)).toFixed(2)} but ` +
                    `${Number(a.investedKd).toFixed(2)} is in an open position`,
          });
        }
      }

      await pool.query(
        `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, note)
         VALUES ($1,$2,$3,$4);`,
        [d, kind, kind === 'DEPOSIT' ? amt : -amt, note || null]);

      const [a, pnl] = await Promise.all([accountSummary(d), pnlSummary(d)]);
      res.json({ ok: true, account: present.accountState(a, pnl) });
    }
  }));

  // ---- gates · IGateService --------------------------------------------
  r.get('/gates', async (_req, res) => {
    try {
      const cfg = gateStore.effective();
      const configs = present.gateConfigs(cfg, gateStore.meta());
      const d = daily.kuwaitDay();
      // N-16 · the EFFECTIVE budget. Using the file constant meant a saved slot
      // size never moved rejectsCount, so the panel reported the cost of a
      // threshold at a budget the operator had already changed.
      const b = await board(d, cfg.BUDGET.slotKd).catch(() => null);
      if (b) {
        /*
         * Keyed off the STABLE gate id, not a word derived from the display
         * name. `gateName.split(' ')[0]` produced "price", "net", "average" —
         * none of which are keys in `counts`, so every count read 0 and the
         * panel silently said no gate was rejecting anything.
         */
        const COUNT_KEY = {
          'g1-floor': 'price band', 'g2-net': 'profit floor', 'g3-size': 'trade size',
          'g4-moves': 'movement', 'g5-tape': 'tape quality', 'g6-postable': 'postable',
          'g7-exit': 'exit depth', 'g8-dist': 'distribution', 'g9-consistency': 'consistency',
          'g10-direction': 'direction',
        };
        for (const c of configs) {
          c.rejectsCount = Number(b.counts[COUNT_KEY[c.id]] || 0);
        }
      }
      res.json(configs);
    } catch (e) { fail(res)(e); }
  });

  /*
   * `PUT /gates/:id` removed.
   *
   * Superseded by the bulk endpoint below. It also produced one version row per
   * gate — fourteen for a single user action, and a reset re-saved identical
   * values as a "change", which is what B-16 was raised to eliminate.
   */

  /*
   * B-16 · BULK. `resetGateChanges` fired one PUT per gate — fourteen requests
   * and fourteen version rows for a single user action, and a reset re-saved
   * identical values as a "change".
   */
  /*
   * The gate-change apply path, shared by PUT /gates and its POST /budget alias.
   * Validates every key/value, saves one version row, and returns the same body
   * both routes answer with — so /budget is a strict alias, not a second shape.
   */
  async function applyGateChanges(changes, { changedBy, note }) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw badRequest('changes object is required');
    }
    /*
     * S-08 · every key must be a gate the store binds, and every value a finite
     * number the gate can take. `{"session-budget": -1}` was accepted, and so
     * was a key nobody reads (which then "saved" and changed nothing).
     */
    for (const [id, val] of Object.entries(changes)) {
      if (!gateStore.BINDING[id]) throw badRequest(`"${id}" is not a gate`, `known: ${Object.keys(gateStore.BINDING).join(', ')}`);
      const v = typeof val === 'object' && val !== null ? val.numericValue : val;
      if (v == null || !Number.isFinite(Number(v))) throw badRequest(`"${id}" needs a numeric value`);
      const n = Number(v);
      if (id === 'session-budget' && !(n >= 100 && n <= 1e6)) throw badRequest('session-budget must be 100..1,000,000 KD');
      if (id.startsWith('target-') && id.endsWith('tick') || id === 'target-2ticks' || id === 'target-3ticks') {
        if (n !== 0 && n !== 1) throw badRequest(`"${id}" is a toggle: 0 or 1`);
      } else if (n < -1000 || n > 1e7) throw badRequest(`"${id}" is out of range`);
      if (typeof val === 'object' && val !== null && val.mode != null && !['warn', 'block'].includes(val.mode)) {
        throw badRequest(`"${id}".mode must be warn or block`);
      }
    }
    if (Object.keys(changes).length > 40) throw badRequest('too many changes in one request');
    /*
     * The structural lock still holds on the kb path: g1-floor routes to a
     * kb_threshold row now, and a write there would slip past gateStore.save's
     * refusal — so the lock is enforced here, before anything is written.
     */
    const locked = Object.keys(changes).filter((id) => gateStore.LOCKED.has(id));
    if (locked.length) {
      throw refused(`${locked.join(', ')} cannot be changed — it is structural, not a preference`,
        'Below 100 fils the exchange tick is 0.1 fil: one tick pays about 1.05 KD against 3.36 in commission, negative at any budget.');
    }
    const before = await board(daily.kuwaitDay(), gateStore.sessionBudgetKd()).catch(() => null);
    /*
     * R-36 · a change to a kb-backed threshold writes the TABLE (the one store),
     * not a gate_config override — otherwise the override would win over the row
     * and the two would drift on the next boot. The rest still write gate_config.
     * A gate_config version row is bumped either way so the board cache, keyed on
     * that version, invalidates and the action is recorded.
     */
    const cfgChanges = {};
    for (const [id, val] of Object.entries(changes)) {
      const num = Number(typeof val === 'object' && val !== null ? val.numericValue : val);
      if (gateStore.KB[id]) await gateStore.writeThreshold(gateStore.KB[id], num, { changedBy: changedBy || 'ui' });
      else cfgChanges[id] = val;
    }
    await gateStore.save(cfgChanges, { changedBy: changedBy || 'ui', note: note || null,
      passesBefore: before?.recommended.length ?? null });
    invalidate();
    const after = await board(daily.kuwaitDay(), gateStore.sessionBudgetKd()).catch(() => null);
    return present.gateConfigs(gateStore.effective(), {
      version: gateStore.meta().version, loadedAt: gateStore.meta().loadedAt,
      passesBefore: before?.recommended.length, passesAfter: after?.recommended.length });
  }

  r.put('/gates', wrap(async (req, res) => {
    res.json(await applyGateChanges(req.body?.changes, { changedBy: req.body?.changedBy, note: req.body?.note }));
  }));

  /*
   * R-30 · POST /budget — the contract document names this route for setting the
   * slot. It is a strict alias of PUT /gates {"session-budget": n}: same
   * validation, same version row, same body. Accepts { budgetKd } or { slotKd }.
   */
  r.post('/budget', wrap(async (req, res) => {
    const raw = req.body?.budgetKd ?? req.body?.slotKd;
    if (raw == null || !Number.isFinite(Number(raw))) throw badRequest('budgetKd (the session slot, in KD) is required');
    res.json(await applyGateChanges({ 'session-budget': Number(raw) },
      { changedBy: req.body?.changedBy, note: req.body?.note }));
  }));

  // ---- sessions · the date picker (R-18) -------------------------------
  /*
   * GET /api/sessions — the days that traded and may be selected for review.
   * A strict alias of /api/review/sessions (same list), named at the top level
   * because the contract document and the picker call /api/sessions. A date
   * absent from this list is refused by the picker.
   */
  r.get('/sessions', wrap(async (_req, res) => {
    res.json(await require('./review').sessionsList(pool));
  }));

  // ---- session · ISessionService ---------------------------------------
  r.get('/session', wrap(async (req, res) => {
    const { sessionPhase } = require('../socket');
    const p = sessionPhase();
    const k = new Date(Date.now() + SESSION.timezoneOffsetHours * 3600000);

    /*
     * B-14 · drift was a hardcoded map {9: 0.203, 10: 0.296, ...}, and
     * SessionBanner rendered the same four numbers again from its own copy.
     *
     * MEASURED: the market-wide average change from the open, by hour, over the
     * captured sessions. Null when there is not enough history — an honest gap
     * beats four constants that look like a finding.
     */
    const { rows } = await pool.query(
      `WITH h AS (
         SELECT spread.kuwait_day(created_at) AS d, symbol,
                EXTRACT(hour FROM created_at ${K})::int AS hr,
                last_price::numeric AS px,
                first_value(last_price::numeric) OVER (
                  PARTITION BY spread.kuwait_day(created_at), symbol
                  ORDER BY created_at) AS open_px
           FROM spread.v_quote_screening
          WHERE spread.kuwait_day(created_at) >= current_date - 20
       )
       SELECT hr, round(avg(px - open_px)::numeric, 3) AS drift, count(DISTINCT d) AS sessions
         FROM h WHERE open_px > 0 GROUP BY hr ORDER BY hr;`)/* a DB failure must not become an empty list — see errors.js */;

    const row = rows.find((r2) => Number(r2.hr) === k.getUTCHours());
    const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
    res.json({
      ...present.sessionInfo({ ...p, hour: k.getUTCHours(),
        timeStr: k.toISOString().slice(11, 16),
        // C14 · computed, not 0/false. The step-down is 12:00 Kuwait; "late to
        // open" is a position not posted by 09:30.
        minutesToStepDown: p.open ? Math.max(0, 720 - mins) : 0,
        lateToOpen: p.open && mins >= 570 },
        row ? Number(row.drift) : 0),
      open: !!p.open,
      kuwaitDay: daily.kuwaitDay(),
      reserveReleased: mins >= 660,
      // The whole curve, so the banner stops carrying its own copy.
      driftByHour: rows.map((r2) => ({
        hour: Number(r2.hr), driftFils: Number(r2.drift), sessions: Number(r2.sessions) })),
      driftMeasured: !!row,
      // R-11 · the capture interval, from QUALITY — the browser reads stale from
      // this (3 × the interval with no push), never a client-side constant.
      captureIntervalSecs: QUALITY.captureIntervalSecs,
      // R-19 / R-20 · the market gate and the session stops, as the server
      // sees them now. canOpen false is what the trading routes enforce.
      stops: await require('../services/stops').evaluate(daily.kuwaitDay()).catch((e) => ({ error: e.message, code: e.code, canOpen: false, mode: 'unknown', reasons: [`stops not computed: ${e.message}`] })),
    });
  }));

  // The gate and the stops on their own, for a page that needs only them.
  r.get('/session/stops', wrap(async (_req, res) => {
    res.json(await require('../services/stops').evaluate(daily.kuwaitDay()));
  }));

  // ---- market · the breadth strip ---------------------------------------
  r.get('/market', wrap(async (req, res) => {
    const d = day(req);
    // Today's row while the scraper is computing it intraday; else the latest.
    const { rows: [m] } = await pool.query(
      `SELECT * FROM spread.market_day WHERE trading_day <= $1
        ORDER BY trading_day DESC LIMIT 1;`, [d]);
    res.json({ ...(present.marketDay(m) || {}), isToday: m ? String(m.trading_day).slice(0, 10) === d : false,
      available: !!m });
  }));

  // ---- AI · IAiService --------------------------------------------------
  r.get('/ai/history', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, created_at, reasoning, rejected FROM spread.ai_note
          WHERE trading_day = $1 AND NOT rejected
          ORDER BY created_at DESC LIMIT 50;`, [day(req)]);
      res.json(rows.reverse().map((x) => ({
        id: String(x.id),
        timestamp: new Date(x.created_at).toISOString(),
        text: x.reasoning,
      })));
    } catch (e) { fail(res)(e); }
  });

  /*
   * S-03 · a question costs up to nine model round-trips. Ten a minute per
   * client, two in flight, 4,000 characters, and a 45-second ceiling inside
   * claude.ask — a hung upstream call no longer holds a request forever.
   *
   * B-03 · when the boundary REJECTS the model's text, the client gets the
   * refusal, not the rejected prose.
   */
  const { limit, concurrency } = require('./ratelimit');
  r.post('/ai/ask', limit({ capacity: 10, refillPerSec: 10 / 60 }), concurrency(2), wrap(async (req, res) => {
    const { symbol, prompt, question, tradingState, position } = req.body || {};
    const q = String(prompt ?? question ?? '').trim();
    if (!q) throw badRequest('a question is required');
    if (q.length > 4000) throw badRequest('the question is too long', 'up to 4,000 characters');
    const sym = symbol == null || symbol === '' ? null : symbolParam(symbol);
    const out = await claude.ask({
      symbol: sym, question: q,
      // 3.1 · the client's position and trading state reach the prompt. When
      // the client sends neither, the ledger's own open contract is used.
      position: position ?? (await contracts(day(req))).find((c) => c.state !== 'picked' && (!sym || c.symbol === sym)) ?? null,
      tradingState: tradingState ?? null,
      tradingDay: day(req), budgetKd: budget(req), surface: 'DETAIL',
    });
    res.json({
      text: out.ok ? out.text : (out.refusal || out.text || 'the engine could not answer'),
      ok: out.ok, source: out.ok ? 'engine' : out.code,
    });
  }));

  // ---- live · used by the detail page and the alert ---------------------
  r.get('/live/filltime/:symbol', wrap(async (req, res) => {
    res.json(await live.fillTime(symbolParam(req.params.symbol), { budgetKd: budget(req) }));
  }));

  r.get('/live/depth/:symbol', wrap(async (req, res) => {
    res.json(await depth.signalFor(symbolParam(req.params.symbol), day(req)));
  }));

  r.get('/live/wakeups', async (req, res) => {
    try { res.json(await live.wakeUpScan(day(req))); } catch (e) { fail(res)(e); }
  });

  // ---- history · the three feeds the pages were inventing ---------------
  r.get('/orders', wrap(async (req, res) => {
    const out = await history.orders({ from: dayParam(req.query.from, null), to: dayParam(req.query.to, null),
      limit: limitParam(req.query.limit, { fallback: 500, max: 500 }),
      cursor: parseCursor(req.query.cursor, 'orders') });
    if (out.next) res.set('next', out.next); // 6.4 · the next page is by contract
    res.json(out);
  }));

  r.get('/performance/daily', wrap(async (req, res) => {
    res.json(await history.dailyPnl({ from: dayParam(req.query.from, null), to: dayParam(req.query.to, null),
      limit: limitParam(req.query.limit, { fallback: 500, max: 500 }) }));
  }));

  /*
   * R-29 · the learning file for one session (BACKEND_spec §8): the contracts,
   * the signals that fired and whether they were right, and the gate counts.
   * JSON by default; ?format=csv returns the contracts as a flat CSV. Read-only.
   */
  r.get('/export/:date', wrap(async (req, res) => {
    const d = dayParam(req.params.date);
    const [ord, sigs, brd] = await Promise.all([
      history.orders({ from: d, to: d, limit: 500 }),
      pool.query(
        `SELECT symbol, signal, fired_at, was_right, px_5min, px_15min, px_60min
           FROM public.signal_log WHERE trading_date = $1::date ORDER BY fired_at`, [d]).then((r2) => r2.rows).catch(() => []),
      board(d, gateStore.sessionBudgetKd()).catch(() => null),
    ]);
    if (String(req.query.format).toLowerCase() === 'csv') {
      const head = 'symbol,seq,state,entry,exit,shares,netKd,feesKd,fills';
      const line = (c) => {
        const buy = c.legs.find((l) => l.side === 'BUY');
        const sell = [...c.legs].reverse().find((l) => l.side === 'SELL');
        return [c.symbol, c.seq, c.state, buy?.price ?? '', sell?.price ?? '', buy?.shares ?? '', c.netKd ?? '', c.commissionKd ?? '', c.fills].join(',');
      };
      res.set('content-type', 'text/csv');
      res.set('content-disposition', `attachment; filename="spread-${d}.csv"`);
      res.send([head, ...ord.contracts.map(line)].join('\n'));
      return;
    }
    res.json({
      date: d,
      contracts: ord.contracts, summary: ord.summary,
      signals: { count: sigs.length, scored: sigs.filter((s) => s.was_right != null).length, rows: sigs },
      gates: brd ? brd.counts : null,
    });
  }));

  // ---- AI memory · confirmable facts (R-29) ----------------------------
  /*
   * A fact the engine proposes and the operator confirms. Unconfirmed facts do
   * not reach the model's context (claude.js loads confirmed_by_user only).
   */
  r.post('/ai/memory', wrap(async (req, res) => {
    const fact = String(req.body?.fact || '').trim();
    if (!fact) throw badRequest('fact is required');
    const sym = req.body?.symbol ? symbolParam(req.body.symbol) : null;
    const { rows: [row] } = await pool.query(
      `INSERT INTO spread.ai_memory (symbol, fact, source, confirmed_by_user, still_true)
       VALUES ($1, $2, 'operator', false, true) RETURNING id, symbol, fact, confirmed_by_user;`, [sym, fact.slice(0, 2000)]);
    res.json({ ok: true, memory: row });
  }));
  r.post('/ai/memory/:id/confirm', wrap(async (req, res) => {
    const id = intParam(req.params.id, { name: 'id', min: 1, max: 2 ** 31 });
    const { rows: [row] } = await pool.query(
      'UPDATE spread.ai_memory SET confirmed_by_user = true WHERE id = $1 RETURNING id, confirmed_by_user;', [id]);
    if (!row) throw notFound(`no memory #${id}`);
    res.json({ ok: true, memory: row });
  }));

  // ---- settings · the Anthropic key, masked (R-29) ---------------------
  r.get('/settings', wrap(async (_req, res) => {
    const mask = (v) => { const s = String(v || ''); return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`; };
    const { rows } = await pool.query('SELECT key, value, is_secret FROM public.app_config ORDER BY key').catch(() => ({ rows: [] }));
    const settings = {};
    for (const row of rows) settings[row.key] = row.is_secret ? mask(row.value) : row.value;
    // The Anthropic key: app_config first, else the env — masked to its last four either way.
    const dbKey = rows.find((row) => row.key === 'anthropic_api_key');
    const envKey = process.env.ANTHROPIC_API_KEY;
    settings.anthropic_api_key = dbKey ? mask(dbKey.value)
      : envKey ? `${mask(envKey)} (env)` : null;
    res.json({ settings });
  }));

  r.get('/candles/:symbol', wrap(async (req, res) => {
    res.json(await history.candles(symbolParam(req.params.symbol), {
      day: dayParam(req.query.date, null),
      minutes: intParam(req.query.minutes, { name: 'minutes', fallback: 5, min: 1, max: 10080 }) }));
  }));

  // ---- order rules · called before the form accepts a price -------------
  r.post('/rules/sell-amend', (req, res) => res.json(rules.checkSellAmend(req.body || {})));
  r.post('/rules/buy-reposition', (req, res) => res.json(rules.checkBuyReposition(req.body || {})));
  r.post('/rules/stranded', (req, res) => res.json(rules.checkStranded(req.body || {})));

  return r;
}

module.exports = { build, board, invalidate, contracts, accountSummary, pnlSummary, resolveScreenDay };
