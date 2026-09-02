-- 002 · Source data — tables if we own them, views if we do not
--
-- THE PROBLEM THIS SOLVES.
--
-- `public.stock_quotes` is written by the scrapers, which live outside this
-- repository. Whether it EXISTS depends on which database this runs against:
--
--   the existing database   public.stock_quotes is there, written by the
--                           scrapers. We read it and never write to it.
--
--   a NEW database          nothing is there. The new project has to own the
--                           source tables, and the scrapers get repointed.
--
-- Both are legitimate deployments and the migration must not care. So the
-- tables are created in `spread` when `public` has nothing, and the views
-- resolve to whichever exists.
--
-- The alternative — assuming one shape — is what produced the error this
-- replaces: `relation "public.stock_quotes" does not exist`.

DO $$
DECLARE
  has_public_quotes boolean;
  has_public_depth  boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = 'awsat_market_quotes')
    INTO has_public_quotes;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = 'awsat_stock_depth')
    INTO has_public_depth;

  -- ---------------------------------------------------------------------
  -- QUOTES
  -- ---------------------------------------------------------------------
  /**
   * ─── A MISSING SOURCE IS A MISCONFIGURATION, NOT A FALLBACK ──────────────
   *
   * The ELSE arm used to create empty spread.quote and spread.depth tables and
   * point the views at them. Nothing ever wrote to those tables, so the views
   * returned zero rows — and the whole suite passed, because not one of its
   * 256 checks asserted that a view returns anything.
   *
   * Worse, the detection named public.stock_quotes: the PRE-RENAME table. On
   * kse that does not exist, so this branch was never taken and the backend
   * silently served empty views against a database full of data.
   *
   * A deploy against a database without the source tables should refuse to
   * start, not serve zeros. That is what would have caught this months ago.
   */
  IF NOT has_public_quotes THEN
    RAISE EXCEPTION USING
      MESSAGE = 'public.awsat_market_quotes does not exist in this database',
      DETAIL  = 'spread-backend reads the scraper''s tables and never writes them. '
                'Without them every view is empty and every endpoint returns zeros.',
      HINT    = 'Point DATABASE_URL at the database the scraper writes to (kse), '
                'or run the scraper''s migrations there first.';
  END IF;

  IF NOT has_public_depth THEN
    RAISE EXCEPTION USING
      MESSAGE = 'public.awsat_stock_depth does not exist in this database',
      HINT    = 'Same cause as awsat_market_quotes — check DATABASE_URL.';
  END IF;

  IF has_public_quotes THEN
    RAISE NOTICE 'public.awsat_market_quotes found — reading it, never writing to it';

    EXECUTE $v$
      CREATE OR REPLACE VIEW spread.v_quote AS
      SELECT * FROM public.awsat_market_quotes
       WHERE session IN ('Trading', 'Trading at Last', 'Close-Of-Day') $v$;

    EXECUTE $v$
      CREATE OR REPLACE VIEW spread.v_quote_screening AS
      SELECT * FROM public.awsat_market_quotes
       WHERE session = 'Trading' $v$;

  ELSE
    RAISE NOTICE 'public.awsat_market_quotes NOT found — this database owns the source tables. '
                 'Repoint the scrapers at spread.quote.';

    -- The scraper's shape, named by our rules. `last_qty` is ONE trade and is
    -- populated on every row; Gate 5 previously inferred size from volume
    -- differencing, which is every trade in the minute.
    CREATE TABLE IF NOT EXISTS spread.quote (
      id            bigserial PRIMARY KEY,
      symbol        text NOT NULL,
      market        text,
      -- FOUR VALUES, ONE NON-EXECUTABLE:
      --   Trading                   09:00-12:59  executable
      --   Close Auction Acceptance  13:00-13:09  NO — band prices only
      --   Trading at Last           13:10-13:14  executable, 16% of volume
      --   Close-Of-Day              13:15-13:25  executable, the final print
      session       text,
      last_price    numeric,
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

    EXECUTE $v$
      CREATE OR REPLACE VIEW spread.v_quote AS
      SELECT * FROM spread.quote
       WHERE session IN ('Trading', 'Trading at Last', 'Close-Of-Day') $v$;

    EXECUTE $v$
      CREATE OR REPLACE VIEW spread.v_quote_screening AS
      SELECT * FROM spread.quote
       WHERE session = 'Trading' $v$;
  END IF;

  -- ---------------------------------------------------------------------
  -- DEPTH
  -- ---------------------------------------------------------------------
  IF has_public_depth THEN
    EXECUTE 'CREATE OR REPLACE VIEW spread.v_depth AS SELECT * FROM public.awsat_stock_depth';
  ELSE
    /*
     * THE SHAPE HERE IS A GUESS AND IT WAS WRONG ONCE.
     *
     * `public.stock_depth` does not have `bid`/`offer` columns — the export
     * failed with `column "bid" does not exist`. Run scripts/inspect-depth.sql
     * against the old database and align this before importing.
     *
     * The columns below are what CR-34 READS. Whatever the scraper calls them,
     * the import must map onto these four, because the signal is
     *
     *     BUY      bid_qty > deep   AND  offer_qty < thin
     *     SELL     bid_qty < thin
     *     BLOCKED  offer_qty > wall
     *
     * A column that does not map is a silent NULL, not an error, and the
     * signal then reads WAIT forever without saying why.
     */
    CREATE TABLE IF NOT EXISTS spread.depth (
      id            bigserial PRIMARY KEY,
      symbol        text NOT NULL,
      level         int  NOT NULL DEFAULT 1,
      bid           numeric,
      bid_qty       bigint,
      offer         numeric,
      offer_qty     bigint,
      created_at    timestamptz NOT NULL DEFAULT now(),
      -- Anything the source carries that does not map. Keeps the import
      -- lossless while the shape is being confirmed.
      raw           jsonb
    );
    -- One book per symbol per level per capture.
    CREATE UNIQUE INDEX IF NOT EXISTS depth_unique_idx
      ON spread.depth (symbol, level, created_at);
    CREATE INDEX IF NOT EXISTS depth_symbol_time_idx
      ON spread.depth (symbol, created_at DESC);

    EXECUTE 'CREATE OR REPLACE VIEW spread.v_depth AS SELECT * FROM spread.depth';
  END IF;

  -- ---------------------------------------------------------------------
  -- BROKER ORDER SNAPSHOTS
  -- ---------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = 'order_list_snapshots') THEN
    CREATE TABLE IF NOT EXISTS spread.broker_order_snapshot (
      id            bigserial PRIMARY KEY,
      symbol        text,
      -- The broker's own net, commission INCLUDED. No model involved, which is
      -- why it is the reconciliation anchor for the per-execution fee.
      net_value_kd  numeric,
      raw           jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS broker_snapshot_time_idx
      ON spread.broker_order_snapshot (created_at DESC);
  END IF;
END $$;

COMMENT ON VIEW spread.v_quote IS
  'Executable prints. Use for close, volume and trade count — Trading at Last '
  'carries 16% of daily volume and the final print lives in Close-Of-Day.';

COMMENT ON VIEW spread.v_quote_screening IS
  'The continuous session only. Use for high, low, range and EVERY GATE. '
  'One auction print of 849,788 shares clearing 8 fils below the 12:59 price '
  'made a 2-fil range look like 9.';

COMMENT ON VIEW spread.v_depth IS
  'Order book depth. CR-34 depends entirely on this. A direction claim needs '
  '100+ snapshots — a nine-minute reading gave the opposite sign.';
