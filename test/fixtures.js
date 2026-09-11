'use strict';
/**
 * ============================================================================
 *  test/fixtures.js — THE ONLY test file that may write public.*
 * ============================================================================
 * The code under test reads the scraper's tables (public.awsat_order_list,
 * awsat_stock_depth, signal_log, position, app_config). A suite that exercises
 * that code needs rows there. Writing them from six different test files is how
 * a DELETE against the live database shipped without anyone noticing.
 *
 * So: one module, guarded twice —
 *   1. it refuses unless dbguard has already admitted a *_test database;
 *   2. scripts/lint-rules.sh scans test/ for public.* writes and exempts ONLY
 *      this file, so a write anywhere else fails the build.
 *
 * Every helper takes a test-only symbol prefix and refuses a bare name, so a
 * cleanup can never reach a real instrument.
 * ============================================================================
 */
const { requireTestDb } = require('./dbguard');

const TEST_PREFIXES = ['SZTEST', 'FEE', 'RVTEST'];
const isTestSymbol = (s) => TEST_PREFIXES.some((p) => String(s).startsWith(p));

/**
 * Day-keyed rows (market_day, symbol_day) cannot be symbol-scoped, so they are
 * DAY-scoped instead: fixtures may only write days before 2010, years before
 * any capture exists. A schema-only kse_test (pg_dump -s) has no sessions at
 * all, and the review suite needs one that TRADED.
 */
const TEST_DAY = '2001-01-08';
const isTestDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && String(d) < '2010-01-01';

function assertTestSymbol(sym) {
  if (!isTestSymbol(sym)) {
    throw new Error(`fixtures: "${sym}" is not a test symbol (${TEST_PREFIXES.join('|')}*)`);
  }
}
function assertTestDay(day) {
  if (!isTestDay(day)) throw new Error(`fixtures: "${day}" is not a test day (before 2010)`);
}

function bind(pool) {
  // Called after dbguard at the suite top; asserting again costs nothing.
  requireTestDb('fixtures');

  return {
    TEST_DAY,

    /**
     * public.instruments — 017 gave spread.order_leg a foreign key here, so a
     * leg for a test symbol needs its instrument first. ON CONFLICT: reruns.
     */
    instrument: (sym, market = 'Main Market') => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.instruments (market, symbol, code, description)
         VALUES ($1, $2, $2, 'test instrument') ON CONFLICT (symbol) DO NOTHING`, [market, sym]);
    },
    clearInstruments: (prefix) => {
      assertTestSymbol(prefix);
      return pool.query('DELETE FROM public.instruments WHERE symbol LIKE $1', [`${prefix}%`]);
    },

    /**
     * public.awsat_market_quotes — one print. `at` is an ISO instant; the
     * trading_date is whatever the caller says, exactly as the scraper does.
     */
    quote: (sym, { day, at, session = 'Trading', last, lastQty = 100, bid, bidQty = 1000,
                   offer, offerQty = 1000, volume = 0, trades = 0, source = 'awsat_server' }) => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.awsat_market_quotes (market, symbol, code, session, last_price, last_qty,
           bid, bid_qty, offer, offer_qty, volume, trades, trading_date, ingest_source, created_at)
         VALUES ('Main Market',$1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING`,
        [sym, session, last, lastQty, bid, bidQty, offer, offerQty, volume, trades, day, source, at]);
    },
    clearQuotes: (prefix) => {
      assertTestSymbol(prefix);
      return pool.query('DELETE FROM public.awsat_market_quotes WHERE symbol LIKE $1', [`${prefix}%`]);
    },

    /** public.tradingview_history — one daily bar (spread.v_daily). */
    daily: (sym, day, { open, high, low, close, volume }) => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.tradingview_history (symbol, trade_date, open_price, high_price, low_price,
           close_price, volume) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [sym, day, open, high, low, close, volume]);
    },
    clearDaily: (prefix) => {
      assertTestSymbol(prefix);
      return pool.query('DELETE FROM public.tradingview_history WHERE symbol LIKE $1', [`${prefix}%`]);
    },

    /** public.awsat_market_summary — a LIVE breadth capture (the market gate). */
    marketSummary: (day, at, { symbols = 100, advancing = 60, declining = 25, unchanged = 15, batch = 'SZTESTFX' } = {}) =>
      pool.query(
        `INSERT INTO public.awsat_market_summary (captured_at, trading_date, session_state, symbols_traded, advancing, declining, unchanged, batch_id, source, received_at)
         VALUES ($1,$2,'LIVE',$3,$4,$5,$6,$7,'test',now()) ON CONFLICT DO NOTHING`,
        [at, day, symbols, advancing, declining, unchanged, batch]),
    clearMarketSummary: (batch = 'SZTESTFX') =>
      pool.query('DELETE FROM public.awsat_market_summary WHERE batch_id = $1', [batch]),

    /** public.market_day / public.symbol_day — a session that TRADED, on a test day. */
    marketDay: (day, { symbols = 1, advancing = 1, declining = 0, unchanged = 0, volume = 1000, trades = 10 } = {}) => {
      assertTestDay(day);
      return pool.query(
        `INSERT INTO public.market_day (trading_date, symbols_traded, advancing, declining, unchanged,
           pct_advancing, total_volume, total_trades, regime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NEUTRAL') ON CONFLICT (trading_date) DO NOTHING`,
        [day, symbols, advancing, declining, unchanged, symbols ? (100 * advancing / symbols) : 0, volume, trades]);
    },
    symbolDay: (sym, day, row = {}) => {
      assertTestSymbol(sym); assertTestDay(day);
      return pool.query(
        `INSERT INTO public.symbol_day (symbol, trading_date, open_px, high_px, low_px, close_px, prev_close,
           total_volume, trades, data_quality, source, avg_spread_pct, days_active, uptick_ratio, range_source,
           avg_trade_size, moves, up_moves_2plus, tiny_pct_up, buy_sell_ratio, coverage_pct, day_range, chg_fils)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AWSAT',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT DO NOTHING`,
        [sym, day, row.open ?? 200, row.high ?? 202, row.low ?? 199, row.close ?? 201, row.prevClose ?? 200,
         row.volume ?? 1000, row.trades ?? 10, row.dataQuality ?? 'FULL', row.avgSpreadPct ?? 0.5,
         row.daysActive ?? 1, row.uptickRatio ?? 1, row.rangeSource ?? 'FULL',
         row.avgTradeSize ?? null, row.moves ?? null, row.upMoves2plus ?? null, row.tinyPctUp ?? null,
         row.buySellRatio ?? null, row.coveragePct ?? null, row.dayRange ?? null, row.chgFils ?? null]);
    },
    /** spread.symbol_day_stats — the bridge row the gates read (016/018). */
    symbolDayStats: (sym, day, s = {}) => {
      assertTestSymbol(sym); assertTestDay(day);
      return pool.query(
        `INSERT INTO spread.symbol_day_stats (symbol, trading_day, pct_postable, pct_exitable_ratio,
           pct_exitable_size, bid_kd_p25, gap_pct, volume_ratio_5d, days_active_5d, down_days_5d,
           change_5d_fils, minutes_measured, budget_kd, pct_moves_sub100)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [sym, day, s.pctPostable, s.pctExitableRatio, s.pctExitableSize, s.bidKdP25, s.gapPct,
         s.volumeRatio5d, s.daysActive5d, s.downDays5d, s.change5dFils, s.minutes, s.budgetKd ?? 790,
         s.pctMovesSub100]);
    },
    /**
     * ABAR on 1 September 2026, as captured in test/fixtures/*.2026-09-01.txt
     * (the 016 view row, the bridge row and the blended tape figure), written
     * under a test symbol on a test day. Nothing here is invented.
     */
    abarLike: async (sym, day) => {
      assertTestSymbol(sym); assertTestDay(day);
      const fs = require('fs'), path = require('path');
      const F = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
        .trim().split('\n').map((l) => l.split('|').map((v) => (v === '' ? null : v)));
      const p = F('symbol_day.2026-09-01.txt').find((r) => r[0] === 'ABAR');
      const b = F('bridge_stats.2026-09-01.txt').find((r) => r[0] === 'ABAR');
      const t = F('tiny_blended.2026-09-01.txt').find((r) => r[0] === 'ABAR');
      if (!p || !b || !t) throw new Error('fixtures: ABAR is missing from the 2026-09-01 capture');
      const [, close, prev, avgTrade, moves, up2, tinyUp, bsr, cov, quality, , range, chgFils, market, , bid, offer] = p;
      await pool.query('DELETE FROM spread.symbol_day_stats WHERE symbol = $1', [sym]);
      await pool.query('INSERT INTO public.instruments (market, symbol, code, description, is_tradeable) VALUES ($1,$2,$2,$3,true) ON CONFLICT (symbol) DO UPDATE SET market = EXCLUDED.market, is_tradeable = true',
        [market, sym, 'ABAR as captured on 2026-09-01']);
      await pool.query(
        `INSERT INTO public.symbol_day (symbol, trading_date, close_px, prev_close, avg_trade_size, moves, up_moves_2plus,
           tiny_pct_up, buy_sell_ratio, coverage_pct, data_quality, source, day_range, chg_fils, total_volume, trades)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'AWSAT',$12,$13,0,0) ON CONFLICT DO NOTHING`,
        [sym, day, close, prev, avgTrade, moves, up2, tinyUp, bsr, cov, quality, range, chgFils]);
      await pool.query(
        `INSERT INTO spread.symbol_day_stats (symbol, trading_day, minutes_measured, pct_postable, pct_exitable_ratio,
           pct_exitable_size, bid_kd_p25, gap_pct, volume_ratio_5d, days_active_5d, down_days_5d, change_5d_fils,
           budget_kd, pct_moves_sub100)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,790,$13) ON CONFLICT DO NOTHING`,
        [sym, day, b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], t[1]]);
      await pool.query(
        `INSERT INTO public.awsat_market_quotes (market, symbol, code, session, last_price, last_qty, bid, bid_qty,
           offer, offer_qty, volume, trades, trading_date, ingest_source, created_at)
         VALUES ($1,$2,$2,'Trading',$3,100,$4,20000,$5,20000,0,0,$6,'awsat_server',$6::date + time '09:00')
         ON CONFLICT DO NOTHING`, [market, sym, close, bid, offer, day]);
      return { close: Number(close), bid: Number(bid), offer: Number(offer), market };
    },
    clearDay: async (day) => {
      assertTestDay(day);
      await pool.query('DELETE FROM spread.symbol_day_stats WHERE trading_day = $1', [day]);
      await pool.query('DELETE FROM public.symbol_day WHERE trading_date = $1', [day]);
      await pool.query('DELETE FROM public.market_day WHERE trading_date = $1', [day]);
    },

    /** public.app_config — the sizing budget the old frontend read. */
    setBudget: (kd) => pool.query(
      `INSERT INTO public.app_config (key, value) VALUES ('budget_kd', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(kd)]),
    clearBudget: () => pool.query("DELETE FROM public.app_config WHERE key = 'budget_kd'"),
    /** public.app_config — an arbitrary setting, for the /settings masking test (R-29). */
    appConfig: (key, value, isSecret = false) => pool.query(
      `INSERT INTO public.app_config (key, value, is_secret) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret`,
      [key, String(value), isSecret]),
    clearAppConfig: (prefix) => pool.query('DELETE FROM public.app_config WHERE key LIKE $1', [`${prefix}%`]),

    /** public.awsat_stock_depth — one level for a test symbol. */
    depthLevel: (sym, { level = 1, bid, bidQty, offer, offerQty }) => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.awsat_stock_depth (symbol, level, bid, bid_qty, offer, offer_qty,
           trading_date, ingest_source, created_at, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,current_date,'awsat_server',now(),now())
         ON CONFLICT DO NOTHING`, [sym, level, bid, bidQty, offer, offerQty]);
    },
    /**
     * public.awsat_stock_depth — one capture (many levels) at a given instant.
     * levels: [[level, bid, bidQty], ...]; offer is bid+2 with 5,000 qty.
     */
    depthAt: async (sym, at, levels) => {
      assertTestSymbol(sym);
      for (const [level, bid, bidQty] of levels) {
        await pool.query(
          `INSERT INTO public.awsat_stock_depth (symbol, level, bid, bid_qty, offer, offer_qty,
             trading_date, ingest_source, created_at, captured_at)
           VALUES ($1,$2,$3,$4,$5,5000,$6::date,'awsat_server',$7,$7) ON CONFLICT DO NOTHING`,
          [sym, level, bid, bidQty, bid + 2, require('../src/jobs/daily').kuwaitDay(new Date(at)), at]);
      }
    },
    // A capture with FULL control of both sides — levels are
    // [{ level, bid, bidQty, offer, offerQty }] — for the ladder-marker tests
    // (CEILING/UNDERCUT need real offers, which depthAt fakes as bid+2).
    depthLevels: async (sym, at, levels) => {
      assertTestSymbol(sym);
      const day = require('../src/jobs/daily').kuwaitDay(new Date(at));
      for (const l of levels) {
        await pool.query(
          `INSERT INTO public.awsat_stock_depth (symbol, level, bid, bid_qty, offer, offer_qty,
             trading_date, ingest_source, created_at, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,'awsat_server',$8,$8) ON CONFLICT DO NOTHING`,
          [sym, l.level, l.bid ?? null, l.bidQty ?? null, l.offer ?? null, l.offerQty ?? null, day, at]);
      }
    },
    setDepthBid: (sym, bid) => {
      assertTestSymbol(sym);
      return pool.query('UPDATE public.awsat_stock_depth SET bid = $2 WHERE symbol = $1', [sym, bid]);
    },
    clearDepth: (sym) => {
      assertTestSymbol(sym);
      return pool.query('DELETE FROM public.awsat_stock_depth WHERE symbol = $1', [sym]);
    },

    /** public.awsat_market_quotes — one capture of a symbol, for the halt detector / m45. */
    marketQuote: (sym, at, { session, lastPrice = null, bid = null, bidQty = null, offer = null, offerQty = null, trades = null, volume = null, day } = {}) => {
      assertTestSymbol(sym);
      const d = day || require('../src/jobs/daily').kuwaitDay(new Date(at));
      return pool.query(
        `INSERT INTO public.awsat_market_quotes (market, symbol, session, last_price, bid, bid_qty, offer, offer_qty,
           trades, volume, trading_date, ingest_source, source_precedence, created_at)
         VALUES ('KSE',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,'awsat_server',1,$11)`,
        [sym, session, lastPrice, bid, bidQty, offer, offerQty, trades, volume, d, at]);
    },
    clearQuotesRaw: (sym) => {
      assertTestSymbol(sym);
      return pool.query('DELETE FROM public.awsat_market_quotes WHERE symbol = $1', [sym]);
    },

    /** public.depth_watchlist — one active slot, for the halt slot-swap decision. */
    depthSlot: (sym, { slotNo, day, at = new Date() } = {}) => {
      assertTestSymbol(sym);
      return pool.query(
        // The scraper's CHECK (024): PRE_DAY is slots 1–3, WAKEUP 4–8. Derived
        // from the slot number so a caller cannot write a pair the shared
        // database refuses (the old literal 'swappable' failed with 23514).
        `INSERT INTO public.depth_watchlist (trading_date, slot_no, symbol, slot_type, assigned_at, assigned_by)
         VALUES ($1::date,$2,$3,$5,$4,'test')`,
        [day, slotNo, sym, at, slotNo <= 3 ? 'PRE_DAY' : 'WAKEUP']);
    },
    clearDepthSlots: (day) => pool.query('DELETE FROM public.depth_watchlist WHERE trading_date = $1::date', [day]),
    clearSymbolDay: (sym) => { assertTestSymbol(sym); return pool.query('DELETE FROM public.symbol_day WHERE symbol = $1', [sym]); },
    /** public.instruments — mark a test instrument suspended / delisted (CR-8 SUSPENDED rows). */
    setInstrumentStatus: (sym, { tradeable = true, brokerStatus = null } = {}) => {
      assertTestSymbol(sym);
      return pool.query('UPDATE public.instruments SET is_tradeable = $2, broker_status = $3 WHERE symbol = $1', [sym, tradeable, brokerStatus]);
    },

    /** public.awsat_order_list — a broker fill the reconciliation matches. */
    brokerOrder: (row) => {
      assertTestSymbol(row.symbol);
      return pool.query(
        `INSERT INTO public.awsat_order_list (order_id, symbol, side, order_status, price,
           quantity, filled_quantity, order_value, net_value, executions_observed,
           trading_date, ingest_source, created_at)
         VALUES ($1,$2,$3,'Filled',$4,$5,$6,$7,$8,$9,$10,'awsat_client',now())`,
        [row.orderId, row.symbol, row.side, row.price, row.quantity,
         row.filledQuantity ?? row.quantity, row.orderValue, row.netValue,
         row.executions ?? null, row.day]);
    },
    clearBrokerOrders: (prefix) => {
      assertTestSymbol(prefix);
      return pool.query('DELETE FROM public.awsat_order_list WHERE symbol LIKE $1', [`${prefix}%`]);
    },

    /**
     * public.client_heartbeat — the scraper's per-cycle liveness record, which
     * feedHealth reads (SPR-27/30). The table is created by the scraper's own
     * migration, so a schema-only backend test DB may not have it; ensure it
     * here (DDL, idempotent) and upsert one script's row. `secondsAgo` sets how
     * stale last_seen_at is, so a suite can make a feed 'silent'. Test rows use
     * source 'test' and are cleared by it, never touching a real heartbeat.
     */
    heartbeatTable: () => pool.query(
      `CREATE TABLE IF NOT EXISTS public.client_heartbeat (
         script text NOT NULL, source text NOT NULL DEFAULT 'awsat_client',
         version text, rows_seen integer, problem text,
         last_seen_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (script, source));`),
    heartbeat: async (script, { secondsAgo = 0, rowsSeen = 0, problem = null, version = 'test' } = {}) => {
      await pool.query(
        `INSERT INTO public.client_heartbeat (script, source, version, rows_seen, problem, last_seen_at)
         VALUES ($1, 'test', $2, $3, $4, now() - ($5 || ' seconds')::interval)
         ON CONFLICT (script, source) DO UPDATE
           SET version = EXCLUDED.version, rows_seen = EXCLUDED.rows_seen,
               problem = EXCLUDED.problem, last_seen_at = EXCLUDED.last_seen_at;`,
        [script, version, rowsSeen, problem, String(secondsAgo)]);
    },
    // Every row, not only source='test': the scraper's own suite runs against
    // the same *_test database and leaves awsat_client rows for all four
    // scripts, which made "quotes is absent" read ok. The guard already
    // confines this to a *_test database.
    clearHeartbeats: () => pool.query('DELETE FROM public.client_heartbeat')
      .catch(() => {}),

    /** public.signal_log / public.position — the review surface's sources. */
    signal: (sym, day, signal, price, wasRight) => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.signal_log (symbol, trading_date, signal, fired_at, price, was_right)
         VALUES ($1,$2,$3,now(),$4,$5)`, [sym, day, signal, price, wasRight]);
    },
    clearSignals: (sym) => {
      assertTestSymbol(sym);
      return pool.query('DELETE FROM public.signal_log WHERE symbol = $1', [sym]);
    },
    /** public.signal_log — a scored HALT_RESUME firing at a chosen instant (G-3). */
    haltResumeSignal: (sym, day, firedAt, price, px15) => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.signal_log (symbol, trading_date, signal, fired_at, price, px_15min, was_right, scored_at)
         VALUES ($1,$2,'HALT_RESUME',$3,$4,$5,true,now())`, [sym, day, firedAt, price, px15]);
    },
    position: (sym, day, shares, avgCost) => {
      assertTestSymbol(sym);
      return pool.query(
        `INSERT INTO public.position (symbol, trading_date, shares, avg_cost, opened_at, is_open)
         VALUES ($1,$2,$3,$4,$2::date + time '10:00', true)`, [sym, day, shares, avgCost]);
    },
    clearPositions: (sym) => {
      assertTestSymbol(sym);
      return pool.query('DELETE FROM public.position WHERE symbol = $1', [sym]);
    },

    /** spread.* cleanup, SYMBOL-scoped. Never by day. */
    clearLegs: (prefix) => {
      assertTestSymbol(prefix);
      return pool.query(
        `WITH gone AS (
           DELETE FROM spread.cash_movement
            WHERE order_leg_id IN (SELECT id FROM spread.order_leg WHERE symbol LIKE $1)
           RETURNING 1)
         DELETE FROM spread.order_leg WHERE symbol LIKE $1`, [`${prefix}%`]);
    },
  };
}

module.exports = { bind, isTestSymbol, isTestDay, TEST_PREFIXES, TEST_DAY };
