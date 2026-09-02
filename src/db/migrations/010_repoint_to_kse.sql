-- ===========================================================================
--  010_repoint_to_kse.sql — point the source views at the tables that exist
--
--  ─── WHY THIS HAS NEVER RUN ────────────────────────────────────────────────
--  Every view in 002 reads public.stock_quotes and public.stock_depth. The kse
--  database renamed those to awsat_market_quotes and awsat_stock_depth in
--  migration 002 of the scraper, back in the first session. There is not one
--  reference to the current names anywhere in this codebase, so these views
--  have only ever resolved against the OLD `trading` database.
--
--  Three tables, not two: stock_daily is now tradingview_history.
--
--  Four changes here, and the last three are not renames.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · v_quote — executable prints, for close, volume and trade count.
--
-- ADDS Closing and CB Auction, which 002 omitted.
--
--   Closing      539 rows, 518 priced. TIJARA's 9 August close of 159 is here
--                and in Close-Of-Day; Close Auction Acceptance read 167 and was
--                the outlier.
--   CB Auction   581 rows, all priced, 26.8M shares. Real trading after a
--                circuit breaker — CATTL's 24 August low of 217 was set in one.
--
-- The blank label is included too: 12,550 rows, 09:00-12:59, continuous trading
-- whose session field was not captured in July. A capture defect, not an
-- exchange state.
-- ---------------------------------------------------------------------------
-- DROP first: CREATE OR REPLACE cannot change a view's column list, and
-- awsat_market_quotes has a different shape from the stock_quotes these views
-- were written against.
DROP VIEW IF EXISTS spread.v_quote CASCADE;
CREATE VIEW spread.v_quote AS
SELECT * FROM public.awsat_market_quotes
 WHERE session IN ('Trading', 'Trading at Last', 'Closing', 'Close-Of-Day',
                   'CB Auction', '');

COMMENT ON VIEW spread.v_quote IS
  'Executable prints. Trading at Last carries 16% of daily volume and the final '
  'print lives in Close-Of-Day. Close Auction Acceptance is EXCLUDED: +/-5% band '
  'prices only.';

-- ---------------------------------------------------------------------------
-- 2 · v_quote_screening — the range, and every gate.
--
-- 002 had this as Trading only, which was right about the closing auction and
-- wrong about two other things: it dropped CB Auction, which IS executable, and
-- all 12,550 blank-labelled rows, which would leave ten July days screening on
-- a fraction of their captures.
--
-- The TIJARA argument in 002 stands and is the reason this view exists: one
-- auction print of 849,788 shares eight fils below the 12:59 price turned a
-- 3-fil range into 9.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spread.v_quote_screening CASCADE;
CREATE VIEW spread.v_quote_screening AS
SELECT * FROM public.awsat_market_quotes
 WHERE session IN ('Trading', 'CB Auction', '');

COMMENT ON VIEW spread.v_quote_screening IS
  'The tradeable session: continuous trading plus circuit-breaker auctions. Use '
  'for high, low, range and EVERY GATE. Everything from 13:00 clears at one '
  'price, so feeding it into a range measures the auction, not the session.';

-- ---------------------------------------------------------------------------
-- 3 · v_depth — DISTINCT ON, and this is not a rename.
--
-- The depth key in kse is (symbol, level, captured_at, ingest_source), and
-- ingest_source is IN it — so one symbol/level/instant can legitimately appear
-- twice, once from awsat_server and once from awsat_client. Both writers exist.
--
-- A plain SELECT * would return each level twice whenever both run, and a job
-- counting snapshots would DOUBLE-COUNT rather than error. CR-34 needs 100+
-- snapshots and would reach that on fifty real ones — the silent kind of wrong.
--
-- Zero collisions today because the client has only posted twice. It becomes
-- real the moment both run at once, which is what a debugging session does.
--
-- captured_at, not created_at: ten levels of one book share a capture instant
-- and that is what groups a snapshot. created_at is insert time.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spread.v_depth CASCADE;
CREATE VIEW spread.v_depth AS
SELECT DISTINCT ON (symbol, level, captured_at) *
  FROM public.awsat_stock_depth
 ORDER BY symbol, level, captured_at,
          -- Server rows win a tie only because the choice must be deterministic;
          -- the two sources carry the same book.
          ingest_source;

COMMENT ON VIEW spread.v_depth IS
  'Order book depth, ONE ROW PER (symbol, level, captured_at). The underlying '
  'key includes ingest_source, so the same level can appear twice when the '
  'server and client both write — a job counting snapshots would double-count '
  'silently.';

-- ---------------------------------------------------------------------------
-- 4 · v_daily — stock_daily is tradingview_history in kse.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS spread.v_daily CASCADE;
CREATE VIEW spread.v_daily AS
SELECT * FROM public.tradingview_history;

COMMENT ON VIEW spread.v_daily IS
  'TradingView daily history. Was public.stock_daily in the old trading '
  'database.';
