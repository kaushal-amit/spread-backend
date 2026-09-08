-- ===========================================================================
--  016 · the gate statistics the scraper declares and never fills
-- ===========================================================================
--
--  WHY THE BOARD WAS EMPTY
--
--  011 turned spread.symbol_day into a view over public.symbol_day and renamed
--  its columns to the scraper's vocabulary. lib/funnel.js kept reading the
--  003 names: pct_session_postable_800, pct_session_exitable_ratio,
--  volume_ratio_5d, days_active_5d, change_1d_fils, bid_kd_p25 and eight more.
--  `SELECT d.*` returned none of them, every gate but Gate 8 treats a missing
--  value as a failure, and no symbol could pass. It looked like a quiet market.
--
--  A view alias would not have fixed it. Verified against kse on 2 September:
--  public.symbol_day HAS pct_postable, pct_exitable, vol_ratio_5d, bid_p25,
--  block_ratio, exitable_best_hour and spread_fils_p50 — and every one is NULL
--  in all 4,465 rows across 33 sessions. The scraper declares them and does not
--  compute them. Two more would have aliased to the wrong meaning:
--
--    chg_1d / chg_5d     are PERCENT (ASC: 2.23 on a 1,605 close = 35 fils);
--                        Gate 10's threshold is -2 FILS.
--    days_active         is a 20-session window; Gate 9 is a 5-session gate.
--
--  WHAT THIS DOES
--
--  1. Aliases ONLY the columns whose meaning was confirmed:
--       up_moves_2plus -> price_moves_2plus   (2+ fil UP moves, volume minutes)
--       tiny_pct_up    -> pct_moves_sub100    (% of UP moves from <=100-share
--                                              prints; 003 measured EITHER
--                                              direction — see COMMENT below)
--       chg_fils       -> change_1d_fils      (close - prev_close, in fils)
--
--  2. Adds spread.symbol_day_stats — a BRIDGE table the backend fills from the
--     minute quotes (`npm run stats:daily`, src/jobs/stats) for the statistics
--     the scraper leaves NULL. The view reads COALESCE(scraper, bridge) and
--     names which one answered in gate_stats_source, so the day the scraper
--     starts computing them the bridge goes quiet and can be dropped — and the
--     board never silently changes meaning under a reader.
--
--  3. Seeds spread.kb_threshold (created empty by 013) from public.kb_threshold
--     where that exists, else from sql/kb_seed.sql via the migration runner.
--     /api/budget and /api/sizing threw "kb_threshold is missing …" on kse.
--
--  The daily job's header still says "add it to the scraper's compute". That
--  remains the destination; this is the bridge until it arrives. The same SQL
--  is shipped for the scraper in scripts/scraper-symbol-day-stats.sql.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS spread.symbol_day_stats (
  symbol                  text        NOT NULL,
  trading_day             date        NOT NULL,
  -- Gate 6. % of captured minutes where the touch bid, in KD, sat inside the
  -- band where an order of budget_kd is 5-30% of the level.
  pct_postable            numeric,
  -- Gate 7. % of minutes where offer notional <= 2 x bid notional.
  pct_exitable_ratio      numeric,
  -- Informational. % of minutes where offer shares <= 3 x shares_at_budget.
  pct_exitable_size       numeric,
  exitable_best_hour_pct  numeric,
  -- Budget-independent queue depth percentiles, in KD.
  bid_kd_p25              numeric,
  bid_kd_p50              numeric,
  -- Gate 2 at a 2-tick target. % of minutes where offer - bid >= 2 fils.
  gap_pct                 numeric,
  -- Gate 8. today's volume / mean of the previous 5 sessions' volume.
  volume_ratio_5d         numeric,
  -- Gate 9 / Gate 10 flags. Previous 5 SESSIONS, today excluded.
  days_active_5d          int,
  down_days_5d            int,
  -- Gate 10. close - close 5 sessions ago, in fils.
  change_5d_fils          numeric,
  minutes_measured        int,
  budget_kd               numeric     NOT NULL,   -- the slot the size gates used
  shares_at_budget        bigint,
  source                  text        NOT NULL DEFAULT 'BACKEND_BRIDGE',
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, trading_day)
);

COMMENT ON TABLE spread.symbol_day_stats IS
  'BRIDGE. Gate statistics public.symbol_day declares but leaves NULL, computed '
  'by the backend from spread.v_quote_screening (npm run stats:daily). Read only '
  'through spread.symbol_day, which prefers the scraper''s value when present. '
  'Drop this table when public.symbol_day.pct_postable stops being NULL.';

-- ---------------------------------------------------------------------------
-- The view. Every 011 column kept; the funnel's names added.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spread.symbol_day CASCADE;

CREATE VIEW spread.symbol_day AS
SELECT
  p.symbol,
  p.trading_date            AS trading_day,
  p.open_px                 AS open_fils,
  p.high_px                 AS high_fils,
  p.low_px                  AS low_fils,
  p.close_px                AS close_fils,
  p.prev_close              AS prev_close_fils,
  p.chg_fils                AS change_fils,
  p.day_range               AS range_trading_fils,
  p.total_volume            AS volume_shares,
  p.trades                  AS trade_count,
  p.avg_trade_size          AS avg_trade_shares,
  p.moves                   AS price_moves,
  p.up_moves                AS price_moves_up,
  p.down_moves              AS price_moves_down,
  p.up_moves_tiny           AS tiny_move_count,
  p.tiny_pct_up             AS pct_moves_sub,
  p.bought_at_offer         AS shares_at_offer,
  p.sold_at_bid             AS shares_at_bid,
  p.trades_at_offer         AS events_at_offer,
  p.trades_at_bid           AS events_at_bid,
  p.buy_sell_ratio          AS flow_ratio,
  p.minutes_captured        AS ticks_captured,
  p.coverage_pct            AS capture_pct,
  p.data_quality            AS capture_quality,
  p.turnover_kd,
  p.avg_spread_fils,
  p.avg_spread_pct,
  p.days_active,
  p.down_days,
  p.peak_hour,
  p.first_half_shares_per_min  AS am_shares_per_min,
  p.second_half_shares_per_min AS pm_shares_per_min,
  p.close_source, p.range_source, p.prev_session_used, p.prev_session_gap_days,
  p.tick_band_crossed, p.source, p.family,
  p.avg_uptick_shares, p.avg_downtick_shares, p.uptick_ratio, p.n_upticks, p.n_downticks,
  p.markup, p.resumed, p.lift, p.hit,
  p.chg_1d, p.chg_5d, p.up_moves_2plus, p.up_moves_3plus, p.pct_at_offer, p.computed_at,

  -- ── the funnel's names ───────────────────────────────────────────────────
  -- Confirmed aliases (same meaning, different name):
  p.up_moves_2plus          AS price_moves_2plus,
  p.tiny_pct_up             AS pct_moves_sub100,
  p.chg_fils                AS change_1d_fils,
  p.block_ratio,

  -- Scraper first, bridge second. NULL when neither has it — and the funnel
  -- treats NULL as a failure, which is the loud outcome we want.
  COALESCE(p.pct_postable,       s.pct_postable)         AS pct_session_postable_800,
  COALESCE(p.pct_exitable,       s.pct_exitable_ratio)   AS pct_session_exitable_ratio,
  s.pct_exitable_size                                    AS pct_session_exitable_size_800,
  COALESCE(p.exitable_best_hour, s.exitable_best_hour_pct) AS exitable_best_hour_pct,
  COALESCE(p.bid_p25,            s.bid_kd_p25)           AS bid_kd_p25,
  COALESCE(p.bid_p50,            s.bid_kd_p50)           AS bid_kd_p50,
  COALESCE(p.vol_ratio_5d,       s.volume_ratio_5d)      AS volume_ratio_5d,
  s.gap_pct,
  s.days_active_5d,
  s.down_days_5d,
  s.change_5d_fils,
  s.budget_kd                                            AS stats_budget_kd,
  s.computed_at                                          AS stats_computed_at,
  CASE WHEN p.pct_postable IS NOT NULL THEN 'SCRAPER'
       WHEN s.symbol IS NOT NULL       THEN 'BACKEND_BRIDGE'
       ELSE NULL END                                     AS gate_stats_source
FROM public.symbol_day p
LEFT JOIN spread.symbol_day_stats s
       ON s.symbol = p.symbol AND s.trading_day = p.trading_date;

COMMENT ON VIEW spread.symbol_day IS
  'public.symbol_day (the scraper''s per-session statistics) under the names '
  'lib/funnel.js reads, joined to spread.symbol_day_stats for the gate columns '
  'the scraper leaves NULL. gate_stats_source says which side answered. '
  'chg_1d/chg_5d are PERCENT and are NOT used by any gate; change_1d_fils and '
  'change_5d_fils are fils.';

COMMENT ON COLUMN spread.symbol_day.pct_moves_sub100 IS
  'Gate 5. From the scraper''s tiny_pct_up: percent of UP-moves caused by '
  'prints of 100 shares or fewer. 003 measured moves in EITHER direction; the '
  'scraper''s own comment records that the blended figure halves it (ARABREC '
  '12 blended, 24 up-only), so this is the STRICTER measure and the 20% '
  'threshold is applied to it unchanged.';

-- ---------------------------------------------------------------------------
-- kb_threshold: 013 created it empty and shipped no seed.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.kb_threshold') IS NOT NULL THEN
    INSERT INTO spread.kb_threshold
      (key, value, unit, source_cr, note, prev_value, changed_on, changed_by, still_true)
    SELECT key, value, unit, source_cr, note, prev_value, changed_on, changed_by, still_true
      FROM public.kb_threshold
    ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- The eight keys sizing.js refuses to run without, so a database with no
-- public.kb_threshold (a *_test database, a fresh host) still sizes. Values are
-- the 2 September kse rows; sql/kb_seed.sql carries all thirty.
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('commission_rate',      0.0015, 'rate',    'schedule', 'changes 1 October',                     true),
  ('commission_min_kd',    0.5,    'KD',      'schedule', 'changes 1 October',                     true),
  ('my_pct_min',           5,      'percent', 'CR-48',    'below this you are invisible in the queue', true),
  ('my_pct_max',           30,     'percent', 'CR-48',    'above this you ARE the level',          true),
  ('exit_depth_max_x',     3,      'x',       'CR-54',    'offer_qty as a multiple of your size',  true),
  ('reserve_pct',          25,     'percent', 'CR-39',    'held back until 11:00',                 true),
  ('reserve_release_hhmm', 1100,   'hhmm',    'CR-39',    NULL,                                    true),
  ('tick_min_price',       100,    'fils',    'CR-48',    'below 100 fils the tick is 0.1',        true)
ON CONFLICT (key) DO NOTHING;
