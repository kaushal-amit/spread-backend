-- 007 · Create the source tables unconditionally
--
-- WHAT WENT WRONG IN 002.
--
-- 002 branched on whether `public.awsat_market_quotes` exists and created
-- `spread.quote` only in the ELSE arm. It reported success and the table was
-- not there, so the import failed with
--
--   ERROR: relation "spread.quote" does not exist
--
-- The branch is the fragile part: a DO block that reports NOTICE rather than
-- failing gives no signal when it takes the arm you did not expect, and
-- `IF NOT EXISTS` inside it hides the difference between "already there" and
-- "never created".
--
-- SO THE BRANCH IS REMOVED FROM TABLE CREATION. The tables are created ALWAYS.
-- An empty table costs nothing, and the views — which are cheap to redefine —
-- carry the only decision left: read `public` when it has data, otherwise read
-- ours.
--
-- 002 stays applied and untouched. Editing an applied migration reports drift,
-- which is correct: the database and the repository would disagree.

-- ---------------------------------------------------------------------------
-- The tables. Always, on every database.
-- ---------------------------------------------------------------------------
-- ─── THESE TABLES ARE NEVER WRITTEN ────────────────────────────────────────
--
-- Nothing in the codebase inserts into spread.quote or spread.depth. They were
-- a fallback for a deployment without the scraper's tables, and 002 now REFUSES
-- such a deployment rather than serving empty views over these.
--
-- Left in place because dropping a table another migration created is churn,
-- and an empty table nothing reads costs nothing. But do not add a reader:
-- a copy of public.awsat_market_quotes in spread.* would be a second source of
-- truth for the same rows, which is what the schema boundary exists to prevent.
CREATE TABLE IF NOT EXISTS spread.quote (
  id            bigserial PRIMARY KEY,
  symbol        text NOT NULL,
  market        text,
  -- FOUR VALUES, ONE NON-EXECUTABLE:
  --   Trading                   09:00-12:59  executable
  --   Close Auction Acceptance  13:00-13:09  NO — band prices only
  --   Trading at Last           13:10-13:14  executable, 16% of daily volume
  --   Close-Of-Day              13:15-13:25  executable, the final print
  session       text,
  last_price    numeric,
  -- ONE trade, populated on every row. Gate 5 previously inferred size from
  -- volume differencing, which is every trade in the minute — the two agreed
  -- on 39 of 123 minutes, exactly those where a single trade occurred.
  last_qty      bigint,
  bid           numeric,
  bid_qty       bigint,
  offer         numeric,
  offer_qty     bigint,
  trades        bigint,
  volume        bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_symbol_time_idx ON spread.quote (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS quote_time_idx        ON spread.quote (created_at);
CREATE INDEX IF NOT EXISTS quote_session_idx     ON spread.quote (session);

-- ---------------------------------------------------------------------------
-- Depth.
--
-- THE COLUMN NAMES BELOW ARE WHAT CR-34 READS, not necessarily what the
-- scraper calls them — `public.awsat_stock_depth` has no `bid` column and the export
-- failed on it.
--
-- Whatever the source shape turns out to be, the import must map onto
-- bid_qty and offer_qty, because the signal is:
--
--     BUY      bid_qty > deep   AND  offer_qty < thin
--     SELL     bid_qty < thin
--     BLOCKED  offer_qty > wall
--
-- A column that does not map is a SILENT NULL, not an error. The signal then
-- reads WAIT forever without saying why. `raw` keeps the import lossless while
-- the mapping is confirmed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.depth (
  id            bigserial PRIMARY KEY,
  symbol        text NOT NULL,
  level         int  NOT NULL DEFAULT 1,
  bid           numeric,
  bid_qty       bigint,
  offer         numeric,
  offer_qty     bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  raw           jsonb
);

CREATE INDEX IF NOT EXISTS depth_symbol_time_idx ON spread.depth (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS spread.broker_order_snapshot (
  id            bigserial PRIMARY KEY,
  symbol        text,
  -- The broker's own net, commission INCLUDED and no model involved. This is
  -- the anchor for charged-versus-expected reconciliation, and it is what
  -- proved the settlement fee is charged per EXECUTION.
  net_value_kd  numeric,
  raw           jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_snapshot_time_idx
  ON spread.broker_order_snapshot (created_at DESC);

-- ---------------------------------------------------------------------------
-- The views. The only decision left, and it is made on DATA rather than on
-- existence — an empty public.awsat_market_quotes should not win over a populated
-- spread.quote.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  public_rows bigint := 0;
  src text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'stock_quotes') THEN
    EXECUTE 'SELECT count(*) FROM public.awsat_market_quotes' INTO public_rows;
  END IF;

  src := CASE WHEN public_rows > 0 THEN 'public.awsat_market_quotes' ELSE 'spread.quote' END;

  EXECUTE format(
    'DROP VIEW IF EXISTS spread.v_quote; CREATE VIEW spread.v_quote AS SELECT * FROM %s ' ||
    'WHERE session IN (''Trading'', ''Trading at Last'', ''Close-Of-Day'')', src);

  EXECUTE format(
    'DROP VIEW IF EXISTS spread.v_quote_screening; CREATE VIEW spread.v_quote_screening AS SELECT * FROM %s ' ||
    'WHERE session = ''Trading''', src);

  RAISE NOTICE 'spread.v_quote reads %  (public.awsat_market_quotes has % rows)', src, public_rows;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'stock_depth') THEN
    EXECUTE 'DROP VIEW IF EXISTS spread.v_depth';
    EXECUTE 'CREATE VIEW spread.v_depth AS SELECT * FROM public.awsat_stock_depth';
  ELSE
    EXECUTE 'DROP VIEW IF EXISTS spread.v_depth';
    EXECUTE 'CREATE VIEW spread.v_depth AS SELECT * FROM spread.depth';
  END IF;
END $$;

COMMENT ON TABLE spread.quote IS
  'Quote captures. Created on every database whether or not public.awsat_market_quotes '
  'exists — the views decide which is read, based on which has DATA.';

COMMENT ON COLUMN spread.depth.bid_qty IS
  'CR-34 reads this. If the import leaves it NULL the signal reads WAIT forever '
  'without saying why, which is why doctor counts rows WITH quantities.';
