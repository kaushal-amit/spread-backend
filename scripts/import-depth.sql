-- Import public.stock_depth -> spread.depth
--
-- Both live in the SAME database now, so no CSV is needed. The mapping is
-- exact — the source header is:
--
--   id, scrape_batch_id, symbol, code, description, level,
--   bid_price, bid_qty, offer_price, offer_qty,
--   captured_at, trading_date, created_at
--
-- Two things the source corrected:
--
--   scrape_batch_id  groups TEN LEVELS into ONE capture. 52,057 rows are
--                    5,208 book captures. CR-34 counts captures; counting rows
--                    would overstate the sample tenfold.
--
--   captured_at      when the BOOK looked like this. created_at is when the
--                    row was written, about 0.3s later.

-- Run migration 008 first: npm run migrate

INSERT INTO spread.depth
  (symbol, level, bid, bid_qty, offer, offer_qty,
   captured_at, created_at, trading_day, capture_id, market_code, raw)
SELECT symbol,
       level,
       bid_price,
       bid_qty,
       offer_price,
       offer_qty,
       captured_at,
       created_at,
       trading_date,
       scrape_batch_id::text,
       code::text,
       jsonb_build_object('source_id', id, 'description', description)
  FROM public.stock_depth
 WHERE symbol IS NOT NULL
ON CONFLICT (symbol, capture_id, level) WHERE capture_id IS NOT NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- Verify. Row count alone proves nothing — if bid_qty came through NULL the
-- import "succeeded" and CR-34 is dead.
-- ---------------------------------------------------------------------------
SELECT count(*)                        AS rows,
       count(DISTINCT capture_id)      AS captures,
       count(DISTINCT symbol)          AS symbols,
       count(*) FILTER (WHERE bid_qty IS NOT NULL
                          AND offer_qty IS NOT NULL) AS usable,
       min(trading_day)                AS oldest,
       max(trading_day)                AS newest
  FROM spread.depth;
-- expected: 52,057 rows · 5,208 captures · 52,057 usable

-- ---------------------------------------------------------------------------
-- What CR-34 can actually speak about.
--
-- The rule refuses a direction claim below 100 CAPTURES, because a nine-minute
-- reading of one session gave the opposite sign to the full session.
-- ---------------------------------------------------------------------------
SELECT trading_day, symbol,
       count(DISTINCT capture_id) AS captures,
       count(DISTINCT capture_id) >= 100 AS can_state_a_direction
  FROM spread.depth
 GROUP BY 1, 2
 ORDER BY 3 DESC;
-- expected: 7 symbol-days of 25 clear the bar.
--   6 Aug   EMIRATES 1,238 · TIJARA 1,219 · EQUIPMENT 1,217
--   13 Aug  TIJARA     444
--   12 Aug  OULAFUEL   398
--   11 Aug  ARABREC    286 · CATTL 127
-- Everything else is silent, correctly.

-- ---------------------------------------------------------------------------
-- The ladder, which no screen has ever shown. Level 1 is the touch; the depth
-- BEHIND it decides whether the touch survives a seller.
-- ---------------------------------------------------------------------------
SELECT symbol, trading_day, levels_captured,
       bid_shares_5, offer_shares_5, bid_shares_all, offer_shares_all
  FROM spread.v_depth_ladder
 WHERE symbol = 'EMIRATES'
 ORDER BY at DESC LIMIT 5;
