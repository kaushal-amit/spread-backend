-- ===========================================================================
--  038_v_depth_day_key.sql — v_depth can be filtered by day WITHOUT reading a
--  symbol's whole history
--
--  v_depth is DISTINCT ON (symbol, level, captured_at). A qualifier on a
--  column that is not in the DISTINCT ON key cannot be pushed below the
--  DISTINCT, so `WHERE symbol = $1 AND trading_date = $2` read and de-duplicated
--  every capture the symbol ever had (EXPLAIN: a full walk of
--  awsat_depth_symbol_idx) and only then dropped the other days. The ladder,
--  the bid-age check and the halt scanner all go through this view, several
--  times a minute.
--
--  trading_date is functionally dependent on captured_at (one capture, one
--  session day), so adding it to the DISTINCT ON key changes NO row of the
--  result — it only lets the planner apply the day filter first, against
--  awsat_depth_date_idx (trading_date, symbol).
-- ===========================================================================
DROP VIEW IF EXISTS spread.v_depth CASCADE;
CREATE VIEW spread.v_depth AS
SELECT DISTINCT ON (symbol, trading_date, level, captured_at) *
  FROM public.awsat_stock_depth
 ORDER BY symbol, trading_date, level, captured_at,
          -- Server rows win a tie only because the choice must be deterministic;
          -- the two sources carry the same book.
          ingest_source;
COMMENT ON VIEW spread.v_depth IS
  'public.awsat_stock_depth, one row per (symbol, level, captured_at) — trading_date in the key so a day filter is applied before the DISTINCT (038)';
