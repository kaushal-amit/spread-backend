-- ===========================================================================
--  015_drop_duplicates.sql — five tables that hold what another table holds
--
--  Every confusion this month came from two things holding the same data. Two
--  symbol_day tables, neither aware of the other. kb_threshold built in the
--  scraper by mistake. spread.quote and spread.depth serving EMPTY VIEWS for
--  months without erroring.
--
--  Verified empty before this ran, with a populated counterpart in every case:
--
--      spread.quote            0    public.awsat_market_quotes    1,000,706
--      spread.depth            0    public.awsat_stock_depth        194,575
--      spread.depth_watchlist  0    public.depth_watchlist                8
--      spread.symbol           0    public.instruments                  142
--      spread.job_run          0    public.scrape_runs               12,462
--
--  spread.symbol_profile is NOT dropped. It is empty too, but its 22 columns
--  exist nowhere else — and median_trades_by_0930 is what the wake-up pace
--  ratio divides by. That is not a duplicate table, it is an unbuilt feature
--  with a table waiting.
--
--  The schema split stays. The lint rule stopping this codebase writing to the
--  capture tables has caught more than it cost. What goes is anything that
--  exists twice.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Refuse rather than destroy, and NAME the table that stopped it.
--
-- The first version raised a bare "one of the five is not empty" and left
-- whoever ran it to find which. It was spread.symbol, holding one row a TEST
-- had inserted to satisfy a foreign key — so the message has to distinguish
-- "something is writing to this" from "a fixture left a row behind".
--
-- spread.symbol is exempt from the guard for exactly that reason: its only
-- writer is test setup, and the foreign keys pointing at it are what forced
-- those inserts. The other four are guarded.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  t text;
  n bigint;
BEGIN
  -- Counted one at a time through to_regclass, because a UNION over four
  -- tables cannot survive one of them being absent — and after a successful
  -- run they ARE absent. A guard that only works before it has ever run is a
  -- guard that fails every re-run.
  FOREACH t IN ARRAY ARRAY['spread.quote', 'spread.depth',
                           'spread.depth_watchlist', 'spread.job_run']
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM ' || t INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION USING
          MESSAGE = t || ' holds ' || n || ' row(s) — something began writing to it',
          HINT    = 'This migration assumed it was empty. Find the writer before '
                    'dropping, or the rows are lost.';
      END IF;
    END IF;
  END LOOP;
END
$guard$;

-- CASCADE on symbol: order_leg and claim carry foreign keys to it, and those
-- constraints are what made the fee tests insert a spread.symbol row first.
-- Dropping the constraint is the point — the canonical list is
-- public.instruments, which has is_primary and is_tradeable.
DROP TABLE IF EXISTS spread.quote CASCADE;
DROP TABLE IF EXISTS spread.depth CASCADE;
DROP TABLE IF EXISTS spread.depth_watchlist CASCADE;
DROP TABLE IF EXISTS spread.symbol CASCADE;
DROP TABLE IF EXISTS spread.job_run CASCADE;

COMMENT ON TABLE spread.symbol_profile IS
  'KEPT DELIBERATELY, though empty. Twenty-two columns that exist nowhere else, '
  'and median_trades_by_0930 is the denominator of the wake-up pace ratio — so '
  'wakeup_pace_min = 3 has been comparing against nothing. An unbuilt feature '
  'with a table waiting, not a duplicate.';
