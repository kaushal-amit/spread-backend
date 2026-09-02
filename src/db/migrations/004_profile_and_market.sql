-- 004 · Rolling per-symbol profile, and the market-wide day

CREATE TABLE IF NOT EXISTS spread.symbol_profile (
  symbol                    text PRIMARY KEY REFERENCES spread.symbol(symbol),
  as_of                     date NOT NULL,

  -- A 20-day median computed from 12 days is a DIFFERENT STATISTIC, and
  -- nothing previously recorded which one you had.
  sessions_in_window        int NOT NULL,

  median_daily_trade_count         numeric,
  median_trades_by_0930     numeric,
  median_trades_by_1000     numeric,
  median_trades_by_1100     numeric,
  median_trades_by_1200     numeric,
  median_volume_shares      numeric,
  median_price_move_count        numeric,
  median_pct_moves_sub100   numeric,
  median_bid_kd             numeric,

  -- Capital determines the universe. At 790 KD, 12 of 135 are in band; at
  -- 2,500 KD, 41 are. That is a constraint, not a screening failure.
  min_budget_kd             numeric,   -- 5% of the median resting bid
  max_budget_kd             numeric,   -- 30% of it — above this you ARE the book

  -- Measured over 79 sessions: fill % falls with depth, escape % rises, and
  -- the product peaks at -2 fils. The peak is the product, not either column.
  optimal_bid_depth_fils    int,

  peak_hour                 int,
  pm_beats_am_pct           numeric,   -- market-wide base rate is 21%

  -- CR-34 · thresholds SCALE WITH THE STOCK. One symbol's 300,000 is roughly
  -- 8% of a level on a 5M-share day; the same number means nothing elsewhere.
  deep_bid_shares           bigint,
  thin_bid_shares           bigint,
  thin_offer_shares         bigint,
  wall_offer_shares         bigint,

  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN spread.symbol_profile.sessions_in_window IS
  'How many sessions actually contributed. A 20-day median from 12 days is a '
  'different statistic and must not be presented as the same one.';

CREATE TABLE IF NOT EXISTS spread.market_day (
  trading_day        date PRIMARY KEY REFERENCES spread.trading_day(trading_day),
  symbols_traded     int,
  total_volume       bigint,
  total_trades       bigint,
  advancers          int,
  decliners          int,
  unchanged          int,
  avg_spread_fils    numeric,
  avg_price_move_count    numeric,

  -- THE GUARD ON THE GUARD.
  --
  -- symbol_day.capture_pct measures a symbol against the BUSIEST SYMBOL that
  -- day. If the scraper degrades market-wide the denominator degrades with it
  -- and every symbol reads 100% — the failure becomes invisible precisely when
  -- it is total.
  --
  -- 6 August: 42% of the session blind, gaps clustering at 74-94 seconds — the
  -- 60-second background-tab throttle signature. Per-symbol coverage that day
  -- looked healthy against a maximum that was itself broken.
  session_max_ticks  int,
  expected_ticks     int,
  market_coverage_ratio    numeric,   -- session_max / expected. Below 0.80 flags the DAY
  median_gap_secs    numeric,   -- OBSERVED, not configured
  capture_flag       text,      -- OK | THIN | GAPPY | THROTTLED

  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN spread.market_day.median_gap_secs IS
  'Observed median seconds between captures on the busiest symbol. Derived from '
  'the data, never from the configured interval — a configured value drifts '
  'from reality and an observed one cannot.';

COMMENT ON COLUMN spread.market_day.capture_flag IS
  'Two INDEPENDENT signals: thin totals and long gaps. Either can fire alone — '
  'a short session gives few ticks with normal gaps, a throttled one gives '
  'normal-looking totals with long gaps. GAPPY is the dangerous case, because '
  'a throttle hides inside a healthy count.';

-- Corporate actions. A results day or a dividend explains a spike that would
-- otherwise read as distribution.
CREATE TABLE IF NOT EXISTS spread.symbol_event (
  symbol        text NOT NULL REFERENCES spread.symbol(symbol),
  event_date    date NOT NULL,
  event_type    text NOT NULL,   -- RESULTS|DIVIDEND|AGM|SUSPENSION|CAPITAL|INSIDER
  headline_en   text,
  headline_ar   text,
  source_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, event_date, event_type)
);
