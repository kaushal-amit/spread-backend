-- ===========================================================================
--  scraper-symbol-day-stats.sql — for kse-scraper's daily.symbolday
-- ===========================================================================
--  public.symbol_day declares pct_postable, pct_exitable, bid_p25, spread_fils_p50,
--  vol_ratio_5d and exitable_best_hour and leaves them NULL on every row. This
--  is the statement that fills them, written against awsat_market_quotes, so
--  the scraper can adopt it verbatim and the backend's bridge table
--  (spread.symbol_day_stats, src/jobs/stats) becomes redundant.
--
--  Definitions (the backend's gates read exactly these):
--    pct_postable        % of captured minutes where the touch-bid depth in KD
--                        sits inside [budget/0.30, budget/0.05] — an order of
--                        :budget KD would be 5-30% of the level. BUDGET-DEPENDENT;
--                        :budget_kd is the slot size (790 today).
--    pct_exitable        % of minutes where offer notional <= 2 x bid notional.
--    bid_p25 / bid_p50   percentiles of touch-bid depth in KD. Budget-independent.
--    spread_fils_p50     median (offer - bid) in fils.
--    vol_ratio_5d        today's volume / mean volume of the previous 5 sessions.
--    exitable_best_hour  the best single hour's pct_exitable (hours with >= 10 minutes).
--    tiny_pct            NEW COLUMN, please: % of price moves in EITHER direction
--                        whose last_qty <= 100. tiny_pct_up (up-only) is what you
--                        have; Gate 5's 20% threshold was calibrated on the
--                        blended figure, which runs about half of it.
--
--  Ran read-only on kse, 2 September 2026: 134 symbols, 236 minutes each.
--  Parameters: :day (date), :budget_kd (numeric).
-- ===========================================================================
WITH t AS (
  SELECT symbol, created_at,
         bid::numeric AS bid, bid_qty::bigint AS bid_shares,
         offer::numeric AS ofr, offer_qty::bigint AS offer_shares,
         volume::bigint AS vol, last_qty::bigint AS lq, last_price::numeric AS px,
         lag(last_price::numeric) OVER (PARTITION BY symbol ORDER BY created_at) AS prev_px
    FROM public.awsat_market_quotes
   WHERE trading_date = :day
     AND session IN ('Trading', 'CB Auction', '')
     AND bid > 0 AND offer > 0
), m AS (
  SELECT symbol,
         round(100.0 * count(*) FILTER (WHERE bid_shares * bid / 1000 BETWEEN :budget_kd / 0.30 AND :budget_kd / 0.05)
               / NULLIF(count(*), 0), 1)                                                   AS pct_postable,
         round(100.0 * count(*) FILTER (WHERE offer_shares * ofr <= 2 * bid_shares * bid)
               / NULLIF(count(*), 0), 1)                                                   AS pct_exitable,
         round(percentile_cont(0.25) WITHIN GROUP (ORDER BY bid_shares * bid / 1000)::numeric, 2) AS bid_p25,
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY bid_shares * bid / 1000)::numeric, 2) AS bid_p50,
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY ofr - bid)::numeric, 2)          AS spread_fils_p50,
         max(vol)                                                                          AS day_volume,
         round(100.0 * count(*) FILTER (WHERE px <> prev_px AND lq BETWEEN 1 AND 100)
               / NULLIF(count(*) FILTER (WHERE px <> prev_px), 0), 1)                      AS tiny_pct
    FROM t GROUP BY symbol
), best_hour AS (
  SELECT symbol, max(pct) AS exitable_best_hour
    FROM (SELECT symbol, EXTRACT(hour FROM created_at AT TIME ZONE 'Asia/Kuwait') AS hr,
                 100.0 * count(*) FILTER (WHERE offer_shares * ofr <= 2 * bid_shares * bid) / NULLIF(count(*), 0) AS pct
            FROM t GROUP BY symbol, hr HAVING count(*) >= 10) h
   GROUP BY symbol
), sessions AS (
  SELECT trading_date FROM public.symbol_day WHERE trading_date < :day
   GROUP BY trading_date ORDER BY trading_date DESC LIMIT 5
), hist AS (
  SELECT d.symbol, avg(d.total_volume) AS base_volume
    FROM public.symbol_day d JOIN sessions s ON s.trading_date = d.trading_date
   GROUP BY d.symbol
)
UPDATE public.symbol_day sd
   SET pct_postable       = m.pct_postable,
       pct_exitable       = m.pct_exitable,
       bid_p25            = m.bid_p25,
       bid_p50            = m.bid_p50,
       spread_fils_p50    = m.spread_fils_p50,
       exitable_best_hour = round(b.exitable_best_hour::numeric, 1),
       -- tiny_pct           = m.tiny_pct,      -- once the column exists
       vol_ratio_5d       = CASE WHEN h.base_volume > 0 THEN round(m.day_volume / h.base_volume, 3) END
  FROM m
  LEFT JOIN best_hour b USING (symbol)
  LEFT JOIN hist h USING (symbol)
 WHERE sd.symbol = m.symbol AND sd.trading_date = :day;
