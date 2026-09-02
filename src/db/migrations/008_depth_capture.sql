-- 008 · Depth — capture identity and the real timestamp
--
-- TWO THINGS THE SOURCE DATA CORRECTED.
--
-- 1 · A ROW IS NOT A SNAPSHOT.
--
--    The scraper writes TEN LEVELS per capture, sharing one scrape_batch_id.
--    52,057 rows are 5,208 actual book captures.
--
--    CR-34 refuses a direction claim below 100 snapshots, and `depth.js`
--    counted ROWS. That overstates the sample TENFOLD: a symbol with 100 rows
--    has 10 real captures, and would have passed the check that exists
--    precisely because five observations once inverted the sign.
--
-- 2 · captured_at IS NOT created_at.
--
--    captured_at is when the book looked like that. created_at is when the row
--    was written, ~0.3s later. For a signal about what the book was doing, the
--    first is the truth and the second is an artefact of the writer.

ALTER TABLE spread.depth
  -- Groups the ten levels of one capture. THE UNIT OF A SNAPSHOT.
  ADD COLUMN IF NOT EXISTS capture_id   text,
  -- When the BOOK looked like this, not when the row was written.
  ADD COLUMN IF NOT EXISTS captured_at  timestamptz,
  -- The scraper already derives the session day. Trusting it beats deriving it
  -- again from a timestamp in a different timezone.
  ADD COLUMN IF NOT EXISTS trading_day  date,
  ADD COLUMN IF NOT EXISTS market_code  text;

CREATE INDEX IF NOT EXISTS depth_capture_idx
  ON spread.depth (symbol, trading_day, capture_id);
CREATE INDEX IF NOT EXISTS depth_captured_idx
  ON spread.depth (symbol, captured_at DESC);

-- One row per symbol, level and capture. A re-import cannot double the sample.
CREATE UNIQUE INDEX IF NOT EXISTS depth_unique_capture_idx
  ON spread.depth (symbol, capture_id, level)
  WHERE capture_id IS NOT NULL;

COMMENT ON COLUMN spread.depth.capture_id IS
  'One book capture across all ten levels. COUNT DISTINCT ON THIS, never rows — '
  '52,057 rows are 5,208 captures, and counting rows overstates the CR-34 sample '
  'tenfold.';

COMMENT ON COLUMN spread.depth.captured_at IS
  'When the BOOK looked like this. created_at is when the row was written, about '
  '0.3s later. A signal about the book uses this one.';

-- ---------------------------------------------------------------------------
-- Level 1 is the top of book — what CR-34 reads. The deeper levels are the
-- ladder that has been missing from every screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW spread.v_depth_top AS
SELECT symbol, capture_id, trading_day,
       bid, bid_qty, offer, offer_qty,
       COALESCE(captured_at, created_at) AS at
  FROM spread.depth
 WHERE level = 1;

COMMENT ON VIEW spread.v_depth_top IS
  'Top of book, one row per capture. CR-34 reads this; the full ladder is in '
  'spread.depth.';

-- Depth BEYOND the touch. A bid of 42,400 at level 1 with 10,000 behind it is
-- a different book from one with 500,000 behind it, and only the second
-- survives a seller.
CREATE OR REPLACE VIEW spread.v_depth_ladder AS
SELECT symbol, capture_id, trading_day,
       COALESCE(captured_at, created_at) AS at,
       sum(bid_qty)   FILTER (WHERE level <= 5) AS bid_shares_5,
       sum(offer_qty) FILTER (WHERE level <= 5) AS offer_shares_5,
       sum(bid_qty)                              AS bid_shares_all,
       sum(offer_qty)                            AS offer_shares_all,
       max(level)                                AS levels_captured
  FROM spread.depth
 GROUP BY symbol, capture_id, trading_day, COALESCE(captured_at, created_at);
