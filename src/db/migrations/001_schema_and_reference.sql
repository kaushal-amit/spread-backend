-- 001 · Schema, reference tables, calendar
--
-- Everything lives in `spread`. `public` is READ FROM and NEVER WRITTEN TO —
-- it belongs to the TMI engine and to the scrapers.
--
-- NAMING RULES, applied without exception. Each exists because of a specific
-- failure in the previous schema:
--
--   1. The GRAIN is in the table name.      stock_daily was read as stock_prices.
--                                            symbol_day cannot be misread.
--   2. Every numeric column carries a UNIT.  price meant fils in one place and
--                                            KD in another.
--   3. One word, ONE meaning.                data_quality carried three,
--                                            including a TradingView marker.
--   4. A percentage says what it is OF.      pct_moves_sub100, not tiny_pct.
--   5. No abbreviations.                     change not chg, shares not qty.

CREATE SCHEMA IF NOT EXISTS spread;

COMMENT ON SCHEMA spread IS
  'SPREAD passive market-making engine. Owns all its own tables. Reads public.* '
  'through views in migration 002 and never writes there.';

-- ---------------------------------------------------------------------------
-- The listed universe.
--
-- Replaces `companies`, which is missing ALENMA — a symbol that traded 14-23
-- July, vanished for twelve sessions and returned on 11 August. A symbol
-- disappearing currently looks identical to a quiet stock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.symbol (
  symbol            text PRIMARY KEY,
  name_en           text,
  name_ar           text,

  -- MAIN | PREMIER | AUCTION. Premier pays 0.10% against Main's 0.15%, so
  -- getting this wrong misprices every trade on that symbol.
  market            text NOT NULL DEFAULT 'MAIN',

  -- market_id is null for every company in the old schema, so commission.js
  -- may be applying the Main rate to Premier stocks. Until this is populated
  -- from Boursa Kuwait listing data, commission.js FLAGS the assumption rather
  -- than hiding it.
  market_verified   boolean NOT NULL DEFAULT false,

  sector            text,
  lot_size          int NOT NULL DEFAULT 100,

  first_seen_on     date,
  last_seen_on      date,
  is_active         boolean NOT NULL DEFAULT true,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN spread.symbol.market_verified IS
  'false means `market` is an assumption, not listing data. commission.js must '
  'surface the assumption rather than silently applying the Main rate.';

COMMENT ON COLUMN spread.symbol.last_seen_on IS
  'A symbol that stops appearing is a data question, not a quiet stock. '
  'ALENMA vanished for twelve sessions and nothing noticed.';

-- ---------------------------------------------------------------------------
-- The trading calendar.
--
-- This table is more load-bearing than it looks. Every "5 sessions ago"
-- calculation previously used a DATE OFFSET, and 29 and 30 July are missing
-- from history — so a `- 1 day` offset made 1 August's change 6 fils wrong,
-- and everything derived from it after that.
--
-- Boursa Kuwait: Sunday-Thursday, 09:00-13:00 continuous, then auction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.trading_day (
  trading_day       date PRIMARY KEY,
  is_session        boolean NOT NULL DEFAULT true,
  open_at           time NOT NULL DEFAULT '09:00',
  close_at          time NOT NULL DEFAULT '13:00',
  -- Close Auction Acceptance 13:00-13:09, Trading at Last 13:10-13:14,
  -- Close-Of-Day 13:15-13:25.
  auction_close_at  time NOT NULL DEFAULT '13:25',
  holiday_name      text,
  note              text
);

COMMENT ON TABLE spread.trading_day IS
  'The session calendar. "The previous session" is a lookup here, never a date '
  'offset — 29 and 30 July are missing from history and an offset made the '
  'following session''s change 6 fils wrong.';

-- The previous SESSION, not the previous day. Used everywhere prev_close and
-- the 5-day window are computed.
CREATE OR REPLACE FUNCTION spread.prev_session(d date, n int DEFAULT 1)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT trading_day FROM spread.trading_day
   WHERE trading_day < d AND is_session
   ORDER BY trading_day DESC
   OFFSET GREATEST(n - 1, 0) LIMIT 1;
$$;

COMMENT ON FUNCTION spread.prev_session IS
  'The Nth previous SESSION. Never use date arithmetic for this.';
