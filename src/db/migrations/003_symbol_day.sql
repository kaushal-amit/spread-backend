-- 003 · spread.symbol_day — one row per symbol per trading day
--
-- EVERY GATE READS FROM HERE. Nothing recomputes a statistic in a screening
-- query, and that restraint is the entire architecture.
--
-- Three times a correctly-specified check was implemented with the wrong
-- statistic, and the wrong statistic INVERTED the answer:
--
--   volume ratio  specified 5-day, implemented 20-day    spike hidden
--   queue         specified % of session, implemented median
--                 -> read 2.0% on the day it produced FOUR FILLS
--   exit depth    specified % of session, implemented median
--                 -> read 0.97 when the true figure was 38% exitable
--
-- In every case the specification was right and the query was not. A rule that
-- lives in a markdown file gets broken again; a rule that lives in one column
-- is broken once.

CREATE TABLE IF NOT EXISTS spread.symbol_day (
  symbol                        text NOT NULL REFERENCES spread.symbol(symbol),
  trading_day                   date NOT NULL REFERENCES spread.trading_day(trading_day),

  -- ---- prices · ALL IN FILS ---------------------------------------------
  open_fils                     numeric,
  high_fils                     numeric,   -- Trading session only
  low_fils                      numeric,   -- Trading session only
  close_fils                    numeric,   -- includes Trading at Last
  prev_close_fils               numeric,   -- from the previous SESSION
  range_trading_fils            numeric,   -- excludes auction prints

  -- ---- activity ----------------------------------------------------------
  volume_shares                 bigint,
  trade_count                   int,
  turnover_kd                   numeric,

  -- ---- Gate 3 · trade size ------------------------------------------------
  -- On a stock averaging 1,200 shares a 100-share order is 8% of normal and
  -- moves the tape. On one averaging 27,812 it is 0.4%.
  avg_trade_shares              numeric,

  -- ---- Gate 4 · movement --------------------------------------------------
  -- NOT a trade count. GFH traded 227 times and changed price 8 times —
  -- everything went through at one price. A count gate keeps GFH and cuts
  -- CATTL, exactly backwards.
  price_moves                   int,
  price_moves_up                int,
  price_moves_down              int,
  -- CR-pending §6. MADAR: 14 moves a day and a MEDIAN OF ONE up-move of 2+
  -- fils. Different properties, and only one of them pays at a 2-fil target.
  price_moves_2plus             int,

  -- ---- Gate 5 · tape quality ----------------------------------------------
  -- ARGAN, 9 August: 7 of 31 price moves came from trades totalling 28 shares
  -- — four shares each, on a stock averaging 19,881.
  tiny_move_count               int,
  tiny_move_shares              bigint,
  pct_moves_sub100              numeric,

  -- ---- Gate 6 · postable · percentiles are BUDGET-INDEPENDENT -------------
  bid_kd_p10                    numeric,
  bid_kd_p25                    numeric,
  bid_kd_p50                    numeric,
  bid_kd_p75                    numeric,
  bid_kd_p90                    numeric,
  pct_session_postable_800      numeric,

  -- ---- Gate 7 · exit · THREE measures, THREE questions --------------------
  -- Each answers something different and none replaces the others.
  pct_session_exitable_ratio    numeric,   -- offer <= 2x bid
  pct_session_exitable_size_800 numeric,   -- offer <= 3x my shares
  exitable_best_hour_pct        numeric,   -- the best single hour
  exitable_best_hour            int,
  offer_shares_p10              numeric,
  offer_shares_p50              numeric,
  offer_shares_p90              numeric,

  -- ---- Gate 8 · distribution ----------------------------------------------
  -- CR-33. MEASURED print location, not inferred from the tick rule. The two
  -- methods disagreed on DIRECTION on the same session: the tick rule said
  -- buyers 3:1, print location said sellers 1.3:1.
  --
  -- The tick rule is blind to the quietest form of distribution — a large
  -- seller hitting the same bid repeatedly registers as "unchanged" and is
  -- discarded. That was 35 events and 432,685 shares on one session.
  shares_at_offer               bigint,    -- last_price >= offer: a buyer paid up
  shares_at_bid                 bigint,    -- last_price <= bid:   a seller hit
  shares_inside_spread          bigint,
  events_at_offer               int,
  events_at_bid                 int,
  flow_ratio                    numeric,   -- at_bid / at_offer. >1 = distribution

  -- Kept for the 20-session comparison against print location, then retired.
  avg_uptick_shares             numeric,
  avg_downtick_shares           numeric,
  block_ratio                   numeric,
  volume_ratio_5d               numeric,
  trade_count_ratio_5d          numeric,

  -- ---- CR-33 · true trade size --------------------------------------------
  -- last_qty is populated on 31,796 of 31,796 rows and nothing reads it.
  -- Gate 5 infers size from volume differencing, which is EVERY trade in the
  -- minute rather than one trade. They agreed on 39 of 123 minutes — only when
  -- exactly one trade occurred.
  last_qty_p10                  numeric,
  last_qty_p50                  numeric,
  last_qty_p90                  numeric,
  trades_under_100              int,       -- dedup on last_trade_time

  -- ---- Gate 9 · consistency -----------------------------------------------
  -- Three dead stocks topped the screen after one busy day. The cost is
  -- explicit: a six-day run from 143 to 181 began after five quiet sessions
  -- and this would have blocked day one. The wake-up scan catches those live.
  days_active_5d                int,
  down_days_5d                  int,

  -- ---- Gate 10 · direction · CR-35 · WARN ONLY ----------------------------
  -- NOT a block. A stock that fell yesterday is 44% to rise today — a coin
  -- flip. CR-12 blocked on direction and was suspended after one modelled save
  -- against three real costs.
  --
  -- And the four bad picks that raised CR-35 each failed a gate that ALREADY
  -- EXISTS: 11 moves, 5% exitable, 35% painted. Direction correlated with the
  -- real failures rather than causing them.
  change_1d_fils                numeric,
  change_5d_fils                numeric,
  change_20d_fils               numeric,

  -- ---- activity hours · CR-29 ---------------------------------------------
  -- The fixed "check at 09:30" rule does not work. MADAR does 9% of its trades
  -- in the first hour and its morning count is ANTI-predictive: 18 trades by
  -- 10:00 gave a 50-trade day, 8 gave 209.
  trades_hour_09                int,
  trades_hour_10                int,
  trades_hour_11                int,
  trades_hour_12                int,
  peak_hour                     int,
  pct_trades_by_1000            numeric,

  -- ---- pace, for the 15-minute fill estimate ------------------------------
  am_shares_per_min             numeric,
  pm_shares_per_min             numeric,
  avg_spread_fils               numeric,

  -- ---- capture quality · OURS, one meaning --------------------------------
  -- A percentage computed from half a session is NOT WRONG — it is NOT
  -- COMPARABLE, and it sorts beside a fully-captured symbol as though it meant
  -- the same thing. That is worse than a wrong number, because nothing about
  -- it looks wrong.
  ticks_captured                int,
  capture_pct                   numeric,
  capture_quality               text,      -- OK | PARTIAL | THIN | MISSING
  source                        text,      -- BROKER | TRADINGVIEW | MERGED | NONE

  computed_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, trading_day)
);

CREATE INDEX IF NOT EXISTS symbol_day_day_idx ON spread.symbol_day (trading_day);
CREATE INDEX IF NOT EXISTS symbol_day_recent_idx
  ON spread.symbol_day (symbol, trading_day DESC);

COMMENT ON COLUMN spread.symbol_day.bid_kd_p50 IS
  'MEDIAN BID DEPTH. NEVER use this for a "can I transact" gate. KFIC, 9 August: '
  'the median said 2.0% postable and rejected the stock that produced four fills '
  'that day, because the bid swung 33-fold across the session. Verified against '
  'live Postgres: the median and the percentage disagree on ALL 13 symbols in '
  'band, worst gap 90.6 points. Gate 6 uses pct_session_postable_800.';

COMMENT ON COLUMN spread.symbol_day.pct_moves_sub100 IS
  'Gate 5. Percentage OF PRICE MOVES caused by trades of 100 shares or fewer. '
  'The name states what it is a percentage of, which tiny_pct did not.';

COMMENT ON COLUMN spread.symbol_day.price_moves IS
  'Gate 4. Minutes where last_price changed, EITHER DIRECTION. A round trip '
  'needs price down to your bid AND up to your offer. Not a trade count.';

COMMENT ON COLUMN spread.symbol_day.flow_ratio IS
  'CR-33. shares_at_bid / shares_at_offer from MEASURED print location. Above 1 '
  'is net distribution. Replaces the tick rule, which is blind to a large '
  'seller hitting the same bid repeatedly.';

COMMENT ON COLUMN spread.symbol_day.capture_quality IS
  'OURS. OK | PARTIAL | THIN | MISSING, against the busiest symbol that day. '
  'Not the same as the old public.stock_daily.data_quality, which carried three '
  'meanings including a TradingView "no book" marker.';
