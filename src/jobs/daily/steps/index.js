/**
 * ─── INERT, AND NOW UNRUNNABLE ─────────────────────────────────────────────
 *
 * These steps computed spread.symbol_day and spread.market_day, which are now
 * VIEWS over public.* that the SCRAPER computes — so every UPDATE here would
 * fail on a view it cannot write.
 *
 * They also read spread.symbol, which migration 015 dropped as an empty
 * duplicate of public.instruments. So this file will throw on line 467 if
 * anyone runs it.
 *
 * NOT REPAIRED, deliberately: repairing it would make it runnable, and running
 * it would recreate the two-analytics-layers problem the schema boundary
 * exists to prevent. If a measurement is missing, add it to the scraper's
 * compute — five columns came across that way rather than being recomputed
 * here.
 */

'use strict';
/**
 * ============================================================================
 *  jobs/daily/steps — the SQL that computes every stored gate column
 * ============================================================================
 * ALL FROM v_quote_screening UNLESS STATED. Screening means the continuous
 * session; auction prints are not tradeable and must never reach a high, a low
 * or a range.
 *
 * TWO STATISTICS THAT MUST NOT BE MEDIANS. This defect occurred twice and
 * inverted the answer both times.
 *
 *   GATE 6 — one stock's bid swung 33-fold across a session: 7.6% at 09:17
 *   (filled in 2 min), 28% at 10:30 (filled in 4), 1.2% at 11:30 (never).
 *   The MEDIAN said 2.0% — reject. It produced four fills that day.
 *
 *   GATE 7 — median offer/bid was 0.97, apparently balanced. The offer
 *   exceeded twice the bid for 62% of the session; the true figure was 38%
 *   exitable.
 *
 * Rule: any gate about "can I transact" is a PERCENTAGE OF THE SESSION, never
 * a central tendency. Both are written that way below and must stay that way.
 * ============================================================================
 */

const { GATES, QUALITY, DEPTH } = require('../../../config/spread.config');
const gateStore = require('../../../services/gateStore');

// Kuwait WALL CLOCK, for hour-of-day only. The session DAY is never derived
// from this: that is spread.kuwait_day() (019), which rolls at 04:00.
const K = "AT TIME ZONE 'Asia/Kuwait'";

/*
 * The RAW source table, resolved at runtime.
 *
 * Almost everything reads the VIEWS — they filter by session and that filter is
 * the point. But the null-session alarm cannot: a view that selects
 * `WHERE session = 'Trading'` can never return a row whose session is NULL, and
 * a symbol with 928 such rows would stay invisible for exactly the reason the
 * alarm exists.
 */
let SOURCE_QUOTES = null;
async function resolveSource(db) {
  if (SOURCE_QUOTES) return SOURCE_QUOTES;
  const { rows } = await db.query(
    `SELECT table_schema FROM information_schema.tables
      WHERE table_name IN ('stock_quotes','quote')
        AND table_schema IN ('public','spread')
      ORDER BY CASE table_schema WHEN 'public' THEN 0 ELSE 1 END LIMIT 1;`);
  const schema = rows[0]?.table_schema || 'spread';
  SOURCE_QUOTES = schema === 'public' ? 'public.stock_quotes' : 'spread.quote';
  return SOURCE_QUOTES;
}

/* ==========================================================================
 * build — today's rows
 * ========================================================================*/
async function build(day, db) {
  const { rowCount } = await db.query(
    `WITH t AS (
       SELECT symbol, market, last_price::numeric AS px, volume::bigint AS vol,
              trades::bigint AS trd, bid::numeric AS bid, offer::numeric AS ofr,
              created_at
         FROM spread.v_quote_screening
        WHERE spread.kuwait_day(created_at) = $1
     ), agg AS (
       SELECT symbol, max(market) AS market,
              count(*) AS ticks,
              max(vol) - min(vol) AS volume_shares,
              max(trd) AS trade_count,
              -- high/low from the SCREENING view only. One auction print of
              -- 849,788 shares clearing 8 fils below the 12:59 price made a
              -- 2-fil stock look like a 9-fil one.
              max(px) AS high_fils, min(px) AS low_fils,
              max(px) - min(px) AS range_trading_fils,
              avg(ofr - bid) AS avg_spread_fils
         FROM t GROUP BY symbol
     ), opening AS (
       SELECT DISTINCT ON (symbol) symbol, px AS open_fils
         FROM t ORDER BY symbol, created_at ASC
     ), closing AS (
       -- close, volume and trade count come from v_quote: Trading at Last
       -- carries 16% of daily volume and the final print is in Close-Of-Day.
       SELECT DISTINCT ON (symbol) symbol,
              last_price::numeric AS close_fils,
              volume::bigint AS vol_full,
              trades::bigint AS trd_full
         FROM spread.v_quote
        WHERE spread.kuwait_day(created_at) = $1
        ORDER BY symbol, created_at DESC
     )
     INSERT INTO spread.symbol_day
       (symbol, trading_day, open_fils, high_fils, low_fils, close_fils,
        range_trading_fils, volume_shares, trade_count, turnover_kd,
        avg_trade_shares, avg_spread_fils, ticks_captured, source)
     SELECT a.symbol, $1::date, o.open_fils, a.high_fils, a.low_fils, c.close_fils,
            a.range_trading_fils,
            COALESCE(c.vol_full, a.volume_shares),
            COALESCE(c.trade_count, a.trade_count),
            COALESCE(c.vol_full, a.volume_shares) * c.close_fils / 1000.0,
            CASE WHEN COALESCE(c.trade_count, a.trade_count) > 0
                 THEN COALESCE(c.vol_full, a.volume_shares)::numeric
                      / COALESCE(c.trade_count, a.trade_count) END,
            a.avg_spread_fils, a.ticks,
            -- TradingView cannot back up the book: no bid, no offer, no
            -- quantities, no session. If the broker scraper dies, Gates 6 and
            -- 7 have no other source, so the row records where it came from.
            CASE WHEN a.ticks > 0 THEN 'BROKER' ELSE 'TRADINGVIEW' END
       FROM agg a
       LEFT JOIN closing c USING (symbol)
       LEFT JOIN opening o USING (symbol)
     ON CONFLICT (symbol, trading_day) DO UPDATE SET
       open_fils = EXCLUDED.open_fils, high_fils = EXCLUDED.high_fils,
       low_fils = EXCLUDED.low_fils, close_fils = EXCLUDED.close_fils,
       range_trading_fils = EXCLUDED.range_trading_fils,
       volume_shares = EXCLUDED.volume_shares, trade_count = EXCLUDED.trade_count,
       turnover_kd = EXCLUDED.turnover_kd,
       avg_trade_shares = EXCLUDED.avg_trade_shares,
       avg_spread_fils = EXCLUDED.avg_spread_fils,
       ticks_captured = EXCLUDED.ticks_captured, source = EXCLUDED.source,
       computed_at = now();`, [day]);
  return { rows: rowCount };
}

/* ==========================================================================
 * prevClose — through spread.prev_session(), never a date offset
 * ========================================================================*/
async function prevClose(day, db) {
  const { rowCount } = await db.query(
    `UPDATE spread.symbol_day s
        SET prev_close_fils = (
              SELECT x.close_fils FROM spread.symbol_day x
               WHERE x.symbol = s.symbol
                 AND x.trading_day = spread.prev_session($1::date)
                 AND x.close_fils IS NOT NULL)
      WHERE s.trading_day = $1;`, [day]);

  /*
   * A symbol with no previous close is either newly listed or was absent. Fall
   * back to the most recent non-null close BEFORE that session — but only as a
   * fallback, so a genuine gap is still visible in how far back it reached.
   */
  const { rowCount: filled } = await db.query(
    `UPDATE spread.symbol_day s
        SET prev_close_fils = (
              SELECT x.close_fils FROM spread.symbol_day x
               WHERE x.symbol = s.symbol AND x.trading_day < $1
                 AND x.close_fils IS NOT NULL
               ORDER BY x.trading_day DESC LIMIT 1)
      WHERE s.trading_day = $1 AND s.prev_close_fils IS NULL;`, [day]);

  return { rows: rowCount, fallback: filled };
}

/* ==========================================================================
 * baselines — 5-day. Specified as 5-day; implementing it as 20 hid a spike.
 * ========================================================================*/
async function baselines(day, db) {
  const { rowCount } = await db.query(
    `WITH w AS (
       SELECT symbol, trading_day, volume_shares, trade_count,
              row_number() OVER (PARTITION BY symbol ORDER BY trading_day DESC) AS rn
         FROM spread.symbol_day
        WHERE trading_day < $1 AND volume_shares IS NOT NULL
     ), b AS (
       SELECT symbol, avg(volume_shares) AS base_volume, avg(trade_count) AS base_trades
         FROM w WHERE rn <= 5 GROUP BY symbol
     )
     UPDATE spread.symbol_day s
        SET volume_ratio_5d = CASE WHEN b.base_volume > 0
              THEN round(s.volume_shares::numeric / b.base_volume, 3) END,
            trade_count_ratio_5d = CASE WHEN b.base_trades > 0
              THEN round(s.trade_count::numeric / b.base_trades, 3) END
       FROM b
      WHERE s.symbol = b.symbol AND s.trading_day = $1;`, [day]);
  return { rows: rowCount };
}

/* ==========================================================================
 * gates — moves, tape quality, postable, exitable
 * ========================================================================*/
async function gates(day, db) {
  // A2 · the band edges size against the operator's set budget (spread.gate_config
  // session-budget), the SAME source as the live screen — never the file seed.
  // A batch process may not have loaded the store at boot; load it, and refuse
  // loudly rather than compute a band off a number nobody set (on a 2,000 account
  // the 790 seed would place the queue band at a third of the real level).
  await gateStore.load(db).catch(() => {});
  const slot = gateStore.sessionBudgetKd();
  if (slot == null) {
    throw new Error(
      'daily gates: no session budget is set (spread.gate_config session-budget) — '
      + 'refusing to compute the queue band off the file seed. '
      + 'Set it with PUT /gates {"session-budget": 2000}.');
  }
  const [qLo, qHi] = GATES.queueBandPct;
  // The band edges in KD: your order must be qLo..qHi percent of the level.
  const minLevelKd = slot / (qHi / 100);
  const maxLevelKd = slot / (qLo / 100);

  const { rowCount } = await db.query(
    `WITH t AS (
       SELECT symbol, created_at,
              last_price::numeric AS px, volume::bigint AS vol,
              last_qty::bigint AS one_trade,
              bid::numeric AS bid, bid_qty::bigint AS bid_shares,
              offer::numeric AS ofr, offer_qty::bigint AS offer_shares,
              lag(last_price::numeric) OVER w AS prev_px,
              lag(volume::bigint)      OVER w AS prev_vol
         FROM spread.v_quote_screening
        WHERE spread.kuwait_day(created_at) = $1
       WINDOW w AS (PARTITION BY symbol ORDER BY created_at)
     ), moved AS (
       SELECT *, (px <> prev_px) AS is_move,
              -- CR-33: last_qty is ONE trade. volume differencing is every
              -- trade in the minute, and they agree only when exactly one
              -- occurred — 39 of 123 minutes on the session measured.
              COALESCE(one_trade, vol - prev_vol) AS trade_shares
         FROM t WHERE prev_px IS NOT NULL
     ), m AS (
       SELECT symbol,
              -- Gate 4. EITHER DIRECTION: a round trip needs price down to
              -- your bid AND up to your offer.
              count(*) FILTER (WHERE is_move)                             AS price_moves,
              count(*) FILTER (WHERE px > prev_px)                        AS price_moves_up,
              count(*) FILTER (WHERE px < prev_px)                        AS price_moves_down,
              -- A 2-fil target needs 2-fil UP moves. One stock had 14 moves a
              -- day and a median of ONE up-move of 2+.
              count(*) FILTER (WHERE px - prev_px >= 2)                   AS price_moves_2plus,
              -- Gate 5. A move caused by a trade of 100 shares or fewer.
              count(*) FILTER (WHERE is_move AND trade_shares BETWEEN 1 AND 100) AS tiny_move_count,
              sum(trade_shares) FILTER (WHERE is_move AND trade_shares BETWEEN 1 AND 100)
                                                                          AS tiny_move_shares,
              -- Gate 6. Percentiles are BUDGET-INDEPENDENT, so the stored
              -- value survives a change of slot size.
              percentile_cont(0.10) WITHIN GROUP (ORDER BY bid_shares * bid / 1000) AS bid_kd_p10,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY bid_shares * bid / 1000) AS bid_kd_p25,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY bid_shares * bid / 1000) AS bid_kd_p50,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY bid_shares * bid / 1000) AS bid_kd_p75,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY bid_shares * bid / 1000) AS bid_kd_p90,
              -- A PERCENTAGE OF THE SESSION, never the median.
              100.0 * count(*) FILTER (WHERE bid_shares * bid / 1000 BETWEEN $2 AND $3)
                    / NULLIF(count(*),0)                                  AS pct_postable,
              -- Gate 7, THREE measures. The ratio catches the offer-wall shape
              -- that cost 24 KD; the size version answers what the trader
              -- actually needs — "is the offer big relative to ME".
              100.0 * count(*) FILTER (WHERE offer_shares * ofr <= 2 * bid_shares * bid)
                    / NULLIF(count(*),0)                                  AS pct_exitable_ratio,
              100.0 * count(*) FILTER (WHERE offer_shares <= 3 * $4::bigint)
                    / NULLIF(count(*),0)                                  AS pct_exitable_size,
              percentile_cont(0.10) WITHIN GROUP (ORDER BY offer_shares)  AS offer_shares_p10,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY offer_shares)  AS offer_shares_p50,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY offer_shares)  AS offer_shares_p90,
              -- CR-33 · true trade size from last_qty, not differencing.
              percentile_cont(0.10) WITHIN GROUP (ORDER BY one_trade)     AS last_qty_p10,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY one_trade)     AS last_qty_p50,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY one_trade)     AS last_qty_p90,
              count(*) FILTER (WHERE one_trade BETWEEN 1 AND 100)         AS trades_under_100,
              -- Gate 8, kept for the 20-session comparison against print
              -- location, then retired.
              avg(trade_shares) FILTER (WHERE px > prev_px)               AS avg_uptick_shares,
              avg(trade_shares) FILTER (WHERE px < prev_px)               AS avg_downtick_shares,
              -- The 15-minute pace, split AM/PM: the spread is widest at 09:00
              -- and tightest at noon, so one figure describes neither.
              sum(trade_shares) FILTER (WHERE EXTRACT(hour FROM created_at ${K}) < 11)
                / NULLIF(count(*) FILTER (WHERE EXTRACT(hour FROM created_at ${K}) < 11), 0)
                                                                          AS am_pace,
              sum(trade_shares) FILTER (WHERE EXTRACT(hour FROM created_at ${K}) >= 11)
                / NULLIF(count(*) FILTER (WHERE EXTRACT(hour FROM created_at ${K}) >= 11), 0)
                                                                          AS pm_pace
         FROM moved GROUP BY symbol
     )
     UPDATE spread.symbol_day s
        SET price_moves         = m.price_moves,
            price_moves_up      = m.price_moves_up,
            price_moves_down    = m.price_moves_down,
            price_moves_2plus   = m.price_moves_2plus,
            tiny_move_count     = m.tiny_move_count,
            tiny_move_shares    = m.tiny_move_shares,
            pct_moves_sub100    = CASE WHEN m.price_moves > 0
                                    THEN round(100.0 * m.tiny_move_count / m.price_moves, 2) END,
            bid_kd_p10 = round(m.bid_kd_p10, 2),
            bid_kd_p25 = round(m.bid_kd_p25, 2),
            bid_kd_p50 = round(m.bid_kd_p50, 2),
            bid_kd_p75 = round(m.bid_kd_p75, 2),
            bid_kd_p90 = round(m.bid_kd_p90, 2),
            pct_session_postable_800      = round(m.pct_postable, 1),
            pct_session_exitable_ratio    = round(m.pct_exitable_ratio, 1),
            pct_session_exitable_size_800 = round(m.pct_exitable_size, 1),
            offer_shares_p10 = round(m.offer_shares_p10, 0),
            offer_shares_p50 = round(m.offer_shares_p50, 0),
            offer_shares_p90 = round(m.offer_shares_p90, 0),
            last_qty_p10 = round(m.last_qty_p10, 0),
            last_qty_p50 = round(m.last_qty_p50, 0),
            last_qty_p90 = round(m.last_qty_p90, 0),
            trades_under_100 = m.trades_under_100,
            avg_uptick_shares   = round(m.avg_uptick_shares, 0),
            avg_downtick_shares = round(m.avg_downtick_shares, 0),
            block_ratio = CASE WHEN m.avg_uptick_shares > 0
                            THEN round(m.avg_downtick_shares / m.avg_uptick_shares, 3) END,
            am_shares_per_min = round(m.am_pace, 0),
            pm_shares_per_min = round(m.pm_pace, 0)
       FROM m
      WHERE s.symbol = m.symbol AND s.trading_day = $1;`,
    [day, minLevelKd, maxLevelKd, Math.floor((slot * 1000) / 150)]);
  return { rows: rowCount };
}

/* ==========================================================================
 * flow — CR-33. MEASURED print location, not the tick rule.
 *
 * The two methods disagreed on DIRECTION on the same session: the tick rule
 * said buyers 3:1, print location said sellers 1.3:1.
 *
 * The tick rule is blind to the quietest form of distribution — a large seller
 * hitting the same bid repeatedly registers as "unchanged" and is DISCARDED.
 * That was 35 events and 432,685 shares on one session.
 * ========================================================================*/
async function flow(day, db) {
  const { rowCount } = await db.query(
    `WITH t AS (
       SELECT symbol,
              last_price::numeric AS px, last_qty::bigint AS one_trade,
              bid::numeric AS bid, offer::numeric AS ofr
         FROM spread.v_quote_screening
        WHERE spread.kuwait_day(created_at) = $1
          AND last_qty IS NOT NULL AND bid > 0 AND offer > 0
     ), f AS (
       SELECT symbol,
              sum(one_trade) FILTER (WHERE px >= ofr)              AS shares_at_offer,
              sum(one_trade) FILTER (WHERE px <= bid)              AS shares_at_bid,
              sum(one_trade) FILTER (WHERE px > bid AND px < ofr)  AS shares_inside,
              count(*)       FILTER (WHERE px >= ofr)              AS events_at_offer,
              count(*)       FILTER (WHERE px <= bid)              AS events_at_bid
         FROM t GROUP BY symbol
     )
     UPDATE spread.symbol_day s
        SET shares_at_offer      = f.shares_at_offer,
            shares_at_bid        = f.shares_at_bid,
            shares_inside_spread = f.shares_inside,
            events_at_offer      = f.events_at_offer,
            events_at_bid        = f.events_at_bid,
            -- Above 1 is net distribution: more size hitting the bid than
            -- lifting the offer.
            flow_ratio = CASE WHEN f.shares_at_offer > 0
                          THEN round(f.shares_at_bid::numeric / f.shares_at_offer, 3) END
       FROM f
      WHERE s.symbol = f.symbol AND s.trading_day = $1;`, [day]);
  return { rows: rowCount };
}

/* ==========================================================================
 * capture — how much of the session a row was computed from
 *
 * A percentage from half a session is NOT WRONG — it is NOT COMPARABLE, and it
 * sorts beside a fully-captured symbol as though it meant the same thing.
 *
 * A RATIO, never a count. The current cadence gives ~442 ticks; move the
 * scraper to one capture a minute and a full session becomes ~240, so a fixed
 * ">= 400" floor would fail everything while nothing had degraded.
 * ========================================================================*/
async function capture(day, db) {
  const { rowCount } = await db.query(
    `WITH m AS (SELECT max(ticks_captured) AS session_max
                  FROM spread.symbol_day WHERE trading_day = $1)
     UPDATE spread.symbol_day s
        SET capture_pct = round(100.0 * s.ticks_captured / NULLIF(m.session_max, 0), 1),
            capture_quality = CASE
              WHEN s.ticks_captured IS NULL THEN 'MISSING'
              WHEN 100.0 * s.ticks_captured / NULLIF(m.session_max,0) < $3 THEN 'THIN'
              WHEN 100.0 * s.ticks_captured / NULLIF(m.session_max,0) < $2 THEN 'PARTIAL'
              ELSE 'OK' END
       FROM m
      WHERE s.trading_day = $1 AND s.source IS DISTINCT FROM 'TRADINGVIEW';`,
    [day, QUALITY.minCapturePct, QUALITY.refuseBelowPct]);
  return { rows: rowCount };
}

/* ==========================================================================
 * hours — CR-29. The fixed "check at 09:30" rule does not work.
 *
 * One stock does 9% of its trades in the first hour and its morning count is
 * ANTI-predictive: 18 trades by 10:00 gave a 50-trade day, 8 gave 209.
 * ========================================================================*/
async function hours(day, db) {
  const { rowCount } = await db.query(
    `WITH h AS (
       SELECT symbol,
              EXTRACT(hour FROM created_at ${K})::int AS hr,
              max(trades::bigint) - min(trades::bigint) AS n
         FROM spread.v_quote_screening
        WHERE spread.kuwait_day(created_at) = $1
        GROUP BY symbol, hr
     ), p AS (
       SELECT symbol,
              max(n) FILTER (WHERE hr = 9)  AS h09,
              max(n) FILTER (WHERE hr = 10) AS h10,
              max(n) FILTER (WHERE hr = 11) AS h11,
              max(n) FILTER (WHERE hr = 12) AS h12,
              (array_agg(hr ORDER BY n DESC))[1] AS peak_hour,
              sum(n) FILTER (WHERE hr <= 9) AS by_1000,
              sum(n) AS full_day
         FROM h GROUP BY symbol
     )
     UPDATE spread.symbol_day s
        SET trades_hour_09 = p.h09, trades_hour_10 = p.h10,
            trades_hour_11 = p.h11, trades_hour_12 = p.h12,
            peak_hour = p.peak_hour,
            pct_trades_by_1000 = CASE WHEN p.full_day > 0
              THEN round(100.0 * p.by_1000 / p.full_day, 1) END
       FROM p
      WHERE s.symbol = p.symbol AND s.trading_day = $1;`, [day]);
  return { rows: rowCount };
}

/* ==========================================================================
 * consistency — Gate 9. Deliberately EXCLUDES today.
 *
 * The question is whether the stock was ALREADY active, not whether it is
 * active now — otherwise a one-day flash counts itself.
 *
 * Uses the previous N SESSIONS, not the previous N days.
 * ========================================================================*/
async function consistency(day, db) {
  const { rowCount } = await db.query(
    `WITH sessions AS (
       SELECT trading_day FROM spread.trading_day
        WHERE is_session AND trading_day < $1
        ORDER BY trading_day DESC LIMIT $2
     ), a AS (
       SELECT d.symbol,
              count(*) FILTER (WHERE d.price_moves >= $3)                    AS days_active,
              count(*) FILTER (WHERE d.close_fils < d.prev_close_fils)        AS down_days
         FROM spread.symbol_day d
         JOIN sessions ON sessions.trading_day = d.trading_day
        GROUP BY d.symbol
     )
     UPDATE spread.symbol_day s
        SET days_active_5d = a.days_active,
            down_days_5d   = a.down_days
       FROM a
      WHERE s.symbol = a.symbol AND s.trading_day = $1;`,
    [day, GATES.consistencyWindow, GATES.minPriceMoves]);
  return { rows: rowCount };
}

/* ==========================================================================
 * direction — CR-35. STORED AND DISPLAYED. Gates nothing.
 *
 * A stock that fell yesterday is 44% to rise today. And the four bad picks
 * that raised this each failed a gate that already exists — direction
 * correlated with the real failures rather than causing them.
 * ========================================================================*/
async function direction(day, db) {
  const { rowCount } = await db.query(
    `UPDATE spread.symbol_day s
        SET change_1d_fils  = s.close_fils - s.prev_close_fils,
            change_5d_fils  = s.close_fils - (
              SELECT x.close_fils FROM spread.symbol_day x
               WHERE x.symbol = s.symbol
                 AND x.trading_day = spread.prev_session($1::date, 5)),
            change_20d_fils = s.close_fils - (
              SELECT x.close_fils FROM spread.symbol_day x
               WHERE x.symbol = s.symbol
                 AND x.trading_day = spread.prev_session($1::date, 20))
      WHERE s.trading_day = $1;`, [day]);
  return { rows: rowCount };
}

/* ==========================================================================
 * missing — explicit rows for symbols that produced nothing.
 *
 * A symbol with no row looks identical to one that did not trade. Deliberately
 * NOT wrapped in a catch: the point of this step is that a scraper failure
 * becomes visible, and swallowing its own error makes the step itself
 * invisible.
 * ========================================================================*/
async function missing(day, db) {
  const { rowCount } = await db.query(
    `INSERT INTO spread.symbol_day (symbol, trading_day, source, capture_quality)
     SELECT c.symbol, $1::date, 'NONE', 'MISSING'
       FROM spread.symbol c
      WHERE c.is_active
        AND NOT EXISTS (SELECT 1 FROM spread.symbol_day s
                         WHERE s.symbol = c.symbol AND s.trading_day = $1)
     ON CONFLICT (symbol, trading_day) DO NOTHING;`, [day]);
  return { rows: rowCount };
}

/* ========================================================================== */
async function market(day, db) {
  const { rowCount } = await db.query(
    `INSERT INTO spread.market_day
       (trading_day, symbols_traded, total_volume, total_trades,
        advancers, decliners, unchanged, avg_spread_fils, avg_price_move_count)
     SELECT $1::date,
            count(*) FILTER (WHERE capture_quality <> 'MISSING'),
            sum(volume_shares), sum(trade_count),
            count(*) FILTER (WHERE close_fils > prev_close_fils),
            count(*) FILTER (WHERE close_fils < prev_close_fils),
            count(*) FILTER (WHERE close_fils = prev_close_fils),
            round(avg(avg_spread_fils), 2),
            round(avg(price_moves), 1)
       FROM spread.symbol_day WHERE trading_day = $1
     ON CONFLICT (trading_day) DO UPDATE SET
       symbols_traded = EXCLUDED.symbols_traded, total_volume = EXCLUDED.total_volume,
       total_trades = EXCLUDED.total_trades, advancers = EXCLUDED.advancers,
       decliners = EXCLUDED.decliners, unchanged = EXCLUDED.unchanged,
       avg_spread_fils = EXCLUDED.avg_spread_fils,
       avg_price_move_count = EXCLUDED.avg_price_move_count;`, [day]);
  return { rows: rowCount };
}

/* ==========================================================================
 * coverage — THE GUARD ON THE GUARD.
 *
 * capture_pct measures a symbol against the busiest symbol THAT DAY. If the
 * scraper degrades market-wide the denominator degrades with it and every
 * symbol reads 100% — the failure becomes invisible precisely when it is total.
 *
 * Two INDEPENDENT signals, because either can fire alone: a short session gives
 * few ticks with normal gaps; a throttled one gives normal-looking totals with
 * long gaps. The second is the dangerous case.
 * ========================================================================*/
async function coverage(day, db) {
  const expected = Math.round((QUALITY.sessionMinutes * 60) / QUALITY.captureIntervalSecs);

  const { rows: [r] } = await db.query(
    `WITH best AS (
       SELECT symbol, count(*) AS ticks
         FROM spread.v_quote_screening
        WHERE spread.kuwait_day(created_at) = $1
        GROUP BY symbol ORDER BY ticks DESC LIMIT 1
     ), gaps AS (
       -- OBSERVED, not configured. A configured interval drifts from reality
       -- and an observed one cannot.
       SELECT EXTRACT(EPOCH FROM (created_at - lag(created_at) OVER (ORDER BY created_at))) AS g
         FROM spread.v_quote_screening
        WHERE spread.kuwait_day(created_at) = $1
          AND symbol = (SELECT symbol FROM best)
     )
     SELECT (SELECT ticks FROM best) AS session_max,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY g) FROM gaps WHERE g > 0)
              AS median_gap;`, [day]);

  const maxTicks = Number(r?.session_max || 0);
  const medianGap = r?.median_gap == null ? null : Number(r.median_gap);
  const ratio = expected > 0 ? maxTicks / expected : null;

  const thin = ratio != null && ratio < QUALITY.minMarketCoverageRatio;
  const throttled = medianGap != null
    && medianGap > QUALITY.captureIntervalSecs * QUALITY.throttleGapMultiple;
  const flag = thin && throttled ? 'THROTTLED' : thin ? 'THIN' : throttled ? 'GAPPY' : 'OK';

  await db.query(
    `UPDATE spread.market_day
        SET session_max_ticks = $2, expected_ticks = $3,
            market_coverage_ratio = $4, median_gap_secs = $5, capture_flag = $6
      WHERE trading_day = $1;`,
    [day, maxTicks, expected,
     ratio == null ? null : Number(ratio.toFixed(3)),
     medianGap == null ? null : Number(medianGap.toFixed(1)), flag]);

  if (flag !== 'OK') {
    await db.query(
      `INSERT INTO spread.data_alarm (trading_day, table_name, alarm, detail)
       VALUES ($1, 'stock_quotes', 'LOW_COVERAGE', $2)
       ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                    COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
      [day, JSON.stringify({ flag, maxTicks, expected, medianGap,
        note: 'every per-symbol coverage figure today is measured against a maximum that is itself degraded' })]);
  }

  return { sessionMaxTicks: maxTicks, expectedTicks: expected,
    marketCoverageRatio: ratio == null ? null : Number(ratio.toFixed(3)),
    medianGapSecs: medianGap, flag };
}

/* ==========================================================================
 * profile — 20-day medians, and the reach thresholds
 * ========================================================================*/
async function profile(day, db) {
  const { rowCount } = await db.query(
    `WITH sessions AS (
       SELECT trading_day FROM spread.trading_day
        WHERE is_session AND trading_day <= $1
        ORDER BY trading_day DESC LIMIT $2
     ), w AS (
       SELECT d.* FROM spread.symbol_day d
         JOIN sessions ON sessions.trading_day = d.trading_day
        WHERE d.capture_quality IN ('OK','PARTIAL')
     ), m AS (
       SELECT symbol,
              count(*)                                                    AS sessions_in_window,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY trade_count)    AS median_trades,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY volume_shares)  AS median_volume,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY price_moves)    AS median_moves,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY pct_moves_sub100) AS median_tiny,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY bid_kd_p25)     AS median_bid_kd,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY trades_hour_09) AS med_h09,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY trades_hour_10) AS med_h10,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY trades_hour_11) AS med_h11,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY trades_hour_12) AS med_h12,
              (array_agg(peak_hour ORDER BY trading_day DESC))[1]         AS peak_hour
         FROM w GROUP BY symbol
     )
     INSERT INTO spread.symbol_profile
       (symbol, as_of, sessions_in_window, median_daily_trade_count,
        median_volume_shares, median_price_move_count, median_pct_moves_sub100,
        median_bid_kd, median_trades_by_0930, median_trades_by_1000,
        median_trades_by_1100, median_trades_by_1200, peak_hour,
        min_budget_kd, max_budget_kd,
        deep_bid_shares, thin_bid_shares, thin_offer_shares, wall_offer_shares)
     SELECT symbol, $1::date, sessions_in_window, median_trades,
            median_volume, median_moves, median_tiny, median_bid_kd,
            med_h09, COALESCE(med_h09,0) + COALESCE(med_h10,0),
            COALESCE(med_h09,0) + COALESCE(med_h10,0) + COALESCE(med_h11,0),
            COALESCE(med_h09,0) + COALESCE(med_h10,0) + COALESCE(med_h11,0) + COALESCE(med_h12,0),
            peak_hour,
            -- 5% of the median resting bid is the floor to be seen at all;
            -- 30% is where you become the book.
            round(median_bid_kd * 0.05, 0), round(median_bid_kd * 0.30, 0),
            -- CR-34 thresholds scale with the stock's own volume.
            round(median_volume * $3)::bigint, round(median_volume * $4)::bigint,
            round(median_volume * $4)::bigint, round(median_volume * $3 * 0.7)::bigint
       FROM m
     ON CONFLICT (symbol) DO UPDATE SET
       as_of = EXCLUDED.as_of, sessions_in_window = EXCLUDED.sessions_in_window,
       median_daily_trade_count = EXCLUDED.median_daily_trade_count,
       median_volume_shares = EXCLUDED.median_volume_shares,
       median_price_move_count = EXCLUDED.median_price_move_count,
       median_pct_moves_sub100 = EXCLUDED.median_pct_moves_sub100,
       median_bid_kd = EXCLUDED.median_bid_kd,
       median_trades_by_0930 = EXCLUDED.median_trades_by_0930,
       median_trades_by_1000 = EXCLUDED.median_trades_by_1000,
       median_trades_by_1100 = EXCLUDED.median_trades_by_1100,
       median_trades_by_1200 = EXCLUDED.median_trades_by_1200,
       peak_hour = EXCLUDED.peak_hour,
       min_budget_kd = EXCLUDED.min_budget_kd, max_budget_kd = EXCLUDED.max_budget_kd,
       deep_bid_shares = EXCLUDED.deep_bid_shares,
       thin_bid_shares = EXCLUDED.thin_bid_shares,
       thin_offer_shares = EXCLUDED.thin_offer_shares,
       wall_offer_shares = EXCLUDED.wall_offer_shares,
       updated_at = now();`,
    [day, QUALITY.baselineDays, DEPTH.deepBidPctOfVolume, DEPTH.thinBidPctOfVolume]);
  return { rows: rowCount };
}

/* ==========================================================================
 * alarms — the table that should have existed.
 *
 * 928 null-session rows across four days, every one the same symbol, and no
 * other symbol had a single null. Any query filtering session='Trading' drops
 * it SILENTLY. Four days passed unnoticed.
 * ========================================================================*/
async function alarms(day, db) {
  const raised = [];
  const SOURCE_QUOTES = await resolveSource(db);

  // 1 · a symbol whose session is 100% null
  const { rows: nulls } = await db.query(
    `SELECT symbol, count(*) AS n
       FROM public.stock_quotes
      WHERE spread.kuwait_day(created_at) = $1
      GROUP BY symbol
     HAVING count(*) FILTER (WHERE session IS NOT NULL) = 0;`, [day]);
  for (const r of nulls) {
    await db.query(
      `INSERT INTO spread.data_alarm (trading_day, table_name, column_name, symbol, alarm, detail)
       VALUES ($1,'stock_quotes','session',$2,'ALL_NULL',$3)
       ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                    COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
      [day, r.symbol, JSON.stringify({ rows: Number(r.n),
        note: 'every query filtering session = Trading drops this symbol silently' })]);
    raised.push({ symbol: r.symbol, alarm: 'ALL_NULL' });
  }

  // 2 · a depth-watchlist symbol with too few snapshots for CR-34
  const { rows: thin } = await db.query(
    `SELECT w.symbol, count(d.*) AS snapshots
       FROM spread.depth_watchlist w
       LEFT JOIN spread.v_depth d
         ON d.symbol = w.symbol AND spread.kuwait_day(d.created_at) = w.trading_day
      WHERE w.trading_day = $1
      GROUP BY w.symbol HAVING count(d.*) < $2;`, [day, DEPTH.minSnapshots]);
  for (const r of thin) {
    await db.query(
      `INSERT INTO spread.data_alarm (trading_day, table_name, symbol, alarm, detail)
       VALUES ($1,'stock_depth',$2,'LOW_COVERAGE',$3)
       ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                    COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
      [day, r.symbol, JSON.stringify({ snapshots: Number(r.snapshots),
        needed: DEPTH.minSnapshots,
        note: 'a depth-direction claim below this sample size is refused' })]);
    raised.push({ symbol: r.symbol, alarm: 'LOW_COVERAGE' });
  }

  // 3 · a symbol that has stopped appearing
  const { rows: gone } = await db.query(
    `SELECT symbol FROM spread.symbol
      WHERE is_active AND last_seen_on IS NOT NULL
        AND last_seen_on < spread.prev_session($1::date, 5);`, [day]);
  for (const r of gone) {
    await db.query(
      `INSERT INTO spread.data_alarm (trading_day, table_name, symbol, alarm, detail)
       VALUES ($1,'symbol',$2,'SYMBOL_VANISHED',$3)
       ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                    COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
      [day, r.symbol, JSON.stringify({
        note: 'absent for five sessions — a vanished symbol looks identical to a quiet one' })]);
    raised.push({ symbol: r.symbol, alarm: 'SYMBOL_VANISHED' });
  }

  // Keep last_seen_on current so (3) means something tomorrow.
  await db.query(
    `UPDATE spread.symbol s SET last_seen_on = $1,
            first_seen_on = COALESCE(s.first_seen_on, $1)
       FROM spread.symbol_day d
      WHERE d.symbol = s.symbol AND d.trading_day = $1
        AND d.capture_quality <> 'MISSING';`, [day]);

  return { raised: raised.length, detail: raised };
}

module.exports = {
  build, prevClose, baselines, gates, flow, capture, hours,
  consistency, direction, missing, market, coverage, profile, alarms,
};
