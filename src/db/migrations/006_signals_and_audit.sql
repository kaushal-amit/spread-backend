-- 006 · Signals, alerts, configuration, audit

-- ---------------------------------------------------------------------------
-- CR-34 · bid-depth direction signal.
--
-- Stored rather than computed on the fly so the 91%/0% split can be RE-DERIVED
-- rather than asserted, and so a second symbol can validate it.
--
-- The finding, one stock, 418 snapshots, full session:
--   bid over 300,000  ->  10 of 11 upward ticks   91% up
--   bid under 50,000  ->  every downward tick      0% up
--
-- A deep bid is buyers who CANNOT GET FILLED. They are queued; the only way in
-- is to raise the price. A thin bid is a level that has just been consumed.
--
-- AND THE CORRECTION THAT MATTERS: an earlier reading of NINE MINUTES of the
-- same session concluded the OPPOSITE. Five observations inside a falling
-- stretch, and the sign inverted. Hence sample_sufficient.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.depth_signal (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  trading_day       date NOT NULL,
  symbol            text NOT NULL,

  bid_fils          numeric,
  bid_shares        bigint,
  offer_fils        numeric,
  offer_shares      bigint,

  signal            text NOT NULL,   -- BUY | SELL | BLOCKED | WAIT
  reason            text,

  -- A depth-direction claim with fewer than 100 snapshots behind it is
  -- REFUSED, in the signal and in the AI layer.
  snapshots_behind  int NOT NULL,
  sample_sufficient boolean NOT NULL,

  -- Written on the following snapshot. This is what validates the signal
  -- without anyone re-running the analysis by hand.
  next_tick_fils    numeric,
  next_tick_at      timestamptz
);

CREATE INDEX IF NOT EXISTS depth_signal_lookup_idx
  ON spread.depth_signal (symbol, trading_day, at DESC);

COMMENT ON TABLE spread.depth_signal IS
  'CR-34. INFORMS the alert and the AI layer. GATES NOTHING until a second '
  'symbol confirms — 418 snapshots is a good sample of one session and no '
  'evidence that the mechanism generalises.';

-- ---------------------------------------------------------------------------
-- CR-32 · entry window alert.
--
-- One stock, 12 August: the trade was available TEN TIMES, average window 3.3
-- minutes, and manual checking every ten minutes caught NONE of them. At one
-- window the offer went 143,760 -> 1,012 -> 34,012 in ninety seconds.
--
-- window_closed_at is the measurement. The claim is 3.3-minute windows;
-- storing open and close proves or disproves it over a month.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.entry_alert (
  id                bigserial PRIMARY KEY,
  fired_at          timestamptz NOT NULL DEFAULT now(),
  trading_day       date NOT NULL,
  symbol            text NOT NULL,

  bid_fils          numeric,
  offer_fils        numeric,
  spread_fils       numeric,
  offer_shares      bigint,
  my_shares         bigint,
  est_fill_mins  numeric,
  target_ticks      int,
  depth_signal      text,

  acted_on          boolean,
  window_closed_at  timestamptz,
  window_seconds    int
);

CREATE INDEX IF NOT EXISTS entry_alert_day_idx ON spread.entry_alert (trading_day, symbol);

-- Written by the morning screen, not by hand. CR-34 needs 100+ snapshots per
-- symbol per session and current coverage is 3-7 symbols a day.
CREATE TABLE IF NOT EXISTS spread.depth_watchlist (
  trading_day   date NOT NULL,
  symbol        text NOT NULL REFERENCES spread.symbol(symbol),
  rank          int,
  reason        text,
  snapshots     int NOT NULL DEFAULT 0,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trading_day, symbol)
);

-- ---------------------------------------------------------------------------
-- Configuration, versioned. Changing a threshold is an EVENT, not a mutation.
--
-- Two of the last three thresholds were set from a SINGLE failure each and
-- each one hid good stocks. passes_before/after records what a change did.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.gate_config (
  id              bigserial PRIMARY KEY,
  version         int NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  config          jsonb NOT NULL,
  changed_by      text,
  change_note     text,
  passes_before   int,
  passes_after    int
);

CREATE UNIQUE INDEX IF NOT EXISTS gate_config_version_idx ON spread.gate_config (version);

-- Every mutation, timestamped. Analysis only; not rendered.
CREATE TABLE IF NOT EXISTS spread.event_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  trading_day   date,
  symbol        text,
  action        text NOT NULL,
  detail        jsonb
);

CREATE INDEX IF NOT EXISTS event_log_day_idx ON spread.event_log (trading_day, at);

-- ---------------------------------------------------------------------------
-- AI commentary.
--
-- Eleven sessions of commentary existed only in chat history and could not be
-- scored. A TAKE that lost money and a TAKE that made money look identical in
-- a chat window.
--
-- cited_values traces every number to its source column, so a wrong comment
-- can be traced to WRONG DATA rather than wrong reasoning. Those need
-- completely different fixes and look identical after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.ai_note (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  trading_day   date,
  surface       text,      -- LIST | DETAIL | LIVE
  symbol        text,
  verdict       text,      -- TAKE | WAIT | AVOID | WARN
  reasoning     text,
  cited_values  jsonb,
  model         text,
  tokens        int,
  rejected      boolean NOT NULL DEFAULT false,
  reject_reason text,
  outcome       text,      -- the weekly review fills this
  outcome_kd    numeric
);

CREATE INDEX IF NOT EXISTS ai_note_day_idx ON spread.ai_note (trading_day, symbol);
CREATE INDEX IF NOT EXISTS ai_note_review_idx ON spread.ai_note (trading_day)
  WHERE outcome IS NULL;

-- ---------------------------------------------------------------------------
-- Jobs, and the alarm that should have existed.
--
-- 928 null-session rows across four days, every one the same symbol, and no
-- other symbol had a single null. Any query filtering session='Trading' drops
-- it SILENTLY — it is not rejected by a gate, it is absent, and a missing
-- stock looks identical to one that did not trade. Four days passed unnoticed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.job_run (
  id            bigserial PRIMARY KEY,
  job_name      text NOT NULL,
  trading_day   date,
  status        text NOT NULL,   -- RUNNING|OK|PARTIAL|FAILED|SKIPPED
  guard_status  text,
  rows_written  int,
  rows_missing  int,
  duration_ms   int,
  detail        jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS job_run_lookup_idx
  ON spread.job_run (job_name, trading_day DESC, started_at DESC);

CREATE TABLE IF NOT EXISTS spread.data_alarm (
  id            bigserial PRIMARY KEY,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  trading_day   date,
  table_name    text NOT NULL,
  column_name   text,
  symbol        text,
  alarm         text NOT NULL,   -- ALL_NULL | NO_ROWS | LOW_COVERAGE | STALE | SYMBOL_VANISHED
  detail        jsonb,
  resolved_at   timestamptz
);

CREATE INDEX IF NOT EXISTS data_alarm_open_idx ON spread.data_alarm (raised_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE spread.data_alarm IS
  'The table that should have existed. If any symbol shows 100% null in a '
  'required field, or a watchlist symbol produces under 100 depth snapshots, '
  'or a symbol stops appearing — it is raised here rather than being silent.';
