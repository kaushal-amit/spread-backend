-- ===========================================================================
--  011_symbol_day_reads_public.sql — one analytics layer, not two
--
--  spread.symbol_day and spread.market_day were TABLES filled by this codebase's
--  daily job, recomputing from the source views what the scraper had already
--  computed from the same rows.
--
--  Two analytics layers over one dataset is the shape the schema boundary was
--  drawn to prevent. And there was never a contest: public.symbol_day holds
--  3,769 rows across 28 sessions with S1-S10 passing; these tables held ZERO.
--  Verified empty before this ran.
--
--  ─── VIEWS, NOT COPIES ─────────────────────────────────────────────────────
--  A copy needs a writer and can go stale — exactly what we found with
--  spread.quote, which nothing wrote and which served empty views for months.
--
--  ─── THE COLUMN NAMES ──────────────────────────────────────────────────────
--  The two schemas name the same measurements differently: close_fils is
--  close_px, trade_count is trades, volume_shares is total_volume. The mapping
--  below is where this can go wrong — a wrong pairing passes every schema check
--  and returns the wrong number — so each is asserted in test/views.test.js.
-- ===========================================================================

DROP TABLE IF EXISTS spread.symbol_day CASCADE;

CREATE VIEW spread.symbol_day AS
SELECT
  symbol,
  trading_date            AS trading_day,
  open_px                 AS open_fils,
  high_px                 AS high_fils,
  low_px                  AS low_fils,
  close_px                AS close_fils,
  prev_close              AS prev_close_fils,
  chg_fils                AS change_fils,
  day_range               AS range_trading_fils,
  total_volume            AS volume_shares,
  trades                  AS trade_count,
  avg_trade_size          AS avg_trade_shares,
  moves                   AS price_moves,
  up_moves                AS price_moves_up,
  down_moves              AS price_moves_down,
  up_moves_tiny           AS tiny_move_count,
  tiny_pct_up             AS pct_moves_sub,
  bought_at_offer         AS shares_at_offer,
  sold_at_bid             AS shares_at_bid,
  trades_at_offer         AS events_at_offer,
  trades_at_bid           AS events_at_bid,
  buy_sell_ratio          AS flow_ratio,
  minutes_captured        AS ticks_captured,
  coverage_pct            AS capture_pct,
  data_quality            AS capture_quality,
  turnover_kd,
  avg_spread_fils,
  avg_spread_pct,
  days_active,
  down_days,
  peak_hour,
  first_half_shares_per_min  AS am_shares_per_min,
  second_half_shares_per_min AS pm_shares_per_min,
  -- Carried under OUR names: these have no counterpart in the old schema and
  -- renaming them would invent a vocabulary nobody uses.
  close_source, range_source, prev_session_used, prev_session_gap_days,
  tick_band_crossed, source, family,
  avg_uptick_shares, avg_downtick_shares, uptick_ratio, n_upticks, n_downticks,
  markup, resumed, lift, hit,
  chg_1d, chg_5d, up_moves_2plus, up_moves_3plus, pct_at_offer, computed_at
FROM public.symbol_day;

COMMENT ON VIEW spread.symbol_day IS
  'A VIEW over public.symbol_day, computed by the scraper. Was a table filled by '
  'this codebase''s daily job — two analytics layers over one dataset, one of '
  'which had never run. The old column names are preserved as aliases so '
  'existing queries keep working.';

DROP TABLE IF EXISTS spread.market_day CASCADE;

CREATE VIEW spread.market_day AS
SELECT
  trading_date AS trading_day,
  symbols_traded, advancing, declining, unchanged,
  pct_advancing, pct_advancing_ratio, breadth_5d_avg, thin_symbols,
  avg_pct_change, median_pct_change, pct_change_p10, pct_change_p90,
  total_volume, total_trades, volume_vs_20d, symbols_over_3x_daily,
  new_symbols, suspended_symbols, renamed_symbols, cb_events_total,
  regime, turnover_kd, index_close, index_ytd_pct, broker_seen_at,
  computed_advancing, computed_declining, computed_symbols, computed_at
FROM public.market_day;

COMMENT ON VIEW spread.market_day IS
  'A VIEW over public.market_day. Ours carries the broker''s own breadth via '
  'broker_seen_at, which the recomputed version never had.';
