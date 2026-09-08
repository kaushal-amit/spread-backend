-- ===========================================================================
--  023 · halt-resume detector (FLOW 6.7, HALT_RESUME_study items 1 & 2)
-- ===========================================================================
--  A circuit-breaker halt that resumes DOWN pays a measured +5.43 average over
--  the fillable band, and the window is ~2 minutes — half the edge is gone 60
--  seconds after the resume. The detector removes the requirement to be watching
--  the right symbol at the right minute: it polls every symbol's `session`,
--  records Trading -> CB Auction as a HALT (direction fixed HERE, from the price
--  five minutes prior) and CB Auction -> Trading as a RESUME with the verdict
--  already computed.
--
--  THE TRANSITION LOG IS BACKEND-OWNED. The study places it in signal_log, but
--  the backend may not write public.* (lint-enforced), so every firing is
--  recorded in spread.halt_event — same fields, same scoring columns — and the
--  signal_log unification, if wanted, is a scraper-side step. The auto-swap into
--  a depth slot is likewise a REQUEST: public.depth_watchlist is the scraper's,
--  so the backend decides which slot to displace and emits/records the request.
--  Idempotent.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS spread.halt_event (
  id             bigserial PRIMARY KEY,
  trading_day    date        NOT NULL,
  symbol         text        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('HALT','RESUME')),
  detected_at    timestamptz NOT NULL DEFAULT now(),
  session_from   text,
  session_to     text,
  -- HALT facts (direction is decided here and never recomputed)
  halt_price_fils numeric,
  px_5min_prior_fils numeric,
  direction      text        CHECK (direction IN ('DOWN','UP') OR direction IS NULL),
  -- RESUME facts and the computed verdict
  halt_ref       bigint      REFERENCES spread.halt_event(id),
  resume_price_fils numeric,
  touch_bid_shares  bigint,
  touch_offer_shares bigint,
  your_shares    bigint,
  your_bid_pct   numeric,
  exit_ratio     numeric,
  target_fils    numeric,
  stop_fils      numeric,
  verdict        text,
  verdict_detail text,
  taken          boolean,
  -- nightly scoring (item 5, not computed here — the columns exist for it)
  px_20min_fils  numeric,
  was_right      boolean,
  scored_at      timestamptz
);
CREATE INDEX IF NOT EXISTS halt_event_day_symbol ON spread.halt_event (trading_day, symbol);
CREATE INDEX IF NOT EXISTS halt_event_symbol     ON spread.halt_event (symbol, kind);
COMMENT ON TABLE spread.halt_event IS
  'The halt-resume transition log (FLOW 6.7). Every firing recorded, whether '
  'taken or not; direction is fixed at the halt. Backend-owned because the '
  'backend may not write public.signal_log.';

-- The skip list, from the data (study §6): ten halts between them, none paid.
CREATE TABLE IF NOT EXISTS spread.halt_skip (
  symbol     text PRIMARY KEY,
  reason     text NOT NULL,
  still_true boolean NOT NULL DEFAULT true
);
INSERT INTO spread.halt_skip (symbol, reason) VALUES
  ('MUBARRAD', '2 halts, 0 gave 5 fils, +0.5 avg'),
  ('NIH',      '4 halts, none paid, +1.5 avg'),
  ('TIJARA',   '4 halts, none paid, +2.0 avg')
ON CONFLICT (symbol) DO NOTHING;

-- The gate numbers, editable without a deploy (study §3, §4, §9, §10).
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('halt_min_price',        100, 'fils',    'HALT §9', 'below this the resume is out of band', true),
  ('halt_max_price',        333, 'fils',    'HALT §9', 'above this the resume is out of band (a 700 KD budget cannot size it)', true),
  ('halt_book_too_deep_qty', 50000, 'shares', 'HALT §4', 'touch bid at/over this is not fillable — BOOK TOO DEEP', true),
  ('halt_exit_multiple_min', 5,   'x',       'HALT §9', 'offer_qty at/over this multiple of your shares blocks the exit', true),
  ('halt_target_fils',      5,   'fils',    'HALT §10', 'the printed target is the resume price plus this', true),
  ('halt_stop_fils',        5,   'fils',    'HALT §10', 'the printed stop is the resume price minus this', true),
  ('halt_direction_window_mins', 5, 'minutes', 'HALT §7', 'direction compares the resume/halt price to the price this long before the halt', true),
  ('halt_poll_secs',        20,  'seconds', 'HALT §7', 'the detector polls the latest capture this often', true)
ON CONFLICT (key) DO NOTHING;
