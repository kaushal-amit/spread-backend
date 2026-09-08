-- ===========================================================================
--  030 · the per-slot stale rule (A4, Item 5)
-- ===========================================================================
--  A depth slot whose latest awsat_stock_depth capture is older than this many
--  minutes, during the session, is stale — its book is not being swept and its
--  ladder is a stale picture. This is the 10-minute per-slot rule ON TOP of the
--  6.0 captureIntervalSecs freshness (which is a few-tick threshold), not a
--  second copy of it. Idempotent.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('slot_stale_min', 10, 'minutes', 'A4', 'a depth slot with no capture for this long during the session is stale and is displaced first', true)
ON CONFLICT (key) DO NOTHING;
