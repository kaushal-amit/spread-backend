-- ===========================================================================
--  019 · ONE day-roll rule (Step 3.9 / D-06)
-- ===========================================================================
--  kuwaitDay() in src/jobs/daily/index.js rolls the session day at 04:00
--  Kuwait: a leg booked at 01:00 belongs to the session that closed the
--  previous afternoon. Eleven SQL sites derived the day their own way —
--  `(created_at AT TIME ZONE 'UTC' + interval '3 hours')::date`, which rolls
--  at MIDNIGHT — so a row written between midnight and 04:00 was dated one
--  day later in SQL than in JavaScript. The two disagreed for four hours
--  every night, and nothing compared them.
--
--  spread.kuwait_day(timestamptz) is the rule, once. Every SQL derivation
--  calls it; test/dayroll.test.js asserts it agrees with kuwaitDay().
--
--  Idempotent: CREATE OR REPLACE, IF NOT EXISTS, ON CONFLICT. Safe to apply
--  on kse after 016–018.
-- ===========================================================================

CREATE OR REPLACE FUNCTION spread.kuwait_day(ts timestamptz)
RETURNS date
LANGUAGE sql STABLE STRICT PARALLEL SAFE
AS $$
  -- Asia/Kuwait is UTC+3 with no daylight saving. The four-hour step is the
  -- session roll: 00:00–03:59 Kuwait still belongs to the previous session.
  SELECT ((ts AT TIME ZONE 'Asia/Kuwait') - interval '4 hours')::date;
$$;

COMMENT ON FUNCTION spread.kuwait_day(timestamptz) IS
  'The session day of an instant: Kuwait time, rolled at 04:00. The SQL twin '
  'of kuwaitDay() in src/jobs/daily/index.js — the two must agree, and '
  'test/dayroll.test.js checks that they do. Use this, never AT TIME ZONE + 3h.';

-- ---------------------------------------------------------------------------
-- The calendar seeds from what actually traded. The scraper stamps
-- trading_date on every quote; that is ground truth, and it needs no
-- conversion at all.
-- ---------------------------------------------------------------------------
INSERT INTO spread.trading_day (trading_day, is_session)
SELECT DISTINCT trading_date, true FROM public.awsat_market_quotes
ON CONFLICT (trading_day) DO UPDATE
  SET is_session = spread.trading_day.is_session OR EXCLUDED.is_session;

-- ---------------------------------------------------------------------------
-- data_alarm: the inserts said ON CONFLICT DO NOTHING against a table with no
-- unique constraint, so nothing ever conflicted and a rerun raised the same
-- alarm again. One open alarm per (day, table, column, symbol, kind); the
-- inserts name this index as their conflict target.
-- ---------------------------------------------------------------------------
DELETE FROM spread.data_alarm a
 USING spread.data_alarm b
 WHERE a.resolved_at IS NULL AND b.resolved_at IS NULL
   AND a.id > b.id
   AND a.table_name = b.table_name AND a.alarm = b.alarm
   AND a.trading_day IS NOT DISTINCT FROM b.trading_day
   AND a.column_name IS NOT DISTINCT FROM b.column_name
   AND a.symbol IS NOT DISTINCT FROM b.symbol;

CREATE UNIQUE INDEX IF NOT EXISTS data_alarm_open_once
  ON spread.data_alarm (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                        COALESCE(column_name, ''), COALESCE(symbol, ''))
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- exit_venue is written by the ROUTE that closed the position (3.8):
--   MARKET  hit-bid — sold into the bid
--   LIMIT   a resting sell that filled (record FILLED / resolve FILLED)
--   AUCTION reserved for the closing auction
-- NOT VALID so an existing row with another value cannot block the migration;
-- validated where every row already conforms.
-- ---------------------------------------------------------------------------
ALTER TABLE spread.order_leg DROP CONSTRAINT IF EXISTS order_leg_exit_venue_valid;
ALTER TABLE spread.order_leg ADD CONSTRAINT order_leg_exit_venue_valid
  CHECK (exit_venue IS NULL OR exit_venue IN ('MARKET','LIMIT','AUCTION')) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spread.order_leg
                  WHERE exit_venue IS NOT NULL AND exit_venue NOT IN ('MARKET','LIMIT','AUCTION')) THEN
    ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_exit_venue_valid;
  END IF;
END $$;
COMMENT ON COLUMN spread.order_leg.exit_venue IS
  'How the position was closed: MARKET (hit-bid), LIMIT (a resting sell filled), AUCTION. Written by the route, never by the client.';
