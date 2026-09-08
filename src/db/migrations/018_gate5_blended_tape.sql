-- ===========================================================================
--  018 · Gate 5 reads the statistic its threshold was calibrated on
-- ===========================================================================
--  016 aliased the scraper's tiny_pct_up to pct_moves_sub100. Measured against
--  the minute quotes for 1 September, that column is EXACTLY
--
--      up-moves whose last_qty <= 100  /  up-moves            (ABAR 31.5 vs 30.9)
--
--  while 003's pct_moves_sub100 — the figure the 20% threshold was set against —
--  was
--
--      moves in EITHER direction whose last_qty <= 100  /  all moves   (ABAR 17.7)
--
--  Same print-size measure (last_qty, the last single trade in the minute; NOT
--  volume differencing, which gives 0-46% and is a third statistic). Different
--  direction filter, and the up-only figure runs roughly twice the blended one
--  on every symbol checked. Applying 20% to it failed 98 of 140 symbols on Gate 5.
--
--  The scraper has no blended column, so it joins the bridge (the same SQL is
--  in scripts/scraper-symbol-day-stats.sql for the scraper to adopt). Gate 5
--  reads the blended figure; the up-only figure stays visible under its own
--  name because it IS informative — it is just not the gate's input.
-- ===========================================================================

ALTER TABLE spread.symbol_day_stats
  ADD COLUMN IF NOT EXISTS pct_moves_sub100 numeric;

COMMENT ON COLUMN spread.symbol_day_stats.pct_moves_sub100 IS
  'Gate 5. Percent of price moves (either direction) caused by a print of 100 '
  'shares or fewer, print size = last_qty. The 003 definition the 20% threshold '
  'was calibrated on.';

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
  p.up_moves_2plus          AS price_moves_2plus,
  p.chg_fils                AS change_1d_fils,
  p.block_ratio,
  -- Gate 5: the BLENDED figure (bridge), not the scraper's up-only one.
  s.pct_moves_sub100,
  p.tiny_pct_up             AS pct_moves_sub100_up,

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
  'the scraper leaves NULL or defines differently. gate_stats_source says which '
  'side answered. chg_1d/chg_5d are PERCENT and are NOT used by any gate.';

COMMENT ON COLUMN spread.symbol_day.pct_moves_sub100 IS
  'Gate 5. Percent of price moves in EITHER direction from prints of <=100 '
  'shares (last_qty). From the bridge. The scraper''s up-only figure is '
  'pct_moves_sub100_up and runs about twice this.';
